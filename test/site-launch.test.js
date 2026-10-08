'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'native-site-'));
process.env.NATIVE_SKIN_DATA = DATA_DIR;
process.env.NATIVE_DATA_DIR = DATA_DIR;
process.env.NATIVE_DB_PATH = path.join(DATA_DIR, 'native.db');
process.env.NATIVE_PRELAUNCH = '1';
delete process.env.NATIVE_PUBLIC_URL;

const db = require('../server/db');
const { listen } = require('../server/server');
const modRoutes = require('../server/mod-routes');

let server, base;
const json = async (p, o = {}) => { const r = await fetch(`${base}${p}`, o); return { status: r.status, body: await r.json().catch(() => null) }; };
const call = (method, p, body, token) => json(p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

test.before(async () => { server = await listen(0, '127.0.0.1'); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => {
  modRoutes.stopStreams();
  server.closeAllConnections?.(); server.close();
  try { db.closeDb(); } catch {}
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  setTimeout(() => process.exit(0), 50).unref();
});

test('pre-launch: config, store lock, founder pick, offers, votes and admin controls', async () => {
  const adminUser = db.createUser({ email: 'boss@example.com', username: 'Boss', password: 'correct horse battery' });
  db.setUserAdmin(adminUser.id, true);
  const admin = db.createSession(adminUser.id).token;
  const user = db.createSession(db.createUser({ email: 'early@example.com', username: 'Early', password: 'correct horse battery' }).id).token;

  let r = await json('/v1/site/config');
  assert.equal(r.status, 200);
  assert.equal(r.body.launch.prelaunch, true);
  assert.equal(r.body.launch.lockStore, true);

  r = await call('GET', '/v1/admin/site', undefined, admin);
  assert.equal(r.status, 200);
  const catalog = (await json('/v1/store/catalog')).body.items;
  const ids = catalog.filter((i) => !i.exclusive && i.kind === 'cape').slice(0, 3).map((i) => i.id);
  r = await call('POST', '/v1/admin/site', { launch: { founderCapes: ids } }, admin);
  assert.deepEqual(r.body.config.launch.founderCapes, ids);
  assert.equal((await call('GET', '/v1/admin/site', undefined, user)).status, 403);

  // every cape costs 1.99
  r = await call('POST', '/v1/admin/site/prices', { price: 1.99 }, admin);
  assert.equal(r.status, 200);
  const priced = (await json('/v1/store/catalog')).body.items.filter((i) => !i.exclusive);
  assert.ok(priced.every((i) => i.price === 1.99));

  // store locked for normal users
  r = await call('POST', '/v1/store/claim', { itemId: ids[1] }, user);
  assert.equal(r.status, 423);

  // founder pick: exactly one
  r = await call('GET', '/v1/site/founder', undefined, user);
  assert.equal(r.body.eligible, true);
  assert.equal(r.body.picked, null);
  r = await call('POST', '/v1/site/founder', { itemId: ids[0] }, user);
  assert.equal(r.status, 200);
  assert.equal(r.body.picked, ids[0]);
  r = await call('POST', '/v1/site/founder', { itemId: ids[1] }, user);
  assert.equal(r.status, 409);
  r = await call('GET', '/v1/store/me', undefined, user);
  assert.ok(r.body.owned.some((o) => o.id === ids[0] && o.source === 'founder'));
  r = await call('POST', '/v1/store/equip', { itemId: ids[0] }, user);
  assert.equal(r.status, 200);
  r = await call('POST', '/v1/store/unclaim', { itemId: ids[0] }, user);
  assert.equal(r.status, 403);

  // offers lower the price
  r = await call('POST', '/v1/admin/site/offers', { title: 'Launch sale', percent: 50, itemIds: [ids[1]] }, admin);
  assert.equal(r.status, 200);
  const sale = (await json('/v1/store/catalog')).body.items.find((i) => i.id === ids[1]);
  assert.equal(sale.salePrice, 1);
  assert.equal(sale.offer.percent, 50);
  assert.equal((await json('/v1/site/config')).body.offers.length, 1);
  const offerId = r.body.settings.offers[0].id;
  r = await call('DELETE', `/v1/admin/site/offers/${offerId}`, undefined, admin);
  assert.equal(r.body.settings.offers.length, 0);

  // maintenance + announcement
  r = await call('POST', '/v1/admin/site', { maintenance: { enabled: true, message: 'Brb' }, announcement: { enabled: true, text: 'Hi', href: '/vote' } }, admin);
  assert.equal(r.body.config.maintenance.enabled, true);
  assert.equal(r.body.config.announcement.href, '/vote');
  r = await call('POST', '/v1/admin/site', { announcement: { href: 'javascript:alert(1)' } }, admin);
  assert.equal(r.status, 400);

  // votes
  r = await call('POST', '/v1/admin/polls', { title: 'Next cape', options: [{ label: 'Frog' }, { label: 'Moon' }], results: 'after_vote' }, admin);
  assert.equal(r.status, 200);
  const poll = r.body.polls[0];
  r = await json('/v1/polls');
  assert.equal(r.body.polls[0].showResults, false);
  assert.equal((await call('POST', `/v1/polls/${poll.id}/vote`, { optionId: poll.options[0].id })).status, 401);
  r = await call('POST', `/v1/polls/${poll.id}/vote`, { optionId: poll.options[1].id }, user);
  assert.equal(r.status, 200);
  assert.equal(r.body.poll.myVote, poll.options[1].id);
  assert.equal(r.body.poll.options[1].votes, 1);
  r = await call('PATCH', `/v1/admin/polls/${poll.id}`, { status: 'closed' }, admin);
  assert.equal(r.status, 200);
  assert.equal((await call('POST', `/v1/polls/${poll.id}/vote`, { optionId: poll.options[0].id }, user)).status, 410);
  // closed: the most-voted option wins, the admin can name another, and Store items show on options
  r = await json('/v1/polls');
  assert.equal(r.body.polls[0].winnerId, poll.options[1].id);
  r = await call('PATCH', `/v1/admin/polls/${poll.id}`, { winnerOptionId: poll.options[0].id }, admin);
  assert.equal(r.body.polls[0].winnerId, poll.options[0].id);
  assert.equal(r.body.polls[0].winnerPicked, true);
  assert.equal((await call('PATCH', `/v1/admin/polls/${poll.id}`, { winnerOptionId: 'nope00' }, admin)).status, 400);
  const allItems = (await json('/v1/store/catalog')).body.items;
  const cos = allItems.find((i) => i.kind === 'cosmetic') || allItems.find((i) => !ids.includes(i.id));
  if (cos) {
    r = await call('POST', '/v1/admin/polls', { title: 'Next hat', kind: 'cosmetic', options: [{ itemId: cos.id }, { label: 'Other' }] }, admin);
    assert.equal(r.status, 200);
    const made = r.body.polls[0];
    assert.equal(made.options[0].label, cos.name);
    assert.equal(made.options[0].item.id, cos.id);
    assert.ok(made.options[0].item.kind === 'cosmetic' ? made.options[0].item.modelUrl : made.options[0].image);
    assert.equal(made.winnerId, null);
    // founder gifts may be cosmetics too
    r = await call('POST', '/v1/admin/site', { launch: { founderCapes: [...ids, cos.id] } }, admin);
    assert.ok(r.body.config.launch.founderCapes.includes(cos.id));
    r = await call('POST', '/v1/admin/site', { launch: { founderCapes: ids } }, admin);
  }
  assert.equal((await call('POST', '/v1/admin/polls', { title: 'Bad', options: [{ itemId: 'no-such-item' }, { label: 'B' }] }, admin)).status, 400);

  // launch: unlock
  r = await call('POST', '/v1/admin/site', { launch: { prelaunch: false } }, admin);
  assert.equal(r.body.config.launch.launched, true);
  r = await call('POST', '/v1/store/claim', { itemId: ids[1] }, user);
  assert.equal(r.status, 402); // paid now, not locked
});

test('beta program: apply, admin review grants badge + cape + lifetime Native+, reject revokes', async () => {
  const billing = require('../server/billing');
  const bossUser = db.createUser({ email: 'boss3@example.com', username: 'BossThree', password: 'correct horse battery' });
  db.setUserAdmin(bossUser.id, true);
  const boss = db.createSession(bossUser.id).token;
  const tester = db.createUser({ email: 'tester@example.com', username: 'Tester', password: 'correct horse battery' });
  const tok = db.createSession(tester.id).token;
  const badges = () => JSON.parse(db.getUserById(tester.id).badges || '[]');

  // nobody gets a badge just for signing up
  assert.ok(!badges().includes('super_beta_tester'));
  let r = await call('GET', '/v1/beta/me', undefined, tok);
  assert.equal(r.status, 200);
  assert.equal(r.body.open, true);
  assert.equal(r.body.application, null);
  assert.equal((await call('GET', '/v1/beta/me')).status, 401);

  const form = { discord: 'tester#1', platform: 'windows', age: '18-24', specs: 'Ryzen 5, RTX 3060, 16GB', versions: ['1.21.1'], hours: 12, playstyle: ['survival'], experience: 'Tested mods', why: 'I love breaking launchers and writing very detailed bug reports for them.', timezone: 'UTC', agree: true };
  r = await call('POST', '/v1/beta/apply', { ...form, why: 'short' }, tok);
  assert.equal(r.status, 400);
  r = await call('POST', '/v1/beta/apply', { ...form, age: 'under13' }, tok);
  assert.equal(r.status, 400);
  r = await call('POST', '/v1/beta/apply', form, tok);
  assert.equal(r.status, 200);
  assert.equal(r.body.application.status, 'pending');

  assert.equal((await call('GET', '/v1/admin/beta', undefined, tok)).status, 403);
  r = await call('GET', '/v1/admin/beta?status=pending', undefined, boss);
  assert.equal(r.status, 200);
  const app = r.body.applications.find((a) => a.username === 'Tester');
  assert.ok(app);
  assert.equal(r.body.counts.pending >= 1, true);

  r = await call('PATCH', `/v1/admin/beta/${app.id}`, { status: 'approved', note: 'Welcome aboard!' }, boss);
  assert.equal(r.status, 200);
  assert.ok(badges().includes('super_beta_tester'));
  assert.equal(billing.hasPlus(tester.id), true);
  assert.equal(billing.plusFor(tester.id).endsAt, null, 'lifetime');
  assert.equal(billing.ownedSource(tester.id, 'super-beta-tester'), 'beta');
  r = await call('GET', '/v1/beta/me', undefined, tok);
  assert.equal(r.body.application.status, 'approved');
  assert.equal(r.body.application.note, 'Welcome aboard!');
  assert.equal((await call('POST', '/v1/beta/apply', form, tok)).status, 409);

  r = await call('PATCH', `/v1/admin/beta/${app.id}`, { status: 'rejected' }, boss);
  assert.ok(!badges().includes('super_beta_tester'));
  assert.equal(billing.hasPlus(tester.id), false);
  assert.ok(!billing.ownedSource(tester.id, 'super-beta-tester'));
  assert.equal((await call('POST', '/v1/beta/apply', form, tok)).status, 409, 'cool-down before re-applying');

  // closing applications
  await call('POST', '/v1/admin/site', { beta: { open: false } }, boss);
  const other = db.createSession(db.createUser({ email: 'late2@example.com', username: 'LateTwo', password: 'correct horse battery' }).id).token;
  assert.equal((await call('POST', '/v1/beta/apply', form, other)).status, 423);
  assert.equal((await json('/v1/site/config')).body.beta.open, false);
});
