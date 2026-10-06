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

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'native-premium-test-'));
process.env.NATIVE_DATA_DIR = DATA_DIR;

let db;
let server;
let base;
const ALEX = Object.keys(PROFILES)[0];
const SAM = Object.keys(PROFILES)[1];

test.before(async () => {
  await new Promise((resolve) => mojang.listen(0, '127.0.0.1', resolve));
  process.env.NATIVE_MC_PROFILE_URL = `http://127.0.0.1:${mojang.address().port}/minecraft/profile`;
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

test('premium sign-in: a Microsoft account becomes a Native account on first sign-in', async () => {
  const res = await post('/v1/auth/minecraft', { minecraftAccessToken: ALEX });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.created, true);
  assert.equal(body.account.name, 'AlexPremium');
  assert.match(body.token, /^nat_[a-f0-9]{64}$/);
  const user = db.getUserBySession(body.token);
  assert.equal(user.auth_type, 'premium');
  assert.equal(user.email, null);
  assert.equal(user.session_kind, 'premium');

  // Signing in again reuses the same account.
  const again = await (await post('/v1/auth/minecraft', { minecraftAccessToken: ALEX })).json();
  assert.equal(again.created, false);
  assert.equal(again.account.id, body.account.id);

  // Logging out ends that session on the server.
  assert.equal((await post('/v1/auth/logout', {}, again.token)).status, 200);
  assert.equal(db.getUserBySession(again.token), null);
  assert.ok(db.getUserBySession(body.token), 'other sessions stay');
});

test('premium sign-in: a bad Minecraft token never signs in', async () => {
  const res = await post('/v1/auth/minecraft', { minecraftAccessToken: 'x'.repeat(48) });
  assert.equal(res.status, 401);
  const short = await post('/v1/auth/minecraft', { minecraftAccessToken: 'short' });
  assert.equal(short.status, 400);
});

test('premium sign-in: the premium owner takes its name back from an email account', async () => {
  const squatter = db.createUser({ email: 'squat@test.local', username: 'SamPremium', password: 'password123' });
  const res = await (await post('/v1/auth/minecraft', { minecraftAccessToken: SAM })).json();
  assert.equal(res.account.name, 'SamPremium');
  const moved = db.getUserById(squatter.id);
  assert.notEqual(moved.username.toLowerCase(), 'sampremium');
  assert.match(moved.username, /^SamPremium_\d+$|^Sam/);
});

test('merge: a premium account merges one-way into an email account and takes its name', async () => {
  const native = db.createUser({ email: 'merge@test.local', username: 'MergeMe', password: 'password123' });
  const premium = await (await post('/v1/auth/minecraft', { minecraftAccessToken: ALEX })).json();

  const wrong = await post('/v1/account/merge', { login: 'merge@test.local', password: 'nope' }, premium.token);
  assert.equal(wrong.status, 401);
  // Only premium sessions can start a merge.
  const nativeSession = db.createSession(native.id).token;
  assert.equal((await post('/v1/account/merge', { login: 'merge@test.local', password: 'password123' }, nativeSession)).status, 409);

  const res = await post('/v1/account/merge', { login: 'merge@test.local', password: 'password123' }, premium.token);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.account.id, native.id);
  assert.equal(body.account.name, 'AlexPremium');
  const merged = db.getUserBySession(body.token);
  assert.equal(merged.auth_type, 'merged');
  assert.equal(merged.email, 'merge@test.local');
  assert.equal(db.getUserBySession(premium.token), null, 'old sessions end');
  assert.equal(db.getUserBySession(nativeSession), null);

  // The premium sign-in now lands on the merged account; the email login still works.
  const later = await (await post('/v1/auth/minecraft', { minecraftAccessToken: ALEX })).json();
  assert.equal(later.account.id, native.id);
  const login = await post('/v1/auth/login', { login: 'merge@test.local', password: 'password123' });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).account.name, 'AlexPremium');
  assert.equal((await post('/v1/account/merge', { login: 'merge@test.local', password: 'password123' }, later.token)).status, 409);
});

test('web link: a launcher session opens the website once', async () => {
  const { token } = await (await post('/v1/auth/minecraft', { minecraftAccessToken: SAM })).json();
  assert.equal((await post('/v1/auth/web-link', {})).status, 401);
  const { code } = await (await post('/v1/auth/web-link', {}, token)).json();
  assert.ok(code);
  const redeem = await post('/v1/auth/web-link/redeem', { code });
  assert.equal(redeem.status, 200);
  const web = await redeem.json();
  assert.equal(db.getUserBySession(web.token).session_kind, 'web');
  assert.equal((await post('/v1/auth/web-link/redeem', { code })).status, 400, 'single use');
});
