'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'native-game-social-'));
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
  modRoutes.stopStreams();
  server.closeAllConnections?.(); server.close();
  try { db.closeDb(); } catch {}
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  setTimeout(() => process.exit(0), 50).unref();
});

test('the in-game Relay can find players, send and answer friend requests, and manage friends with its game ticket', async () => {
  const alice = db.createUser({ email: 'gs-alice@example.com', username: 'GsAlice', password: 'correct horse battery' });
  const bob = db.createUser({ email: 'gs-bob@example.com', username: 'GsBob', password: 'correct horse battery' });
  const aliceTicket = modRoutes.signTicket(alice.id).ticket;
  const bobTicket = modRoutes.signTicket(bob.id).ticket;

  let r = await call('GET', '/v1/social/search?q=GsB', undefined, aliceTicket);
  assert.equal(r.status, 200);
  assert.ok(r.body.results.some((u) => u.username === 'GsBob' || u.name === 'GsBob'));

  r = await call('POST', '/v1/social/requests/send', { username: 'GsBob' }, aliceTicket);
  assert.equal(r.status, 200);
  r = await call('GET', '/v1/social/requests', undefined, bobTicket);
  assert.equal(r.body.requests.received.length, 1);
  r = await call('POST', '/v1/social/requests/respond', { requestId: r.body.requests.received[0].id, action: 'accept' }, bobTicket);
  assert.equal(r.status, 200);
  assert.equal(db.getFriends(alice.id).length, 1);

  r = await call('POST', '/v1/social/friends/update', { friendId: bob.id, nickname: 'Bobby', pinned: true }, aliceTicket);
  assert.equal(r.status, 200);
  r = await call('DELETE', `/v1/social/friends/${bob.id}`, undefined, aliceTicket);
  assert.equal(r.status, 200);
  assert.equal(db.getFriends(alice.id).length, 0);

  // never the launcher-only parts
  assert.equal((await call('POST', '/v1/social/presence', { status: 'online' }, aliceTicket)).status, 401);
  assert.equal((await call('GET', '/v1/social/friends', undefined, aliceTicket)).status, 401);
  assert.equal((await call('GET', '/v1/social/requests', undefined, 'nmt1.bad.ticket')).status, 401);
});
