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

test('only Noctra store capes animate: own strips become still capes, owned store strips animate', async () => {
  const user = db.createUser({ email: 'anim@example.com', username: 'AnimUser', password: 'correct horse battery' });
  const session = db.createSession(user.id);
  const strip = png(128, 64 * 4, 90);
  const still = png(128, 64, 90);

  const bad = await post('/v1/wardrobe', { username: 'AnimUser', cape: b64(png(128, 32)), capeAnim: { strip: b64(strip), frames: 4, fps: 12 } }, session.token);
  assert.equal(bad.status, 400);

  // A self-made cape (animated or not) is refused: players can't upload capes of their own.
  const own = await post('/v1/wardrobe', { username: 'AnimUser', cape: b64(still), capeAnim: { strip: b64(strip), frames: 4, fps: 12 } }, session.token);
  assert.equal(own.status, 200);
  assert.equal(own.body.animated, false);
  assert.match(own.body.notice, /Only Noctra capes/);
  assert.equal(own.body.profile.cape, null);
  assert.equal(own.body.profile.capeAnimation, undefined);

  // A store strip the account does not own is refused too...
  const storeStrip = fs.readFileSync(path.join(__dirname, '..', 'server', 'store', 'assets', 'matrix.strip.png.b64'), 'utf8').trim();
  const storeStill = fs.readFileSync(path.join(__dirname, '..', 'server', 'store', 'assets', 'matrix.still.png.b64'), 'utf8').trim();
  const notOwned = await post('/v1/wardrobe', { username: 'AnimUser', cape: storeStill, capeAnim: { strip: storeStrip, frames: 24, fps: 12 } }, session.token);
  assert.equal(notOwned.body.animated, false);

  // ...until it is added to the locker.
  const claim = await post('/v1/store/claim', { itemId: 'matrix' }, session.token);
  assert.equal(claim.status, 200);
  assert.deepEqual(claim.body.owned.map((o) => o.id), ['matrix']);
  const ok = await post('/v1/wardrobe', { username: 'AnimUser', cape: storeStill, capeAnim: { strip: storeStrip, frames: 24, fps: 12 } }, session.token);
  assert.equal(ok.body.animated, true);
  assert.equal(ok.body.profile.capeStore, 'matrix');
  assert.equal(ok.body.profile.capeAnimation.frames, 24);
  const csl = await json('/csl/AnimUser.json');
  assert.equal(csl.body.capeAnimation.frames, 24);
  const entry = (await json('/v1/skins/directory')).body.entries.find((e) => e.n === 'AnimUser');
  assert.deepEqual({ f: entry.a.f, p: entry.a.p }, { f: 24, p: 12 });

  // An older launcher re-sends the static first frame: the animation stays.
  const resync = await post('/v1/wardrobe', { username: 'AnimUser', cape: storeStill, model: 'slim' }, session.token);
  assert.equal(resync.body.animated, true);

  // A different (classic) cape drops it.
  const vanilla = fs.readFileSync(path.join(__dirname, '..', 'src', 'assets', 'capes', 'vanilla.png'));
  const swap = await post('/v1/wardrobe', { username: 'AnimUser', cape: b64(vanilla) }, session.token);
  assert.equal(swap.body.animated, false);
  assert.equal((await json('/csl/AnimUser.json')).body.capeAnimation, undefined);

  // Removing it from the locker takes it off.
  await post('/v1/store/equip', { itemId: 'matrix' }, session.token);
  const unclaim = await post('/v1/store/unclaim', { itemId: 'matrix' }, session.token);
  assert.equal(unclaim.body.equipped, null);
  assert.deepEqual(unclaim.body.owned, []);
  assert.equal((await json('/csl/AnimUser.json')).body.cape, null);
});

test('legacy self-made capes on disk are not served', async () => {
  const strip = png(64, 32 * 3, 40);
  const hash = (buf) => require('node:crypto').createHash('sha256').update(buf).digest('hex');
  fs.mkdirSync(path.join(DATA_DIR, 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'profiles', 'legacyanim.json'), JSON.stringify({
    username: 'LegacyAnim', model: 'default', skin: null, cape: hash(png(64, 32, 40)), capeAnim: { strip: hash(strip), frames: 3, fps: 10 }, updatedAt: new Date().toISOString()
  }));
  const csl = await json('/csl/LegacyAnim.json');
  assert.equal(csl.body.cape, null);
  assert.equal(csl.body.capeAnimation, undefined);
});

