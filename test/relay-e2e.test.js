'use strict';
/**
 * Relay end-to-end: boots the real backend (server/index.js) on a temp data
 * dir and drives accounts, friends, DMs, groups, reactions, uploads, presence
 * and the realtime SSE stream over HTTP, exactly like the launcher does.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = 34000 + Math.floor(Math.random() * 1000);
const BASE = process.env.RELAY_E2E_BASE || `http://127.0.0.1:${PORT}`;
const EXTERNAL = Boolean(process.env.RELAY_E2E_BASE);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-e2e-'));
let child;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, route, { token, body } = {}) {
  const res = await fetch(BASE + route, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json: json || {} };
}

/** Minimal SSE client collecting parsed events. */
async function openStream(token, route = null) {
  const controller = new AbortController();
  const res = route
    ? await fetch(BASE + route, { signal: controller.signal, headers: { Authorization: `Bearer ${token}` } })
    : await fetch(`${BASE}/v1/social/stream?token=${token}`, { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const events = [];
  const waiters = [];
  (async () => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let type = 'message';
          let data = '';
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) type = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          let payload = data;
          try { payload = JSON.parse(data); } catch {}
          const event = { type, payload };
          events.push(event);
          for (const w of [...waiters]) if (w.match(event)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(event); }
        }
      }
    } catch {}
  })();
  return {
    events,
    close: () => controller.abort(),
    wait(match, timeout = 4000) {
      const found = events.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error('SSE timeout. Seen: ' + events.map((e) => e.type).join(','))); } }, timeout);
      });
    },
    waitType: (type, extra = () => true, timeout) => undefined
  };
}

function lastCode(email) {
  return '123456'; // NATIVE_TEST_MODE: codes are stored hashed
}

async function register(username) {
  const email = `${username.toLowerCase()}@example.test`;
  await api('POST', '/v1/auth/register/send-code', { body: { email, username } }); // mail may fail offline; the code is stored first
  const code = lastCode(email);
  assert.ok(code, 'verification code stored');
  const res = await api('POST', '/v1/auth/register/verify', { body: { email, code, username, password: 'hunter22' } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return { id: res.json.account.id, name: username, token: res.json.token, email };
}

test.before(async () => {
  if (EXTERNAL) return;
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NATIVE_DATA_DIR: dataDir, RESEND_API_KEY: 'test', NATIVE_TEST_MODE: '1' },
    stdio: 'ignore'
  });
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('server did not start');
});

test.after(() => { child?.kill(); try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {} });

const U = {};
const tag = Math.random().toString(36).slice(2, 6);

test('health and auth gates', async () => {
  const health = await api('GET', '/health');
  assert.equal(health.json.ok, true);
  assert.ok(health.json.providers.includes('social'));
  for (const route of ['/v1/social/friends', '/v1/social/conversations', '/v1/social/requests', '/v1/social/relay/groups']) {
    assert.equal((await api('GET', route)).status, 401, route);
    assert.equal((await api('GET', route, { token: 'nope' })).status, 401, route);
  }
});

test('accounts: register, duplicate, login', async (t) => {
  if (EXTERNAL) return t.skip('registration needs mail');
  U.a = await register(`Alice${tag}`);
  U.b = await register(`Bob${tag}`);
  U.c = await register(`Cara${tag}`);
  U.d = await register(`Dan${tag}`);
  const dup = await api('POST', '/v1/auth/register/send-code', { body: { email: U.a.email, username: `Zed${tag}` } });
  assert.equal(dup.status, 400);
  const bad = await api('POST', '/v1/auth/login', { body: { login: U.a.name, password: 'wrong-pass' } });
  assert.equal(bad.status, 401);
  const ok = await api('POST', '/v1/auth/login', { body: { login: U.a.name, password: 'hunter22' } });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.token);
  const byEmail = await api('POST', '/v1/auth/login', { body: { login: U.a.email, password: 'hunter22' } });
  assert.equal(byEmail.status, 200);
});

