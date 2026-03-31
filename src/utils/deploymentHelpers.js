const https = require("https");
const axios = require("axios");
const { joinUrl } = require("./http");
const { parseTupleRows } = require("./query");

function toCSV(serverList) {
  if (!serverList || serverList.length === 0) return null;
  const header = "ServerName";
  const rows = serverList.map(name => `"${String(name).replace(/"/g, '""')}"`);
  return [header, ...rows].join("\r\n");
}

function getPatchWindowMs(patchWindow) {
  if (patchWindow && typeof patchWindow === "object") {
    const d = Number(patchWindow.days) || 0; 
    const h = Number(patchWindow.hours) || 0; 
    const m = Number(patchWindow.minutes) || 0;
    return d * 86400000 + h * 3600000 + m * 60000;
  }
  const legacyHours = Number(patchWindow);
  if (Number.isFinite(legacyHours) && legacyHours > 0) return legacyHours * 3600000;
  return 0;
}

function msToXSDuration(ms) {
  if (!Number.isFinite(ms) || ms === 0) return "PT0S";
  const neg = ms < 0;
  let t = Math.abs(ms);
  const totalSeconds = Math.floor(t / 1000);
  const days = Math.floor(totalSeconds / 86400);
  let rem = totalSeconds % 86400;
  const hours = Math.floor(rem / 3600);
  rem = rem % 3600;
  const minutes = Math.floor(rem / 60);
  const seconds = rem % 60;

  let out = "";
  if (days) out += `${days}D`;
  const timeParts = [];
  if (hours) timeParts.push(`${hours}H`);
  if (minutes) timeParts.push(`${minutes}M`);
  if (seconds) timeParts.push(`${seconds}S`);
  if (timeParts.length) out += `T${timeParts.join("")}`;
  else if (!days) out = "T0S";

  return (neg ? "-" : "") + "P" + out;
}

function localUtcOffsetMs() {
  return -(new Date().getTimezoneOffset()) * 60000; 
}

async function fetchBaselinePatches(bigfixCtx, baselineName, bfAuthOpts) {
  try {
    const { BIGFIX_BASE_URL } = bigfixCtx;
    const relevance = `((name of it | "N/A"), (source severity of it | "N/A"), (cve id list of it | "N/A"), (source of it | "N/A")) of source fixlets of components of component groups of bes fixlets whose (name of it as lowercase = "${String(baselineName).toLowerCase().replace(/"/g, '\\"')}")`;
    const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
    const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
    if (resp.status >= 200 && resp.status < 300) {
        const rows = parseTupleRows(resp.data);
        return rows.map(r => ({ name: r[0], severity: r[1], cves: r[2], source: r[3] }));
    }
  } catch (e) { }
  return [];
}

function patchesToCSV(patches) {
  if (!patches || !patches.length) return null;
  const escape = (v) => `"${String(v || "").replace(/"/g, '""')}"`;
  const lines = ["Patch Name,Severity,CVEs,Source"];
  for (const p of patches) { lines.push(`${escape(p.name)},${escape(p.severity)},${escape(p.cves)},${escape(p.source)}`); }
  return lines.join("\r\n");
}

async function validateChangeNumber(number, ctx) {
  const { SN_URL, SN_USER, SN_PASSWORD, SN_ALLOW_SELF_SIGNED } = ctx.servicenow;
  let snBase = (SN_URL || "").replace(/\/+$/, "");
  if (/\/api\/now$/i.test(snBase)) snBase = snBase.replace(/\/api\/now$/i, "");
  if (!snBase || !SN_USER || !SN_PASSWORD) { return { ok: false, code: "CONFIG", message: "ServiceNow env not configured" }; }
  
  const endpoint = `${snBase}/api/now/table/change_request` + `?sysparm_query=number=${encodeURIComponent(number)}` + `&sysparm_fields=sys_id,number,state,stage,approval,work_start,work_end` + `&sysparm_display_value=true`;
  const agent = new https.Agent({ rejectUnauthorized: !(String(SN_ALLOW_SELF_SIGNED).toLowerCase() === "true") });
  const resp = await axios.get(endpoint, { httpsAgent: agent, auth: { username: SN_USER, password: SN_PASSWORD }, headers: { Accept: "application/json" }, timeout: 30000, validateStatus: () => true });
  
  if (resp.status === 401 || resp.status === 403) return { ok: false, code: "NOT_FOUND_OR_FORBIDDEN", message: "Change Request doesn't exist or user doesn't have required privileges." }; 
  
  let result = resp?.data?.result;
  if (Array.isArray(result)) { /* ok */ } else if (result && typeof result === "object") { result = [result]; } else { result = []; }
  
  if (result.length === 0) return { ok: false, code: "NOT_FOUND_OR_FORBIDDEN", message: "Change Request doesn't exist or user doesn't have required privileges." }; 
  
  const rec = result[0] || {}; 
  const state = String(rec.state || "").trim(); 
  const isImplement = /^implement$/i.test(state);
  
  if (!isImplement) return { ok: false, code: "NOT_IMPLEMENT", message: "Change Request is not at Implement stage.", record: rec }; 
  return { ok: true, exists: true, implement: true, record: rec };
}

module.exports = {
    toCSV,
    getPatchWindowMs,
    msToXSDuration,
    localUtcOffsetMs,
    fetchBaselinePatches,
    patchesToCSV,
    validateChangeNumber
};