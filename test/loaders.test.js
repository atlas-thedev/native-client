const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

require('./electron-stub');
const loaders = require('../electron/loaders');

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `noctra-loaders-${name}-`));

test('loader names normalize to one kind each', () => {
  const cases = {
    Vanilla: 'vanilla', '': 'vanilla', Fabric: 'fabric', fabric: 'fabric', Quilt: 'quilt',
    Forge: 'forge', NeoForge: 'neoforge', neoforge: 'neoforge', 'Legacy Fabric': 'legacyfabric',
    'legacy-fabric': 'legacyfabric'
  };
  for (const [input, kind] of Object.entries(cases)) assert.equal(loaders.normalize(input), kind, input);
  assert.equal(loaders.displayName('legacy-fabric'), 'Legacy Fabric');
});

test('loader versions sort numerically with prereleases below releases', async () => {
  const input = ['0.16.9', '0.16.10', '0.17.0-beta.1', '0.16.10-beta.2', '0.17.0', '0.9.0'];
  const sorted = [...input].sort(loaders.compareLoaderVersions);
  assert.deepEqual(sorted, ['0.9.0', '0.16.9', '0.16.10-beta.2', '0.16.10', '0.17.0-beta.1', '0.17.0']);
  // The renderer mirror orders identically.
  const mirror = await import('../src/lib/loaders.js');
  assert.deepEqual([...input].sort(mirror.compareLoaderVersions), sorted);
  for (const name of ['Fabric', 'Legacy Fabric', 'NeoForge', 'quilt', 'Vanilla']) {
    assert.equal(mirror.normalizeLoader(name), loaders.normalize(name));
  }
});

test('NeoForge build prefixes follow the game version', () => {
  assert.equal(loaders.neoforgePrefix('1.21.1'), '21.1.');
  assert.equal(loaders.neoforgePrefix('1.21'), '21.0.');
  assert.equal(loaders.neoforgePrefix('26.1'), '26.1.0.');
  assert.equal(loaders.neoforgePrefix('26.1.2'), '26.1.2.');
  assert.equal(loaders.neoforgePrefix('24w14a'), null);
});

test('availability rules cover each loader range', () => {
  assert.equal(loaders.availability('Legacy Fabric', '1.8.9').available, true);
  assert.equal(loaders.availability('Legacy Fabric', '1.20.1').available, false);
  assert.equal(loaders.availability('Quilt', '1.12.2').available, false);
  assert.equal(loaders.availability('NeoForge', '1.20.1').available, true);
  assert.equal(loaders.availability('NeoForge', '1.19.4').available, false);
  assert.equal(loaders.availability('Fabric', '24w14a').available, true);
  assert.equal(loaders.availability('Forge', '24w14a').available, false);
});

function mockFetch(routes) {
  const original = global.fetch;
  global.fetch = async (url) => {
    const key = Object.keys(routes).find((prefix) => String(url).startsWith(prefix));
    if (!key) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => routes[key] };
  };
  return () => { global.fetch = original; };
}