test('friends: search, request, accept, list, nickname/pin/mute', async (t) => {
  if (!U.a) return t.skip();
  const search = await api('GET', `/v1/social/search?q=${U.b.name.slice(0, 6)}`, { token: U.a.token });
  assert.ok(search.json.results.some((u) => u.id === U.b.id));
  const self = await api('GET', `/v1/social/search?q=${U.a.name}`, { token: U.a.token });
  assert.ok(!self.json.results.some((u) => u.id === U.a.id), 'search excludes self');

  assert.equal((await api('POST', '/v1/social/requests/send', { token: U.a.token, body: { username: U.a.name } })).status, 400, 'cannot friend yourself');
  assert.equal((await api('POST', '/v1/social/requests/send', { token: U.a.token, body: { username: 'Nobody_Here' } })).status, 400);

  const sse = await openStream(U.b.token);
  const sent = await api('POST', '/v1/social/requests/send', { token: U.a.token, body: { username: U.b.name } });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  await sse.wait((e) => e.type === 'request:changed');
  assert.equal((await api('POST', '/v1/social/requests/send', { token: U.a.token, body: { username: U.b.name } })).status, 400, 'duplicate request rejected');

  const inbox = await api('GET', '/v1/social/requests', { token: U.b.token });
  assert.equal(inbox.json.requests.received.length, 1);
  const outbox = await api('GET', '/v1/social/requests', { token: U.a.token });
  assert.equal(outbox.json.requests.sent.length, 1);
  const reqId = inbox.json.requests.received[0].id;

  assert.equal((await api('POST', '/v1/social/requests/respond', { token: U.a.token, body: { requestId: reqId, action: 'accept' } })).status, 400, 'sender cannot accept own request');
  const acc = await api('POST', '/v1/social/requests/respond', { token: U.b.token, body: { requestId: reqId, action: 'accept' } });
  assert.equal(acc.status, 200, JSON.stringify(acc.json));
  await sse.wait((e) => e.type === 'friends:changed');
  sse.close();

  for (const [x, y] of [[U.a, U.b]]) {
    const list = await api('GET', '/v1/social/friends', { token: x.token });
    assert.ok(list.json.friends.some((f) => f.id === y.id));
    const other = await api('GET', '/v1/social/friends', { token: y.token });
    assert.ok(other.json.friends.some((f) => f.id === x.id));
  }

  // Cara: mutual request (both directions) auto-accepts; Dan declines.
  assert.equal((await api('POST', '/v1/social/requests/send', { token: U.a.token, body: { username: U.c.name } })).status, 200);
  const mutual = await api('POST', '/v1/social/requests/send', { token: U.c.token, body: { username: U.a.name } });
  assert.equal(mutual.status, 200);
  assert.ok((await api('GET', '/v1/social/friends', { token: U.c.token })).json.friends.some((f) => f.id === U.a.id), 'mutual request becomes friendship');

  await api('POST', '/v1/social/requests/send', { token: U.d.token, body: { username: U.a.name } });
  const dReq = (await api('GET', '/v1/social/requests', { token: U.a.token })).json.requests.received[0];
  assert.equal((await api('POST', '/v1/social/requests/respond', { token: U.a.token, body: { requestId: dReq.id, action: 'decline' } })).status, 200);
  assert.ok(!(await api('GET', '/v1/social/friends', { token: U.a.token })).json.friends.some((f) => f.id === U.d.id));

  const upd = await api('POST', '/v1/social/friends/update', { token: U.a.token, body: { friendId: U.b.id, nickname: 'Bobby', pinned: true, muted: true } });
  assert.equal(upd.status, 200);
  const bobby = (await api('GET', '/v1/social/friends', { token: U.a.token })).json.friends.find((f) => f.id === U.b.id);
  assert.equal(bobby.nickname, 'Bobby');
  assert.ok(bobby.pinned && bobby.muted);
});