test('admin store: create animated + static capes, edit, hide, delete', async () => {
  const admin = db.createUser({ email: 'boss@example.com', username: 'StoreBoss', password: 'correct horse battery' });
  db.getDb().prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin.id);
  const token = db.createSession(admin.id).token;
  const pleb = db.createSession(db.createUser({ email: 'pleb@example.com', username: 'Pleb', password: 'correct horse battery' }).id).token;
  const req = (method, pathname, body, t = token) => json(pathname, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: body ? JSON.stringify(body) : undefined });

  assert.equal((await req('GET', '/v1/admin/store/items', null, pleb)).status, 403);
  assert.equal((await json('/v1/admin/store/items')).status, 401);

  const created = await req('POST', '/v1/admin/store/items', { name: 'Galaxy Swirl', description: 'Stars.', tags: 'space, Animated', animated: true, strip: b64(png(64, 32 * 4, 70)), still: b64(png(64, 32, 70)), frames: 4, fps: 8, featured: true });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.item.id, 'galaxy-swirl');
  assert.deepEqual(created.body.item.tags, ['space', 'animated']);
  assert.equal((await req('POST', '/v1/admin/store/items', { name: 'Galaxy Swirl', animated: false, still: b64(png(64, 32)) })).status, 409);
  assert.equal((await req('POST', '/v1/admin/store/items', { name: 'Broken', animated: true, strip: b64(png(64, 100)), still: b64(png(64, 32)), frames: 3, fps: 8 })).status, 400);

  const flat = await req('POST', '/v1/admin/store/items', { name: 'Plain Black', animated: false, still: b64(png(64, 32, 0)) });
  assert.equal(flat.body.item.animated, false);
  assert.equal(flat.body.item.stripUrl, null);

  let catalog = (await json('/v1/store/catalog')).body;
  assert.equal(catalog.items[0].id === 'galaxy-swirl' || catalog.items[0].featured, true);
  assert.ok(catalog.items.some((i) => i.id === 'plain-black'));
  assert.equal(catalog.items.find((i) => i.id === 'galaxy-swirl').isNew, true);

  // Static store capes can be worn too.
  const wear = await post('/v1/store/equip', { itemId: 'plain-black' }, pleb);
  assert.equal(wear.body.equipped, 'plain-black');
  assert.equal(wear.body.profile.capeAnimation, undefined);
  assert.equal((await json('/v1/store/me', { headers: { Authorization: `Bearer ${pleb}` } })).body.equipped, 'plain-black');

  const edit = await req('PATCH', '/v1/admin/store/items/galaxy-swirl', { name: 'Galaxy', hidden: true, fps: 15 });
  assert.equal(edit.body.item.name, 'Galaxy');
  assert.equal(edit.body.item.fps, 15);
  catalog = (await json('/v1/store/catalog')).body;
  assert.equal(catalog.items.some((i) => i.id === 'galaxy-swirl'), false);
  assert.equal((await json('/v1/store/items/galaxy-swirl')).body.item.hidden, true);
  assert.equal((await post('/v1/store/claim', { itemId: 'galaxy-swirl' }, pleb)).status, 410);

  const del = await req('DELETE', '/v1/admin/store/items/plain-black');
  assert.equal(del.status, 200);
  assert.equal((await json('/v1/store/items/plain-black')).status, 404);
  assert.equal((await json('/v1/store/me', { headers: { Authorization: `Bearer ${pleb}` } })).body.owned.some((o) => o.id === 'plain-black'), false);
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

  const watched = [];
  const watch = http.get(`${base}/v1/store/stream?token=${session.token}`, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk) => watched.push(chunk));
  });
  watch.on('error', () => {});
  await new Promise((r) => setTimeout(r, 250));
  assert.equal((await json('/v1/store/stream')).status, 401);

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
  const wend = Date.now() + 3000;
  while (!watched.join('').includes('wardrobe:changed') && Date.now() < wend) await new Promise((r) => setTimeout(r, 50));
  assert.match(watched.join(''), /event: wardrobe:changed/);
  watch.destroy();

  const off = await post('/v1/store/equip', { itemId: null }, session.token);
  assert.equal(off.body.equipped, null);
  assert.equal((await json('/csl/ShopUser.json')).body.cape, null);
});

test('exclusive Beta Tester cape: listed, never claimable, only admins hand it out', async () => {
  const catalog = await json('/v1/store/catalog');
  const beta = catalog.body.items.find((i) => i.id === 'beta-tester');
  assert.ok(beta, 'beta-tester is listed in the store');
  assert.equal(beta.exclusive, true);
  assert.equal(beta.animated, true);

  const tester = db.createUser({ email: 'tester@example.com', username: 'BetaPal', password: 'correct horse battery' });
  const token = db.createSession(tester.id).token;
  assert.equal((await post('/v1/store/claim', { itemId: 'beta-tester' }, token)).status, 403);
  assert.equal((await post('/v1/store/equip', { itemId: 'beta-tester' }, token)).status, 403);

  // Uploading its PNG through the wardrobe doesn't unlock it either.
  const still = fs.readFileSync(path.join(__dirname, '..', 'server', 'store', 'assets', 'beta-tester.still.png.b64'), 'utf8').trim();
  const sneaky = await post('/v1/wardrobe', { username: 'BetaPal', cape: still }, token);
  assert.equal(sneaky.status, 200);
  assert.equal(sneaky.body.profile.cape, null);

  const admin = db.createUser({ email: 'betaboss@example.com', username: 'BetaBoss', password: 'correct horse battery' });
  db.getDb().prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin.id);
  const adminToken = db.createSession(admin.id).token;
  assert.equal((await post('/v1/admin/store/items/beta-tester/grant', { username: 'BetaPal' }, token)).status, 403);
  assert.equal((await post('/v1/admin/store/items/beta-tester/grant', { username: 'NobodyHere' }, adminToken)).status, 404);
  const granted = await post('/v1/admin/store/items/beta-tester/grant', { username: 'betapal' }, adminToken);
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.equal(granted.body.owners[0].username, 'BetaPal');
  assert.equal(granted.body.owners[0].source, 'admin');

  const worn = await post('/v1/store/equip', { itemId: 'beta-tester' }, token);
  assert.equal(worn.status, 200, JSON.stringify(worn.body));
  assert.equal(worn.body.equipped, 'beta-tester');
  // The launcher re-sends the still on every sync: it stays on.
  const resync = await post('/v1/wardrobe', { username: 'BetaPal', cape: still }, token);
  assert.ok(resync.body.profile.cape);

  const revoked = await post('/v1/admin/store/items/beta-tester/revoke', { username: 'BetaPal' }, adminToken);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.owners.length, 0);
  const me = await json('/v1/store/me', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(me.body.equipped, null);
  assert.equal(me.body.owned.some((o) => o.id === 'beta-tester'), false);
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
