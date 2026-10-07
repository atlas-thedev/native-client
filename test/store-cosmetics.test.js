'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'native-cosmetics-'));
process.env.NATIVE_SKIN_DATA = DATA_DIR;
process.env.NATIVE_DATA_DIR = DATA_DIR;
process.env.NATIVE_DB_PATH = path.join(DATA_DIR, 'native.db');
delete process.env.NATIVE_SKIN_PUBLIC_URL;
delete process.env.NATIVE_PUBLIC_URL;

const db = require('../server/db');
const { listen } = require('../server/server');
const modRoutes = require('../server/mod-routes');
const cosmetics = require('../server/cosmetics');

function png(width, height, shade = 128) {
  const crc = (buf) => { const out = Buffer.alloc(4); out.writeUInt32BE(zlib.crc32(buf) >>> 0); return out; };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    return Buffer.concat([length, body, crc(body)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width, shade)]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
const b64 = (buffer) => buffer.toString('base64');
const HASH = /^[a-f0-9]{64}$/;

let server;
let base;
async function json(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  return { status: response.status, body: await response.json().catch(() => null) };
}
const call = (method, pathname, body, token) => json(pathname, {
  method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body)
});
const account = (name) => {
  const user = db.createUser({ email: `${name.toLowerCase()}@example.com`, username: name, password: 'correct horse battery' });
  return { user, token: db.createSession(user.id).token };
};
// nothing in the store is free: tests that wear items own them first
const own = (user, ...ids) => { for (const id of ids) db.getDb().prepare('INSERT OR IGNORE INTO store_owned (user_id, item_id, acquired_at, source) VALUES (?, ?, ?, ?)').run(user.id, id, Date.now(), 'plus'); };
const entryOf = async (name) => (await json('/v1/skins/directory')).body.entries.find((e) => e.n === name);

test.before(async () => {
  server = await listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  modRoutes.stopStreams();
  server.closeAllConnections?.();
  server.close();
  try { db.closeDb(); } catch {}
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  setTimeout(() => process.exit(0), 50).unref();
});

test('model validation follows the mod limits', () => {
  const ok = cosmetics.validateModel({ format: 1, texture: [64, 32], parts: [{ id: 'a', attach: 'head', cubes: [{ origin: [0, 0, 0], size: [1, 1, 1] }], anim: [{ type: 'spin' }] }] });
  assert.deepEqual(ok, { parts: 1, cubes: 1, animated: true, texture: [64, 32] });
  assert.equal(cosmetics.validateModel({ parts: [{ cubes: [{ size: [1, 2, 3] }] }] }).animated, false);
  assert.throws(() => cosmetics.validateModel('nope'), /valid JSON/);
  assert.throws(() => cosmetics.validateModel({ format: 2, parts: [] }), /format/);
  assert.throws(() => cosmetics.validateModel({ parts: [] }), /no parts/);
  assert.throws(() => cosmetics.validateModel({ parts: [{ attach: 'tail', cubes: [{ size: [1, 1, 1] }] }] }), /attach/);
  assert.throws(() => cosmetics.validateModel({ parts: [{ cubes: [{ size: [1, 1] }] }] }), /size/);
  // no part/cube count limits any more (only the 1 MB model size): big models are fine
  assert.equal(cosmetics.validateModel({ parts: Array.from({ length: 97 }, () => ({ cubes: [{ size: [1, 1, 1] }] })) }).parts, 97);
  assert.throws(() => cosmetics.validateModel({ parts: [{ id: 'empty' }] }), /no cubes/);
});

