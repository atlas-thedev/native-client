'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'noctra-mod-api-'));
process.env.NATIVE_SKIN_DATA = DATA_DIR;
process.env.NOCTRA_DATA_DIR = DATA_DIR;
process.env.NOCTRA_DB_PATH = path.join(DATA_DIR, 'noctra.db');
delete process.env.NATIVE_SKIN_PUBLIC_URL;
delete process.env.NOCTRA_PUBLIC_URL;

const db = require('../server/db');
const { listen } = require('../server/server');
const modRoutes = require('../server/mod-routes');

const hash = (c) => c.repeat(64);
let server;
let base;

async function json(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  return { status: response.status, body: await response.json().catch(() => null) };
}

test.before(async () => {
  server = await listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  modRoutes.stopStreams();
  server.closeAllConnections?.();
  server.close();
  try { db.closeDb(); } catch {}
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  setTimeout(() => process.exit(0), 50).unref();
});

test('directory lists published wardrobes and serves deltas', async () => {
  fs.mkdirSync(path.join(DATA_DIR, 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'profiles', 'alice.json'), JSON.stringify({
    username: 'Alice', model: 'slim', skin: hash('a'), cape: hash('b'), updatedAt: '2026-01-01T00:00:00Z'
  }));
  fs.writeFileSync(path.join(DATA_DIR, 'profiles', 'bob.json'), JSON.stringify({
    username: 'Bob', model: 'default', skin: null, cape: null, updatedAt: '2026-01-01T00:00:00Z'
  }));

  const first = await json('/v1/skins/directory');
  assert.equal(first.status, 200);
  assert.equal(first.body.full, true);
  assert.deepEqual(first.body.entries.map((e) => e.n), ['Alice']);
  assert.equal(first.body.entries[0].m, 'slim');
  assert.equal(first.body.entries[0].s, hash('a'));
  assert.match(first.body.textureBase, /\/csl\/textures\/$/);

  const unchanged = await json(`/v1/skins/directory?epoch=${first.body.epoch}&since=${first.body.rev}`);
  assert.equal(unchanged.body.full, false);
  assert.equal(unchanged.body.entries.length, 0);

  modRoutes.noteProfile({ username: 'Carol', model: 'default', skin: hash('c'), cape: null, updatedAt: '2026-02-01T00:00:00Z' });
  const delta = await json(`/v1/skins/directory?epoch=${first.body.epoch}&since=${first.body.rev}`);
  assert.equal(delta.body.full, false);
  assert.deepEqual(delta.body.entries.map((e) => e.n), ['Carol']);

  const stale = await json('/v1/skins/directory?epoch=1&since=3');
  assert.equal(stale.body.full, true);
});

test('stream pushes a skin event the moment a wardrobe changes', async () => {
  const events = [];
  const request = http.get(`${base}/v1/skins/stream`, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk) => events.push(chunk));
  });
  request.on('error', () => {});
  await new Promise((r) => setTimeout(r, 200));
  modRoutes.noteProfile({ username: 'Dave', model: 'slim', skin: hash('d'), cape: hash('e'), updatedAt: '2026-03-01T00:00:00Z' });
  const end = Date.now() + 3000;
  while (!events.join('').includes('event: skin') && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  request.destroy();
  const text = events.join('');
  assert.match(text, /event: hello/);
  assert.match(text, /event: skin/);
  assert.match(text, /"n":"Dave"/);
});

test('game tickets: issued from a session, verified, scoped and expiring', async () => {
  const user = db.createUser({ email: 'ticket@example.com', username: 'TicketUser', password: 'correct horse battery' });
  const session = db.createSession(user.id);

  const denied = await json('/v1/auth/game-ticket', { method: 'POST' });
  assert.equal(denied.status, 401);

  const issued = await json('/v1/auth/game-ticket', { method: 'POST', headers: { Authorization: `Bearer ${session.token}` } });
  assert.equal(issued.status, 200);
  assert.match(issued.body.ticket, /^nmt1\./);
  assert.equal(issued.body.account.name, 'TicketUser');

  const me = await json('/v1/mod/me', { headers: { Authorization: `Bearer ${issued.body.ticket}` } });
  assert.equal(me.status, 200);
  assert.equal(me.body.account.id, user.id);

  // A ticket is not a session, and a session is not a ticket.
  const asSession = await json('/v1/social/friends', { headers: { Authorization: `Bearer ${issued.body.ticket}` } });
  assert.equal(asSession.status, 401);
  const sessionAsTicket = await json('/v1/mod/me', { headers: { Authorization: `Bearer ${session.token}` } });
  assert.equal(sessionAsTicket.status, 401);

  // Tampering and expiry are rejected.
  const parts = issued.body.ticket.split('.');
  const forged = `${parts[0]}.${Buffer.from(JSON.stringify({ u: 'someone-else', e: Date.now() + 1e9, s: 'game' })).toString('base64url')}.${parts[2]}`;
  assert.equal((await json('/v1/mod/me', { headers: { Authorization: `Bearer ${forged}` } })).status, 401);
  const old = modRoutes.signTicket(user.id, Date.now() - 25 * 60 * 60 * 1000);
  assert.equal(modRoutes.verifyTicket(old.ticket), null);
});
