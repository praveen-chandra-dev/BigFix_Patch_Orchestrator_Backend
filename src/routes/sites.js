const express = require("express");
const axios = require("axios");
const https = require("https");
const xml2js = require("xml2js");
const { getCtx } = require("../env"); // Import env context

const router = express.Router();
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

router.get("/", async (req, res) => {
  try {
    const ctx = getCtx();
    
    // Pull decrypted credentials from the context
    const bfUrl = ctx.bigfix?.BIGFIX_BASE_URL || process.env.BIGFIX_URL || process.env.BIGFIX_BASE_URL;
    const bfUser = ctx.bigfix?.BIGFIX_USER || process.env.BIGFIX_USER;
    const bfPass = ctx.bigfix?.BIGFIX_PASS || process.env.BIGFIX_PASS; // This is the decrypted password

    // Ensure the URL is correctly formatted with the BigFix API port
    let targetUrl = bfUrl.endsWith('/') ? bfUrl.slice(0, -1) : bfUrl;
    if (!targetUrl.includes(":52311")) targetUrl += ":52311";

    const relevance = `(it as string) of (if master site flag of it then "[Master] " & name of it else "[Custom] " & name of it) of all bes sites whose (not external site flag of it)`;
    const encodedRelevance = encodeURIComponent(relevance);

    const response = await axios.get(`${targetUrl}/api/query?relevance=${encodedRelevance}`, {
      httpsAgent,
      auth: { username: bfUser, password: bfPass }
    });

    const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
    const parsed = await parser.parseStringPromise(response.data);
    const answers = parsed?.BESAPI?.Query?.Result?.Answer;

    if (!answers) return res.json([]);

    const answerArray = Array.isArray(answers) ? answers : [answers];
    const sites = answerArray.map(value => {
      const text = typeof value === "string" ? value : value._ || "";
      const type = text.includes("[Master]") ? "Master" : "Custom";
      const name = text.replace("[Master] ", "").replace("[Custom] ", "");
      return { type, name };
    });

    res.json(sites);
  } catch (err) {
    console.error("Site fetch failed:", err.message);
    res.status(500).json({ error: "Failed to fetch sites" });
  }
});

module.exports = router;