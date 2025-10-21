// server.js
require("dotenv").config();
const express = require("express");
const morgan  = require("morgan");
const cors    = require("cors");
const axios   = require("axios");
const https   = require("https");
const nodemailer = require("nodemailer");

/* ====================== ENV ====================== */
const {
  PORT = 5174,

  // BigFix
  BIGFIX_BASE_URL,            // e.g. https://your-root-server:52311
  BIGFIX_USER,                // Basic auth user
  BIGFIX_PASS,                // Basic auth pass
  BIGFIX_ALLOW_SELF_SIGNED,   // "true" to allow self-signed BigFix certs

  // SMTP (all optional)
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,      // "true" if using SMTPS (465)
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
  SMTP_TO,                    // "a@x,b@y;c@z" supported
  SMTP_CC,
  SMTP_BCC,
  SMTP_ALLOW_SELF_SIGNED,     // "true" to allow self-signed SMTP certs

  // Turn on verbose, step-by-step logging
  DEBUG_LOG,
} = process.env;

if (!BIGFIX_BASE_URL) {
  throw new Error("Env BIGFIX_BASE_URL is required (e.g. https://server:52311)");
}
if (!BIGFIX_USER || !BIGFIX_PASS) {
  console.warn("⚠️  BIGFIX_USER / BIGFIX_PASS not set. BigFix calls will likely fail.");
}

/* ====================== Logging helpers ====================== */
let _rid = 0;
function rid() { _rid = (_rid + 1) % 1000000; return _rid.toString().padStart(6, "0"); }
function stamp(start) {
  const ms = Date.now() - start;
  return `(+${ms}ms)`;
}
function log(req, ...args) {
  if (String(DEBUG_LOG).toLowerCase() !== "1") return;
  if (!req._logStart) req._logStart = Date.now();
  if (!req._rid) req._rid = rid();
  console.log(`[${req._rid}] ${stamp(req._logStart)}`, ...args);
}

/* ====================== APP ====================== */
const app = express();
app.use(cors());
app.use(morgan("dev"));
app.use(express.json({ limit: "1mb" }));

/* HTTPS agent for BigFix (optional self-signed support) */
const httpsAgent = new https.Agent({
  rejectUnauthorized: !(String(BIGFIX_ALLOW_SELF_SIGNED).toLowerCase() === "true"),
});

/* ====================== In-memory Action store ====================== */
/* Keeps the most recent Action ID (and a small map of recent actions) */
const actionStore = {
  lastActionId: null,
  actions: Object.create(null), // id -> { id, createdAt, xml }
};

/* ====================== Helpers ====================== */
function joinUrl(base, path) {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
function toLowerSafe(x) { return String(x || "").toLowerCase(); }
function splitEmails(s) {
  return String(s || "").split(/[;,]/).map(v => v.trim()).filter(Boolean);
}
function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/<//g, "&lt;").replace(/>/g, "&gt;");
}

/* Tiny “tuple” flattener for BigFix /api/query JSON */
function collectStrings(node, out) {
  if (node == null) return;
  const t = typeof node;
  if (t === "string" || t === "number" || t === "boolean") { out.push(String(node)); return; }
  if (Array.isArray(node)) { node.forEach(n => collectStrings(n, out)); return; }
  if (t === "object") {
    if ("Answer" in node) collectStrings(node.Answer, out);
    if ("TupleResult" in node) collectStrings(node.TupleResult, out);
    if ("result" in node) collectStrings(node.result, out);
    Object.keys(node).forEach(k => {
      if (["Answer","TupleResult","result"].includes(k)) return;
      collectStrings(node[k], out);
    });
  }
}

/* Parse tuple rows from /api/query output (keeps column order) */
function parseTupleRows(json) {
  const rows = Array.isArray(json?.result) ? json.result : [];
  const out = [];
  for (const r of rows) {
    const parts = [];
    collectStrings(r, parts);
    out.push(parts);
  }
  return out;
}

/* Robust extractor for Action ID from BigFix XML */
function extractActionIdFromXml(xmlText) {
  if (!xmlText) return null;

  // 1) <ID>11158</ID>
  let m = xmlText.match(/<\s*ID\s*>\s*(\d+)\s*<\s*\/\s*ID\s*>/i);
  if (m) return m[1];

  // 2) <Action Resource=".../api/action/11158">
  m = xmlText.match(/<Action[^>]*\bResource\s*=\s*"[^"]*\/(\d+)"[^"]*"[^>]*>/i);
  if (m) return m[1];

  // 3) Rare: <Action ... ID="11158">
  m = xmlText.match(/<Action[^>]*\bID\s*=\s*"(\d+)"[^>]*>/i);
  if (m) return m[1];

  return null;
}

