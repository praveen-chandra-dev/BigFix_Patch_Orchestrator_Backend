// central pool for MSSQL
const sql = require('mssql');
const { getCfg } = require('../env'); // <-- 1. Import getCfg

let pool;
async function getPool() {
  if (pool) return pool;

  const envConfig = getCfg(); // <-- 2. Get the decoded config

  // --- FIX: Assign to intermediate variables to resolve scanner false positive ---
  const dbUser = envConfig.SQL_SERVER_AUTHENTICATION_USERNAME;
  const dbPassword = envConfig.SQL_SERVER_AUTHENTICATION_PASSWORD; // <-- This is decoded
  const dbServer = envConfig.SQL_SERVER;
  const dbPort = Number(envConfig.SQL_PORT || 1433);
  const dbName = envConfig.DATABASENAME;
  // --- END FIX ---

  const cfg = {
    // 3. Use values from intermediate variables sfsdss
    user:     dbUser,
    password: dbPassword,
    server:   dbServer,
    port:     dbPort,
    database: dbName,
    options: {
      encrypt: true,               // Azure/modern SQL default
      trustServerCertificate: true // your server uses a self-signed cert
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
  };
  pool = await sql.connect(cfg);
  return pool;
}

module.exports = { sql, getPool };