require("dotenv").config({ quiet: true });
const fs = require("fs");
const https = require("https");
const path = require("path");
const os = require("os");
const net = require("net");
const selfsigned = require("selfsigned");
const { buildApp } = require("./src/app");
const { logger } = require("./src/services/logger");
const { runDatabaseSetup } = require("./src/db/setup"); 

const { getCfg } = require("./src/env"); 


const cfg = getCfg();
const PORT = Number(cfg.PORT || 5174);

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

function getUserConfiguredHost() {
  try {
    const rawUrl = process.env.BACKEND_URL || process.env.FRONTEND_URL;
    if (rawUrl) {
      const u = new URL(rawUrl);
      return u.hostname.replace(/[\[\]]/g, '');
    }
  } catch (e) {}
  return null;
}

function getSSLOptions() {
  const certDir = path.join(__dirname, "certs");
  if (!fs.existsSync(certDir)) fs.mkdirSync(certDir);

  let foundKey = null;
  let foundCert = null;
  let userFilesFound = false;

  try {
    const files = fs.readdirSync(certDir);
    for (const file of files) {
      if (file.startsWith("auto-server")) continue;
      const fullPath = path.join(certDir, file);
      if (fs.statSync(fullPath).isDirectory()) continue;
      try {
        const content = fs.readFileSync(fullPath, "utf8");
        if (content.includes("-----BEGIN PRIVATE KEY-----") || content.includes("-----BEGIN RSA PRIVATE KEY-----")) {
          foundKey = content;
          logger.info(`Loaded SSL Key from user file: ${file}`);
        }
        if (content.includes("-----BEGIN CERTIFICATE-----")) {
          foundCert = content;
          logger.info(`Loaded SSL Cert from user file: ${file}`);
        }
        if (content.trim().length > 0) userFilesFound = true;
      } catch (readErr) {}
    }
  } catch (e) {
    logger.error("Error scanning certs directory: " + e.message);
  }

  if (foundKey && foundCert) {
    logger.info("✅ Using User-Provided SSL Certificates.");
    return { key: foundKey, cert: foundCert };
  }
  
  if (userFilesFound && (!foundKey || !foundCert)) {
    logger.warn("⚠️ User file detected in 'certs' folder but could not find both KEY and CERT headers. Falling back to auto-generation.");
  }

  const autoKeyPath = path.join(certDir, "auto-server.key");
  const autoCertPath = path.join(certDir, "auto-server.pem");

  if (fs.existsSync(autoKeyPath) && fs.existsSync(autoCertPath)) {
    logger.info("Loading auto-generated SSL certificates from disk...");
    return { key: fs.readFileSync(autoKeyPath), cert: fs.readFileSync(autoCertPath) };
  }

  logger.info("Generating new self-signed SSL certificate...");
  const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }];
  const localIPs = getLocalIPs();
  localIPs.forEach(ip => altNames.push({ type: 7, ip: ip }));
  const userHost = getUserConfiguredHost();
  if (userHost && userHost !== 'localhost' && userHost !== '127.0.0.1') {
    if (net.isIP(userHost)) { altNames.push({ type: 7, ip: userHost }); } 
    else { altNames.push({ type: 2, value: userHost }); }
  }

  const attrs = [{ name: 'commonName', value: 'BigFix Patch Setu' }];
  const pems = selfsigned.generate(attrs, { days: 36500, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: altNames }] });

  fs.writeFileSync(autoKeyPath, pems.private);
  fs.writeFileSync(autoCertPath, pems.cert);
  logger.info("Auto-SSL generated and saved.");

  return { key: pems.private, cert: pems.cert };
}

async function startServer() {
  try {
    await runDatabaseSetup();
    const app = buildApp();
    const httpsOptions = getSSLOptions();
    
    https.createServer(httpsOptions, app).listen(PORT, "0.0.0.0", () => {
      logger.info(`HTTPS Server running on port ${PORT}`);
      const userHost = getUserConfiguredHost();
      if (userHost) logger.info(`Access via: https://${userHost}:${PORT}`);
    });

  } catch (err) {
    logger.error("Failed to start server: " + err.message);
    process.exit(1);
  }
}

startServer();