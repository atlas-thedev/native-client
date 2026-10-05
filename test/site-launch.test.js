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
  const ids = catalog.filter((i) => !i.exclusive).slice(0, 3).map((i) => i.id);
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

  // launch: unlock
  r = await call('POST', '/v1/admin/site', { launch: { prelaunch: false } }, admin);
  assert.equal(r.body.config.launch.launched, true);
  r = await call('POST', '/v1/store/claim', { itemId: ids[1] }, user);
  assert.equal(r.status, 402); // paid now, not locked
});