/* ====================== Health ====================== */
app.get("/health", (req, res) => {
  log(req, "GET /health");
  res.json({ ok: true, ts: new Date().toISOString() });
});

/* ====================== GET /api/query ====================== */
/* Proxies to BigFix `/api/query?output=json&relevance=...` */
app.get("/api/query", async (req, res) => {
  req._logStart = Date.now();
  const { relevance } = req.query;
  log(req, "Proxy /api/query relevance:", relevance);

  try {
    if (!relevance || !String(relevance).trim()) {
      log(req, "Missing relevance");
      return res.status(400).json({ error: "Missing 'relevance' query param" });
    }

    const bfUrl = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
    log(req, "BF GET →", bfUrl);

    const resp = await axios.get(bfUrl, {
      httpsAgent,
      auth: BIGFIX_USER && BIGFIX_PASS ? { username: BIGFIX_USER, password: BIGFIX_PASS } : undefined,
      headers: { Accept: "application/json" },
      responseType: "text",
      timeout: 60_000,
      validateStatus: () => true,
    });

    log(req, `BF GET ← ${resp.status}`);

    if (resp.status < 200 || resp.status >= 300) {
      log(req, "Proxy /api/query error payload (first 300):", String(resp.data).slice(0, 300));
      return res.status(resp.status).send(typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data));
    }

    let data;
    try { data = typeof resp.data === "string" ? JSON.parse(resp.data) : resp.data; }
    catch (e) {
      log(req, "Proxy /api/query JSON parse error:", String(e?.message || e));
      return res.status(502).send(`Unexpected BigFix response (not JSON): ${String(resp.data).slice(0, 500)}`);
    }

    log(req, "Proxy /api/query success");
    res.json(data);
  } catch (err) {
    log(req, "Proxy error:", err?.message);
    res.status(500).json({ error: "Proxy failure", detail: String(err?.message || err) });
  }
});

/* ====================== SMTP ====================== */
function buildTransport() {
  const secure = String(SMTP_SECURE).toLowerCase() === "true"; // SMTPS (465) if true
  const allowSelfSigned = String(SMTP_ALLOW_SELF_SIGNED).toLowerCase() === "true";

  const transportOpts = {
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure,
    tls: { rejectUnauthorized: !allowSelfSigned },
  };
  if (SMTP_USER || SMTP_PASS) transportOpts.auth = { user: SMTP_USER, pass: SMTP_PASS };
  return nodemailer.createTransport(transportOpts);
}

async function sendSandboxMail({
  baselineName, baselineSite, baselineFixletId,
  groupName, groupId, groupSite, groupType,
  customRelevance, actionXml, actionId,
  emailTo, emailFrom, emailCc, emailBcc,
}) {
  const transporter = buildTransport();

  const subject = `Sandbox baseline triggered: ${baselineName} → ${groupName}`;
  const lines = [
    `Sandbox patching has been triggered.`,
    ``,
    `Baseline : ${baselineName}`,
    `Site     : ${baselineSite}`,
    `FixletID : ${baselineFixletId}`,
    ``,
    `Group    : ${groupName}`,
    `Group ID : ${groupId}`,
    `Group Site: ${groupSite}`,
    `Group Type: ${groupType}`,
    ``,
    `Action ID: ${actionId || "Unknown"}`,
    ``,
    `Custom Relevance:`,
    `${customRelevance}`
  ];
  const text = lines.join("\n");
  const html =
    `<div style="font-family:Segoe UI,Roboto,Arial,sans-serif;font-size:14px;color:#111">` +
    `<h3>Sandbox patching triggered</h3>` +
    `<pre style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:12px">${escapeHtml(text)}</pre>` +
    `</div>`;

  const toList  = emailTo  ? splitEmails(emailTo)  : splitEmails(SMTP_TO);
  const ccList  = emailCc  ? splitEmails(emailCc)  : splitEmails(SMTP_CC);
  const bccList = emailBcc ? splitEmails(emailBcc) : splitEmails(SMTP_BCC);

  const info = await transporter.sendMail({
    from: emailFrom || SMTP_FROM,
    to: toList && toList.length ? toList.join(", ") : undefined,
    cc: ccList && ccList.length ? ccList.join(", ") : undefined,
    bcc: bccList && bccList.length ? bccList.join(", ") : undefined,
    subject, text, html,
  });

  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected, envelope: info.envelope, response: info.response };
}

