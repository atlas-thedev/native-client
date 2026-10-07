'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'native-betaupd-'));
process.env.NATIVE_SKIN_DATA = DATA_DIR;
process.env.NATIVE_DATA_DIR = DATA_DIR;
process.env.NATIVE_DB_PATH = path.join(DATA_DIR, 'native.db');
delete process.env.NATIVE_PUBLIC_URL;

const db = require('../server/db');
const { listen } = require('../server/server');
const modRoutes = require('../server/mod-routes');

let server, base;
const call = async (method, p, body, token) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test.before(async () => { server = await listen(0, '127.0.0.1'); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => {
  modRoutes.stopStreams?.();
  server.closeAllConnections?.(); server.close();
  try { db.closeDb(); } catch {}
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  setTimeout(() => process.exit(0), 50).unref();
});

test('beta update channel: admin adds / disables testers, accepted applicants follow the switch', async () => {
  const boss = db.createUser({ email: 'boss@example.com', username: 'Boss', password: 'correct horse battery' });
  db.setUserAdmin(boss.id, true);
  const admin = db.createSession(boss.id).token;
  const alice = db.createUser({ email: 'a@example.com', username: 'Alice', password: 'correct horse battery' });
  const aliceT = db.createSession(alice.id).token;
  const bob = db.createUser({ email: 'b@example.com', username: 'Bob', password: 'correct horse battery' });
  const bobT = db.createSession(bob.id).token;

  // signed out / normal user → stable
  assert.equal((await call('GET', '/v1/beta/channel')).body.channel, 'stable');
  assert.equal((await call('GET', '/v1/beta/channel', undefined, aliceT)).body.channel, 'stable');

  // only admins manage testers
  assert.equal((await call('GET', '/v1/admin/beta/testers', undefined, aliceT)).status, 403);

  // add Alice by username
  let r = await call('POST', '/v1/admin/beta/testers', { username: 'alice', note: 'QA' }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.testers[0].username, 'Alice');
  assert.equal(r.body.testers[0].mode, 'on');
  r = await call('GET', '/v1/beta/channel?version=4.3.0-beta.1&platform=win32', undefined, aliceT);
  assert.deepEqual([r.body.channel, r.body.tester], ['beta', true]);
  r = await call('GET', '/v1/admin/beta/testers', undefined, admin);
  assert.equal(r.body.testers[0].lastVersion, '4.3.0-beta.1');
  assert.equal(r.body.testers[0].lastPlatform, 'win32');
  assert.equal(r.body.stats.active, 1);
  assert.equal(r.body.config.enabled, true);

  // unknown username
  assert.equal((await call('POST', '/v1/admin/beta/testers', { username: 'nobody' }, admin)).status, 404);

  // Bob gets accepted through an application → beta automatically
  r = await call('POST', '/v1/beta/apply', { discord: 'bob#1', platform: 'windows', age: '18-24', why: 'I love testing launchers and reporting every bug I find, honestly.', agree: true }, bobT);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('PATCH', `/v1/admin/beta/${r.body.application.id}`, { status: 'approved' }, admin);
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/v1/beta/channel', undefined, bobT)).body.channel, 'beta');

  // turn accepted-applicant auto-include off → Bob stable, Alice (manual) still beta
  await call('POST', '/v1/admin/beta/updates', { includeAccepted: false }, admin);
  assert.equal((await call('GET', '/v1/beta/channel', undefined, bobT)).body.channel, 'stable');
  assert.equal((await call('GET', '/v1/beta/channel', undefined, aliceT)).body.channel, 'beta');
  await call('POST', '/v1/admin/beta/updates', { includeAccepted: true }, admin);

  // force Bob off, then back to auto
  r = await call('PATCH', `/v1/admin/beta/testers/${bob.id}`, { enabled: false }, admin);
  assert.equal(r.body.testers.find((t) => t.username === 'Bob').mode, 'off');
  assert.equal((await call('GET', '/v1/beta/channel', undefined, bobT)).body.channel, 'stable');
  await call('DELETE', `/v1/admin/beta/testers/${bob.id}`, undefined, admin);
  assert.equal((await call('GET', '/v1/beta/channel', undefined, bobT)).body.channel, 'beta');

  // remove Alice → she drops off the list and back to stable
  r = await call('DELETE', `/v1/admin/beta/testers/${alice.id}`, undefined, admin);
  assert.ok(!r.body.testers.some((t) => t.username === 'Alice'));
  assert.equal((await call('GET', '/v1/beta/channel', undefined, aliceT)).body.channel, 'stable');

  // master switch off → nobody on beta
  await call('POST', '/v1/admin/beta/updates', { enabled: false }, admin);
  assert.equal((await call('GET', '/v1/beta/channel', undefined, bobT)).body.channel, 'stable');
});
