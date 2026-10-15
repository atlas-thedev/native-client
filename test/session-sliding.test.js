'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'native-sliding-'));
process.env.NATIVE_DATA_DIR = DATA_DIR;
process.env.NATIVE_DB_PATH = path.join(DATA_DIR, 'native.db');

const db = require('../server/db');
const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const DAY = 86_400_000;

test.after(() => { try { db.closeDb(); } catch {} fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

test('password sessions slide while used; premium sessions keep their fixed lifetime', () => {
  const user = db.createUser({ email: 'slide@example.com', username: 'Slider', password: 'correct horse battery' });
  const raw = db.getDb();
  const expiry = (token) => raw.prepare('SELECT expires_at FROM sessions WHERE token = ?').get(hash(token)).expires_at;

  const { token } = db.createSession(user.id);
  raw.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(Date.now() + 2 * DAY, hash(token));
  assert.equal(db.getUserBySession(token).id, user.id);
  assert.ok(expiry(token) > Date.now() + 29 * DAY, 'used in its last days: renewed to a full 30 days');

  const fresh = expiry(token);
  db.getUserBySession(token);
  assert.equal(expiry(token), fresh, 'a session in its first half is not rewritten on every request');

  const premium = db.createSession(user.id, 'premium').token;
  raw.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(Date.now() + DAY, hash(premium));
  db.getUserBySession(premium);
  assert.ok(expiry(premium) < Date.now() + 2 * DAY, 'premium sessions are renewed through Microsoft instead');

  raw.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(Date.now() - 1, hash(token));
  assert.equal(db.getUserBySession(token), null, 'an expired session is never revived');
});