/* ====================== POST /api/actions (Sandbox trigger) ====================== */
app.post("/api/actions", async (req, res) => {
  req._logStart = Date.now();
  try {
    const { baselineName, groupName, autoMail, mailTo, mailFrom, mailCc, mailBcc } = req.body || {};
    log(req, "POST /api/actions body:", req.body);

    if (!baselineName || !groupName) {
      log(req, "400 missing baseline/group");
      return res.status(400).json({ ok: false, error: "baselineName and groupName are required" });
    }

    /* 1) Lookup baseline (site + id) */
    const qBaseline = `(name of site of it, id of it) of bes baseline whose (name of it is "${baselineName.replace(/"/g, '\\"')}")`;
    const urlBaseline = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qBaseline)}`;
    log(req, "Baseline lookup →", urlBaseline);

    const baselineResp = await axios.get(urlBaseline, {
      httpsAgent,
      auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
      headers: { Accept: "application/json" },
      responseType: "json",
      timeout: 60_000,
      validateStatus: () => true
    });
    log(req, "Baseline lookup ←", baselineResp.status);

    if (baselineResp.status < 200 || baselineResp.status >= 300) {
      return res.status(baselineResp.status).send(baselineResp.data);
    }

    const baselineRows = Array.isArray(baselineResp.data?.result) ? baselineResp.data.result : [];
    if (!baselineRows.length) {
      log(req, "Baseline not found");
      return res.status(404).json({ ok: false, error: `Baseline not found: ${baselineName}` });
    }

    let siteName = "", fixletId = "";
    {
      const parts = [];
      collectStrings(baselineRows[0], parts);
      if (parts.length >= 2) { siteName = parts[0]; fixletId = parts[1]; }
      else return res.status(500).json({ ok: false, error: "Unexpected baseline query shape" });
    }
    log(req, "Baseline resolved:", { siteName, fixletId });

    /* 2) Lookup group (name,id,siteName,type) */
    const qGroup = `(name of it, id of it, name of site of it, (if automatic flag of it then "Automatic" else if manual flag of it then "manual" else "server based")) of bes computer group whose (name of it is "${groupName.replace(/"/g, '\\"')}")`;
    const urlGroup = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qGroup)}`;
    log(req, "Group lookup →", urlGroup);

    const groupResp = await axios.get(urlGroup, {
      httpsAgent,
      auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
      headers: { Accept: "application/json" },
      responseType: "json",
      timeout: 60_000,
      validateStatus: () => true
    });
    log(req, "Group lookup ←", groupResp.status);

    if (groupResp.status < 200 || groupResp.status >= 300) {
      return res.status(groupResp.status).send(groupResp.data);
    }

    const groupRows = Array.isArray(groupResp.data?.result) ? groupResp.data.result : [];
    if (!groupRows.length) {
      log(req, "Group not found");
      return res.status(404).json({ ok: false, error: `Group not found: ${groupName}` });
    }

    let gName = "", gId = "", gSite = "", gType = "";
    {
      const parts = [];
      collectStrings(groupRows[0], parts);
      if (parts.length >= 4) [gName, gId, gSite, gType] = parts;
      else return res.status(500).json({ ok: false, error: "Unexpected group query shape" });
    }
    log(req, "Group resolved:", { gName, gId, gSite, gType });

    /* 3) Build CustomRelevance according to group type */
    const type = toLowerSafe(gType); // "automatic" | "manual" | "server based"
    const siteTokenForAutomatic = gSite === "ActionSite" ? `site "actionsite"` : `site "CustomSite_${gSite}"`;

    let customRelevance = "";
    if (type.includes("automatic")) {
      customRelevance = `exists true whose ( if true then ( member of group ${gId} of ${siteTokenForAutomatic} ) else false)`;
    } else if (type.includes("manual")) {
      customRelevance = `exists true whose ( if true then ( member of manual group "${gName}" of client ) else false)`;
    } else {
      customRelevance = `exists true whose ( if true then ( member of server based group "${gName}" of client ) else false)`;
    }
    log(req, "CustomRelevance:", customRelevance);

    /* 4) Build XML for baseline action */
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd">` +
      `  <SourcedFixletAction>` +
      `    <SourceFixlet>` +
      `      <Sitename>${siteName}</Sitename>` +
      `      <FixletID>${fixletId}</FixletID>` +
      `      <Action>Action1</Action>` +
      `    </SourceFixlet>` +
      `    <Target>` +
      `      <CustomRelevance>${customRelevance}</CustomRelevance>` +
      `    </Target>` +
      `  </SourcedFixletAction>` +
      `</BES>`;

    log(req, "Action XML length:", xml.length);

    /* 5) POST to BigFix /api/actions */
    const bfPostUrl = joinUrl(BIGFIX_BASE_URL, "/api/actions");
    log(req, `BF POST → ${bfPostUrl} body=${xml.length} chars`);

    const bfResp = await axios.post(bfPostUrl, xml, {
      httpsAgent,
      auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
      headers: { "Content-Type": "text/xml" },
      timeout: 60_000,
      validateStatus: () => true,
      responseType: "text",
    });

    log(req, `BF POST ← ${bfResp.status}`);

    if (bfResp.status < 200 || bfResp.status >= 300) {
      log(req, "BigFix POST error body (first 300):", String(bfResp.data).slice(0, 300));
      return res.status(bfResp.status).send(typeof bfResp.data === "string" ? bfResp.data : JSON.stringify(bfResp.data));
    }

    const bodyText = String(bfResp.data || "");
    log(req, "BF POST body (first 300):", bodyText.slice(0, 300));
    const actionId = extractActionIdFromXml(bodyText);
    log(req, "Extracted Action ID:", actionId);

    if (!actionId) {
      log(req, "Could not extract Action ID from BigFix response");
    }

    // Save in the in-memory store for later
    if (actionId) {
      actionStore.lastActionId = actionId;
      actionStore.actions[actionId] = { id: actionId, createdAt: new Date().toISOString(), xml };
    }

    // Optional mail
    if (autoMail) {
      try {
        await sendSandboxMail({
          baselineName, baselineSite: siteName, baselineFixletId: fixletId,
          groupName: gName, groupId: gId, groupSite: gSite, groupType: gType,
          customRelevance, actionXml: xml, actionId,
          emailTo: mailTo, emailFrom: mailFrom, emailCc: mailCc, emailBcc: mailBcc,
        });
      } catch (e) {
        log(req, "Email send failed:", e?.message || e);
      }
    }

    const payload = { ok: true, actionId, siteName, fixletId, group: gName, createdAt: new Date().toISOString() };
    log(req, "POST /api/actions success →", payload);
    res.json(payload);
  } catch (err) {
    log(req, "POST /api/actions error:", err?.message || err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

/* ====================== Actions helper endpoints ====================== */

// Most recent Action ID (for the UI to “remember” last Sandbox run)
app.get("/api/actions/last", (req, res) => {
  req._logStart = Date.now();
  log(req, "GET /api/actions/last →", actionStore.lastActionId);
  res.json({ actionId: actionStore.lastActionId });
});

// Results for a specific action, as table rows
app.get("/api/actions/:id/results", async (req, res) => {
  req._logStart = Date.now();
  try {
    const id = String(req.params.id || "").trim();
    log(req, "GET /api/actions/:id/results id=", id);

    if (!/^\d+$/.test(id)) {
      log(req, "Invalid id");
      return res.status(400).json({ error: "Invalid action id" });
    }

    const relevance =
      `((if exists (name of computers of it) then name of computers of it else "N/A"),` +
      ` (if exists (names of member actions of actions of it) then (names of member actions of actions of it) else "N/A"),` +
      ` (detailed status of it as string | "N/A"),` +
      ` (start time of it as string | "N/A"),` +
      ` (end time of it as string | "N/A")) of results of bes action whose (id of it = ${id})`;

    const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
    log(req, "BF GET →", url);

    const resp = await axios.get(url, {
      httpsAgent,
      auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
      headers: { Accept: "application/json" },
      responseType: "json",
      timeout: 60_000,
      validateStatus: () => true,
    });
    log(req, "BF GET ←", resp.status);

    if (resp.status < 200 || resp.status >= 300) {
      log(req, "BF GET error payload (first 300):", String(resp.data).slice(0, 300));
      return res.status(resp.status).send(resp.data);
    }

    const rows = parseTupleRows(resp.data).map(parts => {
      // expected order: server, patch, status, start, end
      const [server, patch, status, start, end] = parts;
      return { server, patch, status, start, end };
    });

    const total = rows.length;
    const success = rows.filter(r => /executed successfully/i.test(r.status)).length;
    log(req, "results summary:", { total, success });

    res.json({ actionId: id, total, success, rows });
  } catch (err) {
    log(req, "Action results error:", err?.message || err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

/* ====================== Critical Health (Session Relevance) ====================== */
/* GET /api/health/critical
   Show a row if ANY of these is true: RAM ≥ 85 OR CPU ≥ 85 OR Disk ≤ 10 GB
*/
app.get("/api/health/critical", async (req, res) => {
  req._logStart = Date.now();
  try {
    log(req, "GET /api/health/critical");

    const relevance =
      '((value of result (it, bes property "Patch_Orchestrator_Server_Name") | "N/A") ,' +
      ' (value of result (it, bes property "Patch_Orchestrator_RAM_Utilization") | "N/A"),' +
      ' (value of result (it, bes property "Patch_Orchestrator_CPU_Utilization") | "N/A") ,' +
      ' (value of result (it, bes property "Patch_Orchestrator_Disk_Space") | "N/A"),' +
      ' (value of result (it, bes property "Patch_Orchestrator_IP_Address") | "N/A")) of bes computers';

    const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
    log(req, "BF GET →", url);

    const resp = await axios.get(url, {
      httpsAgent,
      auth: BIGFIX_USER && BIGFIX_PASS ? { username: BIGFIX_USER, password: BIGFIX_PASS } : undefined,
      headers: { Accept: "application/json" },
      responseType: "json",
      timeout: 60_000,
      validateStatus: () => true,
    });

    log(req, "BF GET ←", resp.status);
    if (resp.status < 200 || resp.status >= 300) {
      log(req, "BF GET error payload (first 300):", String(resp.data).slice(0, 300));
      return res.status(resp.status).send(resp.data);
    }

    const tuples = parseTupleRows(resp.data);

    const afterEq = (s) => {
      const str = String(s || "").trim();
      const idx = str.indexOf("=");
      return idx >= 0 ? str.slice(idx + 1).trim() : str;
    };
    const numOrNull = (s) => {
      const m = String(s || "").match(/-?\d+(\.\d+)?/);
      return m ? Number(m[0]) : null;
    };
    const parseDiskGB = (s) => {
      // "C: - Size = 38 GB", "11GB", "/var - Size = 9GB", "1 GB"
      const m = String(s || "").match(/(\d+(?:\.\d+)?)\s*GB/i);
      return m ? Number(m[1]) : null;
    };

    // Parse -> normalize
    const parsed = tuples.map((parts) => {
      const [serverStr, ramStr, cpuStr, diskStr, ipStr] = parts;
      const diskPretty = afterEq(diskStr) || "N/A";
      return {
        server: afterEq(serverStr) || "N/A",
        ramPct: numOrNull(ramStr),
        cpuPct: numOrNull(cpuStr),
        disk: diskPretty,
        diskGB: parseDiskGB(diskPretty),
        ip: afterEq(ipStr) || "N/A",
        raw: parts,
      };
    });

    // ANY-condition filter
    const rows = parsed.filter((r) => {
      const ramBad  = r.ramPct  != null && r.ramPct  >= 85;
      const cpuBad  = r.cpuPct  != null && r.cpuPct  >= 85;
      const diskBad = r.diskGB  != null && r.diskGB  <= 10;
      return ramBad || cpuBad || diskBad;
    });

    res.json({ ok: true, count: rows.length, rows });
  } catch (err) {
    log(req, "Critical health error:", err?.message || err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// --- NEW: total computers count (BES) ---
// GET /api/infra/total-computers  -> { ok:true, total: <number> }
app.get("/api/infra/total-computers", async (req, res) => {
  req._logStart = Date.now();
  try {
    log(req, "GET /api/infra/total-computers");

    const relevance = "number of bes computers";
    const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
    log(req, "BF GET →", url);

    const resp = await axios.get(url, {
      httpsAgent,
      auth: BIGFIX_USER && BIGFIX_PASS ? { username: BIGFIX_USER, password: BIGFIX_PASS } : undefined,
      headers: { Accept: "application/json" },
      responseType: "json",
      timeout: 60_000,
      validateStatus: () => true,
    });

    log(req, "BF GET ←", resp.status);

    if (resp.status < 200 || resp.status >= 300) {
      return res.status(resp.status).send(resp.data);
    }

    // BigFix JSON for "number of bes computers" is usually {"result":[{"Tuple":["123"]}], ...}
    // Be defensive and pull the first number we see.
    let total = 0;
    const data = resp.data;
    if (data && data.result && Array.isArray(data.result) && data.result[0]) {
      const tuple = data.result[0].Tuple || data.result[0].tuple || data.result[0];
      const v = Array.isArray(tuple) ? tuple[0] : tuple;
      const m = String(v).match(/\d+/);
      if (m) total = Number(m[0]);
    }
    // Final fallback: try to find any number in stringified payload
    if (!total) {
      const m = JSON.stringify(resp.data).match(/\b\d+\b/);
      if (m) total = Number(m[0]);
    }

    res.json({ ok: true, total });
  } catch (err) {
    log(req, "total-computers error:", err?.message || err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// --- ServiceNow: validate CHG (robust) ---
app.get("/api/sn/change/validate", async (req, res) => {
  req._logStart = Date.now();

  // Read envs at request time so there is never a scope issue
  const SN_BASE_RAW = process.env.SN_URL || "";
  const SN_USER = process.env.SN_USER || "";
  const SN_PASSWORD = process.env.SN_PASSWORD || "";
  const allowSelfSigned = String(process.env.SN_ALLOW_SELF_SIGNED || "").toLowerCase() === "true";

  // Normalize base (avoid accidental double /api/now)
  // Accept either https://instance or https://instance/api/now
  let snBase = SN_BASE_RAW.replace(/\/+$/, "");
  if (/\/api\/now$/i.test(snBase)) {
    snBase = snBase.replace(/\/api\/now$/i, "");
  }
  const snTableUrl = `${snBase}/api/now/table/change_request`;

  const agent = new (require("https").Agent)({ rejectUnauthorized: !allowSelfSigned });

  try {
    const number = String(req.query.number || "").trim().toUpperCase();
    log(req, "SN validate number:", number);

    if (!number || !/^CHG/.test(number)) {
      return res.status(400).json({ ok: false, error: "Invalid or missing change number (must start with CHG)" });
    }
    if (!snBase || !SN_USER || !SN_PASSWORD) {
      return res.status(500).json({
        ok: false,
        error: "ServiceNow env not configured (SN_URL, SN_USER, SN_PASSWORD required)"
      });
    }

    const endpoint =
      `${snTableUrl}` +
      `?sysparm_query=number=${encodeURIComponent(number)}` +
      `&sysparm_fields=sys_id,number,state,stage,approval,work_start,work_end` +
      `&sysparm_display_value=true`;

    log(req, "SN GET →", endpoint);

    const resp = await axios.get(endpoint, {
      httpsAgent: agent,
      auth: { username: SN_USER, password: SN_PASSWORD },
      headers: { Accept: "application/json" },
      timeout: 30000,
      validateStatus: () => true,
    });

    log(req, "SN GET ←", resp.status);

    // Auth/permission issue
    if (resp.status === 401 || resp.status === 403) {
      return res.json({
        ok: false,
        code: "NOT_FOUND_OR_FORBIDDEN",
        message: "Change Request doesn't exist or user doesn't have required privileges."
      });
    }

    // Defensive read of result
    let result = resp?.data?.result;
    if (Array.isArray(result)) {
      // ok
    } else if (result && typeof result === "object") {
      // some SN apps return a single object directly
      result = [result];
    } else {
      result = [];
    }

    if (result.length === 0) {
      // Truly not found
      return res.json({
        ok: false,
        code: "NOT_FOUND_OR_FORBIDDEN",
        message: "Change Request doesn't exist or user doesn't have required privileges."
      });
    }

    const rec = result[0] || {};
    const state = String(rec.state || "").trim();    // display value because of sysparm_display_value=true
    const approval = String(rec.approval || "").trim();
    const isImplement = /^implement$/i.test(state);

    // If it exists but is not Implement -> NOT_IMPLEMENT
    if (!isImplement) {
      return res.json({
        ok: false,
        code: "NOT_IMPLEMENT",
        message: "Change Request is not at Implement stage.",
        record: {
          sys_id: rec.sys_id, number: rec.number, state, approval,
          work_start: rec.work_start, work_end: rec.work_end
        }
      });
    }

    // Good to go
    return res.json({
      ok: true,
      exists: true,
      implement: true,
      record: {
        sys_id: rec.sys_id, number: rec.number, state, approval,
        work_start: rec.work_start, work_end: rec.work_end
      }
    });
  } catch (err) {
    log(req, "SN validate error:", err?.message || err);
    // Surface a short error for the UI
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

/* ====================== NEW: Pilot triggers ====================== */
/* Helper: validate a CHG directly from server code (no extra HTTP hop) */
async function validateChangeNumber(number, allowSelfSigned = false) {
  const SN_BASE_RAW = process.env.SN_URL || "";
  const SN_USER = process.env.SN_USER || "";
  const SN_PASSWORD = process.env.SN_PASSWORD || "";

  let snBase = SN_BASE_RAW.replace(/\/+$/, "");
  if (/\/api\/now$/i.test(snBase)) snBase = snBase.replace(/\/api\/now$/i, "");
  if (!snBase || !SN_USER || !SN_PASSWORD) {
    return { ok: false, code: "CONFIG", message: "ServiceNow env not configured" };
  }

  const snTableUrl = `${snBase}/api/now/table/change_request`;
  const endpoint =
    `${snTableUrl}` +
    `?sysparm_query=number=${encodeURIComponent(number)}` +
    `&sysparm_fields=sys_id,number,state,stage,approval,work_start,work_end` +
    `&sysparm_display_value=true`;

  const agent = new https.Agent({ rejectUnauthorized: !allowSelfSigned });
  const resp = await axios.get(endpoint, {
    httpsAgent: agent,
    auth: { username: SN_USER, password: SN_PASSWORD },
    headers: { Accept: "application/json" },
    timeout: 30000,
    validateStatus: () => true,
  });

  if (resp.status === 401 || resp.status === 403) {
    return { ok: false, code: "NOT_FOUND_OR_FORBIDDEN", message: "Change Request doesn't exist or user doesn't have required privileges." };
  }

  let result = resp?.data?.result;
  if (Array.isArray(result)) { /* ok */ }
  else if (result && typeof result === "object") { result = [result]; }
  else { result = []; }

  if (result.length === 0) {
    return { ok: false, code: "NOT_FOUND_OR_FORBIDDEN", message: "Change Request doesn't exist or user doesn't have required privileges." };
  }

  const rec = result[0] || {};
  const state = String(rec.state || "").trim();
  const isImplement = /^implement$/i.test(state);
  if (!isImplement) {
    return { ok: false, code: "NOT_IMPLEMENT", message: "Change Request is not at Implement stage.", record: rec };
  }
  return { ok: true, exists: true, implement: true, record: rec };
}

/* Helper: internal routine to trigger baseline against a group (same as /api/actions) */
async function triggerBaselineAction(req, { baselineName, groupName, autoMail, mailTo, mailFrom, mailCc, mailBcc }) {
  // 1) Lookup baseline
  const qBaseline = `(name of site of it, id of it) of bes baseline whose (name of it is "${baselineName.replace(/"/g, '\\"')}")`;
  const urlBaseline = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qBaseline)}`;
  log(req, "Pilot trigger — baseline lookup →", urlBaseline);
  const baselineResp = await axios.get(urlBaseline, {
    httpsAgent,
    auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
    headers: { Accept: "application/json" },
    responseType: "json",
    timeout: 60_000,
    validateStatus: () => true
  });
  log(req, "Pilot trigger — baseline lookup ←", baselineResp.status);
  if (baselineResp.status < 200 || baselineResp.status >= 300) throw new Error(`Baseline lookup failed: HTTP ${baselineResp.status}`);
  const baselineRows = Array.isArray(baselineResp.data?.result) ? baselineResp.data.result : [];
  if (!baselineRows.length) throw new Error(`Baseline not found: ${baselineName}`);
  const partsB = []; collectStrings(baselineRows[0], partsB);
  if (partsB.length < 2) throw new Error("Unexpected baseline query shape");
  const siteName = partsB[0]; const fixletId = partsB[1];

  // 2) Lookup group
  const qGroup = `(name of it, id of it, name of site of it, (if automatic flag of it then "Automatic" else if manual flag of it then "manual" else "server based")) of bes computer group whose (name of it is "${groupName.replace(/"/g, '\\"')}")`;
  const urlGroup = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(qGroup)}`;
  log(req, "Pilot trigger — group lookup →", urlGroup);
  const groupResp = await axios.get(urlGroup, {
    httpsAgent,
    auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
    headers: { Accept: "application/json" },
    responseType: "json",
    timeout: 60_000,
    validateStatus: () => true
  });
  log(req, "Pilot trigger — group lookup ←", groupResp.status);
  if (groupResp.status < 200 || groupResp.status >= 300) throw new Error(`Group lookup failed: HTTP ${groupResp.status}`);
  const groupRows = Array.isArray(groupResp.data?.result) ? groupResp.data.result : [];
  if (!groupRows.length) throw new Error(`Group not found: ${groupName}`);
  const partsG = []; collectStrings(groupRows[0], partsG);
  if (partsG.length < 4) throw new Error("Unexpected group query shape");
  const gName = partsG[0], gId = partsG[1], gSite = partsG[2], gType = partsG[3];

  // 3) Custom Relevance
  const type = toLowerSafe(gType);
  const siteTokenForAutomatic = gSite === "ActionSite" ? `site "actionsite"` : `site "CustomSite_${gSite}"`;
  let customRelevance = "";
  if (type.includes("automatic")) {
    customRelevance = `exists true whose ( if true then ( member of group ${gId} of ${siteTokenForAutomatic} ) else false)`;
  } else if (type.includes("manual")) {
    customRelevance = `exists true whose ( if true then ( member of manual group "${gName}" of client ) else false)`;
  } else {
    customRelevance = `exists true whose ( if true then ( member of server based group "${gName}" of client ) else false)`;
  }

  // 4) XML + POST
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd">` +
    `  <SourcedFixletAction>` +
    `    <SourceFixlet>` +
    `      <Sitename>${siteName}</Sitename>` +
    `      <FixletID>${fixletId}</FixletID>` +
    `      <Action>Action1</Action>` +
    `    </SourceFixlet>` +
    `    <Target>` +
    `      <CustomRelevance>${customRelevance}</CustomRelevance>` +
    `    </Target>` +
    `  </SourcedFixletAction>` +
    `</BES>`;

  const bfPostUrl = joinUrl(BIGFIX_BASE_URL, "/api/actions");
  log(req, `Pilot trigger — BF POST → ${bfPostUrl}`);
  const bfResp = await axios.post(bfPostUrl, xml, {
    httpsAgent,
    auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
    headers: { "Content-Type": "text/xml" },
    timeout: 60_000,
    validateStatus: () => true,
    responseType: "text",
  });
  log(req, `Pilot trigger — BF POST ← ${bfResp.status}`);
  if (bfResp.status < 200 || bfResp.status >= 300) throw new Error(`BigFix POST failed: HTTP ${bfResp.status} ${String(bfResp.data).slice(0, 200)}`);

  const actionId = extractActionIdFromXml(String(bfResp.data || ""));
  if (actionId) {
    actionStore.lastActionId = actionId;
    actionStore.actions[actionId] = { id: actionId, createdAt: new Date().toISOString(), xml };
  }

  // optional mail reusing existing helper
  if (autoMail) {
    try {
      await sendSandboxMail({
        baselineName, baselineSite: siteName, baselineFixletId: fixletId,
        groupName: gName, groupId: gId, groupSite: gSite, groupType: gType,
        customRelevance, actionXml: xml, actionId,
        emailTo: mailTo, emailFrom: mailFrom, emailCc: mailCc, emailBcc: mailBcc,
      });
    } catch (e) {
      log(req, "Pilot trigger — email failed:", e?.message || e);
    }
  }

  return { actionId, siteName, fixletId, group: gName };
}

/* POST /api/pilot/actions — validate CHG (Implement) then trigger baseline */
app.post("/api/pilot/actions", async (req, res) => {
  req._logStart = Date.now();
  try {
    const {
      baselineName,
      groupName,
      chgNumber,
      requireChg = true,
      autoMail,
      mailTo, mailFrom, mailCc, mailBcc,
    } = req.body || {};

    log(req, "POST /api/pilot/actions body:", req.body);

    if (!baselineName || !groupName) {
      return res.status(400).json({ ok: false, error: "baselineName and groupName are required" });
    }

    if (requireChg) {
      if (!chgNumber || !/^CHG/i.test(String(chgNumber))) {
        return res.status(400).json({ ok: false, error: "Valid chgNumber required when requireChg=true" });
      }
      const allowSelfSigned = String(process.env.SN_ALLOW_SELF_SIGNED || "").toLowerCase() === "true";
      const chk = await validateChangeNumber(String(chgNumber).toUpperCase(), allowSelfSigned);
      if (!chk.ok) {
        return res.status(400).json({
          ok: false,
          chgOk: false,
          code: chk.code || "CHG_INVALID",
          message: chk.message || "CHG validation failed"
        });
      }
    }

    const out = await triggerBaselineAction(req, { baselineName, groupName, autoMail, mailTo, mailFrom, mailCc, mailBcc });
    return res.json({ ok: true, chgOk: !requireChg || true, ...out });
  } catch (err) {
    log(req, "POST /api/pilot/actions error:", err?.message || err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

/* POST /api/pilot/actions/force — trigger baseline without CHG validation */
app.post("/api/pilot/actions/force", async (req, res) => {
  req._logStart = Date.now();
  try {
    const { baselineName, groupName, autoMail, mailTo, mailFrom, mailCc, mailBcc } = req.body || {};
    log(req, "POST /api/pilot/actions/force body:", req.body);

    if (!baselineName || !groupName) {
      return res.status(400).json({ ok: false, error: "baselineName and groupName are required" });
    }

    const out = await triggerBaselineAction(req, { baselineName, groupName, autoMail, mailTo, mailFrom, mailCc, mailBcc });
    return res.json({ ok: true, forced: true, ...out });
  } catch (err) {
    log(req, "POST /api/pilot/actions/force error:", err?.message || err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

/* ====================== Start ====================== */
app.listen(Number(PORT), () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