test('direct messages: send, realtime, read, reply, react, edit, delete, paging', async (t) => {
  if (!U.a) return t.skip();
  const streamA = await openStream(U.a.token);
  const streamB = await openStream(U.b.token);
  await streamA.wait((e) => e.type === 'presence' && e.payload.userId === U.b.id);

  const sent = await api('POST', `/v1/social/relay/dm/${U.b.id}/messages`, { token: U.a.token, body: { content: 'hello bob' } });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  const m1 = sent.json.message;
  assert.equal(m1.content, 'hello bob');
  const gotB = await streamB.wait((e) => e.type === 'message:new' && e.payload.message.id === m1.id);
  assert.equal(gotB.payload.message.senderId, U.a.id);
  await streamA.wait((e) => e.type === 'message:new' && e.payload.message.id === m1.id); // sender echo for multi-device

  // typing
  assert.equal((await api('POST', '/v1/social/typing', { token: U.b.token, body: { friendId: U.a.id, isTyping: true } })).status, 200);
  await streamA.wait((e) => e.type === 'typing' || e.type === 'message:typing');

  // read receipt via open thread
  const page = await api('GET', `/v1/social/messages/${U.a.id}`, { token: U.b.token });
  assert.equal(page.status, 200);
  assert.ok(page.json.messages.some((m) => m.id === m1.id));
  await streamA.wait((e) => e.type === 'message:read');
  const afterRead = await api('GET', `/v1/social/messages/${U.b.id}`, { token: U.a.token });
  assert.ok(afterRead.json.messages.find((m) => m.id === m1.id).isRead, 'sender sees read flag');

  // reply
  const reply = await api('POST', `/v1/social/relay/dm/${U.a.id}/messages`, { token: U.b.token, body: { content: 'hey alice', replyTo: m1.id } });
  assert.equal(reply.status, 200, JSON.stringify(reply.json));
  const r1 = reply.json.message;
  assert.ok(r1.reply || r1.replyTo, 'reply carries the quoted message');
  await streamA.wait((e) => e.type === 'message:new' && e.payload.message.id === r1.id);

  // react (toggle on then off)
  const react = await api('POST', `/v1/social/messages/${m1.id}/react`, { token: U.b.token, body: { reaction: '🔥' } });
  assert.equal(react.status, 200, JSON.stringify(react.json));
  await streamA.wait((e) => e.type === 'message:reaction' && e.payload.messageId === m1.id);
  const again = await api('POST', `/v1/social/messages/${m1.id}/react`, { token: U.b.token, body: { reaction: '🔥' } });
  assert.equal(again.json.reactions.length, 0, 'same reaction toggles off');

  // edit: only author
  const edit = await api('POST', `/v1/social/relay/dm-messages/${m1.id}/edit`, { token: U.a.token, body: { content: 'hello bob!' } });
  assert.equal(edit.status, 200, JSON.stringify(edit.json));
  assert.ok(edit.json.message.editedAt);
  await streamB.wait((e) => e.type === 'message:updated' && e.payload.message.content === 'hello bob!');
  assert.equal((await api('POST', `/v1/social/relay/dm-messages/${m1.id}/edit`, { token: U.b.token, body: { content: 'hax' } })).status, 400, 'others cannot edit');
  assert.equal((await api('POST', `/v1/social/relay/dm-messages/${m1.id}/delete`, { token: U.b.token, body: {} })).status, 400, 'others cannot delete');

  // too long and empty
  assert.equal((await api('POST', `/v1/social/messages/${U.b.id}`, { token: U.a.token, body: { content: 'x'.repeat(2001) } })).status, 400);
  assert.equal((await api('POST', `/v1/social/relay/dm/${U.b.id}/messages`, { token: U.a.token, body: { content: '   ' } })).status, 400);

  // legacy send path still works
  const legacy = await api('POST', `/v1/social/messages/${U.b.id}`, { token: U.a.token, body: { content: 'legacy path' } });
  assert.equal(legacy.status, 200);

  // delete
  const del = await api('POST', `/v1/social/relay/dm-messages/${legacy.json.message.id}/delete`, { token: U.a.token, body: {} });
  assert.equal(del.status, 200);
  assert.ok(del.json.message.isDeleted);

  // paging
  for (let i = 0; i < 12; i += 1) await api('POST', `/v1/social/relay/dm/${U.b.id}/messages`, { token: U.a.token, body: { content: `bulk ${i}` } });
  const p1 = await api('GET', `/v1/social/relay/dm/${U.b.id}/messages?limit=5`, { token: U.a.token });
  assert.equal(p1.json.messages.length, 5);
  assert.equal(p1.json.hasMore, true);
  const oldest = Math.min(...p1.json.messages.map((m) => m.createdAt));
  const p2 = await api('GET', `/v1/social/relay/dm/${U.b.id}/messages?limit=5&before=${oldest}`, { token: U.a.token });
  assert.ok(p2.json.messages.every((m) => m.createdAt <= oldest));
  assert.ok(!p2.json.messages.some((m) => p1.json.messages.some((x) => x.id === m.id)), 'pages do not overlap');

  // conversations snapshot + polling fallback
  const convo = await api('GET', '/v1/social/conversations?perFriend=3', { token: U.a.token });
  assert.ok(convo.json.conversations[U.b.id]);
  const since = await api('GET', `/v1/social/updates?since=${Date.now() - 60_000}`, { token: U.b.token });
  assert.equal(since.status, 200);

  // non-friends cannot talk
  assert.equal((await api('POST', `/v1/social/relay/dm/${U.d.id}/messages`, { token: U.a.token, body: { content: 'hi' } })).status, 400, 'non-friend DM rejected');

  streamA.close(); streamB.close();
});