/* No cosmetics ship with the server: admins upload them. These are made through the admin API. */
const SEEDED = { 'propeller-cap': 'hats', 'royal-crown': 'hats', 'top-hat': 'hats', 'pixel-shades': 'glasses', 'angel-wings': 'back', 'street-sneakers': 'shoes', 'rocket-boots': 'shoes' };
const boxModel = (attach, spin = false) => ({ format: 1, texture: [32, 32], parts: [{ id: 'box', attach, cubes: [{ origin: [-2, -10, -2], size: [4, 2, 4], uv: [0, 0] }], anim: spin ? [{ type: 'spin', speed: 90 }] : [] }] });
const ATTACH_OF = { hats: 'head', glasses: 'head', back: 'body', shoes: 'rightLeg' };
async function seedCosmetics() {
  const admin = account('SeedAdmin');
  db.getDb().prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin.user.id);
  for (const [id, slot] of Object.entries(SEEDED)) {
    const r = await call('POST', '/v1/admin/store/items', { kind: 'cosmetic', id, slot, name: id.replace(/-/g, ' '), price: 0, model: boxModel(ATTACH_OF[slot], id === 'propeller-cap'), texture: b64(png(32, 32)), thumb: b64(png(64, 64, 90)), featured: id === 'propeller-cap' }, admin.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
}

test('no 3D cosmetics are built in; admin-made ones list with model, texture and thumbnail', async () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'store', 'catalog.json'), 'utf8')).items;
  assert.equal(shipped.filter((i) => i.kind === 'cosmetic' || cosmetics.isSlot(i.section)).length, 0, 'no hardcoded cosmetics');
  let catalog = (await json('/v1/store/catalog')).body;
  for (const slot of cosmetics.SLOTS) assert.ok(catalog.sections.some((s) => s.id === slot), `section ${slot}`);
  assert.equal(catalog.items.filter((i) => i.kind === 'cosmetic').length, 0);

  await seedCosmetics();
  catalog = (await json('/v1/store/catalog')).body;
  for (const [id, slot] of Object.entries(SEEDED)) {
    const item = catalog.items.find((i) => i.id === id);
    assert.ok(item, `${id} is listed`);
    assert.equal(item.kind, 'cosmetic');
    assert.equal(item.slot, slot);
    assert.equal(item.animated, false, 'cosmetics are never animated capes');
    const model = await fetch(item.modelUrl);
    assert.equal(model.status, 200);
    const info = cosmetics.validateModel(Buffer.from(await model.arrayBuffer()));
    assert.equal(item.motion, info.animated);
    assert.equal((await fetch(item.textureUrl)).status, 200);
    assert.equal((await fetch(item.stillUrl)).status, 200);
  }
  assert.ok(catalog.items.filter((i) => i.kind === 'cape').every((i) => !i.modelUrl));
  const cap = catalog.items.find((i) => i.id === 'propeller-cap');
  assert.equal(cap.motion, true);
  assert.equal(cap.featured, true);
});

