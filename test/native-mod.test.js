const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const nativeMod = require('../electron/nativeMod');

const JAR = Buffer.from('PK-fake-jar-bytes');
const sha = crypto.createHash('sha256').update(JAR).digest('hex');
const manifest = (over = {}) => ({
  schema: 1,
  version: '1.2.3',
  file: 'native-client-1.2.3.jar',
  url: 'https://github.com/atlas-thedev/native-mod-releases/releases/download/v1.2.3/native-client-1.2.3.jar',
  sha256: sha,
  size: JAR.length,
  loaders: ['fabric', 'quilt'],
  minecraft: { min: '1.16', tested: '26.3' },
  ...over
});

function fakeFetch({ manifestBody = manifest(), jar = JAR, ticketStatus = 200, offline = false } = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (offline) throw new Error('offline');
    const u = String(url);
    if (u.endsWith('manifest.json')) return { ok: true, status: 200, json: async () => manifestBody };
    if (u.includes('/releases/download/')) return { ok: true, status: 200, arrayBuffer: async () => jar.buffer.slice(jar.byteOffset, jar.byteOffset + jar.length) };
    if (u.endsWith('/v1/auth/game-ticket')) {
      if (ticketStatus !== 200) return { ok: false, status: ticketStatus, json: async () => ({ ok: false }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, ticket: 'nmt1.abc.def', expiresAt: 123, account: { id: 'u1', name: 'Steve' } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  impl.calls = calls;
  return impl;
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'native-mod-test-'));

test('supports Fabric/Quilt on 1.16+ and 26.x only', () => {
  assert.equal(nativeMod.supportsLoader('Fabric'), true);
  assert.equal(nativeMod.supportsLoader('quilt'), true);
  assert.equal(nativeMod.supportsLoader('Legacy Fabric'), false);
  assert.equal(nativeMod.supportsLoader('forge'), false);
  assert.equal(nativeMod.supportsLoader('neoforge'), false);
  assert.equal(nativeMod.supportsLoader('vanilla'), false);
  for (const v of ['1.16', '1.16.5', '1.20.1', '1.21.11', '26.1', '26.3', '26.3.1']) assert.equal(nativeMod.supportsMinecraft(v), true, v);
  for (const v of ['1.15.2', '1.8.9', '1.12', '24w14a', '', undefined]) assert.equal(nativeMod.supportsMinecraft(v), false, String(v));
});

test('manifest validation rejects foreign URLs, bad hashes and odd file names', () => {
  assert.ok(nativeMod.validateManifest(manifest()));
  assert.equal(nativeMod.validateManifest(manifest({ url: 'https://evil.example/native-client-1.2.3.jar' })), null);
  assert.equal(nativeMod.validateManifest(manifest({ sha256: 'zz' })), null);
  assert.equal(nativeMod.validateManifest(manifest({ file: '../evil.jar' })), null);
  assert.equal(nativeMod.validateManifest(manifest({ schema: 2 })), null);
  assert.equal(nativeMod.validateManifest(manifest({ size: 1e9 })), null);
});

test('installs the mod, removes older copies and writes the ticket hand-off', async () => {
  const root = tmp();
  const gameDir = path.join(root, 'instances', 'a');
  fs.mkdirSync(path.join(gameDir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'mods', 'native-client-1.0.0.jar'), 'old');
  fs.writeFileSync(path.join(gameDir, 'mods', 'sodium.jar'), 'keep');
  const fetchImpl = fakeFetch();
  try {
    const result = await nativeMod.prepare({
      instance: { id: 'a', version: '1.21.4', loader: 'Fabric' },
      identity: { token: 'session-token', name: 'Steve' },
      gameDir, cacheDir: path.join(root, 'cache'), roots: ['https://api.example'], fetchImpl
    });
    assert.deepEqual({ installed: result.installed, signedIn: result.signedIn, version: result.version }, { installed: true, signedIn: true, version: '1.2.3' });
    assert.deepEqual(fs.readdirSync(path.join(gameDir, 'mods')).sort(), ['native-client-1.2.3.jar', 'sodium.jar']);
    const handoff = JSON.parse(fs.readFileSync(path.join(gameDir, '.noctra', 'session.json'), 'utf8'));
    assert.equal(handoff.ticket, 'nmt1.abc.def');
    assert.equal(handoff.api, 'https://api.example');
    assert.equal(handoff.account.name, 'Steve');
    assert.ok(!JSON.stringify(handoff).includes('session-token'), 'the real session token must never reach the game');
    const ticketCall = fetchImpl.calls.find((c) => c.url.endsWith('/v1/auth/game-ticket'));
    assert.equal(ticketCall.options.headers.Authorization, 'Bearer session-token');

    nativeMod.clearHandoff(gameDir);
    assert.equal(fs.existsSync(path.join(gameDir, '.noctra', 'session.json')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('guests (no Native session) get the mod but no hand-off; stale hand-off is removed', async () => {
  const root = tmp();
  const gameDir = path.join(root, 'i');
  fs.mkdirSync(path.join(gameDir, '.noctra'), { recursive: true });
  fs.writeFileSync(path.join(gameDir, '.noctra', 'session.json'), '{"ticket":"nmt1.old"}');
  try {
    const result = await nativeMod.prepare({
      instance: { id: 'i', version: '26.3', loader: 'quilt' }, identity: null,
      gameDir, cacheDir: path.join(root, 'c'), roots: ['https://api.example'], fetchImpl: fakeFetch()
    });
    assert.equal(result.installed, true);
    assert.equal(result.signedIn, false);
    assert.equal(fs.existsSync(path.join(gameDir, '.noctra', 'session.json')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an expired Native session still installs the mod, as a guest', async () => {
  const root = tmp();
  try {
    const result = await nativeMod.prepare({
      instance: { id: 'i', version: '1.20.1', loader: 'fabric' }, identity: { token: 'dead' },
      gameDir: path.join(root, 'i'), cacheDir: path.join(root, 'c'), roots: ['https://api.example'], fetchImpl: fakeFetch({ ticketStatus: 401 })
    });
    assert.equal(result.installed, true);
    assert.equal(result.signedIn, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('unsupported instances are skipped so CustomSkinLoader can take over', async () => {
  const root = tmp();
  try {
    for (const instance of [{ id: 'x', version: '1.12.2', loader: 'fabric' }, { id: 'x', version: '1.20.1', loader: 'forge' }, { id: 'x', version: '1.21.1', loader: 'neoforge' }]) {
      const result = await nativeMod.prepare({ instance, identity: null, gameDir: path.join(root, 'x'), cacheDir: path.join(root, 'c'), roots: [], fetchImpl: fakeFetch() });
      assert.equal(result.installed, false);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a tampered download is rejected and nothing is installed', async () => {
  const root = tmp();
  try {
    const result = await nativeMod.prepare({
      instance: { id: 'i', version: '1.21.1', loader: 'fabric' }, identity: null,
      gameDir: path.join(root, 'i'), cacheDir: path.join(root, 'c'), roots: [], fetchImpl: fakeFetch({ jar: Buffer.from('PK-evil-jar-bytes') })
    });
    assert.equal(result.installed, false);
    assert.match(result.warning, /checksum/);
    assert.equal(fs.existsSync(path.join(root, 'i', 'mods')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('offline: cached manifest + jar keep working, and a first-ever offline launch falls back', async () => {
  const root = tmp();
  const base = { instance: { id: 'i', version: '1.21.1', loader: 'fabric' }, identity: null, gameDir: path.join(root, 'i'), cacheDir: path.join(root, 'c'), roots: [] };
  try {
    const cold = await nativeMod.prepare({ ...base, fetchImpl: fakeFetch({ offline: true }) });
    assert.equal(cold.installed, false);
    await nativeMod.prepare({ ...base, fetchImpl: fakeFetch() });
    fs.rmSync(path.join(root, 'i', 'mods'), { recursive: true, force: true });
    const warm = await nativeMod.prepare({ ...base, fetchImpl: fakeFetch({ offline: true }) });
    assert.equal(warm.installed, true);
    assert.deepEqual(fs.readdirSync(path.join(root, 'i', 'mods')), ['native-client-1.2.3.jar']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('disabling Native mod skips install, removes existing jar and clears handoff', async () => {
  const root = tmp();
  const gameDir = path.join(root, 'i');
  fs.mkdirSync(path.join(gameDir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'mods', 'native-client-1.2.3.jar'), 'jar');
  fs.writeFileSync(path.join(gameDir, 'mods', 'sodium.jar'), 'sodium');
  fs.mkdirSync(path.join(gameDir, '.native'), { recursive: true });
  fs.writeFileSync(path.join(gameDir, '.native', 'session.json'), '{}');

  try {
    const res = await nativeMod.prepare({
      instance: { id: 'i', version: '1.21.1', loader: 'fabric', disableNativeMod: true },
      identity: { token: 'tok', name: 'User' },
      gameDir,
      cacheDir: path.join(root, 'c'),
      roots: [],
      fetchImpl: fakeFetch()
    });
    assert.equal(res.installed, false);
    assert.equal(res.reason, 'disabled');
    assert.deepEqual(fs.readdirSync(path.join(gameDir, 'mods')), ['sodium.jar']);
    assert.equal(fs.existsSync(path.join(gameDir, '.native', 'session.json')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('PvP preset excludes mouse-tweaks', async () => {
  const { getPreset } = await import('../src/features/instances/presets.js');
  const pvp = getPreset('pvp');
  assert.ok(pvp, 'pvp preset exists');
  assert.equal(pvp.mods.includes('mouse-tweaks'), false, 'mouse-tweaks must be removed from pvp preset');
});


test('Fabric instances get Fabric API (verified), once, so the mod\'s logo font can load', async () => {
  const crypto = require('node:crypto');
  const api = Buffer.from('fake fabric api jar');
  const sha512 = crypto.createHash('sha512').update(api).digest('hex');
  const fetchFor = (hash = sha512) => {
    const calls = [];
    const impl = async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.startsWith('https://api.modrinth.com/v2/project/P7dR8mSH/version')) {
        return { ok: true, status: 200, json: async () => [{ version_type: 'release', files: [{ primary: true, url: 'https://cdn.modrinth.com/data/P7dR8mSH/fabric-api-0.119.4+1.21.4.jar', filename: 'fabric-api-0.119.4+1.21.4.jar', hashes: { sha512: hash } }] }] };
      }
      if (u.startsWith('https://cdn.modrinth.com/')) return { ok: true, status: 200, arrayBuffer: async () => api.buffer.slice(api.byteOffset, api.byteOffset + api.length) };
      return { ok: false, status: 404, json: async () => ({}) };
    };
    impl.calls = calls;
    return impl;
  };
  const root = tmp();
  try {
    const modsDir = path.join(root, 'mods');
    const first = await nativeMod.ensureFabricApi({ loader: 'Fabric', mcVersion: '1.21.4', modsDir, fetchImpl: fetchFor() });
    assert.equal(first.installed, true);
    assert.ok(fs.existsSync(path.join(modsDir, 'fabric-api-0.119.4+1.21.4.jar')));
    assert.ok(fetchFor().calls.length === 0);
    const again = fetchFor();
    assert.equal((await nativeMod.ensureFabricApi({ loader: 'Fabric', mcVersion: '1.21.4', modsDir, fetchImpl: again })).reason, 'present');
    assert.equal(again.calls.length, 0, 'no download when it is already there');

    const disabledDir = path.join(root, 'mods2');
    fs.mkdirSync(disabledDir);
    fs.writeFileSync(path.join(disabledDir, 'fabric-api-0.100.0.jar.disabled'), 'x');
    assert.equal((await nativeMod.ensureFabricApi({ loader: 'fabric', mcVersion: '1.21.4', modsDir: disabledDir, fetchImpl: fetchFor() })).reason, 'present', 'a disabled copy is the player\'s choice');

    const badDir = path.join(root, 'mods3');
    assert.equal((await nativeMod.ensureFabricApi({ loader: 'fabric', mcVersion: '1.21.4', modsDir: badDir, fetchImpl: fetchFor('00') })).reason, 'hash');
    assert.equal(fs.readdirSync(badDir).length, 0, 'a file that fails the hash is not kept');

    assert.equal((await nativeMod.ensureFabricApi({ loader: 'quilt', mcVersion: '1.21.4', modsDir: path.join(root, 'q'), fetchImpl: fetchFor() })).reason, 'loader');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
