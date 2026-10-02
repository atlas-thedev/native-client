'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'noctra-capes-'));
process.env.NATIVE_SKIN_DATA = DATA_DIR;
process.env.NOCTRA_DATA_DIR = DATA_DIR;
process.env.NOCTRA_DB_PATH = path.join(DATA_DIR, 'noctra.db');
delete process.env.NATIVE_SKIN_PUBLIC_URL;
delete process.env.NOCTRA_PUBLIC_URL;

const db = require('../server/db');
const { listen } = require('../server/server');
const modRoutes = require('../server/mod-routes');
const capes = require('../server/capes');

/** A real, valid grayscale PNG of any size. */
function png(width, height, shade = 128) {
  const crcTable = (buf) => { const out = Buffer.alloc(4); out.writeUInt32BE(zlib.crc32(buf) >>> 0); return out; };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    return Buffer.concat([length, body, crcTable(body)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width, shade)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const b64 = (buffer) => buffer.toString('base64');

let server;
let base;

async function json(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  return { status: response.status, body: await response.json().catch(() => null) };
}
const post = (pathname, body, token) => json(pathname, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body)
});

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

test('animation validation accepts every standard cape size and odd ratios, rejects bad strips', () => {
  const sizes = [[64, 32], [128, 64], [256, 128], [512, 256], [1024, 512], [46, 22], [22, 17], [300, 100]];
  for (const [w, h] of sizes) {
    const info = capes.validateAnimation({ strip: png(w, h * 3), still: png(w, h), frames: 3, fps: 10 });
    assert.equal(info.width, w);
    assert.equal(info.frameHeight, h);
  }
  assert.throws(() => capes.validateAnimation({ strip: png(64, 100), still: png(64, 32), frames: 3, fps: 10 }), /not divisible/);
  assert.throws(() => capes.validateAnimation({ strip: png(64, 96), still: png(64, 31), frames: 3, fps: 10 }), /still frame must be/);
  assert.throws(() => capes.validateAnimation({ strip: png(64, 32), still: png(64, 32), frames: 1, fps: 10 }), /frames/);
  assert.throws(() => capes.validateAnimation({ strip: png(64, 64), still: png(64, 32), frames: 2, fps: 99 }), /speed/);
  assert.throws(() => capes.validateAnimation({ strip: Buffer.from('nope'), still: png(64, 32), frames: 2, fps: 10 }), /Invalid PNG/);
});

test('publishing an animated cape: first frame is the cape, the strip rides along, old syncs keep it', async () => {
  const user = db.createUser({ email: 'anim@example.com', username: 'AnimUser', password: 'correct horse battery' });
  const session = db.createSession(user.id);
  const strip = png(128, 64 * 4, 90);
  const still = png(128, 64, 90);

  const bad = await post('/v1/wardrobe', { username: 'AnimUser', cape: b64(png(128, 32)), capeAnim: { strip: b64(strip), frames: 4, fps: 12 } }, session.token);
  assert.equal(bad.status, 400);

  const ok = await post('/v1/wardrobe', { username: 'AnimUser', cape: b64(still), capeAnim: { strip: b64(strip), frames: 4, fps: 12 } }, session.token);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.animated, true);
  assert.equal(ok.body.profile.capeAnimation.frames, 4);
  assert.equal(ok.body.profile.capeAnimation.fps, 12);
  assert.match(ok.body.profile.cape, /\/csl\/textures\/[a-f0-9]{64}$/);
  assert.notEqual(ok.body.profile.cape, ok.body.profile.capeAnimation.url);

  const csl = await json('/csl/AnimUser.json');
  assert.equal(csl.body.capeAnimation.frames, 4);
  const stripResponse = await fetch(csl.body.capeAnimation.url);
  assert.equal(stripResponse.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await stripResponse.arrayBuffer()).length, strip.length);

  const dir = await json('/v1/skins/directory');
  const entry = dir.body.entries.find((e) => e.n === 'AnimUser');
  assert.equal(entry.c, csl.body.cape.split('/').pop());
  assert.deepEqual({ f: entry.a.f, p: entry.a.p }, { f: 4, p: 12 });
  assert.equal(entry.a.h, csl.body.capeAnimation.url.split('/').pop());

  // An older launcher re-sends the static first frame: the animation stays.
  const resync = await post('/v1/wardrobe', { username: 'AnimUser', cape: b64(still), model: 'slim' }, session.token);
  assert.equal(resync.body.animated, true);

  // A different static cape drops it.
  const swap = await post('/v1/wardrobe', { username: 'AnimUser', cape: b64(png(64, 32, 200)) }, session.token);
  assert.equal(swap.body.animated, false);
  assert.equal((await json('/csl/AnimUser.json')).body.capeAnimation, undefined);
  const dir2 = await json('/v1/skins/directory');
  assert.equal(dir2.body.entries.find((e) => e.n === 'AnimUser').a, null);
});