test('built-in cosmetics from older deploys are removed from a saved catalogue', async () => {
  const store = require('../server/store-routes');
  const file = path.join(DATA_DIR, 'store', 'catalog.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const old = { ...saved.items.find((i) => i.id === 'top-hat'), id: 'old-builtin-hat', bundled: true };
  saved.items.push(old);
  fs.writeFileSync(file, JSON.stringify(saved));
  db.getDb().prepare('INSERT OR IGNORE INTO store_owned (user_id, item_id, acquired_at, source) VALUES (?, ?, ?, ?)').run('someone', 'old-builtin-hat', Date.now(), 'free');
  store.resetCatalog();
  const catalog = (await json('/v1/store/catalog')).body;
  assert.equal(catalog.items.find((i) => i.id === 'old-builtin-hat'), undefined);
  assert.ok(catalog.items.find((i) => i.id === 'top-hat'), 'admin-made cosmetics stay');
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM store_owned WHERE item_id = ?').get('old-builtin-hat').n, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).items.some((i) => i.id === 'old-builtin-hat'), false);
});

test('wear one cosmetic per slot: profile, mod directory, CSL document and /me follow', async () => {
  const { user, token } = account('HatFan');
  own(user, 'propeller-cap', 'angel-wings', 'pixel-shades', 'street-sneakers', 'royal-crown', 'aurora');
  assert.equal((await call('POST', '/v1/store/equip', { itemId: 'propeller-cap' })).status, 401);

  let r = await call('POST', '/v1/store/equip', { itemId: 'propeller-cap' }, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.wearing, { hats: 'propeller-cap' });
  assert.equal(r.body.equipped, null, 'a hat is not a cape');
  r = await call('POST', '/v1/store/equip', { itemId: 'angel-wings' }, token);
  r = await call('POST', '/v1/store/equip', { itemId: 'pixel-shades' }, token);
  r = await call('POST', '/v1/store/equip', { itemId: 'street-sneakers' }, token);
  assert.deepEqual(r.body.wearing, { hats: 'propeller-cap', back: 'angel-wings', glasses: 'pixel-shades', shoes: 'street-sneakers' });
  // a second hat replaces the first; a cape sits next to the cosmetics
  r = await call('POST', '/v1/store/equip', { itemId: 'royal-crown' }, token);
  assert.equal(r.body.wearing.hats, 'royal-crown');
  r = await call('POST', '/v1/store/equip', { itemId: 'aurora' }, token);
  assert.equal(r.body.equipped, 'aurora');
  assert.equal(Object.keys(r.body.wearing).length, 4);

  const me = await json('/v1/store/me', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(me.body.wearing.back, 'angel-wings');
  assert.ok(me.body.owned.some((o) => o.id === 'royal-crown'));

  const entry = await entryOf('HatFan');
  assert.equal(entry.k.length, 4);
  for (const ref of entry.k) { assert.match(ref.m, HASH); assert.match(ref.x, HASH); }
  assert.ok(entry.k.some((ref) => ref.i === 'royal-crown'));
  assert.ok(entry.a, 'the animated cape still animates');

  const doc = (await json('/csl/HatFan.json')).body;
  assert.equal(doc.cosmetics.length, 4);
  const crown = doc.cosmetics.find((c) => c.slot === 'hats');
  assert.equal(crown.id, 'royal-crown');
  assert.equal((await fetch(crown.modelUrl)).status, 200);

  // a wardrobe sync (launcher) never drops the cosmetics
  const sync = await call('POST', '/v1/wardrobe', { model: 'default', skin: b64(png(64, 64, 200)) }, token);
  assert.equal(sync.status, 200, JSON.stringify(sync.body));
  assert.equal((await entryOf('HatFan')).k.length, 4);

  // take one slot off, then the cape; the rest stays
  r = await call('POST', '/v1/store/equip', { slot: 'glasses', itemId: null }, token);
  assert.equal(r.body.wearing.glasses, undefined);
  assert.equal(r.body.wearing.hats, 'royal-crown');
  r = await call('POST', '/v1/store/equip', { itemId: null }, token);
  assert.equal(r.body.equipped, null);
  assert.equal(Object.keys(r.body.wearing).length, 3);
  assert.equal((await call('POST', '/v1/store/equip', { slot: 'tail', itemId: null }, token)).status, 400);

  // unclaiming a worn cosmetic takes it off
  r = await call('POST', '/v1/store/unclaim', { itemId: 'angel-wings' }, token);
  assert.equal(r.status, 200);
  assert.equal(r.body.wearing.back, undefined);
  assert.equal((await entryOf('HatFan')).k.length, 2);
});

test('a thumbnail is never a wearable cape', async () => {
  const { token } = account('CapeSneak');
  const item = (await json('/v1/store/catalog')).body.items.find((i) => i.id === 'top-hat');
  const thumb = Buffer.from(await (await fetch(item.stillUrl)).arrayBuffer());
  const r = await call('POST', '/v1/wardrobe', { model: 'default', skin: b64(png(64, 64, 10)), cape: b64(thumb) }, token);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.capes, []);
});

test('cosmetics-only players are in the mod directory; taking everything off removes them', async () => {
  const { user, token } = account('ShoeOnly');
  own(user, 'rocket-boots');
  await call('POST', '/v1/store/equip', { itemId: 'rocket-boots' }, token);
  const entry = await entryOf('ShoeOnly');
  assert.ok(entry, 'listed with only shoes');
  assert.equal(entry.s, null);
  assert.equal(entry.c, null);
  assert.equal(entry.k[0].i, 'rocket-boots');
  await call('POST', '/v1/store/equip', { slot: 'shoes', itemId: null }, token);
  assert.equal(await entryOf('ShoeOnly'), undefined);
});

test('admin: create, edit, equip, revoke and delete a custom cosmetic', async () => {
  const admin = account('CosAdmin');
  db.getDb().prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin.user.id);
  const fan = account('CosFan');
  const model = { format: 1, texture: [32, 32], parts: [{ id: 'box', attach: 'head', cubes: [{ origin: [-2, -10, -2], size: [4, 2, 4], uv: [0, 0] }], anim: [{ type: 'bob', speed: 1, amplitude: 1 }] }] };
  let r = await call('POST', '/v1/admin/store/items', { kind: 'cosmetic', slot: 'hats', name: 'Test Box', model, texture: b64(png(32, 32)), thumb: b64(png(64, 64)) }, fan.token);
  assert.equal(r.status, 403);
  r = await call('POST', '/v1/admin/store/items', { kind: 'cosmetic', slot: 'tail', name: 'Bad Slot', model, texture: b64(png(32, 32)) }, admin.token);
  assert.equal(r.status, 400);
  r = await call('POST', '/v1/admin/store/items', { kind: 'cosmetic', slot: 'hats', name: 'Bad Model', model: { parts: [] }, texture: b64(png(32, 32)) }, admin.token);
  assert.equal(r.status, 400);
  r = await call('POST', '/v1/admin/store/items', { kind: 'cosmetic', slot: 'hats', name: 'Test Box', model, texture: b64(png(32, 32)), thumb: b64(png(64, 64)), exclusive: true }, admin.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.item.slot, 'hats');
  assert.equal(r.body.item.motion, true);
  const id = r.body.item.id;

  // exclusive: only an admin hands it out
  assert.equal((await call('POST', '/v1/store/equip', { itemId: id }, fan.token)).status, 403);
  r = await call('POST', `/v1/admin/store/users/${fan.user.id}/capes`, { action: 'equip', itemId: id }, admin.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.user.wearing.hats, id);
  assert.equal((await entryOf('CosFan')).k[0].i, id);

  // a new model reaches the game
  const before = (await entryOf('CosFan')).k[0].m;
  r = await call('PATCH', `/v1/admin/store/items/${id}`, { model: { ...model, parts: [{ ...model.parts[0], anim: [] }] } }, admin.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.item.motion, false);
  assert.notEqual((await entryOf('CosFan')).k[0].m, before);

  r = await call('POST', `/v1/admin/store/items/${id}/revoke`, { username: 'CosFan' }, admin.token);
  assert.equal(r.status, 200);
  assert.equal(await entryOf('CosFan'), undefined);
  assert.equal((await call('DELETE', `/v1/admin/store/items/${id}`, undefined, admin.token)).status, 200);
});

