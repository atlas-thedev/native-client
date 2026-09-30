'use strict';
/**
 * Launcher side of Relay: drives the real Electron main-process IPC handlers
 * (electron/social.js + electron/relay.js) against the real backend, the same
 * way the renderer does through preload.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = 35000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noctra-cli-srv-'));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'noctra-cli-ud-'));
process.env.NATIVE_WARDROBE_API = BASE;
process.env.NOCTRA_TEST_USER_DATA = userData;
const stub = require('./electron-stub.js');
const handlers = new Map();
stub.ipcMain.handle = (channel, fn) => handlers.set(channel, fn);
const social = require('../electron/social.js');
const relay = require('../electron/relay.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const invoke = (channel, ...args) => {
  const fn = handlers.get(channel);
  assert.ok(fn, `missing IPC handler ${channel}`);
  return fn({}, ...args);
};
const http = async (method, route, { token, body } = {}) => {
  const res = await fetch(BASE + route, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return res.json();
};
const sent = [];
const deps = { app: stub.app, getWin: () => ({ isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push({ channel, payload }) } }) };
const U = {};
let child;

function codeFor(email) {
  const db = new DatabaseSync(path.join(serverDir, 'noctra.db'), { readOnly: true });
  try { return db.prepare('SELECT code FROM verification_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1').get(email)?.code; } finally { db.close(); }
}
async function register(name) {
  const email = `${name.toLowerCase()}@example.test`;
  await http('POST', '/v1/auth/register/send-code', { body: { email, username: name } });
  const res = await http('POST', '/v1/auth/register/verify', { body: { email, code: codeFor(email), username: name, password: 'hunter22' } });
  assert.ok(res.ok, JSON.stringify(res));
  return { id: res.account.id, name, type: 'noctra', token: res.token };
}
const signInAs = (who) => fs.writeFileSync(path.join(userData, 'accounts.json'), JSON.stringify({ activeId: who.id, accounts: [U.a, U.b].filter(Boolean) }));
const waitFor = async (fn, timeout = 5000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(40); }
  throw new Error('timed out. Window events: ' + sent.map((s) => s.payload?.type || s.channel).join(','));
};

test.before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NOCTRA_DATA_DIR: serverDir, RESEND_API_KEY: 'test' }, stdio: 'ignore'
  });
  for (let i = 0; i < 60; i += 1) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(250); }
  const tag = Math.random().toString(36).slice(2, 6);
  U.a = await register(`Ann${tag}`);
  U.b = await register(`Ben${tag}`);
  signInAs(U.a);
  social.init(deps, stub.ipcMain);
  relay.init();
});

test.after(() => {
  social.stopStream();
  child?.kill();
  setTimeout(() => process.exit(0), 50).unref();
  fs.rmSync(serverDir, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
});

test('every preload relay and social channel has a main-process handler', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
  const channels = [...preload.matchAll(/invoke\('((?:relay|social):[A-Za-z]+)'/g)].map((m) => m[1]);
  assert.ok(channels.length > 25);
  for (const channel of channels) assert.ok(handlers.has(channel), `no handler for ${channel}`);
});

test('realtime stream connects and forwards events to the window', async () => {
  await waitFor(() => sent.some((s) => s.channel === 'social:streamStatus' && s.payload.status === 'connected'));
  assert.equal((await invoke('social:getStreamStatus')).status, 'connected');
});

test('friends over IPC: search, request, accept, list', async () => {
  const found = await invoke('social:searchUsers', U.b.name.slice(0, 5));
  assert.ok(found.results?.some((u) => u.id === U.b.id) || found.some?.((u) => u.id === U.b.id), JSON.stringify(found).slice(0, 200));
  const req = await invoke('social:sendRequest', U.b.name);
  assert.ok(req.ok, JSON.stringify(req));
  signInAs(U.b);
  const inbox = await invoke('social:getRequests');
  assert.equal(inbox.requests.received.length, 1);
  const acc = await invoke('social:respondRequest', { requestId: inbox.requests.received[0].id, action: 'accept' });
  assert.ok(acc.ok, JSON.stringify(acc));
  assert.ok((await invoke('social:getFriends')).friends.some((f) => f.id === U.a.id));
  signInAs(U.a);
  assert.ok((await invoke('social:getFriends')).friends.some((f) => f.id === U.b.id));
});

test('DM round trip with live delivery, receipts, reactions and cache fallback', async () => {
  const before = sent.length;
  const msg = await invoke('social:sendMessage', { friendId: U.b.id, content: 'ping from ann' });
  assert.ok(msg.ok, JSON.stringify(msg));
  await waitFor(() => sent.slice(before).some((s) => s.channel === 'social:event' && s.payload.type === 'message:new' && s.payload.message?.id === msg.message.id));

  // Ben replies straight over HTTP; Ann's window must receive it live.
  const reply = await http('POST', `/v1/social/relay/dm/${U.a.id}/messages`, { token: U.b.token, body: { content: 'pong from ben', replyTo: msg.message.id } });
  await waitFor(() => sent.some((s) => s.payload?.type === 'message:new' && s.payload.message?.id === reply.message.id));

  const page = await invoke('social:getMessages', { friendId: U.b.id, limit: 10 });
  assert.ok(page.ok && page.messages.length >= 2);
  const conv = await invoke('social:getConversations', { perFriend: 5 });
  assert.ok(conv.conversations?.[U.b.id]?.messages?.length >= 2);

  const reacted = await invoke('social:setMessageReaction', { messageId: reply.message.id, reaction: '🔥' });
  assert.ok(reacted.ok, JSON.stringify(reacted));
  assert.ok((await invoke('social:markRead', U.b.id)).ok);
  assert.ok((await invoke('social:setTyping', { friendId: U.b.id, isTyping: true })).ok);

  const edited = await invoke('relay:editDirectMessage', msg.message.id, 'ping (edited)');
  assert.ok(edited.ok && edited.message.editedAt, JSON.stringify(edited));
  const deleted = await invoke('relay:deleteDirectMessage', msg.message.id);
  assert.ok(deleted.ok && deleted.message.isDeleted);

  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const up = await invoke('social:uploadMedia', { dataUrl: png, filename: 'px.png' });
  assert.ok(up.ok && up.url, JSON.stringify(up));
  const withMedia = await invoke('relay:sendDirectMessage', U.b.id, { content: '', mediaUrl: up.url, mediaName: 'px.png', mediaKind: 'image' });
  assert.ok(withMedia.ok && withMedia.message.mediaUrl);

  const upd = await invoke('social:updateFriend', { friendId: U.b.id, nickname: 'Benny', pinned: true, muted: false });
  assert.ok(upd.ok, JSON.stringify(upd));
});

test('groups over IPC: full lifecycle', async () => {
  const created = await invoke('relay:createGroup', { name: 'IPC Crew', memberIds: [U.b.id] });
  assert.ok(created.ok, JSON.stringify(created));
  const gid = created.group.id;
  assert.ok((await invoke('relay:getGroups')).groups.some((g) => g.id === gid));
  assert.ok((await invoke('relay:getGroup', gid)).ok);

  const m = await invoke('relay:sendGroupMessage', gid, { content: 'welcome' });
  assert.ok(m.ok, JSON.stringify(m));
  await waitFor(() => sent.some((s) => s.payload?.type === 'group:message' && s.payload.message?.id === m.message.id));
  assert.ok((await invoke('relay:reactToGroupMessage', m.message.id, '👍')).ok);
  assert.ok((await invoke('relay:editGroupMessage', m.message.id, 'welcome!')).ok);
  const hist = await invoke('relay:getGroupMessages', gid, { limit: 5 });
  assert.ok(hist.ok && hist.messages.some((x) => x.content === 'welcome!'));
  assert.ok((await invoke('relay:setGroupTyping', gid, true)).ok);
  assert.ok((await invoke('relay:markGroupRead', gid)).ok);
  assert.ok((await invoke('relay:setGroupPrefs', gid, { pinned: true, muted: true })).ok);
  assert.ok((await invoke('relay:updateGroup', gid, { name: 'IPC Crew 2' })).group.name === 'IPC Crew 2');
  assert.ok((await invoke('relay:setMemberRole', gid, U.b.id, 'admin')).ok);
  assert.ok((await invoke('relay:setMemberRole', gid, U.b.id, 'member')).ok);
  assert.ok((await invoke('relay:removeMember', gid, U.b.id)).ok);
  assert.ok((await invoke('relay:addMembers', gid, [U.b.id])).ok);
  assert.ok((await invoke('relay:deleteGroupMessage', m.message.id)).ok);
  assert.ok((await invoke('relay:deleteGroup', gid)).ok);
  assert.ok(!(await invoke('relay:getGroups')).groups.some((g) => g.id === gid));
});

test('presence reaches friends and errors surface cleanly', async () => {
  social.setPresence({ status: 'in-game', activity: 'Playing Minecraft', serverAddress: 'play.example.net' });
  await sleep(300);
  const friends = await http('GET', '/v1/social/friends', { token: U.b.token });
  assert.equal(friends.friends.find((f) => f.id === U.a.id).status, 'in-game');

  const bad = await invoke('relay:sendGroupMessage', 'does-not-exist', { content: 'x' });
  assert.equal(bad.ok, false);
  assert.ok(bad.error);
  fs.writeFileSync(path.join(userData, 'accounts.json'), JSON.stringify({ activeId: null, accounts: [] }));
  const signedOut = await invoke('relay:getGroups');
  assert.equal(signedOut.ok, false);
  assert.match(signedOut.error, /sign in/i);
  signInAs(U.a);
});
