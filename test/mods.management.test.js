const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mods = require('../electron/mods');

test('managed content metadata keeps exact game and loader compatibility', () => {
  const cleaned = mods.cleanMetadata({
    title: 'Sodium',
    source: 'modrinth',
    gameVersions: ['1.21.6'],
    loaders: ['fabric']
  });
  assert.deepEqual(cleaned.gameVersions, ['1.21.6']);
  assert.deepEqual(cleaned.loaders, ['fabric']);
});

function fixture(t, entry = { filename: 'example.jar', folder: 'mods' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mods-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'minecraft/instances/test/mods');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'example.jar'), 'test mod');
  fs.writeFileSync(path.join(dir, '.native-mods.json'), JSON.stringify({ example: entry }));
  const handlers = {};
  mods.init({ app: { getPath: () => root } }, { handle: (name, fn) => { handlers[name] = fn; } });
  return { dir, root, call: (name, payload) => handlers[`mods:${name}`](null, { instanceId: 'test', projectId: 'example', ...payload }) };
}

test('enabling and disabling mods renames the actual file and persists state', t => {
  const { dir, call } = fixture(t);
  assert.equal(call('toggle', { enabled: false }).example.filename, 'example.jar.disabled');
  assert.equal(fs.existsSync(path.join(dir, 'example.jar')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'example.jar.disabled'), 'utf8'), 'test mod');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.native-mods.json'))).example.enabled, false);
  assert.equal(call('toggle', { enabled: true }).example.filename, 'example.jar');
  assert.equal(fs.existsSync(path.join(dir, 'example.jar.disabled')), false);
});

test('legacy bare filenames can be toggled and removed', t => {
  const { dir, call } = fixture(t, 'example.jar');
  call('toggle', { enabled: false });
  assert.deepEqual(call('remove'), {});
  assert.equal(fs.existsSync(path.join(dir, 'example.jar.disabled')), false);
});

test('missing folder metadata defaults to mods during removal', t => {
  const { dir, call } = fixture(t, { filename: 'example.jar' });
  assert.deepEqual(call('remove'), {});
  assert.equal(fs.existsSync(path.join(dir, 'example.jar')), false);
});

test('toggle refuses filename collisions without overwriting either mod', t => {
  const { dir, call } = fixture(t);
  fs.writeFileSync(path.join(dir, 'example.jar.disabled'), 'other mod');
  assert.throws(() => call('toggle', { enabled: false }), /already exists/);
  assert.equal(fs.readFileSync(path.join(dir, 'example.jar'), 'utf8'), 'test mod');
  assert.equal(fs.readFileSync(path.join(dir, 'example.jar.disabled'), 'utf8'), 'other mod');
});

test('malformed filenames cannot escape the content folder', t => {
  const { call } = fixture(t, { filename: '../example.jar', folder: 'mods' });
  assert.throws(() => call('toggle', { enabled: false }), /Invalid filename/);
  assert.throws(() => call('remove'), /Invalid filename/);
});

test('non-mod content cannot be renamed by the mod toggle', t => {
  const { call } = fixture(t, { filename: 'example.jar', folder: 'resourcepacks' });
  assert.throws(() => call('toggle', { enabled: false }), /Only mods/);
});

test('mods cannot be installed to a vanilla instance', async (t) => {
  const { root, call } = fixture(t);
  fs.writeFileSync(path.join(root, 'instances.json'), JSON.stringify({
    instances: [
      { id: 'test', name: 'Vanilla 1.20', loader: 'Vanilla' }
    ]
  }));
  await assert.rejects(
    async () => {
      await call('install', { url: 'https://example.com/mod.jar', filename: 'mod.jar', folder: 'mods' });
    },
    /Mods cannot be installed to Vanilla instances/
  );
});

test('managed installs reject builds for a different Minecraft version', async (t) => {
  const { root, call } = fixture(t);
  fs.writeFileSync(path.join(root, 'instances.json'), JSON.stringify({
    instances: [
      { id: 'test', name: 'Fabric 1.21.6', version: '1.21.6', loader: 'Fabric' }
    ]
  }));
  await assert.rejects(
    call('install', {
      url: 'https://example.com/sodium.jar',
      filename: 'sodium-mc1.21.8.jar',
      folder: 'mods',
      metadata: { gameVersions: ['1.21.8'], loaders: ['fabric'] }
    }),
    /not compatible with Minecraft 1\.21\.6/
  );
});

test('isVanillaInstance detects vanilla vs modded loaders correctly', (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'instances.json'), JSON.stringify({
    instances: [
      { id: 'v1', name: 'Vanilla', loader: 'Vanilla' },
      { id: 'v2', name: 'Vanilla lower', loader: 'vanilla' },
      { id: 'v3', name: 'No loader' },
      { id: 'f1', name: 'Fabric', loader: 'Fabric' },
      { id: 'fg1', name: 'Forge', loader: 'Forge' },
      { id: 'q1', name: 'Quilt', loader: 'Quilt' }
    ]
  }));
  assert.equal(mods.isVanillaInstance('v1'), true);
  assert.equal(mods.isVanillaInstance('v2'), true);
  assert.equal(mods.isVanillaInstance('v3'), true);
  assert.equal(mods.isVanillaInstance('f1'), false);
  assert.equal(mods.isVanillaInstance('fg1'), false);
  assert.equal(mods.isVanillaInstance('q1'), false);
  assert.equal(mods.isVanillaInstance('non-existent'), false);
});

test('untracked files can be deleted and cannot escape the content folder', t => {
  const { dir, root } = fixture(t);
  fs.writeFileSync(path.join(dir, 'local.jar'), 'x');
  const handlers = {};
  mods.init({ app: { getPath: () => root } }, { handle: (name, fn) => { handlers[name] = fn; } });
  handlers['mods:removeFile'](null, { instanceId: 'test', folder: 'mods', filename: 'local.jar' });
  assert.equal(fs.existsSync(path.join(dir, 'local.jar')), false);
  assert.throws(() => handlers['mods:removeFile'](null, { instanceId: 'test', folder: 'mods', filename: '../x.jar' }), /Invalid filename/);
  assert.throws(() => handlers['mods:removeFile'](null, { instanceId: 'test', folder: 'saves', filename: 'x' }), /Unsupported/);
});
