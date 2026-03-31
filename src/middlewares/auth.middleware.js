// src/middlewares/auth.middleware.js
const { getCfg } = require('../env');

function getCookieOptions() {
    const timeoutMins = Number(getCfg().SESSION_TIMEOUT) || 15;
    return {
        maxAge: timeoutMins * 60 * 1000, // Converts minutes to milliseconds
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
    };
}

function getSessionData(req) {
    if (!req.cookies || !req.cookies.auth_session) return null;
    try { return JSON.parse(req.cookies.auth_session); } catch { return null; }
}

function getSessionUserLocal(req) {
    if (!req.cookies || !req.cookies.auth_session) return null;
    try { return JSON.parse(req.cookies.auth_session).username; } catch { return null; }
}

// Express Middleware for Admin checking
function requireAdmin(req, res, next) {
    const session = getSessionData(req);
    if (!session) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    
    // Check permanent dbRole first, fallback to role, making it case-insensitive
    const role = session.dbRole || session.role;
    if (role && role.toLowerCase() === 'admin') {
        next(); // User is admin, proceed to the actual route logic
    } else {
        return res.status(403).json({ ok: false, error: 'forbidden' });
    }
}

// Express Middleware for basic authentication checking
function requireAuth(req, res, next) {
    const username = getSessionUserLocal(req);
    if (!username) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    
    req.user = username; // Attach the username to the request object for easy access
    next();
}

module.exports = {
    getCookieOptions,
    getSessionData,
    getSessionUserLocal,
    requireAdmin,
    requireAuth
};