test('version lists are sorted, tagged and filtered per game version', async () => {
  loaders._cache.clear();
  const restore = mockFetch({
    'https://meta.quiltmc.org/v3/versions/loader/1.21.1': [
      { loader: { version: '0.20.0-beta.9' } },
      { loader: { version: '0.29.2' } },
      { loader: { version: '0.30.0-beta.1' } },
      { loader: { version: '0.24.0' } }
    ],
    'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge': {
      versions: ['21.0.167', '21.1.76', '21.1.77', '21.10.5-beta', '21.1.80-beta', '0.25w14craftmine.3']
    },
    'https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json': {
      '1.21.1': ['1.21.1-52.0.1', '1.21.1-52.1.0', '1.21.1-52.1.16']
    },
    'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json': {
      promos: { '1.21.1-recommended': '52.1.0', '1.21.1-latest': '52.1.16' }
    }
  });
  try {
    const quilt = await loaders.listVersions('Quilt', '1.21.1');
    assert.deepEqual(quilt.versions.map((v) => v.version), ['0.30.0-beta.1', '0.29.2', '0.24.0', '0.20.0-beta.9']);
    assert.equal(quilt.recommended, '0.29.2');
    assert.equal(quilt.latest, '0.30.0-beta.1');
    assert.equal(quilt.versions[0].stable, false);

    const neo = await loaders.listVersions('NeoForge', '1.21.1');
    assert.deepEqual(neo.versions.map((v) => v.version), ['21.1.80-beta', '21.1.77', '21.1.76']);
    assert.equal(neo.recommended, '21.1.77');

    const forge = await loaders.listVersions('Forge', '1.21.1');
    assert.equal(forge.versions[0].version, '52.1.16');
    assert.equal(forge.recommended, '52.1.0');
    assert.equal(forge.versions.find((v) => v.version === '52.1.0').recommended, true);

    const none = await loaders.listVersions('Quilt', '1.12.2');
    assert.equal(none.versions.length, 0);
    assert.match(none.unavailable, /1\.14/);
  } finally {
    restore();
    loaders._cache.clear();
  }
});

test('switch checks keep multi-loader jars and flag the rest', () => {
  const mods = [
    { file: 'sodium.jar', name: 'Sodium', loader: 'fabric', platforms: ['fabric'] },
    { file: 'jei.jar', name: 'JEI', loader: 'forge', platforms: ['forge'] },
    { file: 'both.jar', name: 'Cloth Config', loader: 'fabric', platforms: ['fabric', 'neoforge'] },
    { file: 'qsl.jar', name: 'QSL', loader: 'quilt', platforms: ['quilt'] },
    { file: 'CustomSkinLoader_Fabric.jar', name: 'CSL', loader: 'fabric', platforms: ['fabric'] },
    { file: 'mystery.jar', name: 'mystery', loader: 'unknown', platforms: [] }
  ];
  const toQuilt = loaders.classifyMods(mods, 'Quilt', '1.21.1');
  assert.deepEqual(toQuilt.incompatible.map((m) => m.file), ['jei.jar']);
  assert.equal(toQuilt.compatible, 3);
  assert.equal(toQuilt.unknown.length, 1);

  const toNeo = loaders.classifyMods(mods, 'NeoForge', '1.21.1');
  assert.deepEqual(toNeo.incompatible.map((m) => m.file), ['sodium.jar', 'jei.jar', 'qsl.jar']);
  // NeoForge for 1.20.1 still loads Forge mods.
  assert.equal(loaders.classifyMods(mods, 'NeoForge', '1.20.1').incompatible.some((m) => m.file === 'jei.jar'), false);
  assert.equal(loaders.loaderAccepts('Fabric', 'quilt', '1.21.1'), false);
});