test('uploads: allowed types, rejected types, media served, attachment message', async (t) => {
  if (!U.a) return t.skip();
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const up = await api('POST', '/v1/social/upload', { token: U.a.token, body: { data: png, name: 'pixel.png' } });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  const media = await fetch(up.json.url.replace(/^https?:\/\/[^/]+/, BASE));
  assert.equal(media.status, 200);
  assert.match(media.headers.get('content-type'), /image\/png/);
  assert.equal((await api('POST', '/v1/social/upload', { token: U.a.token, body: { data: 'data:text/html;base64,PGI+aGk8L2I+', name: 'x.html' } })).status, 400, 'html rejected');
  assert.equal((await api('POST', '/v1/social/upload', { token: U.a.token, body: { data: 'data:image/png;base64,', name: 'empty.png' } })).status, 400);
  assert.equal((await api('POST', '/v1/social/upload', { body: { data: png } })).status, 401);
  const msg = await api('POST', `/v1/social/relay/dm/${U.b.id}/messages`, { token: U.a.token, body: { content: '', mediaUrl: up.json.url, mediaName: 'pixel.png', mediaKind: 'image' } });
  assert.equal(msg.status, 200, JSON.stringify(msg.json));
  assert.ok(msg.json.message.mediaUrl);
  assert.equal((await fetch(`${BASE}/v1/social/media/..%2F..%2Fetc%2Fpasswd`)).status >= 400, true, 'no traversal');
});

test('presence and live counter', async (t) => {
  if (!U.a) return t.skip();
  const streamB = await openStream(U.b.token);
  const pres = await api('POST', '/v1/social/presence', { token: U.a.token, body: { status: 'in-game', activity: 'Playing Minecraft', serverAddress: 'mc.example.net' } });
  assert.equal(pres.status, 200);
  const ev = await streamB.wait((e) => e.type === 'presence' && e.payload.userId === U.a.id && e.payload.status === 'in-game');
  assert.equal(ev.payload.serverAddress, 'mc.example.net');
  const friends = await api('GET', '/v1/social/friends', { token: U.b.token });
  const alice = friends.json.friends.find((f) => f.id === U.a.id);
  assert.equal(alice.status, 'in-game');
  const back = await api('POST', '/v1/social/presence', { token: U.a.token, body: { status: 'online', activity: 'In Launcher' } });
  assert.equal(back.status, 200);
  await streamB.wait((e) => e.type === 'presence' && e.payload.userId === U.a.id && e.payload.status === 'online' && e.payload.activity === 'In Launcher');
  const stats = await api('GET', '/v1/social/stats');
  assert.equal(stats.status, 200);
  assert.ok(stats.json.realOnlineUsers >= 1);
  streamB.close();
  // disconnect marks offline for friends
  const streamC = await openStream(U.c.token);
  const streamA = await openStream(U.a.token);
  await streamC.wait((e) => e.type === 'presence' && e.payload.userId === U.a.id && e.payload.status === 'online');
  streamA.close();
  await streamC.wait((e) => e.type === 'presence' && e.payload.userId === U.a.id && e.payload.status === 'offline');
  // a second window of the same account keeps the user online until the last one closes
  const streamC2 = await openStream(U.c.token);
  const streamA2 = await openStream(U.a.token);
  const streamA3 = await openStream(U.a.token);
  await streamC2.wait((e) => e.type === 'presence' && e.payload.userId === U.a.id && e.payload.status === 'online');
  streamA2.close();
  await sleep(400);
  assert.ok(!streamC2.events.some((e) => e.type === 'presence' && e.payload.status === 'offline'), 'still online with one window left');
  streamA3.close();
  await streamC2.wait((e) => e.type === 'presence' && e.payload.userId === U.a.id && e.payload.status === 'offline');
  const seen = (await api('GET', '/v1/social/friends', { token: U.c.token })).json.friends.find((f) => f.id === U.a.id);
  assert.equal(seen.status, 'offline', 'friends list reflects offline immediately');
  streamC.close(); streamC2.close();
});

