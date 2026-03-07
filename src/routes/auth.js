// bigfix-backend/src/routes/auth.js
const express = require('express');
const router  = express.Router();

const { sql, getPool } = require('../db/mssql');
const { hashPassword, verifyPassword } = require('../utils/password');
const { authenticateLDAP } = require('../services/ldap'); 

const HASH_ALGORITHM = 'PBKDF2';

router.use(express.json({ limit: '1mb' }));

// --- HELPER: Map UserID to SystemState Keys ---
function getSystemStateKey(userId) {
  const uid = Number(userId);
  if (uid === 9002) return 'Windows';
  if (uid === 9003) return 'Linux';
  if (uid === 9004) return 'EUC'; // Mapped EUC
  return null; 
}

// --- HELPER: Ensure System Users Exist & Are Valid (Self-Healing) ---
async function ensureSystemUser(id, role, name) {
    try {
        const pool = await getPool();
        // Using MERGE to handle both Creation and Fixing existing bad rows
        await pool.request()
            .input('ID', sql.Int, id)
            .input('Name', sql.NVarChar(128), name)
            .input('Role', sql.NVarChar(20), role)
            .query(`
                MERGE INTO dbo.USERS AS Target
                USING (VALUES (@ID, @Name, @Role)) AS Source (UserID, LoginName, Role)
                ON Target.UserID = Source.UserID
                WHEN MATCHED THEN
                    UPDATE SET 
                        LoginName = Source.LoginName,
                        Role = Source.Role,
                        PasswordHash = 'SYSTEM_USER',
                        PasswordSalt = 'SYSTEM_SALT',
                        HashAlgorithm = 'PBKDF2',
                        UpdatedAt = SYSUTCDATETIME()
                WHEN NOT MATCHED THEN
                    INSERT (UserID, LoginName, Role, PasswordHash, PasswordSalt, HashAlgorithm, CreatedAt, UpdatedAt) 
                    VALUES (Source.UserID, Source.LoginName, Source.Role, 'SYSTEM_USER', 'SYSTEM_SALT', 'PBKDF2', SYSUTCDATETIME(), SYSUTCDATETIME());
            `);
    } catch (e) {
        console.warn(`[Auth] Failed to ensure system user ${id}:`, e.message);
    }
}

// --- HELPER: Check Admin Session ---
function isAdmin(req) {
  if (!req.cookies.auth_session) return false;
  try {
    const session = JSON.parse(req.cookies.auth_session);
    return session.role === 'Admin';
  } catch {
    return false;
  }
}

