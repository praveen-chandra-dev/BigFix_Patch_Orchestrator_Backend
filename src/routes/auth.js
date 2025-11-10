// src/routes/auth.js
const express = require('express');
const router  = express.Router();

const { sql, getPool } = require('../db/mssql');
const { hashPassword, verifyPassword } = require('../utils/password');

router.use(express.json({ limit: '1mb' }));

/* ---------- SIGNUP (Ab User Management se use hoga) ---------- */
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
      OUTPUT inserted.UserID, inserted.LoginName, inserted.CreatedAt
      VALUES (@LoginName, @PasswordHash, @PasswordSalt, @HashAlgorithm, SYSUTCDATETIME(), SYSUTCDATETIME());
    `;
    const r = await pool.request()
      .input('LoginName',     sql.NVarChar(128), username)
      .input('PasswordHash',  sql.NVarChar(128), hp.hash)
      .input('PasswordSalt',  sql.NVarChar(128), hp.salt)
      .input('HashAlgorithm', sql.NVarChar(12),  'PBKDF2')
      .query(q);

    res.json({ ok:true, user: r.recordset[0] });
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

/* ---------- FIX: USER MANAGEMENT ROUTES ---------- */

// GET ALL USERS
router.get('/api/auth/users', async (req, res) => {
  try {
    const pool = await getPool();
    const rs = await pool.request()
      .query('SELECT UserID, LoginName, CreatedAt FROM dbo.USERS ORDER BY LoginName');
    
    res.json({ ok: true, users: rs.recordset });
  } catch (e) {
    console.error('[get users error]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// DELETE A USER
router.delete('/api/auth/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { currentUserId } = req.body; // Hum check karenge ki user khud ko delete na kare

    if (!id) return res.status(400).json({ ok: false, error: 'bad_request' });
    if (Number(id) === Number(currentUserId)) {
      return res.status(403).json({ ok: false, error: 'cannot_delete_self' });
    }

    const pool = await getPool();
    await pool.request()
      .input('UserID', sql.Int, id)
      .query('DELETE FROM dbo.USERS WHERE UserID = @UserID');
    
    res.json({ ok: true, deleted: true });
  } catch (e) {
    console.error('[delete user error]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});


module.exports = router;