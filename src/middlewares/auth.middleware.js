// src/middlewares/auth.middleware.js
//
// Backward-compatibility shim.
// All session logic lives in session.js (DB-backed sessions).
// Code across the codebase that imports from auth.middleware.js
// continues to work unchanged.

'use strict';

const {
    getCookieOptions,
    requireAdmin,
    requireAuth,
    getSessionUserLocal,
    getSessionData
} = require('./session');

module.exports = {
    getCookieOptions,
    getSessionData,
    getSessionUserLocal,
    requireAdmin,
    requireAuth
};
