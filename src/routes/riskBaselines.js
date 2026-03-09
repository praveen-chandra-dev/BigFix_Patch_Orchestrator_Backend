const express = require("express");
const axios = require("axios");
const https = require("https");
const { parseStringPromise } = require("xml2js");
const { prismRequest } = require("../services/prism");

const siteUrlCache = new Map();

function escapeXML(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/* =========================================
   Resolve BigFix Site URL
========================================= */

async function resolveSiteURL(ctx, siteName) {

  if (siteUrlCache.has(siteName)) {
    return siteUrlCache.get(siteName);
  }

  const bfUrl = (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");
  const bfUser = ctx.cfg?.BIGFIX_USER;
  const bfPass = ctx.cfg?.BIGFIX_PASS;

  const httpsAgent = ctx.bigfix?.httpsAgent;

  const relevance =
    `(url of it) of all bes sites whose (display name of it = "${siteName}" or name of it = "${siteName}")`;

  const encoded = encodeURIComponent(relevance);

  const response = await axios.get(
    `${bfUrl}/api/query?relevance=${encoded}`,
    {
      httpsAgent,
      auth: {
        username: bfUser,
        password: bfPass,
      },
    }
  );

  const result = await parseStringPromise(response.data);

  const answerObj =
    result?.BESAPI?.Query?.[0]?.Result?.[0]?.Answer?.[0];

  const siteURL =
    typeof answerObj === "object" ? answerObj._ : answerObj;

  if (!siteURL) {
    throw new Error(`Unable to resolve site URL for: ${siteName}`);
  }

  const trimmed = siteURL.trim();
  siteUrlCache.set(siteName, trimmed);

  return trimmed;
}

/* =========================================
   Attach Baseline Routes
========================================= */

function attachBaselineRoutes(app, ctx) {

  const router = express.Router();

  const bfUrl = (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");
  const bfUser = ctx.cfg?.BIGFIX_USER;
  const bfPass = ctx.cfg?.BIGFIX_PASS;

  const httpsAgent = ctx.bigfix?.httpsAgent;

  /* ============================
     CREATE BASELINE
  ============================ */

  router.post("/create", async (req, res) => {

    try {

      const { name, site, siteType, patches } = req.body;

      if (!name) {
        return res.status(400).json({ error: "Missing baseline name" });
      }

      if (!siteType) {
        return res.status(400).json({ error: "Missing siteType" });
      }

      if (!patches || !Array.isArray(patches)) {
        return res.status(400).json({ error: "Invalid patches data" });
      }

      let baselineComponentsXML = "";
      let patchIds = [];

      for (const p of patches) {

        const rawId = p.patch_id.replace(/^BIGFIX-/i, "").trim();

        if (!/^\d+$/.test(rawId)) {
          throw new Error(`Invalid Fixlet ID: ${rawId}`);
        }

        const siteURL = await resolveSiteURL(ctx, p.site_name);

        baselineComponentsXML += `
        <BaselineComponent
          IncludeInRelevance="true"
          SourceSiteURL="${siteURL}"
          SourceID="${rawId}"
          ActionName="Action1" />`;

        patchIds.push(rawId);
      }

      const baselineXML = `<?xml version="1.0" encoding="UTF-8"?>
<BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd">
  <Baseline>
    <Title>${escapeXML(name)}</Title>
    <Description>Created via PatchSetu API</Description>
    <Relevance>true</Relevance>
    <BaselineComponentCollection>
      <BaselineComponentGroup>
        ${baselineComponentsXML}
      </BaselineComponentGroup>
    </BaselineComponentCollection>
  </Baseline>
</BES>`;

      let endpoint;

      if (siteType.toLowerCase() === "master") {
        endpoint = `${bfUrl}/api/baselines/master`;
      } else {
        endpoint = `${bfUrl}/api/baselines/custom/${encodeURIComponent(site)}`;
      }

      const response = await axios.post(endpoint, baselineXML, {
        httpsAgent,
        headers: { "Content-Type": "application/xml" },
        auth: {
          username: bfUser,
          password: bfPass,
        },
      });

      const parsed = await parseStringPromise(response.data);

      let bigfixBaselineId =
        parsed?.BESAPI?.Baseline?.[0]?.ID?.[0];

      bigfixBaselineId = Number(bigfixBaselineId);

      if (!bigfixBaselineId || Number.isNaN(bigfixBaselineId)) {
        throw new Error("Unable to extract BigFix baseline ID");
      }

      const prismUrl = ctx.prism.PRISM_BASE_URL;

      const prismResponse = await prismRequest({
        method: "POST",
        url: `${prismUrl}/api/v1/baselines`,
        data: {
          baseline_name: name,
          bigfix_baseline_id: bigfixBaselineId,
          patch_ids: patchIds,
          status: "created",
        },
      });

      res.json({
        success: true,
        message: "Baseline created successfully",
        bigfix_baseline_id: bigfixBaselineId,
        prism_data: prismResponse.data,
      });

    } catch (err) {

      console.error("Baseline creation error:", err.response?.data || err.message);

      res.status(500).json({
        error: "Baseline creation failed",
        details: err.message,
      });

    }

  });

  /* ============================
     GET ALL BASELINES
  ============================ */

  router.get("/", async (req, res) => {

    try {

      const prismUrl = ctx.prism.PRISM_BASE_URL;

      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 50;

      const response = await prismRequest({
        method: "GET",
        url: `${prismUrl}/api/v1/baselines`,
        params: { page, limit },
      });

      res.json(response.data);

    } catch (err) {

      res.status(500).json({
        error: "Failed to fetch baselines",
        details: err.message,
      });

    }

  });

  /* ============================
     GET SINGLE BASELINE
  ============================ */

  router.get("/:id", async (req, res) => {

    try {

      const prismUrl = ctx.prism.PRISM_BASE_URL;

      const response = await prismRequest({
        method: "GET",
        url: `${prismUrl}/api/v1/baselines/${req.params.id}`,
      });

      res.json(response.data);

    } catch (err) {

      res.status(500).json({
        error: "Failed to fetch baseline",
        details: err.message,
      });

    }

  });

  /* ============================
     DELETE BASELINE
  ============================ */

  router.delete("/:id", async (req, res) => {

    try {

      const prismUrl = ctx.prism.PRISM_BASE_URL;

      const response = await prismRequest({
        method: "DELETE",
        url: `${prismUrl}/api/v1/baselines/${req.params.id}`,
      });

      res.json(response.data);

    } catch (err) {

      res.status(500).json({
        error: "Failed to delete baseline",
        details: err.message,
      });

    }

  });

  app.use("/api/baselines", router);

}

module.exports = attachBaselineRoutes;