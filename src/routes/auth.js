// src/routes/auth.js
const express = require('express');
const router  = express.Router();

const { sql, getPool } = require('../db/mssql');
const { hashPassword, verifyPassword } = require('../utils/password');

// --- NEW: In-memory cache for user AppState ---
// This is your "app data folder" for per-user state.
// We cache the AppState JSON here to avoid DB queries.
const appStateCache = new Map();
// ----------------------------------------------

router.use(express.json({ limit: '1mb' }));

/* ---------- SIGNUP (Ab User Management se use hoga) ---------- */
router.post('/api/auth/signup', async (req, res) => {
// ... (existing code, no changes) ...
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
// ... (existing code, no changes) ...
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

/* ---------- USER MANAGEMENT ROUTES ---------- */

// GET ALL USERS
router.get('/api/auth/users', async (req, res) => {
// ... (existing code, no changes) ...
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
// ... (existing code, no changes) ...
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
    
    // NEW: Clear user from cache on delete
    appStateCache.delete(Number(id));

    res.json({ ok: true, deleted: true });
  } catch (e) {
    console.error('[delete user error]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

/* ---------- APP STATE ROUTES (WITH CACHE) ---------- */

// GET a user's app state
router.get('/api/auth/state/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ ok: false, error: 'bad_request' });

    // --- NEW: CACHE-FIRST LOGIC ---
    // 1. Check cache first
    const cachedState = appStateCache.get(Number(userId));
    if (cachedState) {
      return res.json({ ok: true, state: cachedState, from: 'cache' });
    }
    // ------------------------------

    // 2. If not in cache, query database
    const pool = await getPool();
    const rs = await pool.request()
      .input('UserID', sql.Int, userId)
      .query('SELECT TOP 1 AppState FROM dbo.USERS WHERE UserID = @UserID');

    if (!rs.recordset.length) return res.status(404).json({ ok: false, error: 'user_not_found' });

    const stateRaw = rs.recordset[0].AppState;
    let state = null;
    if (stateRaw) {
      try { state = JSON.parse(stateRaw); } catch { /* ignore invalid json */ }
    }
    
    // 3. Save to cache for next time
    appStateCache.set(Number(userId), state);

    res.json({ ok: true, state, from: 'db' });
  } catch (e) {
    console.error('[get state error]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// POST (save) a user's app state
router.post('/api/auth/state/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const state = req.body || {}; // This is the full state object from the frontend
    if (!userId) return res.status(400).json({ ok: false, error: 'bad_request' });

    const stateJson = JSON.stringify(state);

    // 1. Update Database
    const pool = await getPool();
    await pool.request()
      .input('UserID', sql.Int, userId)
      .input('AppState', sql.NVarChar(sql.MAX), stateJson)
      .query('UPDATE dbo.USERS SET AppState = @AppState, UpdatedAt = SYSUTCDATETIME() WHERE UserID = @UserID');

    // 2. Update Cache
    appStateCache.set(Number(userId), state);

    res.json({ ok: true, saved: true });
  } catch (e) {
    console.error('[save state error]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});


module.exports = router;