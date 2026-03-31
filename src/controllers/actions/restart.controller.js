const axios = require("axios");
const { joinUrl, escapeXML, getBfAuthContext } = require("../../utils/http");
const { collectStrings, extractActionIdFromXml } = require("../../utils/query");
const { logFactory } = require("../../utils/log");
const { getCtx } = require("../../env");

async function handleBulkRestart(req, res, computerNames) {
  const ctx = getCtx();
  const log = logFactory(ctx.DEBUG_LOG);
  const { BIGFIX_BASE_URL } = ctx.bigfix;

  req._logStart = Date.now();
  try {
    const safeNames = computerNames.map(n => `"${n.toLowerCase().replace(/"/g, '\\"')}"`).join("; ");
    const relevance = `(id of it) of bes computers whose (name of it as lowercase is contained by set of (${safeNames}))`;
    const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
    
    const bfAuthOpts = await getBfAuthContext(req, ctx); 
    const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });

    if (resp.status < 200 || resp.status >= 300) throw new Error(`BigFix query failed: HTTP ${resp.status}`);
    const ids = []; collectStrings(resp.data?.result, ids);
    if (ids.length === 0) return res.status(404).json({ ok: false, error: "No valid Computer IDs found." });

    const targetXml = ids.map(id => `<ComputerID>${id}</ComputerID>`).join("");
    
    const xml = `<?xml version="1.0" encoding="utf-8"?><BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" SkipUI="true"><SingleAction><Title>${escapeXML(`BPS_Restart_Bulk_${ids.length}_Computers`)}</Title><Relevance>true</Relevance><ActionScript MIMEType="application/x-Fixlet-Windows-Shell"><![CDATA[restart 60]]></ActionScript><SuccessCriteria Option="RunToCompletion"></SuccessCriteria><Settings /><SettingsLocks /><Target>${targetXml}</Target></SingleAction></BES>`;

    const bfPostUrl = joinUrl(BIGFIX_BASE_URL, "/api/actions");
    const bfResp = await axios.post(bfPostUrl, xml, {
      ...bfAuthOpts, 
      headers: { "Content-Type": "text/xml" },
      timeout: 60_000,
      validateStatus: () => true,
      responseType: "text",
    });

    if (bfResp.status < 200 || bfResp.status >= 300) throw new Error(`BigFix POST failed: HTTP ${bfResp.status}`);
    const actionId = extractActionIdFromXml(String(bfResp.data || "")); 
    res.json({ ok: true, actionId, count: ids.length, computerNames });
  } catch (err) { res.status(500).json({ ok: false, error: String(err?.message || err) }); }
}

async function restartSingle(req, res) {
  const { computerName } = req.body;
  if (!computerName) return res.status(400).json({ ok: false, error: "computerName is required" });
  return handleBulkRestart(req, res, [computerName]);
}

async function restartBulk(req, res) {
  const { computerNames } = req.body;
  if (!Array.isArray(computerNames) || computerNames.length === 0) return res.status(400).json({ ok: false, error: "computerNames array is required" });
  return handleBulkRestart(req, res, computerNames);
}

module.exports = { restartSingle, restartBulk };