// --- 1. SETUP CHECK ---
router.get('/api/auth/setup-required', async (req, res) => {
  try {
    const pool = await getPool();
    const rs = await pool.request().query("SELECT COUNT(*) as Count FROM dbo.USERS WHERE Role = 'Admin'");
    res.json({ ok: true, requiresSetup: rs.recordset[0].Count === 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// --- 2. LOCAL SIGNUP (For Initial Admin or Local Users) ---
router.post('/api/auth/signup', async (req, res) => {
  try {
    const { username, password, role } = req.body || {};
    if (!username || !password) return res.status(400).json({ ok:false, error:'bad_request' });

    const pool = await getPool();
    const adminCheck = await pool.request().query("SELECT COUNT(*) as Count FROM dbo.USERS WHERE Role = 'Admin'");
    
    let finalRole = 'Windows';
    // First user becomes Admin automatically
    if (adminCheck.recordset[0].Count === 0) {
      finalRole = 'Admin';
    } else {
      // Subsequent signups require Admin privileges
      if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
      finalRole = ['Admin', 'Windows', 'Linux', 'EUC'].includes(role) ? role : 'Windows';
    }
    
    const exists = await pool.request().input('LoginName', sql.NVarChar(128), username).query('SELECT 1 FROM dbo.USERS WHERE LoginName=@LoginName');
    if (exists.recordset.length) return res.status(409).json({ ok:false, error:'user_exists' });

    // Generate ID
    const gapRes = await pool.request().query(`SELECT MIN(t1.UserID + 1) AS NextID FROM dbo.USERS t1 LEFT JOIN dbo.USERS t2 ON t1.UserID + 1 = t2.UserID WHERE t2.UserID IS NULL AND t1.UserID < 9000`);
    let nextId = gapRes.recordset[0].NextID;
    if (!nextId) {
        const maxRes = await pool.request().query('SELECT MAX(UserID) as MaxID FROM dbo.USERS WHERE UserID < 9000');
        nextId = (maxRes.recordset[0].MaxID || 0) + 1;
    }

    const hp = hashPassword(password);
    await pool.request()
      .input('UserID', sql.Int, nextId)
      .input('LoginName', sql.NVarChar(128), username)
      .input('PasswordHash', sql.NVarChar(128), hp.hash)
      .input('PasswordSalt', sql.NVarChar(128), hp.salt)
      .input('HashAlgorithm', sql.NVarChar(12), HASH_ALGORITHM)
      .input('Role', sql.NVarChar(20), finalRole)
      .query(`INSERT INTO dbo.USERS (UserID, LoginName, PasswordHash, PasswordSalt, HashAlgorithm, Role, CreatedAt, UpdatedAt) VALUES (@UserID, @LoginName, @PasswordHash, @PasswordSalt, @HashAlgorithm, @Role, SYSUTCDATETIME(), SYSUTCDATETIME())`);

    res.json({ ok:true, userId: nextId, username, role: finalRole });
  } catch (e) {
    res.status(500).json({ ok:false, error:'server_error', message: e.message });
  }
});

// --- 3. LOGIN (Strict: Must Exist in DB) ---
router.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ ok:false, error:'bad_request' });

    const pool = await getPool();

    // A. LDAP Check
    const isLdapOk = await authenticateLDAP(username, password);
    
    // B. DB Check (Get User Record)
    const rs = await pool.request().input('LoginName', sql.NVarChar(128), username).query('SELECT TOP 1 UserID, LoginName, PasswordHash, PasswordSalt, Role FROM dbo.USERS WHERE LoginName=@LoginName');
    let userRecord = rs.recordset[0];
    let authenticated = false;

    if (isLdapOk) {
        if (userRecord) {
            authenticated = true;
        } else {
            // FIX: If LDAP is valid but user NOT in DB, deny access.
            // Admin must add the user first.
            return res.status(403).json({ 
                ok: false, 
                error: 'access_denied', 
                message: 'Account not authorized. Please contact an Administrator to add your account.' 
            });
        }
    } else {
        // Fallback to local password check (for local admins/users)
        if (userRecord) {
             if (verifyPassword(password, userRecord.PasswordSalt, userRecord.PasswordHash)) authenticated = true;
        }
    }

    if (!authenticated) return res.status(401).json({ ok:false, error:'invalid', message: 'Invalid username or password.' });

    const role = userRecord.Role || 'Windows';
    
    // HEAL SYSTEM USERS ON LOGIN (Ensures consistency)
    if (role === 'Windows' || role === 'Admin') await ensureSystemUser(9002, 'Windows', 'System_Windows');
    if (role === 'Linux' || role === 'Admin') await ensureSystemUser(9003, 'Linux', 'System_Linux');
    if (role === 'EUC' || role === 'Admin') await ensureSystemUser(9004, 'EUC', 'System_EUC');

    const sessionData = { userId: userRecord.UserID, username: userRecord.LoginName, role };
    
    res.cookie('auth_session', JSON.stringify(sessionData), { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
    res.json({ ok:true, userId: userRecord.UserID, username: userRecord.LoginName, role });
  } catch (e) {
    res.status(500).json({ ok:false, error:'server_error', message: e.message });
  }
});

// --- 4. ADMIN: ADD LDAP USER (New Route) ---
router.post('/api/auth/admin/add-user', async (req, res) => {
    try {
        // 1. Verify Admin
        if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'forbidden' });

        const { username, role } = req.body;
        if (!username || !role) return res.status(400).json({ ok: false, error: 'bad_request', message: 'Username and Role required' });
        
        if (!['Admin', 'Windows', 'Linux', 'EUC'].includes(role)) {
            return res.status(400).json({ ok: false, error: 'invalid_role' });
        }

        const pool = await getPool();

        // 2. Check Exists
        const exists = await pool.request().input('LoginName', sql.NVarChar(128), username).query('SELECT 1 FROM dbo.USERS WHERE LoginName=@LoginName');
        if (exists.recordset.length) return res.status(409).json({ ok:false, error:'user_exists', message: 'User already exists' });

        // 3. Generate ID
        const gapRes = await pool.request().query(`SELECT MIN(t1.UserID + 1) AS NextID FROM dbo.USERS t1 LEFT JOIN dbo.USERS t2 ON t1.UserID + 1 = t2.UserID WHERE t2.UserID IS NULL AND t1.UserID < 9000`);
        let nextId = gapRes.recordset[0].NextID;
        if (!nextId) {
             const maxRes = await pool.request().query('SELECT MAX(UserID) as MaxID FROM dbo.USERS WHERE UserID < 9000');
             nextId = (maxRes.recordset[0].MaxID || 0) + 1;
        }

        // 4. Insert User (Mark as LDAP managed via dummy hash)
        await pool.request()
            .input('UserID', sql.Int, nextId)
            .input('LoginName', sql.NVarChar(128), username)
            .input('Role', sql.NVarChar(20), role)
            .query(`
                INSERT INTO dbo.USERS 
                (UserID, LoginName, Role, PasswordHash, PasswordSalt, HashAlgorithm, CreatedAt, UpdatedAt) 
                VALUES 
                (@UserID, @LoginName, @Role, 'LDAP_AUTH', 'LDAP_AUTH', 'NONE', SYSUTCDATETIME(), SYSUTCDATETIME())
            `);

        res.json({ ok: true, message: `User ${username} added successfully with role ${role}.` });

    } catch (e) {
        res.status(500).json({ ok: false, error: 'server_error', message: e.message });
    }
});

