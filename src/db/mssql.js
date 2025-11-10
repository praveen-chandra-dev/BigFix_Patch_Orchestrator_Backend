// central pool for MSSQL
const sql = require('mssql');
const { getCfg } = require('../env'); // <-- 1. Import getCfg

let pool;
async function getPool() {
  if (pool) return pool;

  const envConfig = getCfg(); // <-- 2. Get the decoded config

  const cfg = {
    // 3. Use values from envConfig
    user:     envConfig.SQL_SERVER_AUTHENTICATION_USERNAME,
    password: envConfig.SQL_SERVER_AUTHENTICATION_PASSWORD, // <-- Yeh ab decoded hai
    server:   envConfig.SQL_SERVER,
    port:     Number(envConfig.SQL_PORT || 1433),
    database: envConfig.DATABASENAME,
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