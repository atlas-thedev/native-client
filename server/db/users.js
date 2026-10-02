const crypto = require('crypto');

function generateOfflinePlayerUuid(username) {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${username}`).digest();
  md5[6] = (md5[6] & 0x0f) | 0x30; // version 3
  md5[8] = (md5[8] & 0x3f) | 0x80; // variant 2
  const hex = md5.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Non-blocking variant for request handlers: scrypt must not stall the event loop. */
async function verifyPasswordAsync(password, hash, salt) {
  try {
    const check = await scryptAsync(String(password), String(salt));
    const expected = Buffer.from(String(hash), 'hex');
    return expected.length === check.length && crypto.timingSafeEqual(check, expected);
  } catch {
    return false;
  }
}

/** Comma-separated, verified email addresses that are granted admin access. */
function adminEmails() {
  return String(process.env.NOCTRA_ADMIN_EMAILS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function verifyPassword(password, hash, salt) {
  try {
    const check = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}

const MAX_CODE_ATTEMPTS = 5;
const CODE_RESEND_COOLDOWN_MS = 60 * 1000;

function saveVerificationCode(db, email, code) {
  const now = Date.now();
  const expiresAt = now + 10 * 60 * 1000; // 10 minutes
  const stmt = db.prepare(`
    INSERT INTO verification_codes (email, code, created_at, expires_at, attempts)
    VALUES (?, ?, ?, ?, 0)
    ON CONFLICT(email) DO UPDATE SET
      code = excluded.code,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at,
      attempts = 0
  `);
  stmt.run(email.toLowerCase().trim(), String(code).trim(), now, expiresAt);
  return { code, expiresAt };
}

function getVerificationCode(db, email) {
  return db.prepare('SELECT * FROM verification_codes WHERE email = ?').get(String(email || '').toLowerCase().trim()) || null;
}

/** Milliseconds until another code may be sent to this address (0 = now). */
function verificationCooldown(db, email, now = Date.now()) {
  const row = getVerificationCode(db, email);
  if (!row) return 0;
  return Math.max(0, Number(row.created_at || 0) + CODE_RESEND_COOLDOWN_MS - now);
}

/**
 * Codes are 6 digits, so each one gets a small number of guesses: after
 * MAX_CODE_ATTEMPTS wrong answers it is burned and a new one must be sent.
 */
function checkVerificationCode(db, email, code) {
  const key = String(email || '').toLowerCase().trim();
  const row = getVerificationCode(db, key);
  if (!row || Number(row.expires_at) <= Date.now()) return false;
  if (Number(row.attempts || 0) >= MAX_CODE_ATTEMPTS) {
    clearVerificationCode(db, key);
    return false;
  }
  const supplied = Buffer.from(String(code || '').trim().padEnd(6, ' ').slice(0, 16));
  const expected = Buffer.from(String(row.code).trim().padEnd(6, ' ').slice(0, 16));
  const ok = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  if (!ok) {
    const attempts = Number(row.attempts || 0) + 1;
    if (attempts >= MAX_CODE_ATTEMPTS) clearVerificationCode(db, key);
    else db.prepare('UPDATE verification_codes SET attempts = ? WHERE email = ?').run(attempts, key);
  }
  return ok;
}

// ── Password reset ──────────────────────────────────────────────────────
// Separate from sign-up codes so a reset can never be confused with (or
// block) a registration in progress. Only a salted hash of the code is kept.
const RESET_CODE_TTL_MS = 15 * 60 * 1000;
const RESET_RESEND_COOLDOWN_MS = 60 * 1000;

function hashResetCode(code, salt) {
  return crypto.createHash('sha256').update(`${salt}:${String(code).trim()}`).digest('hex');
}

function savePasswordReset(db, email, code) {
  const key = String(email || '').toLowerCase().trim();
  const now = Date.now();
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare(`
    INSERT INTO password_resets (email, code_hash, salt, created_at, expires_at, attempts)
    VALUES (?, ?, ?, ?, ?, 0)
    ON CONFLICT(email) DO UPDATE SET
      code_hash = excluded.code_hash,
      salt = excluded.salt,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at,
      attempts = 0
  `).run(key, hashResetCode(code, salt), salt, now, now + RESET_CODE_TTL_MS);
  return { expiresAt: now + RESET_CODE_TTL_MS };
}

function getPasswordReset(db, email) {
  return db.prepare('SELECT * FROM password_resets WHERE email = ?').get(String(email || '').toLowerCase().trim()) || null;
}

/** Milliseconds until another reset code may be sent to this address (0 = now). */
function passwordResetCooldown(db, email, now = Date.now()) {
  const row = getPasswordReset(db, email);
  if (!row) return 0;
  return Math.max(0, Number(row.created_at || 0) + RESET_RESEND_COOLDOWN_MS - now);
}

/** Same guess budget as sign-up codes: MAX_CODE_ATTEMPTS wrong answers burn the code. */
function checkPasswordResetCode(db, email, code) {
  const key = String(email || '').toLowerCase().trim();
  const row = getPasswordReset(db, key);
  if (!row || Number(row.expires_at) <= Date.now()) return false;
  if (Number(row.attempts || 0) >= MAX_CODE_ATTEMPTS) {
    clearPasswordReset(db, key);
    return false;
  }
  const supplied = Buffer.from(hashResetCode(code, row.salt), 'hex');
  const expected = Buffer.from(String(row.code_hash), 'hex');
  const ok = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  if (!ok) {
    const attempts = Number(row.attempts || 0) + 1;
    if (attempts >= MAX_CODE_ATTEMPTS) clearPasswordReset(db, key);
    else db.prepare('UPDATE password_resets SET attempts = ? WHERE email = ?').run(attempts, key);
  }
  return ok;
}

function clearPasswordReset(db, email) {
  db.prepare('DELETE FROM password_resets WHERE email = ?').run(String(email || '').toLowerCase().trim());
}

/**
 * Sets a new password and signs the account out everywhere: whoever knew the
 * old password (or held a stolen session) must not stay signed in.
 */
function setUserPassword(db, userId, password) {
  const { hash, salt } = hashPassword(String(password));
  db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(hash, salt, userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return { ok: true };
}

function clearVerificationCode(db, email) {
  db.prepare(`DELETE FROM verification_codes WHERE email = ?`).run(email.toLowerCase().trim());
}

function getUserByEmail(db, email) {
  return db.prepare(`SELECT * FROM users WHERE lower(email) = lower(?)`).get(email.trim()) || null;
}

function getUserByUsername(db, username) {
  return db.prepare(`SELECT * FROM users WHERE lower(username) = lower(?)`).get(username.trim()) || null;
}

function getUserById(db, id) {
  if (!id) return null;
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(String(id)) || null;
}

function getUserByLogin(db, login) {
  const val = login.trim();
  return db.prepare(`
    SELECT * FROM users 
    WHERE lower(email) = lower(?) OR lower(username) = lower(?)
  `).get(val, val) || null;
}

function createUser(db, { email, username, password, model = 'classic' }) {
  const id = `user-${crypto.randomBytes(6).toString('hex')}`;
  const uuid = generateOfflinePlayerUuid(username);
  const { hash, salt } = hashPassword(password);
  const now = Date.now();
  const isAdmin = adminEmails().includes(email.toLowerCase().trim()) ? 1 : 0;

  const stmt = db.prepare(`
    INSERT INTO users (id, email, username, password_hash, salt, uuid, model, created_at, is_admin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(id, email.toLowerCase().trim(), username.trim(), hash, salt, uuid, model === 'slim' ? 'slim' : 'classic', now, isAdmin);

  return {
    id,
    email: email.toLowerCase().trim(),
    username: username.trim(),
    uuid,
    model: model === 'slim' ? 'slim' : 'classic',
    createdAt: now,
    isAdmin: Boolean(isAdmin)
  };
}

function createSession(db, userId) {
  const token = `noc_${crypto.randomBytes(32).toString('hex')}`;
  const now = Date.now();
  const expiresAt = now + 90 * 24 * 60 * 60 * 1000; // 90 days
  const stmt = db.prepare(`
    INSERT INTO sessions (token, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(token, userId, now, expiresAt);
  return { token, expiresAt };
}

function getUserBySession(db, token) {
  if (!token) return null;
  const stmt = db.prepare(`
    SELECT u.id, u.email, u.username, u.uuid, u.model, u.badges, u.is_admin, u.created_at,
           u.minecraft_uuid, u.minecraft_username, u.minecraft_linked_at
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > ?
  `);
  return stmt.get(token, Date.now()) || null;
}

function getMinecraftLink(db, userId) {
  const row = db.prepare(`
    SELECT minecraft_uuid AS uuid, minecraft_username AS name, minecraft_linked_at AS linkedAt
    FROM users WHERE id = ?
  `).get(userId);
  if (!row?.uuid) return null;
  return { uuid: row.uuid, name: row.name, linkedAt: row.linkedAt };
}

function linkMinecraftAccount(db, userId, { uuid, name }) {
  const cleanUuid = String(uuid || '').replace(/-/g, '').toLowerCase();
  const cleanName = String(name || '').trim();
  if (!/^[a-f0-9]{32}$/.test(cleanUuid) || !/^[A-Za-z0-9_]{3,16}$/.test(cleanName)) {
    throw new Error('Microsoft returned an invalid Minecraft profile.');
  }

  const owner = db.prepare('SELECT id FROM users WHERE minecraft_uuid = ? AND id != ?').get(cleanUuid, userId);
  if (owner) throw new Error('That premium Minecraft account is already connected to another Noctra account.');

  const linkedAt = Date.now();
  db.prepare(`
    UPDATE users
    SET minecraft_uuid = ?, minecraft_username = ?, minecraft_linked_at = ?
    WHERE id = ?
  `).run(cleanUuid, cleanName, linkedAt, userId);
  return { uuid: cleanUuid, name: cleanName, linkedAt };
}

function getUserByMinecraftUuid(db, uuid) {
  const cleanUuid = String(uuid || '').replace(/-/g, '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(cleanUuid)) return null;
  return db.prepare('SELECT * FROM users WHERE minecraft_uuid = ?').get(cleanUuid) || null;
}

/** Keeps the stored premium name current (players can rename on minecraft.net). */
function refreshMinecraftName(db, userId, name) {
  const cleanName = String(name || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(cleanName)) return;
  db.prepare('UPDATE users SET minecraft_username = ? WHERE id = ? AND minecraft_username IS NOT ?').run(cleanName, userId, cleanName);
}

function unlinkMinecraftAccount(db, userId) {
  db.prepare(`
    UPDATE users
    SET minecraft_uuid = NULL, minecraft_username = NULL, minecraft_linked_at = NULL
    WHERE id = ?
  `).run(userId);
  return { ok: true };
}

function deleteSession(db, token) {
  if (!token) return;
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

module.exports = {
  generateOfflinePlayerUuid,
  hashPassword,
  verifyPassword,
  verifyPasswordAsync,
  adminEmails,
  MAX_CODE_ATTEMPTS,
  saveVerificationCode,
  getVerificationCode,
  verificationCooldown,
  checkVerificationCode,
  clearVerificationCode,
  RESET_CODE_TTL_MS,
  savePasswordReset,
  getPasswordReset,
  passwordResetCooldown,
  checkPasswordResetCode,
  clearPasswordReset,
  setUserPassword,
  getUserByEmail,
  getUserByUsername,
  getUserById,
  getUserByLogin,
  createUser,
  createSession,
  getUserBySession,
  getMinecraftLink,
  linkMinecraftAccount,
  unlinkMinecraftAccount,
  getUserByMinecraftUuid,
  refreshMinecraftName,
  deleteSession
};