test('groups: create, messages, realtime, roles, members, prefs, leave, delete', async (t) => {
  if (!U.a) return t.skip();
  const G = (route = '') => `/v1/social/relay/groups${route}`;
  const sB = await openStream(U.b.token);
  const sC = await openStream(U.c.token);

  assert.equal((await api('POST', G(), { token: U.a.token, body: { name: '' } })).status, 400, 'name required');
  const created = await api('POST', G(), { token: U.a.token, body: { name: 'Raid Squad', description: 'weekend raids', memberIds: [U.b.id, U.c.id] } });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const gid = created.json.group.id;
  await sB.wait((e) => e.type === 'group:created');
  assert.equal(created.json.group.memberCount, 3);

  assert.equal((await api('POST', G(), { token: U.a.token, body: { name: 'Sneaky', memberIds: [U.d.id] } })).status, 400, 'cannot add non-friends');

  const list = await api('GET', G(), { token: U.b.token });
  assert.ok(list.json.groups.some((g) => g.id === gid));
  assert.equal((await api('GET', G(`/${gid}`), { token: U.d.token })).status, 400, 'outsider cannot read group');

  // messaging
  const sent = await api('POST', G(`/${gid}/messages`), { token: U.a.token, body: { content: 'raid at 8' } });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  const gm = sent.json.message;
  const ev = await sB.wait((e) => e.type === 'group:message' && e.payload.message.id === gm.id);
  assert.equal(ev.payload.groupId, gid);
  await sC.wait((e) => e.type === 'group:message' && e.payload.message.id === gm.id);
  assert.equal((await api('POST', G(`/${gid}/messages`), { token: U.d.token, body: { content: 'let me in' } })).status, 400, 'outsider cannot post');

  const reply = await api('POST', G(`/${gid}/messages`), { token: U.b.token, body: { content: 'on it', replyTo: gm.id } });
  assert.equal(reply.status, 200, JSON.stringify(reply.json));
  assert.ok(reply.json.message.reply || reply.json.message.replyTo);

  // unread + read
  const unread = (await api('GET', G(), { token: U.c.token })).json.groups.find((g) => g.id === gid);
  assert.ok(unread.unreadCount >= 2, 'unread counted for members');
  const read = await api('POST', G(`/${gid}/read`), { token: U.c.token, body: {} });
  assert.equal(read.status, 200);
  assert.equal((await api('GET', G(), { token: U.c.token })).json.groups.find((g) => g.id === gid).unreadCount, 0);

  // typing
  assert.equal((await api('POST', G(`/${gid}/typing`), { token: U.b.token, body: { isTyping: true } })).status, 200);
  await sC.wait((e) => e.type === 'group:typing' && e.payload.userId === U.b.id);

  // reactions
  const re = await api('POST', `/v1/social/relay/messages/${gm.id}/react`, { token: U.c.token, body: { reaction: '👍' } });
  assert.equal(re.status, 200, JSON.stringify(re.json));
  await sB.wait((e) => e.type === 'group:message:reaction' && e.payload.messageId === gm.id);

  // edit / delete permissions
  const ed = await api('POST', `/v1/social/relay/messages/${gm.id}/edit`, { token: U.a.token, body: { content: 'raid at 9' } });
  assert.equal(ed.status, 200, JSON.stringify(ed.json));
  await sB.wait((e) => e.type === 'group:message:updated' && e.payload.message.content === 'raid at 9');
  assert.equal((await api('POST', `/v1/social/relay/messages/${gm.id}/edit`, { token: U.b.token, body: { content: 'nope' } })).status, 400);
  assert.equal((await api('POST', `/v1/social/relay/messages/${reply.json.message.id}/delete`, { token: U.c.token, body: {} })).status, 400, 'plain members cannot delete others');
  const delOwn = await api('POST', `/v1/social/relay/messages/${reply.json.message.id}/delete`, { token: U.b.token, body: {} });
  assert.equal(delOwn.status, 200);

  // history
  const hist = await api('GET', G(`/${gid}/messages?limit=10`), { token: U.b.token });
  assert.ok(hist.json.messages.length >= 2);

  // settings: owner/admin only
  assert.equal((await api('POST', G(`/${gid}/update`), { token: U.b.token, body: { name: 'Hijack' } })).status, 400, 'member cannot rename');
  const rename = await api('POST', G(`/${gid}/update`), { token: U.a.token, body: { name: 'Raid Squad II', description: 'updated' } });
  assert.equal(rename.status, 200, JSON.stringify(rename.json));
  assert.equal(rename.json.group.name, 'Raid Squad II');
  await sB.wait((e) => e.type === 'group:updated' && e.payload.group.name === 'Raid Squad II');

  // members + roles
  assert.equal((await api('POST', G(`/${gid}/members`), { token: U.b.token, body: { userIds: [U.d.id] } })).status, 400, 'member cannot invite');
  await api('POST', '/v1/social/requests/send', { token: U.a.token, body: { username: U.d.name } });
  const dInbox = (await api('GET', '/v1/social/requests', { token: U.d.token })).json.requests.received[0];
  await api('POST', '/v1/social/requests/respond', { token: U.d.token, body: { requestId: dInbox.id, action: 'accept' } });
  const add = await api('POST', G(`/${gid}/members`), { token: U.a.token, body: { userIds: [U.d.id] } });
  assert.equal(add.status, 200, JSON.stringify(add.json));
  assert.equal(add.json.group.memberCount, 4);
  const promote = await api('POST', G(`/${gid}/members/role`), { token: U.a.token, body: { userId: U.b.id, role: 'admin' } });
  assert.equal(promote.status, 200, JSON.stringify(promote.json));
  const sD = await openStream(U.d.token);
  const kick = await api('POST', G(`/${gid}/members/remove`), { token: U.b.token, body: { userId: U.d.id } });
  assert.equal(kick.status, 200, JSON.stringify(kick.json));
  assert.equal(kick.json.group.memberCount, 3);
  assert.equal((await api('POST', G(`/${gid}/messages`), { token: U.d.token, body: { content: 'still here?' } })).status, 400, 'removed member cannot post');
  assert.equal((await api('POST', G(`/${gid}/members/remove`), { token: U.b.token, body: { userId: U.a.id } })).status, 400, 'cannot remove the owner');
  sD.close();

  // prefs are per user
  const prefs = await api('POST', G(`/${gid}/prefs`), { token: U.c.token, body: { pinned: true, muted: true } });
  assert.equal(prefs.status, 200, JSON.stringify(prefs.json));
  const mine = (await api('GET', G(), { token: U.c.token })).json.groups.find((g) => g.id === gid);
  const theirs = (await api('GET', G(), { token: U.b.token })).json.groups.find((g) => g.id === gid);
  assert.ok(mine.pinned && mine.muted);
  assert.ok(!theirs.pinned && !theirs.muted, 'prefs do not leak to other members');

  // leave / delete
  const leave = await api('POST', G(`/${gid}/leave`), { token: U.c.token, body: {} });
  assert.equal(leave.status, 200, JSON.stringify(leave.json));
  assert.ok(!(await api('GET', G(), { token: U.c.token })).json.groups.some((g) => g.id === gid));
  assert.equal((await api('POST', G(`/${gid}/delete`), { token: U.b.token, body: {} })).status, 400, 'admin cannot delete');
  const del = await api('POST', G(`/${gid}/delete`), { token: U.a.token, body: {} });
  assert.equal(del.status, 200, JSON.stringify(del.json));
  await sB.wait((e) => e.type === 'group:deleted');
  assert.ok(!(await api('GET', G(), { token: U.b.token })).json.groups.some((g) => g.id === gid));
  sB.close(); sC.close();
});

