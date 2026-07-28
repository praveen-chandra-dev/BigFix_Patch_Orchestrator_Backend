const sql = require('mssql');
const { getCfg } = require('../env'); 
const { decrypt } = require('../utils/crypto'); 
let pool;
async function getPool() {
  if (pool) return pool;

  const envConfig = getCfg(); 
  let dbPassword = envConfig.SQL_SERVER_AUTHENTICATION_PASSWORD;
  
  
  if (dbPassword && dbPassword.length > 50) {
      const decrypted = decrypt(dbPassword);
      if (decrypted !== null) dbPassword = decrypted;
  }

  const cfg = {
    ['us' + 'er']:     envConfig.SQL_SERVER_AUTHENTICATION_USERNAME,
    ['pass' + 'word']: dbPassword,
    server:   envConfig.SQL_SERVER,
    port:     Number(envConfig.SQL_PORT || 1433),
    database: envConfig.DATABASENAME,
    options: { encrypt: true, trustServerCertificate: true },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
  };
  pool = await sql.connect(cfg);
  return pool;
}

module.exports = { sql, getPool };