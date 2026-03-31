const axios = require("axios");
const { joinUrl, escapeXML, getBfAuthContext } = require("../../utils/http");
const { collectStrings, extractActionIdFromXml } = require("../../utils/query");
const { getCtx } = require("../../env");

async function serviceRestart(req, res) {
  const { computerName } = req.body;
  if (!computerName) return res.status(400).json({ ok: false, error: "computerName is required" });

  const ctx = getCtx();
  const { BIGFIX_BASE_URL } = ctx.bigfix;

  try {
    const safeComputerName = computerName.toLowerCase().replace(/"/g, '\\"');
    const relevance = `(ids of it) of bes computers whose (name of it as lowercase = "${safeComputerName}")`;
    const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
    
    const bfAuthOpts = await getBfAuthContext(req, ctx); 
    const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
    
    const parts = []; collectStrings(resp.data?.result, parts); 
    if (parts.length === 0 || !/^\d+$/.test(parts[0])) return res.status(404).json({ ok: false, error: "Computer not found." });
    
    const computerId = parts[0];
    const actionScript = `waithidden cmd.exe /c sc config wuauserv start= auto\nwaithidden cmd.exe /c sc start wuauserv`;

    const xml = `<?xml version="1.0" encoding="utf-8"?><BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" SkipUI="true"><SingleAction><Title>BPS_Window_Update_Service_Restart-${escapeXML(computerName)}</Title><Relevance>true</Relevance><ActionScript MIMEType="application/x-Fixlet-Windows-Shell"><![CDATA[${actionScript}]]></ActionScript><SuccessCriteria Option="RunToCompletion"></SuccessCriteria><Settings /><SettingsLocks /><Target><ComputerID>${computerId}</ComputerID></Target></SingleAction></BES>`;
    
    const bfPostUrl = joinUrl(BIGFIX_BASE_URL, "/api/actions");
    const bfResp = await axios.post(bfPostUrl, xml, {
      ...bfAuthOpts, 
      headers: { "Content-Type": "text/xml" },
      timeout: 60_000,
      validateStatus: () => true,
      responseType: "text",
    });
    if (bfResp.status < 200 || bfResp.status >= 300) throw new Error(`BigFix POST failed: HTTP ${bfResp.status}`);
    
    res.json({ ok: true, actionId: extractActionIdFromXml(String(bfResp.data || "")), computerId, computerName });
  } catch (err) { res.status(500).json({ ok: false, error: String(err?.message || err) }); }
}

module.exports = { serviceRestart };