test('store: catalogue is public, equip needs a session, equip/unequip are live', async () => {
  const catalog = await json('/v1/store/catalog');
  assert.equal(catalog.status, 200);
  assert.ok(catalog.body.items.length >= 5);
  const cat = catalog.body.items.find((i) => i.id === 'you-got-this');
  assert.equal(cat.frames, 26);
  assert.equal(cat.width, 512);
  assert.equal(cat.frameHeight, 256);
  for (const item of catalog.body.items) {
    assert.equal(item.animated, true);
    const strip = await fetch(item.stripUrl);
    const still = await fetch(item.stillUrl);
    assert.equal(strip.status, 200);
    assert.equal(still.status, 200);
    const info = capes.pngSize(Buffer.from(await strip.arrayBuffer()));
    assert.equal(info.height, item.frames * item.frameHeight);
  }

  assert.equal((await post('/v1/store/equip', { itemId: 'aurora' })).status, 401);

  const user = db.createUser({ email: 'shop@example.com', username: 'ShopUser', password: 'correct horse battery' });
  const session = db.createSession(user.id);
  assert.equal((await post('/v1/store/equip', { itemId: 'nope' }, session.token)).status, 404);

  // The owner's other devices hear about it instantly.
  const heard = [];
  const stream = http.get(`${base}/v1/social/stream`, { headers: { Authorization: `Bearer ${session.token}` } }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk) => heard.push(chunk));
  });
  stream.on('error', () => {});
  await new Promise((r) => setTimeout(r, 250));

  const equip = await post('/v1/store/equip', { itemId: 'aurora' }, session.token);
  assert.equal(equip.status, 200);
  assert.equal(equip.body.equipped, 'aurora');
  assert.equal(equip.body.profile.capeAnimation.frames, 24);
  assert.equal((await json('/v1/store/me', { headers: { Authorization: `Bearer ${session.token}` } })).body.equipped, 'aurora');
  const entry = (await json('/v1/skins/directory')).body.entries.find((e) => e.n === 'ShopUser');
  assert.equal(entry.a.f, 24);

  const end = Date.now() + 3000;
  while (!heard.join('').includes('wardrobe:changed') && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  assert.match(heard.join(''), /event: wardrobe:changed/);
  assert.match(heard.join(''), /"capeStore":"aurora"/);
  stream.destroy();

  const off = await post('/v1/store/equip', { itemId: null }, session.token);
  assert.equal(off.body.equipped, null);
  assert.equal((await json('/csl/ShopUser.json')).body.cape, null);
});

test('mod friends + live stream: presence and requests reach the game', async () => {
  const a = db.createUser({ email: 'fa@example.com', username: 'FriendA', password: 'correct horse battery' });
  const b = db.createUser({ email: 'fb@example.com', username: 'FriendB', password: 'correct horse battery' });
  const sa = db.createSession(a.id);
  const ticketA = (await post('/v1/auth/game-ticket', {}, sa.token)).body.ticket;
  const ticketB = (await post('/v1/auth/game-ticket', {}, db.createSession(b.id).token)).body.ticket;

  assert.equal((await json('/v1/mod/friends')).status, 401);
  assert.equal((await json('/v1/mod/friends', { headers: { Authorization: `Bearer ${sa.token}` } })).status, 401);

  const empty = await json('/v1/mod/friends', { headers: { Authorization: `Bearer ${ticketA}` } });
  assert.equal(empty.body.total, 0);
  assert.equal(empty.body.account.name, 'FriendA');
  assert.equal(empty.body.account.premium.linked, false);

  const request = db.sendFriendRequest(a.id, 'FriendB');
  const pending = await json('/v1/mod/friends', { headers: { Authorization: `Bearer ${ticketB}` } });
  assert.equal(pending.body.requests.received.length, 1);
  assert.equal(pending.body.requests.received[0].name, 'FriendA');
  db.respondFriendRequest(request.id, b.id, 'accept');

  const heard = [];
  const stream = http.get(`${base}/v1/mod/stream?activity=${encodeURIComponent('Playing Minecraft 1.21.1')}`, { headers: { Authorization: `Bearer ${ticketA}` } }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk) => heard.push(chunk));
  });
  stream.on('error', () => {});
  await new Promise((r) => setTimeout(r, 250));

  // FriendB comes online in game: A's mod hears it right away.
  const streamB = http.get(`${base}/v1/mod/stream?activity=${encodeURIComponent('Playing Minecraft 1.20.1')}`, { headers: { Authorization: `Bearer ${ticketB}` } }, (res) => { res.resume(); });
  streamB.on('error', () => {});
  const end = Date.now() + 3000;
  while (!heard.join('').includes('Minecraft 1.20.1') && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  const text = heard.join('');
  assert.match(text, /event: hello/);
  assert.match(text, /event: presence/);
  assert.match(text, /Playing Minecraft 1\.20\.1/);

  const list = await json('/v1/mod/friends', { headers: { Authorization: `Bearer ${ticketA}` } });
  assert.equal(list.body.total, 1);
  assert.equal(list.body.friends[0].name, 'FriendB');
  assert.equal(list.body.friends[0].online, true);
  assert.equal(list.body.friends[0].activity, 'Playing Minecraft 1.20.1');
  assert.equal(list.body.online, 1);

  // Leaving the game flips them offline for their friends, again live.
  streamB.destroy();
  const gone = Date.now() + 3000;
  while (!/"status":"offline"/.test(heard.join('')) && Date.now() < gone) await new Promise((r) => setTimeout(r, 50));
  assert.match(heard.join(''), /"status":"offline"/);
  stream.destroy();
});
