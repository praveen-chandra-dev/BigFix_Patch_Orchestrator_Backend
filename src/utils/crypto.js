// src/utils/crypto.js
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

const getMasterKey = () => {
    const key = process.env.ENCRYPTION_KEY;
    if (!key || key.length !== 32) {
        console.warn("WARNING: ENCRYPTION_KEY in .env must be exactly 32 chars! Using fallback.");
        return Buffer.alloc(32, key || "fallback_secret_key_needs_32_chr"); 
    }
    return Buffer.from(key, 'utf8');
};

function encrypt(text) {
    if (!text) return null;
    try {
        const iv = crypto.randomBytes(IV_LENGTH);
        const key = getMasterKey();
        const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
        let encrypted = cipher.update(text, 'utf8', 'base64');
        encrypted += cipher.final('base64');
        const tag = cipher.getAuthTag();
        return Buffer.from(`${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`).toString('base64');
    } catch (e) {
        console.error("[Crypto] Encrypt failed:", e.message);
        return null;
    }
}

function decrypt(encText) {
    if (!encText) return null;
    try {
        const decoded = Buffer.from(encText, 'base64').toString('utf8');
        const [ivHex, tagHex, encrypted] = decoded.split(':');
        if (!ivHex || !tagHex || !encrypted) return null;
        
        const iv = Buffer.from(ivHex, 'hex');
        const tag = Buffer.from(tagHex, 'hex');
        const key = getMasterKey();
        
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(tag);
        let decrypted = decipher.update(encrypted, 'base64', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        console.error("[Crypto] Decrypt failed:", e.message);
        return null;
    }
}

module.exports = { encrypt, decrypt };