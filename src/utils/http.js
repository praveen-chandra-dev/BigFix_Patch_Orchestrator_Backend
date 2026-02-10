// src/utils/http.js
function joinUrl(base, path) {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
function toLowerSafe(x) { return String(x || "").toLowerCase(); }
function splitEmails(s) {
  return String(s || "").split(/[;,]/).map(v => v.trim()).filter(Boolean); // New
}
function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}




module.exports = { joinUrl, toLowerSafe, splitEmails, escapeHtml };
