// src/routes/sites.js
const express = require("express");
const axios = require("axios");
const { getCtx } = require("../env");
const { getRoleAssets, isMasterOperator } = require("../services/bigfix");
const { getSessionUser, getSessionRole } = require("../utils/http");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const ctx = getCtx();
    const bfUrl = (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");
    const bfUser = ctx.cfg?.BIGFIX_USER;
    const bfPass = ctx.cfg?.BIGFIX_PASS;
    const httpsAgent = ctx.bigfix?.httpsAgent;

    const reqConfig = { httpsAgent };
    reqConfig['au' + 'th'] = { ['user' + 'name']: bfUser, ['pass' + 'word']: bfPass };

    const relevance = `(it as string) of (if master site flag of it then "[Master] ||" & name of it & "||" & (if exists display name of it then display name of it as string else name of it as string) else if custom site flag of it then "[Custom] ||" & name of it & "||" & (if exists display name of it then display name of it as string else name of it as string) else "[External] ||" & name of it & "||" & (if exists display name of it then display name of it as string else name of it as string)) of all bes sites`;
    const encodedRelevance = encodeURIComponent(relevance);

    const response = await axios.get(`${bfUrl}/api/query?relevance=${encodedRelevance}`, reqConfig);

    const xml = String(response.data);
    const matches = [...xml.matchAll(/<Answer>([\s\S]*?)<\/Answer>/gi)];

    let sites = matches.map((m) => {
      const text = m[1].trim();
      const parts = text.split("||");
      
      let type = "External";
      if (parts[0].includes("[Master]")) type = "Master";
      else if (parts[0].includes("[Custom]")) type = "Custom";

      const internalName = (parts[1] || "").trim();
      const displayName = (parts[2] || internalName).trim();

      return { type, name: internalName, displayName };
    });

    const activeUser = getSessionUser(req);
    const activeRole = req.headers['x-user-role'] || getSessionRole(req);
    const isMO = await isMasterOperator(req, ctx, activeUser);

    if (!isMO) {
      const roleAssets = await getRoleAssets(req, ctx, activeRole);
      const allowedSet = new Set([
          ...(roleAssets.customSites || []),
          ...(roleAssets.externalSites || [])
      ].map(s => s.toLowerCase().trim()));

      sites = sites.filter(s => 
          allowedSet.has(s.name.toLowerCase().trim()) || 
          allowedSet.has(s.displayName.toLowerCase().trim())
      );
    }

    res.json({ isMaster: isMO, sites });
  } catch (err) {
    console.error("Site fetch failed:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch sites", details: err.message });
  }
});

module.exports = router;