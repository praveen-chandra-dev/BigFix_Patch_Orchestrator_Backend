// // main.js
// console.log("Booting up BigFix Patch Setu...");

// const fs = require("fs");
// const https = require("https");
// const path = require("path");
// const os = require("os");
// const net = require("net");
// const selfsigned = require("selfsigned");
// const { buildApp } = require("./src/app");
// const { logger } = require("./src/services/logger");
// const { runDatabaseSetup } = require("./src/db/setup"); 
// const { getCfg, loadDbConfig } = require("./src/env"); 

// const cfg = getCfg();
// const PORT = Number(cfg.PORT || 5174);

// function getLocalIPs() {
//   const interfaces = os.networkInterfaces();
//   const ips = [];
//   for (const name of Object.keys(interfaces)) {
//     for (const iface of interfaces[name]) {
//       if (iface.family === "IPv4" && !iface.internal) ips.push(iface.address);
//     }
//   }
//   return ips;
// }

// function getUserConfiguredHost() {
//   try {
//     const rawUrl = process.env.BACKEND_URL || process.env.FRONTEND_URL;
//     if (rawUrl) return new URL(rawUrl).hostname.replace(/[\[\]]/g, '');
//   } catch (e) {}
//   return null;
// }

// async function getSSLOptions() {
//   const certsDir = path.join(process.cwd(), 'certs');
//   const customKeyPath = path.join(certsDir, 'server.key');
//   const customCertPath = path.join(certsDir, 'server.cert');
//   const autoKeyPath = path.join(certsDir, 'auto-server.key');
//   const autoCertPath = path.join(certsDir, 'auto-server.cert');

//   if (fs.existsSync(customKeyPath) && fs.existsSync(customCertPath)) {
//     return { key: fs.readFileSync(customKeyPath), cert: fs.readFileSync(customCertPath) };
//   }
//   if (fs.existsSync(autoKeyPath) && fs.existsSync(autoCertPath)) {
//     try { return { key: fs.readFileSync(autoKeyPath), cert: fs.readFileSync(autoCertPath) }; } catch(e){}
//   }

//   if (!fs.existsSync(certsDir)) fs.mkdirSync(certsDir, { recursive: true });

//   const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }];
//   getLocalIPs().forEach(ip => altNames.push({ type: 7, ip: ip }));
//   const userHost = getUserConfiguredHost();
//   if (userHost && userHost !== 'localhost' && userHost !== '127.0.0.1') {
//     if (net.isIP(userHost)) { altNames.push({ type: 7, ip: userHost }); } else { altNames.push({ type: 2, value: userHost }); }
//   }

//   const pems = await selfsigned.generate([{ name: 'commonName', value: 'BigFix Patch Setu' }], { days: 3650, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: altNames }] });
//   fs.writeFileSync(autoKeyPath, pems.private);
//   fs.writeFileSync(autoCertPath, pems.cert);
//   return { key: pems.private, cert: pems.cert };
// }

// async function startServer() {
//   try {
//     await runDatabaseSetup();
//     await loadDbConfig(); 
//     const app = buildApp();
//     const httpsOptions = await getSSLOptions();
//     const server = https.createServer(httpsOptions, app);
//     server.listen(PORT, "0.0.0.0", () => {
//       logger.info(`Secure Server listening on port ${PORT}`);
//     });
//   } catch (err) {
//     logger.error(`Failed to start server: ${err.message}`);
//     process.exit(1);
//   }
// }

// startServer();

// main.js
console.log("Booting up BigFix Patch Setu...");

const fs = require("fs");
const https = require("https");
const path = require("path");
const os = require("os");
const net = require("net");
const selfsigned = require("selfsigned");
const { buildApp } = require("./src/app");
const { logger } = require("./src/services/logger");
const { runDatabaseSetup } = require("./src/db/setup"); 
const { getCfg, loadDbConfig } = require("./src/env"); 

const cfg = getCfg();
const PORT = Number(cfg.PORT || 5174);

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

function getUserConfiguredHost() {
  try {
    const rawUrl = process.env.BACKEND_URL || process.env.FRONTEND_URL;
    if (rawUrl) return new URL(rawUrl).hostname.replace(/[\[\]]/g, '');
  } catch (e) {}
  return null;
}

async function getSSLOptions() {
  const certsDir = path.join(process.cwd(), 'certs');
  const customKeyPath = path.join(certsDir, 'server.key');
  const customCertPath = path.join(certsDir, 'server.cert');
  const autoKeyPath = path.join(certsDir, 'auto-server.key');
  const autoCertPath = path.join(certsDir, 'auto-server.cert');

  let key, cert;

  if (fs.existsSync(customKeyPath) && fs.existsSync(customCertPath)) {
    key = fs.readFileSync(customKeyPath);
    cert = fs.readFileSync(customCertPath);
  } else if (fs.existsSync(autoKeyPath) && fs.existsSync(autoCertPath)) {
    try { 
        key = fs.readFileSync(autoKeyPath);
        cert = fs.readFileSync(autoCertPath);
    } catch(e){}
  }

  if (!key || !cert) {
      if (!fs.existsSync(certsDir)) fs.mkdirSync(certsDir, { recursive: true });

      const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }];
      getLocalIPs().forEach(ip => altNames.push({ type: 7, ip: ip }));
      const userHost = getUserConfiguredHost();
      if (userHost && userHost !== 'localhost' && userHost !== '127.0.0.1') {
        if (net.isIP(userHost)) { altNames.push({ type: 7, ip: userHost }); } else { altNames.push({ type: 2, value: userHost }); }
      }

      const pems = await selfsigned.generate([{ name: 'commonName', value: 'BigFix Patch Setu' }], { days: 3650, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: altNames }] });
      fs.writeFileSync(autoKeyPath, pems.private);
      fs.writeFileSync(autoCertPath, pems.cert);
      key = pems.private;
      cert = pems.cert;
  }

  return {
    key,
    cert,
    minVersion: 'TLSv1.2', // Drops TLS 1.0/1.1 (fixes obsolete protocol warnings)
    honorCipherOrder: true,
    ciphers: [
        // Strictly PFS (Perfect Forward Secrecy) ciphers.
        // This entirely eliminates SHA-1, CBC, and ROBOT-vulnerable RSA key exchanges!
        'TLS_AES_256_GCM_SHA384',
        'TLS_CHACHA20_POLY1305_SHA256',
        'TLS_AES_128_GCM_SHA256',
        'ECDHE-RSA-AES256-GCM-SHA384',
        'ECDHE-RSA-AES128-GCM-SHA256'
    ].join(':')
  };
}

async function startServer() {
  try {
    await runDatabaseSetup();
    await loadDbConfig(); 
    const app = buildApp();
    const httpsOptions = await getSSLOptions();
    const server = https.createServer(httpsOptions, app);
    server.listen(PORT, "0.0.0.0", () => {
      logger.info(`Secure Server listening on port ${PORT}`);
    });
  } catch (err) {
    logger.error(`Failed to start server: ${err.message}`);
    process.exit(1);
  }
}

startServer();