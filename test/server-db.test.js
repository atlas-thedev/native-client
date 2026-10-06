const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate test DB environment
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-db-test-'));
process.env.NATIVE_DATA_DIR = testDir;

const db = require('../server/db');

test('server/db: verifies WAL mode, foreign keys, indexes, and full user lifecycle', () => {
  const conn = db.getDb();

  // 1. Verify PRAGMAs
  const journalMode = conn.prepare('PRAGMA journal_mode').get();
  assert.equal(journalMode.journal_mode, 'wal');

  const foreignKeys = conn.prepare('PRAGMA foreign_keys').get();
  assert.equal(foreignKeys.foreign_keys, 1);

  // 2. Verify Indexes exist
  const indexes = conn.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name);
  assert.ok(indexes.includes('idx_users_username'));
  assert.ok(indexes.includes('idx_users_email'));
  assert.ok(indexes.includes('idx_sessions_token'));
  assert.ok(indexes.includes('idx_friends_user'));
  assert.ok(indexes.includes('idx_requests_receiver'));
  assert.ok(indexes.includes('idx_messages_pair'));
  assert.ok(indexes.includes('idx_presence_user'));

  // 3. User & Verification lifecycle
  const email = 'hero@native.xyz';
  const username = 'NativeHero';

  db.saveVerificationCode(email, '987654');
  assert.ok(db.checkVerificationCode(email, '987654'));
  assert.equal(db.checkVerificationCode(email, '000000'), false);
  db.clearVerificationCode(email);

  // Codes are burned after too many wrong guesses.
  db.saveVerificationCode(email, '135790');
  for (let i = 0; i < db.MAX_CODE_ATTEMPTS || i < 5; i += 1) db.checkVerificationCode(email, '000000');
  assert.equal(db.checkVerificationCode(email, '135790'), false, 'brute force burns the code');
  db.clearVerificationCode(email);
  assert.equal(db.checkVerificationCode(email, '987654'), false);

  const user = db.createUser({
    email,
    username,
    password: 'SuperSecretPassword123!',
    model: 'slim'
  });
  assert.equal(user.username, 'NativeHero');
  assert.equal(user.model, 'slim');
  assert.ok(user.uuid);

  // Password verification
  const fetchedUser = db.getUserByLogin(username);
  assert.ok(fetchedUser);
  assert.ok(db.verifyPassword('SuperSecretPassword123!', fetchedUser.password_hash, fetchedUser.salt));
  assert.equal(db.verifyPassword('WrongPassword', fetchedUser.password_hash, fetchedUser.salt), false);

  // Sessions
  const session = db.createSession(user.id);
  assert.ok(session.token.startsWith('nat_'));
  // Only a hash of the token is stored.
  assert.equal(db.getDb().prepare('SELECT count(*) AS c FROM sessions WHERE token = ?').get(session.token).c, 0);
  const sessionUser = db.getUserBySession(session.token);
  assert.equal(sessionUser.id, user.id);
  assert.equal(sessionUser.username, 'NativeHero');

  db.deleteSession(session.token);
  assert.equal(db.getUserBySession(session.token), null);
});

test('server/db: verifies foreign key cascades and relational integrity', () => {
  const conn = db.getDb();

  const u1 = db.createUser({ email: 'cascade1@test.com', username: 'CascadeUser1', password: 'password123' });
  const u2 = db.createUser({ email: 'cascade2@test.com', username: 'CascadeUser2', password: 'password123' });

  // Friend request
  const req = db.sendFriendRequest(u1.id, u2.username);
  db.respondFriendRequest(req.id, u2.id, 'accept');

  // Messages
  db.sendMessage(u1.id, u2.id, 'Hello cascade test');
  const msgsBefore = db.getMessages(u1.id, u2.id);
  assert.equal(msgsBefore.messages.length, 1);

  // Presence
  db.updatePresence(u1.id, { status: 'in-game', activity: 'Testing cascades' });
  const presBefore = db.getPresence(u1.id);
  assert.equal(presBefore.activity, 'Testing cascades');

  // Sessions
  const s1 = db.createSession(u1.id);
  assert.ok(db.getUserBySession(s1.token));

  // Now delete user 1 directly from users table -> should CASCADE to sessions, friends, messages, presence!
  conn.prepare('DELETE FROM users WHERE id = ?').run(u1.id);

  // Verify cascades
  assert.equal(db.getUserBySession(s1.token), null);
  assert.equal(db.getPresence(u1.id), null);
  assert.equal(conn.prepare('SELECT count(*) as c FROM friends WHERE user_id = ? OR friend_id = ?').get(u1.id, u1.id).c, 0);
  assert.equal(conn.prepare('SELECT count(*) as c FROM messages WHERE sender_id = ? OR receiver_id = ?').get(u1.id, u1.id).c, 0);
  assert.equal(conn.prepare('SELECT count(*) as c FROM friend_requests WHERE sender_id = ? OR receiver_id = ?').get(u1.id, u1.id).c, 0);
});

test('server/db: premium accounts are created from Microsoft and merge one-way into email accounts', () => {
  const profile = { uuid: '069a79f444e94726a5befca90e38aaf5', name: 'Notch' };
  const premium = db.createPremiumUser(profile);
  assert.equal(premium.auth_type, 'premium');
  assert.equal(premium.email, null);
  assert.equal(premium.username, 'Notch');
  assert.equal(db.getUserByMinecraftUuid(profile.uuid).id, premium.id);
  assert.throws(() => db.createPremiumUser(profile));

  const native = db.createUser({ email: 'merge@test.com', username: 'MergeTester', password: 'password123' });
  assert.equal(native.auth_type, 'native');
  const friend = db.createUser({ email: 'friend@test.com', username: 'MergeFriend', password: 'password123' });
  const conn = db.getDb();
  conn.prepare('INSERT INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)').run(premium.id, friend.id, Date.now());
  conn.prepare('INSERT INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)').run(friend.id, premium.id, Date.now());
  const session = db.createSession(premium.id, 'premium');
  assert.equal(db.getUserBySession(session.token).session_kind, 'premium');

  const { user } = db.mergePremiumInto(premium.id, native.id);
  assert.equal(user.id, native.id);
  assert.equal(user.username, 'Notch');
  assert.equal(user.email, 'merge@test.com');
  assert.equal(user.auth_type, 'merged');
  assert.equal(db.getUserById(premium.id), null);
  assert.equal(db.getUserBySession(session.token), null);
  assert.equal(conn.prepare('SELECT count(*) AS c FROM friends WHERE user_id = ? AND friend_id = ?').get(native.id, friend.id).c, 1);
  assert.throws(() => db.mergePremiumInto(premium.id, native.id), /already merged/);
});