test('in-game chat: a game ticket reads and sends Relay messages, live on the mod stream', async (t) => {
  if (!U.a || !U.b) return t.skip('accounts missing');
  const ticketA = (await api('POST', '/v1/auth/game-ticket', { token: U.a.token })).json.ticket;
  const ticketB = (await api('POST', '/v1/auth/game-ticket', { token: U.b.token })).json.ticket;
  assert.match(ticketA, /^nmt1\./);
  const relayStream = await openStream(ticketB, '/v1/mod/stream?relay=1');
  const plainStream = await openStream(ticketB, '/v1/mod/stream');
  await sleep(150);

  const sent = await api('POST', `/v1/social/relay/dm/${U.b.id}/messages`, { token: ticketA, body: { content: 'gg from the game' } });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  const live = await relayStream.wait((e) => e.type === 'message:new' && e.payload.message?.content === 'gg from the game');
  assert.equal(live.payload.message.senderId, U.a.id);
  await sleep(200);
  assert.ok(!plainStream.events.some((e) => e.type === 'message:new'), 'a stream without ?relay=1 never sees message text');

  const page = await api('GET', `/v1/social/relay/dm/${U.a.id}/messages?limit=5`, { token: ticketB });
  assert.equal(page.status, 200);
  assert.ok(page.json.messages.some((m) => m.content === 'gg from the game'));

  const groups = await api('GET', '/v1/social/relay/groups', { token: ticketA });
  assert.equal(groups.status, 200);
  assert.ok(Array.isArray(groups.json.groups));
  // A ticket may chat, not manage: creating groups or touching members needs the launcher session.
  assert.equal((await api('POST', '/v1/social/relay/groups', { token: ticketA, body: { name: 'nope', memberIds: [U.b.id] } })).status, 401);
  const group = (await api('POST', '/v1/social/relay/groups', { token: U.a.token, body: { name: 'Game squad', memberIds: [U.b.id] } })).json.group;
  assert.ok(group?.id);
  assert.equal((await api('POST', `/v1/social/relay/groups/${group.id}/members/remove`, { token: ticketA, body: { memberId: U.b.id } })).status, 401);
  const gsent = await api('POST', `/v1/social/relay/groups/${group.id}/messages`, { token: ticketA, body: { content: 'squad up' } });
  assert.equal(gsent.status, 200, JSON.stringify(gsent.json));
  await relayStream.wait((e) => e.type === 'group:message' && e.payload.message?.content === 'squad up');
  const gpage = await api('GET', `/v1/social/relay/groups/${group.id}/messages`, { token: ticketB });
  assert.ok(gpage.json.messages.some((m) => m.content === 'squad up'));
  assert.equal((await api('GET', '/v1/social/relay/groups', { token: 'nmt1.bad.ticket' })).status, 401);
  relayStream.close();
  plainStream.close();
});

