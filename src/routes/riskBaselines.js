const express = require("express");
const axios = require("axios");
const https = require("https");
const { parseStringPromise } = require("xml2js");
const { prismRequest } = require("../services/prism");
const { getCtx } = require("../env"); // Import env context

const router = express.Router();
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const siteUrlCache = new Map();

function escapeXML(str = "") {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

async function resolveSiteURL(siteName) {
  if (siteUrlCache.has(siteName)) return siteUrlCache.get(siteName);
  
  const ctx = getCtx();
  const bfUrl = ctx.bigfix?.BIGFIX_BASE_URL || process.env.BIGFIX_URL || process.env.BIGFIX_BASE_URL;
  const bfUser = ctx.bigfix?.BIGFIX_USER || process.env.BIGFIX_USER;
  const bfPass = ctx.bigfix?.BIGFIX_PASS || process.env.BIGFIX_PASS; // Decrypted password

  let targetUrl = bfUrl.endsWith('/') ? bfUrl.slice(0, -1) : bfUrl;
  if (!targetUrl.includes(":52311")) targetUrl += ":52311";

  const relevance = `(url of it) of all bes sites whose (display name of it = "${siteName}" or name of it = "${siteName}")`;
  const response = await axios.get(`${targetUrl}/api/query?relevance=${encodeURIComponent(relevance)}`, {
    httpsAgent, 
    auth: { username: bfUser, password: bfPass },
  });
  
  const result = await parseStringPromise(response.data);
  const answerObj = result?.BESAPI?.Query?.[0]?.Result?.[0]?.Answer?.[0];
  const siteURL = typeof answerObj === "object" ? answerObj._ : answerObj;
  
  if (!siteURL) throw new Error(`Unable to resolve site URL for: ${siteName}`);
  siteUrlCache.set(siteName, siteURL.trim());
  return siteURL.trim();
}

router.post("/create", async (req, res) => {
  try {
    const { name, site, siteType, patches } = req.body;
    if (!name || !siteType || !Array.isArray(patches)) return res.status(400).json({ error: "Invalid baseline payload" });

    const ctx = getCtx();
    const bfUrl = ctx.bigfix?.BIGFIX_BASE_URL || process.env.BIGFIX_URL || process.env.BIGFIX_BASE_URL;
    const bfUser = ctx.bigfix?.BIGFIX_USER || process.env.BIGFIX_USER;
    const bfPass = ctx.bigfix?.BIGFIX_PASS || process.env.BIGFIX_PASS; // Decrypted password

    let targetUrl = bfUrl.endsWith('/') ? bfUrl.slice(0, -1) : bfUrl;
    if (!targetUrl.includes(":52311")) targetUrl += ":52311";

    let baselineComponentsXML = "";
    let patchIds = [];

    for (const p of patches) {
      const rawId = p.patch_id.replace(/^BIGFIX-/i, "").trim();
      const siteURL = await resolveSiteURL(p.site_name);
      baselineComponentsXML += `<BaselineComponent IncludeInRelevance="true" SourceSiteURL="${siteURL}" SourceID="${rawId}" ActionName="Action1" />`;
      patchIds.push(rawId);
    }

    const baselineXML = `<?xml version="1.0" encoding="UTF-8"?>
<BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd">
  <Baseline><Title>${escapeXML(name)}</Title><Description>Created via PatchSetu API</Description><Relevance>true</Relevance>
    <BaselineComponentCollection><BaselineComponentGroup>${baselineComponentsXML}</BaselineComponentGroup></BaselineComponentCollection>
  </Baseline>
</BES>`;

    const endpoint = siteType.toLowerCase() === "master" ? `${targetUrl}/api/baselines/master` : `${targetUrl}/api/baselines/custom/${encodeURIComponent(site)}`;
    
    const response = await axios.post(endpoint, baselineXML, {
      httpsAgent, headers: { "Content-Type": "application/xml" },
      auth: { username: bfUser, password: bfPass },
    });

    const parsed = await parseStringPromise(response.data);
    let bigfixBaselineId = Number(parsed?.BESAPI?.Baseline?.[0]?.ID?.[0]);

    if (!bigfixBaselineId || Number.isNaN(bigfixBaselineId)) throw new Error("Unable to extract BigFix baseline ID");

    const prismUrl = process.env.PRISM_BASE_URL;
    const prismResponse = await prismRequest({
      method: "POST", url: `${prismUrl}/api/v1/baselines`,
      data: { baseline_name: name, bigfix_baseline_id: bigfixBaselineId, patch_ids: patchIds, status: "created" },
    });

    return res.json({ success: true, message: "Baseline created successfully", bigfix_baseline_id: bigfixBaselineId, prism_data: prismResponse.data });
  } catch (err) {
    return res.status(500).json({ error: "Baseline creation failed", details: err.message });
  }
});

router.get("/", async (req, res) => {
  try {
    const prismUrl = process.env.PRISM_BASE_URL;
    const response = await prismRequest({ method: "GET", url: `${prismUrl}/api/v1/baselines`, params: { page: req.query.page || 1, limit: req.query.limit || 50 }});
    res.json(response.data);
  } catch (err) { res.status(500).json({ error: "Failed to fetch baselines", details: err.message }); }
});

router.get("/:id", async (req, res) => {
  try {
    const prismUrl = process.env.PRISM_BASE_URL;
    const response = await prismRequest({ method: "GET", url: `${prismUrl}/api/v1/baselines/${req.params.id}` });
    res.json(response.data);
  } catch (err) { res.status(500).json({ error: "Failed to fetch baseline", details: err.message }); }
});

router.delete("/:id", async (req, res) => {
  try {
    const prismUrl = process.env.PRISM_BASE_URL;
    const response = await prismRequest({ method: "DELETE", url: `${prismUrl}/api/v1/baselines/${req.params.id}` });
    res.json(response.data);
  } catch (err) { res.status(500).json({ error: "Failed to delete baseline", details: err.message }); }
});

module.exports = router;