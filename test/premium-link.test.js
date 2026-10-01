const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// A stand-in for api.minecraftservices.com: each bearer token owns one profile.
const PROFILES = {
  ['mc_token_alex_'.padEnd(48, 'a')]: { id: '0f8b3c1e2d4a4b5c9e6f7a8b9c0d1e2f', name: 'AlexPremium' },
  ['mc_token_sam_'.padEnd(48, 's')]: { id: '1a2b3c4d5e6f40718293a4b5c6d7e8f9', name: 'SamPremium' }
};
const mojang = http.createServer((req, res) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/, '');
  const profile = PROFILES[token];
  res.writeHead(profile ? 200 : 401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(profile || { error: 'UNAUTHORIZED' }));
});

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'noctra-premium-test-'));
process.env.NOCTRA_DATA_DIR = DATA_DIR;

let db;
let server;
let base;
const ALEX = Object.keys(PROFILES)[0];
const SAM = Object.keys(PROFILES)[1];

test.before(async () => {
  await new Promise((resolve) => mojang.listen(0, '127.0.0.1', resolve));
  process.env.NOCTRA_MC_PROFILE_URL = `http://127.0.0.1:${mojang.address().port}/minecraft/profile`;
  db = require('../server/db');
  server = await require('../server/server').listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server?.close();
  mojang.close();
});

const post = (pathname, body, token) => fetch(`${base}${pathname}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body)
});

test('premium sign-in: unlinked premium accounts are told to connect first', async () => {
  const res = await post('/v1/auth/minecraft', { minecraftAccessToken: ALEX });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.code, 'not_linked');
  assert.equal(body.token, undefined);
});

test('premium sign-in: a bad Minecraft token never signs in', async () => {
  const res = await post('/v1/auth/minecraft', { minecraftAccessToken: 'x'.repeat(48) });
  assert.equal(res.status, 401);
  const short = await post('/v1/auth/minecraft', { minecraftAccessToken: 'short' });
  assert.equal(short.status, 400);
});

test('premium sign-in: once connected, the premium account signs into its Noctra account', async () => {
  const user = db.createUser({ email: 'alex@test.local', username: 'AlexNoctra', password: 'password123' });
  const session = db.createSession(user.id).token;

  const link = await post('/v1/account/minecraft', { minecraftAccessToken: ALEX }, session);
  assert.equal(link.status, 200);
  assert.equal((await link.json()).profile.name, 'AlexPremium');

  const signIn = await post('/v1/auth/minecraft', { minecraftAccessToken: ALEX });
  assert.equal(signIn.status, 200);
  const body = await signIn.json();
  assert.equal(body.ok, true);
  assert.equal(body.account.id, user.id);
  assert.equal(body.account.name, 'AlexNoctra');
  assert.match(body.token, /^noc_[a-f0-9]{64}$/);
  assert.notEqual(body.token, session, 'the premium account gets its own session');

  // The new session is a real Noctra session.
  const status = await fetch(`${base}/v1/account/minecraft`, { headers: { Authorization: `Bearer ${body.token}` } });
  assert.equal((await status.json()).profile.uuid, '0f8b3c1e2d4a4b5c9e6f7a8b9c0d1e2f');

  // Another premium account can't sign into Alex's Noctra account.
  const other = await post('/v1/auth/minecraft', { minecraftAccessToken: SAM });
  assert.equal(other.status, 404);
});

test('premium sign-in: one premium account connects to one Noctra account, and disconnecting stops auto sign-in', async () => {
  const owner = db.createUser({ email: 'sam@test.local', username: 'SamNoctra', password: 'password123' });
  const thief = db.createUser({ email: 'thief@test.local', username: 'Thief', password: 'password123' });
  const ownerSession = db.createSession(owner.id).token;
  const thiefSession = db.createSession(thief.id).token;

  assert.equal((await post('/v1/account/minecraft', { minecraftAccessToken: SAM }, ownerSession)).status, 200);
  const steal = await post('/v1/account/minecraft', { minecraftAccessToken: SAM }, thiefSession);
  assert.equal(steal.status, 409);

  const unlink = await fetch(`${base}/v1/account/minecraft`, { method: 'DELETE', headers: { Authorization: `Bearer ${ownerSession}` } });
  assert.equal(unlink.status, 200);
  assert.equal((await post('/v1/auth/minecraft', { minecraftAccessToken: SAM })).status, 404);
});
