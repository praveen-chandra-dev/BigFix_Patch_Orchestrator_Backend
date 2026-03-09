const express = require("express");
const axios = require("axios");
const xml2js = require("xml2js");
const { getCtx } = require("../env");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const ctx = getCtx();

    const bfUrl = (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");
    const bfUser = ctx.cfg?.BIGFIX_USER;
    const bfPass = ctx.cfg?.BIGFIX_PASS;

    const httpsAgent = ctx.bigfix?.httpsAgent;

    const relevance =
      `(it as string) of (if master site flag of it then "[Master] " & name of it else "[Custom] " & name of it) of all bes sites whose (master site flag of it or custom site flag of it)`;

    const encodedRelevance = encodeURIComponent(relevance);

    const response = await axios.get(
      `${bfUrl}/api/query?relevance=${encodedRelevance}`,
      {
        httpsAgent,
        auth: {
          username: bfUser,
          password: bfPass,
        },
      }
    );

    const parser = new xml2js.Parser({
      explicitArray: false,
      mergeAttrs: true,
    });

    const parsed = await parser.parseStringPromise(response.data);

    const answers = parsed?.BESAPI?.Query?.Result?.Answer;

    if (!answers) return res.json([]);

    const answerArray = Array.isArray(answers) ? answers : [answers];

    const sites = answerArray.map((value) => {
      const text = typeof value === "string" ? value : value._ || "";

      const type = text.includes("[Master]") ? "Master" : "Custom";

      const name = text
        .replace("[Master] ", "")
        .replace("[Custom] ", "")
        .trim();

      return { type, name };
    });

    res.json(sites);
  } catch (err) {
    console.error("Site fetch failed:", err.response?.data || err.message);

    res.status(500).json({
      error: "Failed to fetch sites",
      details: err.message,
    });
  }
});

module.exports = router;