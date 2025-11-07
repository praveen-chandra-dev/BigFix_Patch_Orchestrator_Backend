// central pool for MSSQL
const sql = require('mssql');

let pool;
async function getPool() {
  if (pool) return pool;
  const cfg = {
    user:     process.env.SQL_SERVER_AUTHENTICATION_USERNAME,
    password: process.env.SQL_SERVER_AUTHENTICATION_PASSWORD,
    server:   process.env.SQL_SERVER,
    port:     Number(process.env.SQL_PORT || 1433),
    database: process.env.DATABASENAME,
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
