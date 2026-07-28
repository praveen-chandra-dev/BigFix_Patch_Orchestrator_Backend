// src/routes/auth.js
const express = require('express');
const router = express.Router();

// 1. Import Middlewares and Env config
const { requireAdmin } = require('../middlewares/auth.middleware');
const { getCfg } = require('../env'); // <--- THIS IS THE MISSING LINE THAT FIXES THE 500 ERROR

// 2. Import Standard Controllers
const authController = require('../controllers/auth.controller');
const setupController = require('../controllers/setup.controller');
const passwordController = require('../controllers/password.controller');
const credentialController = require('../controllers/credential.controller');
const teamController = require('../controllers/team.controller');

// 3. Import User Controllers
const userController = require('../controllers/user');
const myRolesController = require('../controllers/myRoles.controller');
const samlController = require('../controllers/saml.controller');

const { searchUserInAD } = require('../services/ldap');
const { logger } = require('../services/logger');

// Set payload limit
router.use(express.json({ limit: '1mb' }));

// ==========================================
// PUBLIC LOGIN CONFIGURATION (For SAML/SSO Frontend Check)
// ==========================================
router.get('/api/auth/login-config', (req, res) => {
    const config = getCfg();
    res.json({
        ok: true,
        samlEnabled: config.SAML_ENABLED,
        forceSso: config.FORCE_SSO
    });
});

// ==========================================
// CORE AUTHENTICATION & SETUP ROUTES
// ==========================================
router.post('/api/auth/login', authController.login);
router.post('/api/auth/logout', authController.logout);
router.get('/api/auth/status', authController.status);

router.get('/api/auth/roles', myRolesController.getMyRoles);

router.get('/api/auth/setup-required', setupController.setupRequired);
router.post('/api/auth/signup', setupController.signup);

router.get('/api/auth/saml/login', samlController.samlLogin);
router.post('/api/auth/saml/callback', require('express').urlencoded({ extended: true, limit: '10mb' }), samlController.samlCallback);
router.post('/api/auth/saml/verify', require('express').urlencoded({ extended: true, limit: '10mb' }), samlController.samlCredentialSubmit);

// ==========================================
// AD USER LOOKUP
// ==========================================
router.get('/api/auth/check-ad-user', requireAdmin, async (req, res) => {
    const username = (req.query.username || "").trim();
    if (!username) return res.status(400).json({ ok: false, error: 'bad_request', message: 'Username query parameter required.' });

    try {
        const result = await searchUserInAD(username);
        if (result.error === 'service_account_not_configured') {
            return res.json({ ok: true, found: false, isAd: false, reason: 'service_account_not_configured' });
        }
        return res.json({ ok: true, found: result.found, isAd: result.found });
    } catch (e) {
        logger.error(`[Auth] check-ad-user error for '${username}': ${e.message}`);
        return res.status(500).json({ ok: false, error: 'server_error', message: e.message });
    }
});

// ==========================================
// PASSWORD MANAGEMENT
// ==========================================
router.post('/api/auth/reset-password', requireAdmin, passwordController.resetPassword);
router.post('/api/auth/change-password', passwordController.changePassword);

// ==========================================
// PERSONAL BIGFIX CREDENTIAL
// ==========================================
router.get('/api/auth/my-bigfix-creds', credentialController.getMyBigFixCreds);
router.post('/api/auth/my-bigfix-creds', credentialController.updateMyBigFixCreds);

// ==========================================
// TEAM STATE (UI PREFERENCES)
// ==========================================
router.get('/api/auth/team-state', teamController.getTeamState);
router.post('/api/auth/team-state', teamController.updateTeamState);

// ==========================================
// ADMIN USER MANAGEMENT (PROTECTED)
// ==========================================
router.get('/api/auth/all-roles', requireAdmin, userController.getAllRoles);
router.get('/api/auth/users', requireAdmin, userController.getUsers);
router.post('/api/auth/admin/add-user', requireAdmin, userController.addUser);
router.delete('/api/auth/users/:id', requireAdmin, userController.deleteUser);
router.put('/api/auth/users/:id/role', requireAdmin, userController.updateUserRole);

module.exports = router;