test('dyeable cosmetics: admin base + mask + default colour, players pick a colour, mod and CSL get the dyed texture', async () => {
  const dye = require('../server/dye');
  const admin = account('DyeAdmin');
  db.getDb().prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin.user.id);
  // mask: left half dyeable
  const mask = dye.encodePng({ width: 4, height: 4, data: Buffer.from(Array.from({ length: 64 }, (_, i) => (i % 4 === 3 ? ((i >> 2) % 4 < 2 ? 255 : 0) : 255))) });
  const made = await call('POST', '/v1/admin/store/items', { kind: 'cosmetic', id: 'dye-hat', slot: 'hats', name: 'Dye Hat', price: 0, model: boxModel('head', false), texture: b64(png(4, 4, 200)), thumb: b64(png(8, 8)), dyeable: true, dyeMask: b64(mask), dyeDefault: '#FF0000' }, admin.token);
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.item.dyeable, true);
  assert.equal(made.body.item.dyeDefault, '#ff0000');
  assert.match(made.body.item.dyeUrl, /\/v1\/store\/items\/dye-hat\/dye\/$/);
  const shown = dye.decodePng(Buffer.from(await (await fetch(made.body.item.textureUrl)).arrayBuffer()));
  assert.deepEqual([...shown.data.subarray(0, 4)], [200, 0, 0, 255]); // dyed red where the mask is
  assert.deepEqual([...shown.data.subarray(8, 12)], [200, 200, 200, 255]); // untouched outside it

  const preview = await fetch(`${made.body.item.dyeUrl}00ff00`);
  assert.equal(preview.status, 200);
  assert.deepEqual([...dye.decodePng(Buffer.from(await preview.arrayBuffer())).data.subarray(0, 4)], [0, 200, 0, 255]);

  const { user, token } = account('Dyer');
  assert.equal((await call('POST', '/v1/store/dye', { itemId: 'dye-hat', color: '#0000ff' }, token)).status, 403); // not in the locker yet
  own(user, 'dye-hat');
  assert.equal((await call('POST', '/v1/store/equip', { itemId: 'dye-hat' }, token)).status, 200);
  assert.equal((await call('POST', '/v1/store/dye', { itemId: 'dye-hat', color: 'nope' }, token)).status, 400);
  const dyed = await call('POST', '/v1/store/dye', { itemId: 'dye-hat', color: '#0000FF' }, token);
  assert.equal(dyed.status, 200, JSON.stringify(dyed.body));
  assert.deepEqual(dyed.body.dyes, { 'dye-hat': '#0000ff' });
  const ref = dyed.body.profile.cosmetics.find((c) => c.id === 'dye-hat');
  assert.equal(ref.dye, '#0000ff');
  assert.deepEqual([...dye.decodePng(Buffer.from(await (await fetch(ref.textureUrl)).arrayBuffer())).data.subarray(0, 4)], [0, 0, 200, 255]);
  const entry = await entryOf('Dyer');
  const k = entry.k.find((x) => x.i === 'dye-hat');
  assert.ok(HASH.test(k.x));
  assert.notEqual(k.x, made.body.item.textureUrl.split('/').pop());
  assert.deepEqual((await call('GET', '/v1/store/me', undefined, token)).body.dyes, { 'dye-hat': '#0000ff' });
  // back to the item's own colour
  const reset = await call('POST', '/v1/store/dye', { itemId: 'dye-hat', color: null }, token);
  assert.deepEqual(reset.body.dyes, {});
  assert.equal((await entryOf('Dyer')).k.find((x) => x.i === 'dye-hat').x, made.body.item.textureUrl.split('/').pop());

  // admin: a new default colour re-bakes the texture; switching dyes off keeps the look
  const edited = await call('PATCH', '/v1/admin/store/items/dye-hat', { dyeDefault: '#00ff00' }, admin.token);
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual([...dye.decodePng(Buffer.from(await (await fetch(edited.body.item.textureUrl)).arrayBuffer())).data.subarray(0, 4)], [0, 200, 0, 255]);
  const off = await call('PATCH', '/v1/admin/store/items/dye-hat', { dyeable: false }, admin.token);
  assert.equal(off.body.item.dyeable, undefined);
  assert.equal(off.body.item.textureUrl, edited.body.item.textureUrl);
  assert.equal((await call('POST', '/v1/store/dye', { itemId: 'dye-hat', color: '#0000ff' }, token)).status, 404);
});
