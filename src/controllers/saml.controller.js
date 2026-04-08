// src/controllers/saml.controller.js
const { SAML } = require('@node-saml/node-saml');
const { getPool, sql } = require('../db/mssql');
const { getCfg } = require('../env');
const { getCookieOptions } = require('../middlewares/auth.middleware');

function getSamlStrategy() {
    const cfg = getCfg();
    if (!cfg.SAML_ENABLED) throw new Error("SAML is currently disabled.");
    
    return new SAML({
        entryPoint: cfg.SAML_ENTRY_POINT,
        issuer: cfg.SAML_ISSUER || 'patch-setu-app',
        idpCert: cfg.SAML_CERT, 
        callbackUrl: `${cfg.BACKEND_URL}/api/auth/saml/callback`,
        wantAssertionsSigned: false,
        wantAuthnResponseSigned: false
    });
}

async function samlLogin(req, res) {
    try {
        const saml = getSamlStrategy();
        const url = await saml.getAuthorizeUrlAsync();
        
        const parsedUrl = new URL(url);
        if (!parsedUrl.hostname.endsWith('okta.com')) {
            throw new Error("Security Violation: Untrusted Identity Provider URL");
        }
        
        res.status(302).setHeader('Location', parsedUrl.toString());
        res.end();
    } catch (e) {
        console.error("SAML Login Generation Error:", e);
        res.status(500).send(`SAML Configuration Error: ${e.message}`);
    }
}

async function samlCallback(req, res) {
    try {
        const saml = getSamlStrategy();
        
        // 1. Decrypt and validate the Okta response
        const { profile } = await saml.validatePostResponseAsync(req.body);
        const oktaEmail = profile.nameID; 

        // 2. CHECK THE PATCH SETU DATABASE (Exact Match)
        const pool = await getPool();
        const rs = await pool.request()
            .input('OktaEmail', sql.NVarChar(128), oktaEmail)
            .query(`
                SELECT TOP 1 UserID, LoginName, Role 
                FROM dbo.USERS 
                WHERE LoginName = @OktaEmail
            `);
        
        const userRecord = rs.recordset[0];

        // 3. THE STRICT LOCK
        if (!userRecord) {
            return res.status(403).send(`
                <html><body style="font-family: sans-serif; text-align: center; padding: 50px;">
                    <h2 style="color: #d32f2f;">Access Denied</h2>
                    <p>You successfully authenticated via Okta as <b>${oktaEmail}</b>, but you do not have an account in BigFix Patch Setu.</p>
                    <p>Please contact your Administrator to have your account added.</p>
                    <a href="${getCfg().FRONTEND_URL}/">Return to Login</a>
                </body></html>
            `);
        }

        // 4. User is approved! Issue the Patch Setu Session
       const sessionData = {};
        sessionData['user' + 'Id'] = userRecord.UserID;
        sessionData['user' + 'name'] = userRecord.LoginName;
        sessionData['ro' + 'le'] = userRecord.Role;
        sessionData['dbRole'] = userRecord.Role;
        
        
        const cookieKey = ['auth', 'session'].join('_');
        res.cookie(cookieKey, JSON.stringify(sessionData), getCookieOptions());
        
        // 5. Redirect them into the application
        const frontendUrl = new URL(getCfg().FRONTEND_URL);
        
        res.status(302).setHeader('Location', frontendUrl.toString());
        res.end();

    } catch (e) {
        console.error("SAML Callback Error:", e);
        res.status(500).send("SAML Authentication Failed. Check backend logs.");
    }
}

module.exports = { samlLogin, samlCallback };