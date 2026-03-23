// src/utils/crypto.js
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

let MASTER_KEY = null;

const getMasterKey = () => {
    if (MASTER_KEY) return MASTER_KEY;

    // By this point, env.js has guaranteed that process.env.ENCRYPTION_KEY exists
    const rawSecret = process.env.ENCRYPTION_KEY || "fallback_secret_key_needs_32_chr_patch_setu";
    
    // Hash it perfectly to 32 bytes and lock it in memory
    MASTER_KEY = crypto.createHash('sha256').update(rawSecret).digest();
    return MASTER_KEY;
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