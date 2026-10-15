'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'native-partners-'));
process.env.NATIVE_SKIN_DATA = DATA_DIR;
process.env.NATIVE_DATA_DIR = DATA_DIR;
process.env.NATIVE_DB_PATH = path.join(DATA_DIR, 'native.db');
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

test('partners: seeded Aurex, bundled art, admin CRUD and validation', async () => {
  const adminUser = db.createUser({ email: 'partners@example.com', username: 'PartnerBoss', password: 'correct horse battery' });
  db.setUserAdmin(adminUser.id, true);
  const admin = db.createSession(adminUser.id).token;
  const user = db.createSession(db.createUser({ email: 'pleb@example.com', username: 'Pleb', password: 'correct horse battery' }).id).token;

  let r = await json('/v1/site/partners');
  assert.equal(r.status, 200);
  assert.equal(r.body.partners[0].id, 'aurex01');
  assert.match(r.body.partners[0].logo, /^http:\/\/127\.0\.0\.1:\d+\/v1\/site\/partners\/media\/aurex-logo-v1\.webp$/);
  assert.equal((await json('/v1/site/config')).body.partners.length, 1);

  const media = await fetch(new URL(r.body.partners[0].logo).pathname.replace(/^/, base));
  assert.equal(media.status, 200);
  assert.equal(media.headers.get('content-type'), 'image/webp');
  assert.equal((await fetch(`${base}/v1/site/partners/media/..%2Fsite-routes.js`)).status, 404);

  assert.equal((await call('POST', '/v1/admin/site/partners', { name: 'Nope' }, user)).status, 403);
  assert.equal((await call('POST', '/v1/admin/site/partners', { name: 'Bad', website: 'http://x.example', logo: 'https://x.example/l.png' }, admin)).status, 400);
  assert.equal((await call('POST', '/v1/admin/site/partners', { name: 'Bad', website: 'https://x.example', logo: 'javascript:alert(1)' }, admin)).status, 400);
  assert.equal((await call('POST', '/v1/admin/site/partners', { name: 'Bad', website: 'https://x.example', logo: 'https://x.example/l.png', accent: 'red' }, admin)).status, 400);

  r = await call('POST', '/v1/admin/site/partners', {
    name: 'Blocky Hosts', website: 'https://blocky.example', logo: 'https://blocky.example/logo.png',
    accent: '#22C55E', animation: 'glitch', speed: 9, intensity: 140, perks: ['Fast', '', 'Cheap'], order: 1
  }, admin);
  assert.equal(r.status, 200);
  const added = r.body.settings.partners.find((pt) => pt.name === 'Blocky Hosts');
  assert.equal(added.accent, '#22c55e');
  assert.equal(added.speed, 3);
  assert.equal(added.intensity, 100);
  assert.deepEqual(added.perks, ['Fast', 'Cheap']);
  assert.deepEqual(r.body.config.partners.map((pt) => pt.name), ['Aurex Hosting', 'Blocky Hosts']);

  r = await call('PATCH', `/v1/admin/site/partners/${added.id}`, { order: 0, animation: 'nope', enabled: true }, admin);
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.partners.find((pt) => pt.id === added.id).animation, 'aurora');

  r = await call('PATCH', '/v1/admin/site/partners/aurex01', { enabled: false }, admin);
  assert.deepEqual(r.body.config.partners.map((pt) => pt.name), ['Blocky Hosts']);

  r = await call('DELETE', `/v1/admin/site/partners/${added.id}`, undefined, admin);
  assert.equal(r.status, 200);
  r = await call('DELETE', '/v1/admin/site/partners/aurex01', undefined, admin);
  require('../server/site-routes').resetCache();
  assert.deepEqual((await json('/v1/site/partners')).body.partners, [], 'removing every partner sticks');
  assert.equal((await call('PATCH', '/v1/admin/site/partners/aurex01', { enabled: true }, admin)).status, 404);
});

test('store items can carry a partner brand, and admins can give the Partner badge', async () => {
  const adminUser = db.getUserByUsername('PartnerBoss');
  const admin = db.createSession(adminUser.id).token;
  // the seeded Aurex partner was deleted by the test above: add one back
  let r = await call('POST', '/v1/admin/site/partners', { name: 'Aurex Hosting', website: 'https://www.aurex.lk/en', logo: 'https://cdn.example/aurex.png', accent: '#8b5cf6' }, admin);
  const aurex = r.body.settings.partners.find((pt) => pt.name === 'Aurex Hosting');

  const zlib = require('node:zlib');
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const png = (w, h) => { const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; const raw = Buffer.alloc((w * 4 + 1) * h); return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64'); };

  r = await call('POST', '/v1/admin/store/items', { name: 'Branded Cape', still: png(64, 32), partner: 'nope000000' }, admin);
  assert.equal(r.status, 400, 'unknown partners are refused');
  r = await call('POST', '/v1/admin/store/items', { name: 'Branded Cape', still: png(64, 32), partner: aurex.id }, admin);
  assert.equal(r.status, 200);
  assert.equal(r.body.item.partner.name, 'Aurex Hosting');
  assert.equal(r.body.item.partner.logo, 'https://cdn.example/aurex.png');
  const catalog = await json('/v1/store/catalog');
  assert.equal(catalog.body.items.find((i) => i.id === 'branded-cape').partner.id, aurex.id);
  r = await call('PATCH', '/v1/admin/store/items/branded-cape', { partner: '' }, admin);
  assert.equal(r.body.item.partner, null, 'the brand can be removed');

  r = await call('POST', `/v1/admin/users/${adminUser.id}/badges`, { badge: 'partner', granted: true }, admin);
  assert.ok([200, 201].includes(r.status));
  assert.ok(JSON.parse(db.getUserById(adminUser.id).badges || '[]').includes('partner'));
});


test('the player directory lists the newest accounts and the total', async () => {
  const r = await json('/v1/store/users');
  assert.ok(Array.isArray(r.body.recent));
  assert.ok(r.body.recent.some((u) => u.name === 'PartnerBoss'), 'a brand-new account shows up straight away');
  assert.ok(r.body.total >= 1);
  const search = await json('/v1/store/users?q=Partner');
  assert.equal(search.body.recent, undefined);
});
