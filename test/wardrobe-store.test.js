'use strict';
require('./electron-stub');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'noctra-wstore-'));
process.env.NATIVE_SKIN_DATA = DATA_DIR;
process.env.NOCTRA_DATA_DIR = DATA_DIR;
process.env.NOCTRA_DB_PATH = path.join(DATA_DIR, 'noctra.db');
delete process.env.NATIVE_SKIN_PUBLIC_URL;
delete process.env.NOCTRA_PUBLIC_URL;

const db = require('../server/db');
const { listen } = require('../server/server');
const modRoutes = require('../server/mod-routes');
const wardrobe = require('../electron/wardrobe');

const handlers = new Map();
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'noctra-wstore-ud-'));
let server;

test.before(async () => {
  server = await listen(0, '127.0.0.1');
  process.env.NATIVE_WARDROBE_API = `http://127.0.0.1:${server.address().port}`;
  wardrobe.init({ app: { getPath: () => userData } }, { handle: (name, fn) => handlers.set(name, fn), on() {} });
});

test.after(() => {
  modRoutes.stopStreams();
  server.closeAllConnections?.();
  server.close();
  try { db.closeDb(); } catch {}
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
  setTimeout(() => process.exit(0), 50).unref();
});

test('launcher store: catalogue, equip an animated cape, live refresh, unequip', async () => {
  const user = db.createUser({ email: 'l@example.com', username: 'LauncherUser', password: 'correct horse battery' });
  const session = db.createSession(user.id);
  const account = { id: String(user.id), name: 'LauncherUser', type: 'noctra', token: session.token };

  const catalog = await handlers.get('store:catalog')({}, { force: true });
  assert.equal(catalog.ok, true);
  assert.ok(catalog.items.some((item) => item.id === 'you-got-this' && item.frames === 26));

  const strip = await handlers.get('store:strip')({}, 'you-got-this');
  assert.equal(strip.ok, true);
  assert.match(strip.url, /^data:image\/png;base64,/);

  const equipped = await handlers.get('store:equip')({}, { account, itemId: 'you-got-this' });
  assert.equal(equipped.ok, true, equipped.error);
  assert.equal(equipped.state.active.capeAnim.frames, 26);
  assert.equal(equipped.state.active.capeAnim.fps, 12);
  assert.equal(equipped.state.capes[0].name, 'You Got This');
  assert.equal(equipped.state.capes[0].animated, true);
  assert.equal(equipped.state.active.cape.storeId, 'you-got-this');

  // Pushing the local outfit keeps the animation on the server.
  const sync = await wardrobe.syncWardrobe(account);
  assert.equal(sync.ok, true);
  const csl = await (await fetch(`${process.env.NATIVE_WARDROBE_API}/csl/LauncherUser.json`)).json();
  assert.equal(csl.capeAnimation.frames, 26);
  assert.equal(csl.capeStore, 'you-got-this');

  // Another device (the website) swaps the cape: this launcher picks it up on `wardrobe:changed`.
  await new Promise((r) => setTimeout(r, 20));
  const meta = () => JSON.parse(fs.readFileSync(path.join(userData, 'wardrobe', fs.readdirSync(path.join(userData, 'wardrobe'))[0], 'wardrobe.json'), 'utf8'));
  const web = await fetch(`${process.env.NATIVE_WARDROBE_API}/v1/store/equip`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` }, body: JSON.stringify({ itemId: 'matrix' }) });
  assert.equal(web.status, 200);
  const refreshed = await handlers.get('wardrobe:refresh')({}, account);
  assert.equal(refreshed.pulled, true);
  assert.equal(refreshed.state.active.cape.name, 'Rain Code');
  assert.equal(refreshed.state.active.capeAnim.frames, 24);
  assert.ok(meta().items.length >= 2);

  // Nothing newer in the cloud: nothing to pull.
  assert.equal((await handlers.get('wardrobe:refresh')({}, account)).pulled, false);

  // Taken off remotely -> removed locally.
  await fetch(`${process.env.NATIVE_WARDROBE_API}/v1/store/equip`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` }, body: JSON.stringify({ itemId: null }) });
  const gone = await handlers.get('wardrobe:refresh')({}, account);
  assert.equal(gone.pulled, true);
  assert.equal(gone.state.active.hasCape, false);

  const bad = await handlers.get('store:equip')({}, { account: { ...account, type: 'microsoft' }, itemId: 'aurora' });
  assert.equal(bad.ok, false);
});

test('launcher can publish its own animated cape (any frame ratio) and the directory carries it', async () => {
  const user = db.createUser({ email: 'u2@example.com', username: 'UploadUser', password: 'correct horse battery' });
  const session = db.createSession(user.id);
  const account = { id: String(user.id), name: 'UploadUser', type: 'noctra', token: session.token };
  const strip = fs.readFileSync(path.join(__dirname, '..', 'server', 'store', 'assets', 'matrix.strip.png.b64'), 'utf8');
  const still = fs.readFileSync(path.join(__dirname, '..', 'server', 'store', 'assets', 'matrix.still.png.b64'), 'utf8');
  wardrobe.addItemFromBase64(account, { kind: 'cape', dataUrl: strip, name: 'Mine', anim: { frames: 24, fps: 12 }, stillDataUrl: still });
  const result = await wardrobe.syncWardrobe(account);
  assert.equal(result.ok, true);
  const dir = await (await fetch(`${process.env.NATIVE_WARDROBE_API}/v1/skins/directory`)).json();
  const entry = dir.entries.find((e) => e.n === 'UploadUser');
  assert.equal(entry.a.f, 24);
  assert.equal(entry.a.p, 12);
});
