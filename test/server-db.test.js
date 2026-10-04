const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate test DB environment
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noctra-db-test-'));
process.env.NOCTRA_DATA_DIR = testDir;

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
  const email = 'hero@noctra.xyz';
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
  assert.ok(session.token.startsWith('noc_'));
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

test('server/db: premium Minecraft identities are unique, readable, and removable', () => {
  const first = db.createUser({ email: 'link1@test.com', username: 'LinkTester1', password: 'password123' });
  const second = db.createUser({ email: 'link2@test.com', username: 'LinkTester2', password: 'password123' });
  const profile = {
    uuid: '069a79f444e94726a5befca90e38aaf5',
    name: 'Notch'
  };

  const linked = db.linkMinecraftAccount(first.id, profile);
  assert.equal(linked.uuid, profile.uuid);
  assert.equal(linked.name, profile.name);
  assert.ok(linked.linkedAt > 0);
  assert.deepEqual(db.getMinecraftLink(first.id), linked);

  assert.throws(
    () => db.linkMinecraftAccount(second.id, profile),
    /already connected to another Native account/
  );

  db.unlinkMinecraftAccount(first.id);
  assert.equal(db.getMinecraftLink(first.id), null);
  assert.equal(db.linkMinecraftAccount(second.id, profile).name, profile.name);
});
