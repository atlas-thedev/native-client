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
  return String(process.env.NATIVE_ADMIN_EMAILS || '')
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
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare(`
    INSERT INTO verification_codes (email, code, salt, created_at, expires_at, attempts)
    VALUES (?, ?, ?, ?, ?, 0)
    ON CONFLICT(email) DO UPDATE SET
      code = excluded.code,
      salt = excluded.salt,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at,
      attempts = 0
  `).run(email.toLowerCase().trim(), hashResetCode(code, salt), salt, now, expiresAt);
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
  const supplied = Buffer.from(hashResetCode(String(code || '').trim(), row.salt || ''), 'hex');
  const expected = Buffer.from(String(row.code), 'hex');
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
    INSERT INTO users (id, email, username, password_hash, salt, uuid, model, created_at, is_admin, auth_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'native')
  `);
  stmt.run(id, email.toLowerCase().trim(), username.trim(), hash, salt, uuid, model === 'slim' ? 'slim' : 'classic', now, isAdmin);

  return {
    id,
    email: email.toLowerCase().trim(),
    username: username.trim(),
    uuid,
    model: model === 'slim' ? 'slim' : 'classic',
    createdAt: now,
    isAdmin: Boolean(isAdmin),
    auth_type: 'native'
  };
}

const DAY = 24 * 60 * 60 * 1000;
/**
 * Session lifetimes by kind. Premium sessions are short: the launcher holds the
 * Microsoft refresh token and renews them silently, so a leaked one dies quickly.
 */
const SESSION_TTL = { password: 30 * DAY, premium: 7 * DAY, web: 30 * DAY };
const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function createSession(db, userId, kind = 'password') {
  const safeKind = SESSION_TTL[kind] ? kind : 'password';
  const token = `nat_${crypto.randomBytes(32).toString('hex')}`;
  const now = Date.now();
  const expiresAt = now + SESSION_TTL[safeKind];
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').run(userId, now);
  db.prepare(`
    INSERT INTO sessions (token, user_id, kind, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(tokenHash(token), userId, safeKind, now, expiresAt);
  return { token, expiresAt, kind: safeKind };
}

/** Ends sessions for a user: every one, or only one kind (e.g. all premium sign-ins). */
function revokeSessions(db, userId, kind = null) {
  const result = kind
    ? db.prepare('DELETE FROM sessions WHERE user_id = ? AND kind = ?').run(userId, kind)
    : db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return Number(result.changes || 0);
}

