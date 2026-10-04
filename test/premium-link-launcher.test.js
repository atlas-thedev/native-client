'use strict';
/**
 * Launcher side of "premium ↔ Native": drives the real IPC handlers in
 * electron/auth.js + electron/social.js against the real backend, with
 * Microsoft (msmc) and Minecraft Services replaced by local fakes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const MC_TOKEN = 'mc_access_'.padEnd(64, 'z');
const PROFILE = { id: '7d3f0a4c9b1e4c2a8f6e5d4c3b2a1908', name: 'PremiumPlayer' };

const mojang = http.createServer((req, res) => {
  const ok = String(req.headers.authorization || '') === `Bearer ${MC_TOKEN}`;
  res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(ok ? PROFILE : { error: 'UNAUTHORIZED' }));
});

// Fake msmc: refreshing the saved Microsoft session yields a Minecraft token.
const fakeMc = { profile: { id: PROFILE.id, name: PROFILE.name }, mclc: () => ({ access_token: MC_TOKEN }), validate: () => true };
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'msmc') {
    return { Auth: class { async refresh() { return { getMinecraft: async () => fakeMc, save: () => 'refresh-blob' }; } } };
  }
  return originalLoad.call(this, request, ...rest);
};

const serverData = fs.mkdtempSync(path.join(os.tmpdir(), 'native-premium-srv-'));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'native-premium-ud-'));
process.env.NATIVE_DATA_DIR = serverData;
process.env.NATIVE_TEST_USER_DATA = userData;

const stub = require('./electron-stub.js');
const handlers = new Map();
stub.ipcMain.handle = (channel, fn) => handlers.set(channel, fn);
const invoke = (channel, ...args) => handlers.get(channel)({}, ...args);
const accountsFile = path.join(userData, 'accounts.json');
const writeAccounts = (data) => fs.writeFileSync(accountsFile, JSON.stringify(data));
const readAccountsFile = () => JSON.parse(fs.readFileSync(accountsFile, 'utf8'));

let server;
let db;
let auth;
let social;

test.before(async () => {
  await new Promise((resolve) => mojang.listen(0, '127.0.0.1', resolve));
  process.env.NATIVE_MC_PROFILE_URL = `http://127.0.0.1:${mojang.address().port}/minecraft/profile`;
  db = require('../server/db');
  server = await require('../server/server').listen(0, '127.0.0.1');
  process.env.NATIVE_WARDROBE_API = `http://127.0.0.1:${server.address().port}`;
  auth = require('../electron/auth.js');
  social = require('../electron/social.js');
  const deps = { app: stub.app, getWin: () => null };
  auth.init(deps, stub.ipcMain);
  social.init(deps, stub.ipcMain);
  db.createUser({ email: 'player@test.local', username: 'NativePlayer', password: 'password123' });
});

test.after(() => {
  social.stopStream();
  server?.closeAllConnections?.();
  server?.close();
  mojang.close();
  // social.js keeps a presence heartbeat running, like in the app.
  setTimeout(() => process.exit(0), 50).unref();
});

const MS = { id: PROFILE.id, name: PROFILE.name, uuid: PROFILE.id, type: 'microsoft', refresh: 'refresh-blob' };

test('connect once with a Native password, then the premium account is the Native identity', async () => {
  writeAccounts({ activeId: MS.id, accounts: [MS] });

  const before = await invoke('accounts:ensureNative', MS.id, { force: true });
  assert.equal(before.ok, false);
  assert.equal(before.code, 'not_linked');

  const wrong = await invoke('accounts:connectNative', { microsoftAccountId: MS.id, login: 'NativePlayer', password: 'nope' });
  assert.equal(wrong.ok, false);

  const connected = await invoke('accounts:connectNative', { microsoftAccountId: MS.id, login: 'NativePlayer', password: 'password123' });
  assert.equal(connected.ok, true, connected.error);
  assert.equal(connected.link.name, 'NativePlayer');

  // The renderer sees the connection, never the session token.
  const list = await invoke('accounts:list');
  const listed = list.accounts.find((a) => a.id === MS.id);
  assert.equal(listed.nativeLink.connected, true);
  assert.equal(listed.nativeLink.name, 'NativePlayer');
  assert.equal(listed.nativeToken, undefined);
  assert.ok(!JSON.stringify(list).includes('noc_'), 'no Native session token reaches the renderer');

  // Social features act as the Native account while the premium account is active.
  const identity = social.getActiveNativeAccount();
  assert.equal(identity.name, 'NativePlayer');
  assert.equal(identity.linkedFrom, MS.id);
  const friends = await invoke('social:getFriends');
  assert.equal(friends.ok, true);
});

test('a new device (no saved session) connects automatically from the Microsoft sign-in', async () => {
  writeAccounts({ activeId: MS.id, accounts: [MS] });
  assert.equal(social.getActiveNativeAccount(), null);

  const result = await invoke('accounts:ensureNative', MS.id);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.link.name, 'NativePlayer');
  assert.ok(readAccountsFile().accounts[0].nativeToken, 'session saved for the premium account');
  assert.equal(social.getActiveNativeAccount().name, 'NativePlayer');
});

test('an expired Native session renews itself on the next request', async () => {
  const data = readAccountsFile();
  db.getDb().prepare('DELETE FROM sessions WHERE token = ?').run(auth.readAccounts(userData).accounts[0].nativeToken);
  writeAccounts(data);
  const friends = await invoke('social:getFriends');
  assert.equal(friends.ok, true, friends.error);
});

test('disconnecting stops automatic sign-in everywhere', async () => {
  const result = await invoke('accounts:disconnectNative', MS.id);
  assert.equal(result.ok, true, result.error);
  assert.equal(social.getActiveNativeAccount(), null);
  const again = await invoke('accounts:ensureNative', MS.id, { force: true });
  assert.equal(again.code, 'not_linked');
});