router.post('/api/auth/logout', (req, res) => {
  res.clearCookie('auth_session', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
  res.json({ ok: true, message: 'Logged out' });
});

router.get('/api/auth/status', (req, res) => {
  if (req.cookies?.auth_session) {
    try {
      const sessionData = JSON.parse(req.cookies.auth_session);
      if (sessionData.userId && sessionData.username) return res.json({ ok: true, authed: true, userData: sessionData });
    } catch (e) { return res.json({ ok: false, authed: false }); }
  }
  return res.json({ ok: false, authed: false });
});

// --- UPDATED GET STATE ---
router.get('/api/auth/state/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const pool = await getPool();
    const systemKey = getSystemStateKey(userId);
    let rawState = null;

    if (systemKey) {
      const rs = await pool.request()
        .input('Key', sql.NVarChar(50), systemKey)
        .query("SELECT StateValue FROM dbo.SystemState WHERE StateKey = @Key");
      
      if (rs.recordset.length > 0) {
        rawState = rs.recordset[0].StateValue;
        if (!rawState) rawState = "{}";
      } else {
        await pool.request()
          .input('Key', sql.NVarChar(50), systemKey)
          .query("INSERT INTO dbo.SystemState (StateKey, StateValue) VALUES (@Key, '{}')");
        rawState = "{}";
      }
    } else {
      const rs = await pool.request()
        .input('UID', sql.Int, userId)
        .query("SELECT AppState FROM dbo.USERS WHERE UserID = @UID");
      if (rs.recordset.length > 0) rawState = rs.recordset[0].AppState;
    }

    const state = rawState ? JSON.parse(rawState) : {};
    res.json({ ok: true, state, from: 'db' });

  } catch (e) {
    console.error("Fetch State Error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- UPDATED POST STATE ---
router.post('/api/auth/state/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const stateStr = JSON.stringify(req.body);
    const pool = await getPool();
    const systemKey = getSystemStateKey(userId);

    if (systemKey) {
      const updateRes = await pool.request()
        .input('Val', sql.NVarChar(sql.MAX), stateStr)
        .input('Key', sql.NVarChar(50), systemKey)
        .query("UPDATE dbo.SystemState SET StateValue = @Val WHERE StateKey = @Key");
      
      if (updateRes.rowsAffected[0] === 0) {
         await pool.request()
          .input('Val', sql.NVarChar(sql.MAX), stateStr)
          .input('Key', sql.NVarChar(50), systemKey)
          .query("INSERT INTO dbo.SystemState (StateKey, StateValue) VALUES (@Key, @Val)");
      }
    } else {
      await pool.request()
        .input('Val', sql.NVarChar(sql.MAX), stateStr)
        .input('UID', sql.Int, userId)
        .query("UPDATE dbo.USERS SET AppState = @Val, UpdatedAt = SYSUTCDATETIME() WHERE UserID = @UID");
    }

    res.json({ ok: true, saved: true });
  } catch (e) {
    console.error("Save State Error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/api/auth/users', async (req, res) => {
  try {
    const pool = await getPool();
    const rs = await pool.request().query('SELECT UserID, LoginName, Role, CreatedAt FROM dbo.USERS ORDER BY LoginName');
    res.json({ ok: true, users: rs.recordset });
  } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
});

router.put('/api/auth/users/:id/role', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'forbidden' });

    const { id } = req.params;
    const { role } = req.body;
    
    if ([9002, 9003, 9004].includes(Number(id))) return res.status(403).json({ ok: false, error: 'forbidden' });
    
    if (!['Admin', 'Windows', 'Linux', 'EUC'].includes(role)) {
      return res.status(400).json({ ok: false, error: 'invalid_role' });
    }

    const pool = await getPool();
    await pool.request()
      .input('Role', sql.NVarChar(20), role)
      .input('UserID', sql.Int, id)
      .query('UPDATE dbo.USERS SET Role = @Role, UpdatedAt = SYSUTCDATETIME() WHERE UserID = @UserID');

    res.json({ ok: true, updated: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete('/api/auth/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { currentUserId } = req.body;
    
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'forbidden' });

    if ([9002, 9003, 9004].includes(Number(id))) return res.status(403).json({ ok: false, error: 'forbidden' });
    if (Number(id) === Number(currentUserId)) return res.status(403).json({ ok: false, error: 'cannot_delete_self' });
    
    const pool = await getPool();
    await pool.request().input('UserID', sql.Int, id).query('DELETE FROM dbo.USERS WHERE UserID = @UserID');
    res.json({ ok: true, deleted: true });
  } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
});

module.exports = router;