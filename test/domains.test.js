const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'native-domains-test-'));
process.env.NATIVE_DATA_DIR = DATA_DIR;
process.env.NATIVE_ADMIN_EMAILS = 'boss@test.local';
delete process.env.CLOUDFLARE_API_TOKEN;

const db = require('../server/db');
const { listen } = require('../server/server');
const domains = require('../server/domains');

test('domain autopilot is admin-only, guards input, and drives site/email choices', async () => {
  const user = db.createUser({ email: 'user@test.local', username: 'Plain', password: 'password123' });
  const boss = db.createUser({ email: 'boss@test.local', username: 'Boss', password: 'password123' });
  const userSession = db.createSession(user.id);
  const bossSession = db.createSession(boss.id);
  const server = await listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, pathname, body, token) => fetch(`${base}${pathname}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
  });
  try {
    assert.equal((await call('GET', '/v1/admin/domains')).status, 401);
    assert.equal((await call('GET', '/v1/admin/domains', null, userSession.token)).status, 403);
    const list = await (await call('GET', '/v1/admin/domains', null, bossSession.token)).json();
    assert.equal(list.ok, true);
    assert.ok(Array.isArray(list.domains));
    const bad = await call('POST', '/v1/admin/domains/settings', { cloudflareToken: 'nope' }, bossSession.token);
    assert.equal(bad.status, 400);
    const noToken = await call('POST', '/v1/admin/domains', { domain: 'example.com', website: true }, bossSession.token);
    assert.equal(noToken.status, 400);
    const backend = await call('POST', '/v1/admin/domains', { domain: 'nativelaunch.xyz', website: true }, bossSession.token);
    assert.equal(backend.status, 400);
    const primary = await (await call('GET', '/v1/domains/primary')).json();
    assert.equal(primary.api, 'https://api.nativelaunch.xyz');
    assert.equal(domains.siteUrl(), 'https://playnative.fun');
    assert.equal(domains.senderEmail(), 'noreply@playnative.fun');
    assert.equal(domains.cleanDomain('https://WWW.Example.com/path'), 'example.com');
  } finally {
    server.close();
  }
});