function getUserBySession(db, token) {
  if (!token) return null;
  return db.prepare(`
    SELECT u.id, u.email, u.username, u.uuid, u.model, u.badges, u.is_admin, u.created_at,
           u.auth_type, u.minecraft_uuid, u.minecraft_username, u.minecraft_linked_at,
           s.kind AS session_kind
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(tokenHash(token), Date.now()) || null;
}

function getMinecraftLink(db, userId) {
  const row = db.prepare(`
    SELECT minecraft_uuid AS uuid, minecraft_username AS name, minecraft_linked_at AS linkedAt
    FROM users WHERE id = ?
  `).get(userId);
  if (!row?.uuid) return null;
  return { uuid: row.uuid, name: row.name, linkedAt: row.linkedAt };
}

/** The Native user whose connected premium account currently has this Minecraft name. */
function getUserByMinecraftName(db, name) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  return db.prepare('SELECT * FROM users WHERE lower(minecraft_username) = lower(?)').get(clean) || null;
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

/** Rename a Native account (the caller checks the name is valid and free). */
function renameUser(db, userId, username) {
  db.prepare('UPDATE users SET username = ? WHERE id = ?').run(String(username).trim(), userId);
  return getUserById(db, userId);
}

function deleteSession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash(token));
}

/* ── Premium (Microsoft) accounts ─────────────────────────────────────── */

const dashedUuid = (hex) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
const cleanMcUuid = (value) => String(value || '').replace(/-/g, '').toLowerCase();

/**
 * Creates the account for a real Minecraft player the first time they sign in:
 * the Minecraft name and UUID, no email, no password. The caller frees the name first.
 */
function createPremiumUser(db, { uuid, name }) {
  const mc = cleanMcUuid(uuid);
  const cleanName = String(name || '').trim();
  if (!/^[a-f0-9]{32}$/.test(mc) || !/^[A-Za-z0-9_]{3,16}$/.test(cleanName)) {
    throw new Error('Microsoft returned an invalid Minecraft profile.');
  }
  const id = `user-${crypto.randomBytes(6).toString('hex')}`;
  const now = Date.now();
  db.prepare(`
    INSERT INTO users (id, email, username, password_hash, salt, uuid, model, created_at, is_admin, auth_type,
                       minecraft_uuid, minecraft_username, minecraft_linked_at)
    VALUES (?, NULL, ?, NULL, NULL, ?, 'classic', ?, 0, 'premium', ?, ?, ?)
  `).run(id, cleanName, dashedUuid(mc), now, mc, cleanName, now);
  return getUserById(db, id);
}

/**
 * Merges a premium account into a native (email) account. The native account
 * survives (its email and password keep working) and takes the Minecraft name
 * and UUID. Everything the premium account had moves across; duplicates are
 * dropped. One-way: there is no un-merge.
 */
function mergePremiumInto(db, premiumId, nativeId) {
  const premium = getUserById(db, premiumId);
  const native = getUserById(db, nativeId);
  if (!premium || premium.auth_type !== 'premium') throw new Error('That Microsoft account is already merged.');
  if (!native || native.auth_type !== 'native') throw new Error('That Native account is already merged with a Microsoft account.');
  const p = premium.id;
  const n = native.id;
  // Tables created by optional modules (store, billing, site, beta) may not exist yet.
  const run = (sql, ...args) => {
    try { db.prepare(sql).run(...args); } catch (error) { if (!/no such table/.test(error.message)) throw error; }
  };
  db.exec('BEGIN');
  try {
    // Friends: one row per pair, never yourself.
    run('DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)', p, n, n, p);
    run('UPDATE OR IGNORE friends SET user_id = ? WHERE user_id = ?', n, p);
    run('UPDATE OR IGNORE friends SET friend_id = ? WHERE friend_id = ?', n, p);
    run('DELETE FROM friends WHERE user_id = ? OR friend_id = ?', p, p);
    run('DELETE FROM friend_requests WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)', p, n, n, p);
    run('UPDATE friend_requests SET sender_id = ? WHERE sender_id = ?', n, p);
    run('UPDATE friend_requests SET receiver_id = ? WHERE receiver_id = ?', n, p);
    run('UPDATE OR IGNORE blocks SET user_id = ? WHERE user_id = ?', n, p);
    run('UPDATE OR IGNORE blocks SET blocked_id = ? WHERE blocked_id = ?', n, p);
    run('DELETE FROM blocks WHERE user_id = blocked_id OR user_id = ? OR blocked_id = ?', p, p);
    // Messages and reactions.
    run('UPDATE messages SET sender_id = ? WHERE sender_id = ?', n, p);
    run('UPDATE messages SET receiver_id = ? WHERE receiver_id = ?', n, p);
    run('DELETE FROM messages WHERE sender_id = receiver_id');
    run('UPDATE OR IGNORE message_reactions SET user_id = ? WHERE user_id = ?', n, p);
    run('UPDATE OR IGNORE group_message_reactions SET user_id = ? WHERE user_id = ?', n, p);
    // Groups: when both were members, keep the higher role.
    run(`UPDATE group_members SET role = 'owner' WHERE user_id = ? AND group_id IN (SELECT group_id FROM group_members WHERE user_id = ? AND role = 'owner')`, n, p);
    run(`UPDATE group_members SET role = 'admin' WHERE user_id = ? AND role = 'member' AND group_id IN (SELECT group_id FROM group_members WHERE user_id = ? AND role = 'admin')`, n, p);
    run('UPDATE OR IGNORE group_members SET user_id = ? WHERE user_id = ?', n, p);
    run('UPDATE groups SET owner_id = ? WHERE owner_id = ?', n, p);
    run('UPDATE group_messages SET sender_id = ? WHERE sender_id = ?', n, p);
    // Store, billing, Native+ and site data.
    run('UPDATE OR IGNORE store_owned SET user_id = ? WHERE user_id = ?', n, p);
    run('UPDATE billing_purchases SET user_id = ? WHERE user_id = ?', n, p);
    run('UPDATE billing_subscriptions SET user_id = ? WHERE user_id = ?', n, p);
    run('UPDATE billing_checkouts SET user_id = ? WHERE user_id = ?', n, p);
    run('UPDATE OR IGNORE billing_customer_ids SET user_id = ? WHERE user_id = ?', n, p);
    run('UPDATE OR IGNORE billing_customers SET user_id = ? WHERE user_id = ?', n, p);
    run(`UPDATE plus_grants SET expires_at = CASE
           WHEN expires_at IS NULL OR (SELECT g.expires_at FROM plus_grants g WHERE g.user_id = ?) IS NULL THEN NULL
           ELSE MAX(expires_at, (SELECT g.expires_at FROM plus_grants g WHERE g.user_id = ?)) END
         WHERE user_id = ? AND EXISTS (SELECT 1 FROM plus_grants g WHERE g.user_id = ?)`, p, p, n, p);
    run('UPDATE OR IGNORE plus_grants SET user_id = ? WHERE user_id = ?', n, p);
    run('UPDATE OR IGNORE founder_picks SET user_id = ? WHERE user_id = ?', n, p);
    run('UPDATE OR IGNORE poll_votes SET user_id = ? WHERE user_id = ?', n, p);
    run('UPDATE OR IGNORE redeem_uses SET user_id = ? WHERE user_id = ?', n, p);
    run('UPDATE OR IGNORE beta_applications SET user_id = ? WHERE user_id = ?', n, p);
    let badges = [];
    try { badges = [...new Set([...JSON.parse(native.badges || '[]'), ...JSON.parse(premium.badges || '[]')])]; } catch {}
    // Every old sign-in ends; the caller hands out a fresh one.
    run('DELETE FROM sessions WHERE user_id IN (?, ?)', p, n);
    run('DELETE FROM presence WHERE user_id = ?', p);
    run('DELETE FROM users WHERE id = ?', p);
    db.prepare(`
      UPDATE users SET username = ?, uuid = ?, auth_type = 'merged', badges = ?,
        is_admin = MAX(is_admin, ?), minecraft_uuid = ?, minecraft_username = ?, minecraft_linked_at = ?
      WHERE id = ?
    `).run(premium.username, premium.uuid, JSON.stringify(badges), Number(premium.is_admin || 0),
      premium.minecraft_uuid, premium.minecraft_username, Date.now(), n);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  return { user: getUserById(db, n), from: { native: native.username, premium: premium.username } };
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
  revokeSessions,
  tokenHash,
  SESSION_TTL,
  createPremiumUser,
  mergePremiumInto,
  getUserBySession,
  getMinecraftLink,
  getUserByMinecraftUuid,
  getUserByMinecraftName,
  refreshMinecraftName,
  renameUser,
  deleteSession
};
