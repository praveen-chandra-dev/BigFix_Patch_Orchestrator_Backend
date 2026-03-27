const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

let MASTER_KEY = null;
let lastKeyFingerprint = null;

function logKeyFingerprint(key) {
    const fingerprint = key.slice(0, 8).toString('hex');
    if (fingerprint !== lastKeyFingerprint) {
        console.log(`[Crypto] Using key fingerprint: ${fingerprint}`);
        lastKeyFingerprint = fingerprint;
    }
}

function getMasterKey() {
    if (MASTER_KEY) return MASTER_KEY;

    const rawSecret = process.env.ENCRYPTION_KEY;
    if (!rawSecret) {
        throw new Error('ENCRYPTION_KEY environment variable is not set. Please set it in .env or environment.');
    }

    MASTER_KEY = crypto.createHash('sha256').update(rawSecret).digest();
    logKeyFingerprint(MASTER_KEY);
    return MASTER_KEY;
}

function encrypt(text) {
    if (!text) return null;
    try {
        const iv = crypto.randomBytes(IV_LENGTH);
        const key = getMasterKey();
        const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
        let encrypted = cipher.update(text, 'utf8', 'base64');
        encrypted += cipher.final('base64');
        const tag = cipher.getAuthTag();
        const result = Buffer.from(`${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`).toString('base64');

        // Optional: verify encryption
        const testDecrypt = decrypt(result);
        if (testDecrypt !== text) {
            console.warn('[Crypto] Encryption/decryption verification failed!');
        }
        return result;
    } catch (e) {
        console.error('[Crypto] Encrypt failed:', e.message);
        return null;
    }
}

function decrypt(encText) {
    if (!encText) return null;
    try {
        const decoded = Buffer.from(encText, 'base64').toString('utf8');
        const parts = decoded.split(':');
        if (parts.length !== 3 || parts[0].length !== 32) {
            console.warn('[Crypto] Invalid encrypted format (expected 3 parts, IV 32 hex chars). Returning null.');
            return null;
        }
        const [ivHex, tagHex, encrypted] = parts;
        const iv = Buffer.from(ivHex, 'hex');
        const tag = Buffer.from(tagHex, 'hex');
        const key = getMasterKey();

        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(tag);
        let decrypted = decipher.update(encrypted, 'base64', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        console.error('[Crypto] Decrypt failed:', e.message);
        return null;
    }
}

module.exports = { encrypt, decrypt };