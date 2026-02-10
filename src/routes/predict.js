// bigfix-backend/src/routes/predict.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { getCtx } = require('../env');
const { joinUrl } = require('../utils/http');

// --- Helper: Query BigFix ---
async function queryBigFix(relevance) {
  const ctx = getCtx();
  const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
  
  if (!BIGFIX_BASE_URL) return [];

  const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
  
  try {
    const res = await axios.get(url, {
      httpsAgent,
      auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
      headers: { Accept: "application/json" },
      timeout: 5000 
    });
    
    if (res.data && res.data.result) {
      return Array.isArray(res.data.result) ? res.data.result : [res.data.result];
    }
    return [];
  } catch (e) {
    console.warn("[Predict] BigFix Query Failed (using fallback):", e.message);
    return [];
  }
}

// --- CALL LLM SERVICE (BATCH) ---
async function callLLMBatch(pairs) {
  const baseUrl = process.env.LLM_API_BASE || "http://127.0.0.1:8000";
  const endpoint = `${baseUrl}/predict/batch`;

  console.log(`[Predict] Calling Batch: ${endpoint}`);

  const payload = {
    items: pairs.map(p => ({
      action_name: p.patch,
      target_computer: p.server
    }))
  };

  try {
    const res = await axios.post(endpoint, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 60000 
    });

    console.log(`[Predict] Response Status: ${res.status}`);
    return normalizeResponse(res.data);

  } catch (error) {
    let msg = error.message;
    if (error.response) {
       console.error(`[Predict] Server Error ${error.response.status}:`, JSON.stringify(error.response.data));
       msg = `Server responded with ${error.response.status}: ${JSON.stringify(error.response.data)}`;
    } else {
       console.error(`[Predict] Network Error to ${endpoint}:`, error.message);
    }
    
    return {
      error: true,
      score: 0,
      analysis: `AI Service Error: ${msg}`,
      details: []
    };
  }
}

// --- CALL LLM SERVICE (SINGLE) ---
async function callLLMSingle(patch, server) {
  const baseUrl = process.env.LLM_API_BASE || "http://127.0.0.1:8000";
  const endpoint = `${baseUrl}/predict`;

  try {
    const res = await axios.post(endpoint, {
      action_name: patch,
      target_computer: server
    }, { headers: { "Content-Type": "application/json" }, timeout: 30000 });

    return normalizeResponse(res.data);
  } catch (error) {
    return { error: true, score: 0, analysis: "AI Error", details: [] };
  }
}

// --- RESPONSE NORMALIZER (FIXED) ---
function normalizeResponse(data) {
  let score = 0;
  let analysis = "Prediction complete.";
  let details = [];

  // 1. EXTRACT LIST: Check 'results' key (as per your payload) or root array
  const list = Array.isArray(data.results) ? data.results : (Array.isArray(data) ? data : null);

  if (list) {
    console.log(`[Predict] Processing ${list.length} results.`);
    
    if (list.length === 0) {
        return { score: 0, analysis: "No results returned.", details: [] };
    }

    let totalScore = 0;
    
    // Map raw API rows to clean frontend rows
    details = list.map(item => {
      // Find probability value
      let rawVal = item.predicted_success_rate || item.probability || item.score || 0;
      
      // Convert to % (0.97 -> 97.0)
      let pct = (rawVal <= 1 && rawVal > 0) ? rawVal * 100 : rawVal;
      if (typeof pct === 'string') pct = parseFloat(pct.replace('%',''));

      totalScore += pct;

      return {
        action: item.action_name || item.patch_name || "Unknown Patch",
        computer: item.target_computer || item.server_name || "Unknown Server",
        outcome: item.predicted_outcome || (pct > 80 ? "Success" : "Failure"),
        rate: Number(pct.toFixed(2)) // Keep 2 decimals
      };
    });

    // Calculate Average
    score = totalScore / list.length;
    analysis = `Average success rate across ${list.length} targets.`;
  } 
  // 2. SINGLE OBJECT RESPONSE
  else {
    let rawVal = data.predicted_success_rate || data.probability || data.score || 0;
    score = (rawVal <= 1 && rawVal > 0) ? rawVal * 100 : rawVal;
    
    details.push({
        action: data.action_name || "Single Action",
        computer: data.target_computer || "Single Target",
        outcome: data.predicted_outcome || "Success",
        rate: Number(score.toFixed(2))
    });
  }

  return {
    score: Number(score.toFixed(1)), 
    analysis,
    details: details // Sending full list to UI
  };
}

// --- MAIN ROUTE ---
router.post('/api/predict/success', async (req, res) => {
  try {
    const { baselineName, groupName } = req.body;

    // Resolve BigFix Data
    const relPatches = `(name of source fixlet of it) of components of component groups of bes baselines whose (name of it = "${baselineName}")`;
    const relServers = `names of members of bes computer group whose (name of it = "${groupName}")`;
    
    let patchList = await queryBigFix(relPatches);
    let serverList = await queryBigFix(relServers);

    // FALLBACK (Testing)
    if (patchList.length === 0 || serverList.length === 0) {
        console.log("[Predict] BigFix empty. Using fallback data.");
        patchList = ["Security Update KB500", "Feature Update 22H2"];
        serverList = ["Server-01", "Server-02"];
    }

    const pairs = [];
    for (const patch of patchList) {
      for (const server of serverList) {
        pairs.push({ patch, server });
      }
    }

    // Call API
    let result = { score: 0, analysis: "", details: [] };
    if (pairs.length === 1) {
      const pair = pairs[0];
      result = await callLLMSingle(pair.patch, pair.server);
    } else {
      result = await callLLMBatch(pairs);
    }

    res.json({ 
        ok: true, 
        probability: result.score,
        analysis: result.analysis,
        details: result.details, // Pass details array
        error: result.error
    });

  } catch (error) {
    console.error("Prediction Error:", error);
    res.json({ ok: false, error: error.message });
  }
});

module.exports = router;