test('blocking and unfriending cut off messaging', async (t) => {
  if (!U.a) return t.skip();
  const blocked = await api('POST', '/v1/social/block', { token: U.a.token, body: { targetId: U.c.id } });
  assert.equal(blocked.status, 200);
  assert.ok((await api('GET', '/v1/social/blocked', { token: U.a.token })).json.blocked.some((b) => b.id === U.c.id));
  assert.ok(!(await api('GET', '/v1/social/friends', { token: U.a.token })).json.friends.some((f) => f.id === U.c.id), 'block removes friendship');
  assert.equal((await api('POST', `/v1/social/relay/dm/${U.a.id}/messages`, { token: U.c.token, body: { content: 'hi' } })).status, 400);
  assert.equal((await api('POST', '/v1/social/requests/send', { token: U.c.token, body: { username: U.a.name } })).status, 400, 'blocked user cannot re-request');
  assert.equal((await api('POST', '/v1/social/unblock', { token: U.a.token, body: { targetId: U.c.id } })).status, 200);
  assert.ok(!(await api('GET', '/v1/social/blocked', { token: U.a.token })).json.blocked.some((b) => b.id === U.c.id));

  const un = await api('DELETE', `/v1/social/friends/${U.b.id}`, { token: U.a.token });
  assert.equal(un.status, 200);
  assert.ok(!(await api('GET', '/v1/social/friends', { token: U.b.token })).json.friends.some((f) => f.id === U.a.id));
  assert.equal((await api('POST', `/v1/social/relay/dm/${U.b.id}/messages`, { token: U.a.token, body: { content: 'still there?' } })).status, 400);
});
