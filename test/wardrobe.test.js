require('./electron-stub');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const wardrobe = require('../electron/wardrobe');

const FAKE_IPC = { handle() {}, on() {} };

/** Smallest valid PNG that passes the 24-byte / signature checks. */
function pngBuffer(width = 2, height = 2) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc ^ -1;
}

function makeAccount(overrides = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'noctra-wardrobe-'));
  wardrobe.init({ app: { getPath: () => userData } }, FAKE_IPC);
  return {
    userData,
    account: { id: 'acct-1', name: 'Notch', ...overrides }
  };
}

const pngDataUrl = () => pngBuffer().toString('base64');

test('uploading a skin stores it, makes it active and exposes a preview URL', () => {
  const { account, userData } = makeAccount();
  try {
    let state = wardrobe.addItemFromBase64(account, { kind: 'skin', dataUrl: pngDataUrl(), name: 'Night suit' });

    assert.equal(state.items.length, 1);
    assert.equal(state.model, 'classic');
    assert.equal(state.active.hasSkin, true);
    assert.match(state.active.skinUrl, /^data:image\/png;base64,/);
    assert.equal(state.skins[0].name, 'Night suit');
    assert.equal(state.skins[0].active, true);

    // A slim skin flips the active model for the game profile.
    state = wardrobe.addItemFromBase64(account, { kind: 'skin', dataUrl: pngDataUrl(), name: 'Slim suit', model: 'slim' });
    assert.equal(state.model, 'slim');
    assert.equal(state.skins.length, 2);
    assert.equal(state.active.skin.model, 'slim');

    // Files really live on disk next to the metadata.
    const dirs = fs.readdirSync(path.join(userData, 'wardrobe'));
    const files = fs.readdirSync(path.join(userData, 'wardrobe', dirs[0]));
    assert.equal(files.filter((name) => name.endsWith('.png')).length, 2);
    assert.ok(files.includes('wardrobe.json'));
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('capes upload, apply, and can be cleared without touching the skin', () => {
  const { account, userData } = makeAccount();
  try {
    wardrobe.addItemFromBase64(account, { kind: 'skin', dataUrl: pngDataUrl(), name: 'Skin' });
    let state = wardrobe.addItemFromBase64(account, { kind: 'cape', dataUrl: pngDataUrl(), name: 'Mojang cape' });
    assert.equal(state.active.hasCape, true);
    assert.equal(state.capes.length, 1);

    state = wardrobe.clearActive(account, 'cape');
    assert.equal(state.active.hasCape, false);
    assert.equal(state.active.hasSkin, true);
    assert.equal(state.items.length, 2);

    // Re-applying an existing item restores it.
    state = wardrobe.applyItem(account, state.capes[0].id);
    assert.equal(state.active.hasCape, true);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('favourites and removals behave, and removing the active item clears it', () => {
  const { account, userData } = makeAccount();
  try {
    let state = wardrobe.addItemFromBase64(account, { kind: 'skin', dataUrl: pngDataUrl(), name: 'One' });
    const id = state.items[0].id;

    state = wardrobe.setFavorite(account, id, true);
    assert.equal(state.favorites.length, 1);

    state = wardrobe.removeItem(account, id);
    assert.equal(state.items.length, 0);
    assert.equal(state.active.hasSkin, false);
    assert.equal(state.favorites.length, 0);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('invalid uploads are rejected with a readable message', () => {
  const { account, userData } = makeAccount();
  try {
    assert.throws(
      () => wardrobe.addItemFromBase64(account, { kind: 'skin', dataUrl: Buffer.alloc(64, 7).toString('base64') }),
      /not a valid PNG/i
    );
    assert.throws(
      () => wardrobe.addItemFromBase64(account, { kind: 'hat', dataUrl: pngDataUrl() }),
      /Invalid locker item/i
    );
    assert.equal(wardrobe.publicState(account).items.length, 0);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('legacy three-slot wardrobes migrate into the locker library', () => {
  const { account, userData } = makeAccount();
  try {
    const keyDir = path.join(userData, 'wardrobe');
    // Create the directory the way the module does, then drop a v1 profile in.
    wardrobe.publicState(account);
    const dir = path.join(keyDir, fs.readdirSync(keyDir)[0]);
    fs.writeFileSync(path.join(dir, 'slot-1-skin.png'), pngBuffer());
    fs.writeFileSync(path.join(dir, 'slot-1-cape.png'), pngBuffer());
    fs.writeFileSync(path.join(dir, 'wardrobe.json'), JSON.stringify({
      selected: 0,
      syncKey: 'k'.repeat(48),
      slots: [
        { skin: 'slot-1-skin.png', cape: 'slot-1-cape.png', model: 'slim' },
        { skin: null, cape: null, model: 'classic' },
        { skin: null, cape: null, model: 'classic' }
      ]
    }));

    const state = wardrobe.publicState(account);
    assert.equal(state.version, 2);
    assert.equal(state.items.length, 2);
    assert.equal(state.skins.length, 1);
    assert.equal(state.capes.length, 1);
    assert.equal(state.model, 'slim');

    // Migration is written back, so the next read is the new shape.
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'wardrobe.json'), 'utf8'));
    assert.equal(saved.version, 2);
    assert.equal(Array.isArray(saved.slots), false);
    assert.equal(saved.syncKey, 'k'.repeat(48));
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('prepareFabricInstance writes the CustomSkinLoader files for the active outfit', async () => {
  const { account, userData } = makeAccount();
  try {
    wardrobe.addItemFromBase64(account, { kind: 'skin', dataUrl: pngDataUrl(), name: 'Skin', model: 'slim' });
    wardrobe.addItemFromBase64(account, { kind: 'cape', dataUrl: pngDataUrl(), name: 'Cape' });

    const result = await wardrobe.prepareFabricInstance({ id: 'inst-1', version: '1.21.1' }, account);
    assert.equal(result.model, 'slim');

    const csl = path.join(userData, 'minecraft', 'instances', 'inst-1', 'CustomSkinLoader');
    assert.ok(fs.existsSync(path.join(csl, 'LocalSkin', 'skins', 'Notch.png')));
    assert.ok(fs.existsSync(path.join(csl, 'LocalSkin', 'capes', 'Notch.png')));

    const extraPath = fs.existsSync(path.join(csl, 'ExtraList', 'NoctraWardrobe.json'))
      ? path.join(csl, 'ExtraList', 'NoctraWardrobe.json')
      : path.join(csl, 'ExtraList', 'NativeWardrobe.json');
    const extra = JSON.parse(fs.readFileSync(extraPath, 'utf8'));
    assert.equal(extra.type, 'CustomSkinAPI');
    assert.equal(extra.root, `${wardrobe.API_ROOT}/csl/`);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('new sync keys are random, and the old guessable key is recognised as legacy', () => {
  const account = { id: 'user-123', name: 'PlayerOne', email: 'test@example.com' };
  const a = wardrobe.newSyncKey();
  const b = wardrobe.newSyncKey();
  assert.notEqual(a, b);
  assert.equal(a.length, 48);
  assert.equal(wardrobe.isLegacySyncKey(account, wardrobe.deterministicSyncKey(account)), true);
  assert.equal(wardrobe.isLegacySyncKey(account, a), false);
});

test('storing an item with an existing name overwrites the file instead of duplicating', () => {
  const { account, userData } = makeAccount();
  try {
    const fakeTexture1 = pngBuffer(2, 2);
    const fakeTexture2 = pngBuffer(4, 4);

    let state = wardrobe.addItemFromBase64(account, {
      kind: 'cape',
      dataUrl: fakeTexture1.toString('base64'),
      name: 'Migrator Cape'
    });
    assert.equal(state.capes.length, 1);
    assert.equal(state.capes[0].name, 'Migrator Cape');

    // Storing again with same name should update in place
    state = wardrobe.addItemFromBase64(account, {
      kind: 'cape',
      dataUrl: fakeTexture2.toString('base64'),
      name: 'Migrator Cape'
    });
    assert.equal(state.capes.length, 1);
    assert.equal(state.capes[0].name, 'Migrator Cape');
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('publicState surfaces a cached skin texture when nothing is equipped (avatar fallback path)', () => {
  const { account, userData } = makeAccount();
  try {
    // No wardrobe items means no active skin.
    let state = wardrobe.publicState(account);
    assert.equal(state.active.hasSkin, false);
    assert.equal(state.active.skinUrl, null);

    // warmSkinCache writes the resolved texture to `{userData}/cache/skins/{username}.png`;
    // simulate that landing on disk (the network fetch itself is not exercised here).
    const cached = path.join(userData, 'cache', 'skins', 'Notch.png');
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, pngBuffer());

    // The avatar resolver reads back through publicState, which now exposes the
    // cached texture as a data URL so the account switcher shows the real skin.
    state = wardrobe.publicState(account);
    assert.equal(state.active.hasSkin, true);
    assert.match(state.active.skinUrl, /^data:image\/png;base64,/);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('warmSkinCache does not query Mojang or mc-heads for local Noctra/offline accounts', async () => {
  const { account, userData } = makeAccount({ type: 'noctra', name: 'SomePlayerName' });
  try {
    const warmed = await wardrobe.warmSkinCache(account);
    assert.equal(warmed, false);
    const cached = path.join(userData, 'cache', 'skins', 'SomePlayerName.png');
    assert.equal(fs.existsSync(cached), false);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});



test('an existing CustomSkinLoader config gets LocalSkin first, then the Noctra API, keeping other sites', () => {
  const { userData } = makeAccount();
  try {
    const csl = path.join(userData, 'csl');
    fs.mkdirSync(path.join(csl, 'ExtraList'), { recursive: true });
    fs.writeFileSync(path.join(csl, 'CustomSkinLoader.json'), JSON.stringify({
      version: '15.0.1',
      enable: true,
      loadlist: [
        { name: 'Noctra Client Wardrobe', type: 'CustomSkinAPI', root: 'https://api.nativelaunch.xyz/csl/' },
        { name: 'Mojang', type: 'MojangAPI' },
        { name: 'LocalSkin', type: 'Legacy', checkPNG: false, skin: 'LocalSkin/skins/{USERNAME}.png', model: 'auto' },
        { name: 'Native Client Wardrobe', type: 'CustomSkinAPI', root: 'https://api.nativelaunch.xyz/csl/' },
        { name: 'OptiFine', type: 'Legacy', cape: 'https://optifine.net/capes/{USERNAME}.png' }
      ]
    }));
    fs.writeFileSync(path.join(csl, 'ExtraList', 'NativeWardrobe.json'), '{}');

    const result = wardrobe.configureSkinLoader(csl, 'slim');
    assert.equal(result.managed, true);
    const config = JSON.parse(fs.readFileSync(path.join(csl, 'CustomSkinLoader.json'), 'utf8'));
    assert.deepEqual(config.loadlist.map((site) => site.name), ['LocalSkin', 'Noctra Client Wardrobe', 'Mojang', 'OptiFine']);
    assert.equal(config.loadlist[0].model, 'slim');
    assert.equal(config.loadlist[0].cape, 'LocalSkin/capes/{USERNAME}.png');
    assert.equal(config.version, '15.0.1');
    assert.equal(config.enable, true);
    assert.equal(fs.existsSync(path.join(csl, 'ExtraList', 'NativeWardrobe.json')), false);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('without a CustomSkinLoader config the Noctra API is added through ExtraList', () => {
  const { userData } = makeAccount();
  try {
    const csl = path.join(userData, 'csl');
    const result = wardrobe.configureSkinLoader(csl, 'classic');
    assert.equal(result.managed, false);
    const extra = JSON.parse(fs.readFileSync(path.join(csl, 'ExtraList', 'NoctraWardrobe.json'), 'utf8'));
    assert.equal(extra.type, 'CustomSkinAPI');
    assert.equal(extra.root, `${wardrobe.API_ROOT}/csl/`);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
