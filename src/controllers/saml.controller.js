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
        // 🚀 FIX FOR 500 ERROR: The library requires the certificate to be passed as 'idpCert'
        idpCert: cfg.SAML_CERT, 
        callbackUrl: `${cfg.BACKEND_URL}/api/auth/saml/callback`,
        wantAssertionsSigned: false,
        wantAuthnResponseSigned: false
    });
}

async function samlLogin(req, res) {
    try {
        const saml = getSamlStrategy();
        // Generate the URL securely and redirect to Okta
        const url = await saml.getAuthorizeUrlAsync();
        res.redirect(url);
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
        
        // Okta sends the full email (e.g., "vj@hcl.com")
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

        // 3. THE STRICT LOCK: If they aren't in the DB, reject them immediately!
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
        const sessionData = { 
            userId: userRecord.UserID, 
            username: userRecord.LoginName, 
            role: userRecord.Role, 
            dbRole: userRecord.Role 
        };
        
        res.cookie('auth_session', JSON.stringify(sessionData), getCookieOptions());
        
        // 5. Redirect them into the application
        // Since we didn't add the FRONTEND_URL to .env, this defaults to your backend port (5174), 
        // where your app.js will serve the static React build!
        // res.redirect(`${getCfg().FRONTEND_URL}/`);
        res.redirect(`https://localhost:5173/`);

    } catch (e) {
        console.error("SAML Callback Error:", e);
        res.status(500).send("SAML Authentication Failed. Check backend logs.");
    }
}

module.exports = { samlLogin, samlCallback };