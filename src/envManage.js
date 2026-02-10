<<<<<<< HEAD
// src/envManage.js news
const fs = require("fs");
const path = require("path");
const os = require("os");
=======
// src/envManage.js
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
>>>>>>> 7232a5aadbbb46ebe9cfce066ac302e3b39bab03

function envPath() {
  return path.resolve(process.cwd(), ".env");
}

function readEnvFile() {
  const p = envPath();
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, "utf8");
  const lines = raw.split(/\r?\n/);
  const items = [];
  for (const line of lines) {
    if (!line || line.trim().startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1);
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    items.push({ key, value: val });
  }
  return items;
}

function toEnvContent(dict, existingOrder = []) {
  const keys = [];
  const seen = new Set();
  existingOrder.forEach((k) => {
    if (k in dict) {
      keys.push(k);
      seen.add(k);
    }
  });
  Object.keys(dict)
    .sort()
    .forEach((k) => {
      if (!seen.has(k)) keys.push(k);
    });

  const lines = keys.map((k) => {
    let v = dict[k] ?? "";
    if (/[^\w@%+:/.,\-]/.test(v)) v = JSON.stringify(String(v));
    return `${k}=${v}`;
  });
  lines.push("");
  return lines.join(os.EOL);
}

/**
 * Save to `.env` (no .bak). Uses tmp+rename for atomicity.
 */
function writeEnvAtomic(updates) {
  const p = envPath();
  const tmp = p + ".tmp";

  const items = readEnvFile();
  const order = items.map((i) => i.key);
  const dict = {};
  items.forEach((i) => {
    dict[i.key] = i.value;
  });
  Object.keys(updates || {}).forEach((k) => {
    dict[k] = String(updates[k] ?? "");
  });

  const data = toEnvContent(dict, order);
  fs.writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, p);
  return { path: p };
}

module.exports = { readEnvFile, writeEnvAtomic, envPath };
