const crypto = require('crypto');

const ALGO = 'PBKDF2-SHA256';
const ITER = 150000;         // solid default //Newss
const LEN  = 32;

function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(plain, salt, ITER, LEN, 'sha256');
  return {
    algo: ALGO,
    salt: salt.toString('hex'),
    hash: hash.toString('hex')
  };
}

function verifyPassword(plain, saltHex, hashHex) {
  const salt = Buffer.from(saltHex, 'hex');
  const hash = crypto.pbkdf2Sync(plain, salt, ITER, LEN, 'sha256').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(hashHex, 'hex'));
}

module.exports = { hashPassword, verifyPassword };
