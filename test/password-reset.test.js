const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate test DB environment
process.env.NOCTRA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'noctra-reset-test-'));

const db = require('../server/db');

test('password reset: code is hashed, single-use, and expires', () => {
  const email = 'reset1@test.com';
  db.createUser({ email, username: 'ResetUser1', password: 'oldpassword' });

  assert.equal(db.passwordResetCooldown(email), 0);
  db.savePasswordReset(email, '123456');
  assert.ok(db.passwordResetCooldown(email) > 0, 'a fresh code starts the resend cooldown');

  const row = db.getDb().prepare('SELECT * FROM password_resets WHERE email = ?').get(email);
  assert.ok(row);
  assert.ok(!JSON.stringify(row).includes('123456'), 'the plain code is never stored');

  assert.equal(db.checkPasswordResetCode(email, '000000'), false);
  assert.ok(db.checkPasswordResetCode(email, '123456'));

  db.clearPasswordReset(email);
  assert.equal(db.checkPasswordResetCode(email, '123456'), false, 'a used code cannot be reused');

  db.savePasswordReset(email, '654321');
  db.getDb().prepare('UPDATE password_resets SET expires_at = ? WHERE email = ?').run(Date.now() - 1, email);
  assert.equal(db.checkPasswordResetCode(email, '654321'), false, 'expired codes are rejected');
});

test('password reset: wrong guesses burn the code', () => {
  const email = 'reset2@test.com';
  db.createUser({ email, username: 'ResetUser2', password: 'oldpassword' });

  db.savePasswordReset(email, '246810');
  for (let i = 0; i < db.MAX_CODE_ATTEMPTS; i += 1) db.checkPasswordResetCode(email, '000000');
  assert.equal(db.checkPasswordResetCode(email, '246810'), false, 'brute force burns the code');
});

test('password reset: new password works, old one and old sessions stop working', () => {
  const email = 'reset3@test.com';
  const user = db.createUser({ email, username: 'ResetUser3', password: 'oldpassword' });
  const session = db.createSession(user.id);
  assert.ok(db.getUserBySession(session.token));

  db.setUserPassword(user.id, 'brand-new-password');

  const fresh = db.getUserByEmail(email);
  assert.ok(db.verifyPassword('brand-new-password', fresh.password_hash, fresh.salt));
  assert.equal(db.verifyPassword('oldpassword', fresh.password_hash, fresh.salt), false);
  assert.equal(db.getUserBySession(session.token), null, 'existing sessions are ended');
});
