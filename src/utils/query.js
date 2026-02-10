// src/utils/query.js news
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

function extractActionIdFromXml(xmlText) {
  if (!xmlText) return null;
  let m = xmlText.match(/<\s*ID\s*>\s*(\d+)\s*<\s*\/\s*ID\s*>/i);
  if (m) return m[1];
  m = xmlText.match(/<Action[^>]*\bResource\s*=\s*"[^"]*\/(\d+)"[^"]*"[^>]*>/i);
  if (m) return m[1];
  m = xmlText.match(/<Action[^>]*\bID\s*=\s*"(\d+)"[^>]*>/i);
  if (m) return m[1];
  return null;
}

module.exports = { collectStrings, parseTupleRows, extractActionIdFromXml };
