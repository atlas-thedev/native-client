'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'native-betaplus-'));
process.env.NATIVE_SKIN_DATA = DATA_DIR;
process.env.NATIVE_DATA_DIR = DATA_DIR;
process.env.NATIVE_DB_PATH = path.join(DATA_DIR, 'native.db');
delete process.env.NATIVE_PUBLIC_URL;

const db = require('../server/db');
const billing = require('../server/billing');
const { listen } = require('../server/server');
const modRoutes = require('../server/mod-routes');

const DAY = 86_400_000;
let server, base;
const call = async (method, p, body, token) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const user = (name) => db.createUser({ email: `${name.toLowerCase()}@example.com`, username: name, password: 'correct horse battery' });
const near = (value, expected) => assert.ok(Math.abs(value - expected) < 60_000, `${value} should be about ${expected}`);

test.after(() => {
  modRoutes.stopStreams?.();
  server?.closeAllConnections?.(); server?.close();
  try { db.closeDb(); } catch {}
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  setTimeout(() => process.exit(0), 50).unref();
});

test('beta testers get one month of Native+; old forever beta gifts become a month once', async () => {
  // before the switch: an old tester with forever beta Native+, and someone with a forever admin gift
  const old = user('OldTester');
  const vip = user('Vip');
  billing.givePlus(old.id, { note: 'Super Beta Tester' });
  billing.givePlus(vip.id, { note: 'Friend of the team' });
  assert.equal(billing.plusGift(old.id).expiresAt, null);

  server = await listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${server.address().port}`;
  const boss = user('Boss');
  db.setUserAdmin(boss.id, true);
  const admin = db.createSession(boss.id).token;
  const oldT = db.createSession(old.id).token;

  // the first request runs the switch: the old tester now ends in 30 days, the admin gift stays forever
  let r = await call('GET', '/v1/beta/me', undefined, oldT);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.perks.plus, r.body.perks.plusDays], ['month', 30]);
  near(billing.plusGift(old.id).expiresAt, Date.now() + 30 * DAY);
  assert.equal(billing.plusGift(vip.id).expiresAt, null);
  assert.ok(billing.hasPlus(old.id));

  // a newly accepted tester gets 30 days, shown on their application
  const bob = user('Bob');
  const bobT = db.createSession(bob.id).token;
  r = await call('POST', '/v1/beta/apply', { discord: 'bob#1', platform: 'windows', age: '18-24', why: 'I love testing launchers and reporting every bug I find, honestly.', agree: true }, bobT);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.application.id;
  r = await call('PATCH', `/v1/admin/beta/${id}`, { status: 'approved' }, admin);
  assert.equal(r.status, 200);
  near(r.body.application.plusEndsAt, Date.now() + 30 * DAY);
  r = await call('GET', '/v1/beta/me', undefined, bobT);
  near(r.body.application.plusEndsAt, Date.now() + 30 * DAY);
  assert.equal(billing.plusFor(bob.id).active, true);

  // a longer admin gift is not cut down by the beta month
  const carl = user('Carl');
  billing.givePlus(carl.id, { days: 365, note: 'Giveaway' });
  billing.givePlus(carl.id, { days: 30, note: 'Super Beta Tester' });
  assert.equal(billing.plusGift(carl.id).note, 'Giveaway');
  near(billing.plusGift(carl.id).expiresAt, Date.now() + 365 * DAY);

  // rejecting takes the beta month back
  await call('PATCH', `/v1/admin/beta/${id}`, { status: 'rejected' }, admin);
  assert.equal(billing.plusGift(bob.id), null);
});
