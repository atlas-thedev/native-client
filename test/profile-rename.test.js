const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.NATIVE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'native-rename-test-'));
process.env.NATIVE_TEST_MODE = '1';

let db;
let server;
let base;

test.before(async () => {
  db = require('../server/db');
  server = await require('../server/server').listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server?.close());

const call = (method, pathname, body, token) => fetch(`${base}${pathname}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body ? JSON.stringify(body) : undefined
});

test('rename: a Native account can change its own name, keeps its id and UUID', async () => {
  const user = db.createUser({ email: 'rename1@test.com', username: 'OldName1', password: 'secret123' });
  db.createUser({ email: 'rename2@test.com', username: 'TakenName', password: 'secret123' });
  const { token } = db.createSession(user.id);

  assert.equal((await call('POST', '/v1/account/username', { username: 'TakenName' }, token)).status, 409);
  assert.equal((await call('POST', '/v1/account/username', { username: 'no spaces' }, token)).status, 400);
  assert.equal((await call('POST', '/v1/account/username', { username: 'premium_Steve' }, token)).status, 409);
  assert.equal((await call('POST', '/v1/account/username', { username: 'NewName1' })).status, 401);

  const res = await call('POST', '/v1/account/username', { username: 'NewName1' }, token);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.account.name, 'NewName1');
  const after = db.getUserById(user.id);
  assert.equal(after.username, 'NewName1');
  assert.equal(after.uuid, user.uuid, 'the in-game UUID never changes with the name');

  const profile = await (await call('GET', '/v1/profiles/NewName1')).json();
  assert.equal(profile.ok, true);
  assert.equal(profile.profile.canRename, true);
  assert.ok(profile.profile.names.some((n) => n.name === 'NewName1'));
});

test('rename: premium and merged accounts are refused (their name lives on minecraft.net)', async () => {
  const user = db.createUser({ email: 'rename3@test.com', username: 'MergedOne', password: 'secret123' });
  db.getDb().prepare("UPDATE users SET auth_type = 'merged' WHERE id = ?").run(user.id);
  const { token } = db.createSession(user.id);
  const res = await call('POST', '/v1/account/username', { username: 'Another1' }, token);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).premium, true);
  const profile = await (await call('GET', '/v1/profiles/MergedOne')).json();
  assert.equal(profile.profile.canRename, false);
});

test('profile: badges and launcher playtime are shown, totals never go down', async () => {
  const user = db.createUser({ email: 'stats1@test.com', username: 'StatsUser', password: 'secret123' });
  db.getDb().prepare('UPDATE users SET badges = ? WHERE id = ?').run(JSON.stringify(['developer']), user.id);
  const { token } = db.createSession(user.id);

  assert.equal((await call('POST', '/v1/profiles/me/stats', { playtimeSecs: 7200, sessions: 5, lastPlayed: Date.now() })).status, 401);
  const saved = await (await call('POST', '/v1/profiles/me/stats', { playtimeSecs: 7200, sessions: 5, lastPlayed: Date.now() }, token)).json();
  assert.equal(saved.playtimeSecs, 7200);
  const lower = await (await call('POST', '/v1/profiles/me/stats', { playtimeSecs: 60, sessions: 1 }, token)).json();
  assert.equal(lower.playtimeSecs, 7200, 'another device with less playtime does not lower the total');

  const { profile } = await (await call('GET', '/v1/profiles/StatsUser')).json();
  assert.deepEqual(profile.badges, ['developer']);
  assert.equal(profile.playtimeSecs, 7200);
  assert.equal(profile.sessions, 5);
});
