const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'native-security-test-'));
process.env.NATIVE_DATA_DIR = DATA_DIR;
delete process.env.NATIVE_SKIN_PUBLIC_URL;
delete process.env.NATIVE_TRUST_PROXY;

const db = require('../server/db');
const { listen, clientIp } = require('../server/server');

const PNG = 'data:image/png;base64,' + Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(64, 1)
]).toString('base64');

async function setup(t) {
  const server = await listen(0, '127.0.0.1');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const stamp = Math.random().toString(36).slice(2, 8);
  const a = db.createUser({ email: `a-${stamp}@test.local`, username: `SecA_${stamp}`, password: 'password123' });
  const b = db.createUser({ email: `b-${stamp}@test.local`, username: `SecB_${stamp}`, password: 'password123' });
  db.getDb().prepare('INSERT INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?), (?, ?, ?)')
    .run(a.id, b.id, Date.now(), b.id, a.id, Date.now());
  const token = db.createSession(a.id).token;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  return { base, a, b, headers };
}

test('client IP only trusts X-Real-IP from the local proxy', () => {
  const fake = (remoteAddress, headers) => ({ socket: { remoteAddress }, headers });
  assert.equal(clientIp(fake('203.0.113.9', { 'cf-connecting-ip': '1.2.3.4', 'x-real-ip': '1.2.3.4' })), '203.0.113.9');
  assert.equal(clientIp(fake('127.0.0.1', { 'x-real-ip': '198.51.100.7' })), '198.51.100.7');
  assert.equal(clientIp(fake('::ffff:127.0.0.1', {})), '::ffff:127.0.0.1');
});

test('attachments must be Native uploads and are rebuilt on our origin', async (t) => {
  const { base, b, headers } = await setup(t);
  const upload = await (await fetch(`${base}/v1/social/upload`, { method: 'POST', headers, body: JSON.stringify({ data: PNG, name: 'shot.png' }) })).json();
  assert.equal(upload.ok, true);

  const evil = await fetch(`${base}/v1/social/relay/dm/${b.id}/messages`, {
    method: 'POST', headers, body: JSON.stringify({ content: 'hi', mediaUrl: 'https://grabify.example/track.png', mediaName: 'x' })
  });
  assert.equal(evil.status, 400);

  const spoofHost = upload.url.replace('127.0.0.1', 'evil.example');
  const sent = await fetch(`${base}/v1/social/relay/dm/${b.id}/messages`, {
    method: 'POST', headers, body: JSON.stringify({ content: '', mediaUrl: spoofHost, mediaName: '<b>shot</b>.png', mediaKind: 'image' })
  });
  const body = await sent.json();
  assert.equal(sent.status, 200, JSON.stringify(body));
  assert.ok(body.message.mediaUrl.startsWith(base), 'URL is rebuilt on our own origin');
  assert.equal(body.message.mediaName, 'bshot_b.png');

  // Deleting the only message that uses a file removes the file.
  const file = path.join(DATA_DIR, 'media', path.basename(new URL(body.message.mediaUrl).pathname));
  assert.ok(fs.existsSync(file));
  const del = await fetch(`${base}/v1/social/relay/dm-messages/${body.message.id}/delete`, { method: 'POST', headers, body: '{}' });
  assert.equal(del.status, 200);
  assert.equal(fs.existsSync(file), false);
});

test('API responses are not publicly cacheable and the online count is real', async (t) => {
  const { base } = await setup(t);
  const health = await fetch(`${base}/health`);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  const stats = await (await fetch(`${base}/v1/social/stats`)).json();
  assert.equal(stats.onlineUsers, stats.realOnlineUsers);
});

test('resend-code only works for a sign-up in progress', async (t) => {
  const { base } = await setup(t);
  const res = await fetch(`${base}/v1/auth/resend-code`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'victim@example.com' })
  });
  assert.equal(res.status, 400);
});

test('login is throttled after repeated failures', async (t) => {
  const { base, a } = await setup(t);
  const attempt = () => fetch(`${base}/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: a.username, password: 'wrong-password' })
  });
  const statuses = [];
  for (let i = 0; i < 11; i += 1) statuses.push((await attempt()).status);
  assert.equal(statuses[0], 401);
  assert.equal(statuses[10], 429);
});