test('disabling mods renames jars and updates the manifest', () => {
  const dir = tmp('disable');
  try {
    fs.writeFileSync(path.join(dir, 'jei.jar'), 'x');
    fs.writeFileSync(path.join(dir, 'keep.jar'), 'x');
    fs.writeFileSync(path.join(dir, '.native-mods.json'), JSON.stringify({ jei: { filename: 'jei.jar', folder: 'mods', enabled: true } }));
    const result = loaders.disableMods(dir, ['jei.jar', '../evil.jar', 'missing.jar']);
    assert.deepEqual(result, [{ file: 'jei.jar', disabledFile: 'jei.jar.disabled' }]);
    assert.equal(fs.existsSync(path.join(dir, 'jei.jar.disabled')), true);
    assert.equal(fs.existsSync(path.join(dir, 'keep.jar')), true);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.native-mods.json'), 'utf8'));
    assert.deepEqual(manifest.jei, { filename: 'jei.jar.disabled', folder: 'mods', enabled: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the cached Forge profile is regenerated when the loader jar changes', () => {
  const root = tmp('forgecache');
  try {
    const profile = path.join(root, 'forge', '1.20.1', 'version.json');
    assert.equal(loaders.prepareForgeCache(root, '1.20.1', '/a/forge-1.20.1-47.2.0-installer.jar'), true);
    fs.writeFileSync(profile, '{}');
    assert.equal(loaders.prepareForgeCache(root, '1.20.1', '/a/forge-1.20.1-47.2.0-installer.jar'), false);
    assert.equal(fs.existsSync(profile), true);
    assert.equal(loaders.prepareForgeCache(root, '1.20.1', '/a/neoforge-1.20.1-47.1.106-installer.jar'), true);
    assert.equal(fs.existsSync(profile), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy Forge installers hand MCLC their universal jar', () => {
  const dir = tmp('forgejar');
  try {
    const modern = new AdmZip();
    modern.addFile('version.json', Buffer.from('{}'));
    modern.addFile('install_profile.json', Buffer.from('{}'));
    const modernPath = path.join(dir, 'forge-1.20.1-47.2.0-installer.jar');
    modern.writeZip(modernPath);
    assert.equal(loaders.launchableForgeJar(modernPath, 'forge'), modernPath);

    const universal = new AdmZip();
    universal.addFile('version.json', Buffer.from('{"inheritsFrom":"1.8.9"}'));
    const legacy = new AdmZip();
    legacy.addFile('install_profile.json', Buffer.from('{}'));
    legacy.addFile('forge-1.8.9-11.15.1.2318-1.8.9-universal.jar', universal.toBuffer());
    const legacyPath = path.join(dir, 'forge-1.8.9-11.15.1.2318-1.8.9-installer.jar');
    legacy.writeZip(legacyPath);
    const jar = loaders.launchableForgeJar(legacyPath, 'forge');
    assert.equal(path.basename(jar), 'forge-1.8.9-11.15.1.2318-1.8.9-universal.jar');
    assert.ok(new AdmZip(jar).getEntry('version.json'));

    const broken = new AdmZip();
    broken.addFile('install_profile.json', Buffer.from('{}'));
    const brokenPath = path.join(dir, 'forge-1.5.2-installer.jar');
    broken.writeZip(brokenPath);
    assert.throws(() => loaders.launchableForgeJar(brokenPath, 'forge'), /installer format/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('calendar-versioned Minecraft counts as modern Forge for MCLC', () => {
  loaders.patchMclc();
  const Handler = require('minecraft-launcher-core/components/handler');
  const probe = Handler.prototype.isModernForge;
  assert.equal(probe.call({}, { inheritsFrom: '26.1', id: 'neoforge-26.1.0.19-beta' }), true);
  assert.equal(probe.call({}, { inheritsFrom: '1.21.1', id: 'neoforge-21.1.77' }), true);
  assert.equal(Boolean(probe.call({}, { inheritsFrom: '1.8.9', id: '1.8.9-forge' })), false);
});

test('modpacks keep NeoForge and Quilt instead of refusing them', () => {
  const { loaderFromDependencies } = require('../electron/modpacks');
  assert.deepEqual(loaderFromDependencies({ minecraft: '1.21.1', neoforge: '21.1.77' }), { loader: 'NeoForge', loaderVersion: '21.1.77' });
  assert.deepEqual(loaderFromDependencies({ minecraft: '1.21.1', 'quilt-loader': '0.29.2' }), { loader: 'Quilt', loaderVersion: '0.29.2' });
});

test('the mod index records every loader a jar supports', () => {
  const { readJar } = require('../electron/modIndex');
  const zip = new AdmZip();
  zip.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ id: 'cloth-config', name: 'Cloth Config' })));
  zip.addFile('META-INF/neoforge.mods.toml', Buffer.from('[[mods]]\nmodId="cloth_config"\n'));
  const info = readJar(zip.toBuffer());
  assert.equal(info.loader, 'fabric');
  assert.deepEqual(info.platforms, ['fabric', 'neoforge']);
});
