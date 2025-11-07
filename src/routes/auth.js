// src/routes/auth.js
const express = require('express');
const router  = express.Router();

const { sql, getPool } = require('../db/mssql');
const { hashPassword, verifyPassword } = require('../utils/password');

router.use(express.json({ limit: '1mb' }));

/* ---------- SIGNUP ---------- */
router.post('/api/auth/signup', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ ok:false, error:'bad_request' });

    const pool = await getPool();
    const exists = await pool.request()
      .input('LoginName', sql.NVarChar(128), username)
      .query('SELECT 1 FROM dbo.USERS WHERE LoginName=@LoginName');
    if (exists.recordset.length) return res.status(409).json({ ok:false, error:'user_exists' });

    const hp = hashPassword(password);
    const q = `
      INSERT INTO dbo.USERS (LoginName, PasswordHash, PasswordSalt, HashAlgorithm, CreatedAt, UpdatedAt)
      OUTPUT inserted.UserID
      VALUES (@LoginName, @PasswordHash, @PasswordSalt, @HashAlgorithm, SYSUTCDATETIME(), SYSUTCDATETIME());
    `;
    const r = await pool.request()
      .input('LoginName',     sql.NVarChar(128), username)
      .input('PasswordHash',  sql.NVarChar(128), hp.hash)
      .input('PasswordSalt',  sql.NVarChar(128), hp.salt)
      .input('HashAlgorithm', sql.NVarChar(12),  'PBKDF2')
      .query(q);

    res.json({ ok:true, userId: r.recordset[0]?.UserID });
  } catch (e) {
    console.error('[signup error]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

/* ---------- LOGIN ---------- */
router.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ ok:false, error:'bad_request' });

    const pool = await getPool();
    const rs = await pool.request()
      .input('LoginName', sql.NVarChar(128), username)
      .query('SELECT TOP 1 UserID, LoginName, PasswordHash, PasswordSalt FROM dbo.USERS WHERE LoginName=@LoginName');

    if (!rs.recordset.length) return res.status(401).json({ ok:false, error:'invalid' });
    const u = rs.recordset[0];
    const ok = verifyPassword(password, u.PasswordSalt, u.PasswordHash);
    if (!ok) return res.status(401).json({ ok:false, error:'invalid' });

    res.json({ ok:true, userId: u.UserID, username: u.LoginName });
  } catch (e) {
    console.error('[login error]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

/* ---------- FORGOT: set a NEW PERMANENT password (no email) ---------- */
router.post('/api/auth/forgot', async (req, res) => {
  try {
    const { username, newPassword } = req.body || {};
    if (!username || !newPassword) return res.status(400).json({ ok:false, error:'bad_request' });
    if (String(newPassword).length < 4) return res.status(400).json({ ok:false, error:'weak_password' });

    const pool = await getPool();
    const rs = await pool.request()
      .input('LoginName', sql.NVarChar(128), username)
      .query('SELECT TOP 1 UserID FROM dbo.USERS WHERE LoginName=@LoginName');
    if (!rs.recordset.length) return res.status(404).json({ ok:false, error:'not_found' });

    const hp = hashPassword(newPassword);
    await pool.request()
      .input('LoginName',     sql.NVarChar(128), username)
      .input('PasswordHash',  sql.NVarChar(128), hp.hash)
      .input('PasswordSalt',  sql.NVarChar(128), hp.salt)
      .input('HashAlgorithm', sql.NVarChar(12),  'PBKDF2')
      .query(`
        UPDATE dbo.USERS
        SET PasswordHash=@PasswordHash, PasswordSalt=@PasswordSalt, HashAlgorithm=@HashAlgorithm, UpdatedAt=SYSUTCDATETIME()
        WHERE LoginName=@LoginName
      `);

    res.json({ ok:true, changed:true });
  } catch (e) {
    console.error('[forgot error]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
