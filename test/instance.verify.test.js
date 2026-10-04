require('./electron-stub');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const instanceMod = require('../electron/instance');
const installRegistry = require('../electron/installRegistry');

const FAKE_IPC = { handle() {}, on() {} };

/** Fresh userData + game root per test, wired into both modules under test. */
function makeRoot() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'native-verify-'));
  const gameRoot = path.join(userData, 'minecraft');
  fs.mkdirSync(gameRoot, { recursive: true });
  instanceMod.init({ app: { getPath: () => userData } }, FAKE_IPC);
  installRegistry.init({ app: { getPath: () => userData } });
  return { userData, gameRoot };
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/** Fake asset index with `count` objects, of which the last `missing` are absent. */
function writeAssetIndex(gameRoot, name, { count = 40, missing = 0 } = {}) {
  const objects = {};
  for (let i = 0; i < count; i += 1) {
    const hash = String(i).padStart(40, '0');
    objects[`assets/object-${i}`] = { hash, size: 1 };
    if (i >= missing) {
      const file = path.join(gameRoot, 'assets', 'objects', hash.slice(0, 2), hash);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'x');
    }
  }
  writeJson(path.join(gameRoot, 'assets', 'indexes', `${name}.json`), { objects });
  return objects;
}

/**
 * Reproduce the layout Minecraft Launcher Core leaves behind for a Fabric
 * install: the loader profile carries the metadata, the vanilla client jar is
 * downloaded under the profile name, and the asset index is named after the
 * profile instead of the game version.
 */
function fabricLayout(gameRoot, {
  version = '1.21.1',
  profile = 'fabric-loader-0.16.9-1.21.1',
  indexName = profile,
  count = 40,
  missing = 0
} = {}) {
  const versionsDir = path.join(gameRoot, 'versions', profile);
  writeJson(path.join(versionsDir, `${profile}.json`), {
    id: profile,
    inheritsFrom: version,
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    libraries: []
  });
  fs.writeFileSync(path.join(versionsDir, `${profile}.jar`), Buffer.alloc(1_200_000));
  writeJson(path.join(versionsDir, `${version}.json`), {
    id: version,
    assetIndex: { id: version, url: 'https://example.invalid/index.json' },
    assets: version,
    mainClass: 'net.minecraft.client.main.Main'
  });
  writeAssetIndex(gameRoot, indexName, { count, missing });
  fs.mkdirSync(path.join(gameRoot, 'libraries'), { recursive: true });
}

test('a Fabric install whose asset index is named after the loader profile verifies', () => {
  const { gameRoot } = makeRoot();
  fabricLayout(gameRoot);

  const result = instanceMod.verifyInstallation('1.21.1', 'Fabric');

  assert.equal(result.reason, null);
  assert.equal(result.installed, true);
  assert.equal(result.assetIndex, 'fabric-loader-0.16.9-1.21.1');
  assert.equal(result.totalAssets, 40);
  assert.equal(instanceMod.isInstalled('1.21.1', 'Fabric'), true);
});

test('a canonical game-version asset index verifies the same install', () => {
  const { gameRoot } = makeRoot();
  fabricLayout(gameRoot, { indexName: '1.21.1' });

  const result = instanceMod.verifyInstallation('1.21.1', 'Fabric');

  assert.equal(result.installed, true);
  assert.equal(result.assetIndex, '1.21.1');
});

test('a launch record makes an install verifiable even when the index name is unusual', () => {
  const { gameRoot } = makeRoot();
  const profile = 'fabric-loader-0.16.9-1.21.1';
  fabricLayout(gameRoot, { indexName: 'index-2024-copy' });

  // Nothing named after the version or the profile: verification alone refuses.
  assert.equal(instanceMod.isInstalled('1.21.1', 'Fabric'), false);

  installRegistry.record({
    version: '1.21.1',
    loader: 'Fabric',
    loaderVersion: '0.16.9',
    files: {
      profile,
      jar: path.join(gameRoot, 'versions', profile, `${profile}.jar`),
      versionJson: path.join(gameRoot, 'versions', profile, '1.21.1.json'),
      assetIndex: path.join(gameRoot, 'assets', 'indexes', 'index-2024-copy.json'),
      assetObjects: path.join(gameRoot, 'assets', 'objects')
    }
  });

  const result = instanceMod.verifyInstallation('1.21.1', 'Fabric');
  assert.equal(result.installed, true);
  assert.equal(result.assetIndex, 'index-2024-copy');
  assert.equal(result.verifiedBy, 'launch-record');
});

test('a Forge profile directory named <version>-forge-<build> is detected', () => {
  const { gameRoot } = makeRoot();
  const profile = '1.21.1-forge-52.0.1';
  const versionsDir = path.join(gameRoot, 'versions', profile);
  writeJson(path.join(versionsDir, `${profile}.json`), {
    id: profile,
    inheritsFrom: '1.21.1',
    mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
    libraries: []
  });
  fs.writeFileSync(path.join(versionsDir, `${profile}.jar`), Buffer.alloc(1_200_000));
  writeAssetIndex(gameRoot, '1.21.1');
  fs.mkdirSync(path.join(gameRoot, 'libraries'), { recursive: true });

  const result = instanceMod.verifyInstallation('1.21.1', 'Forge');

  assert.equal(result.installed, true);
  assert.equal(result.loaderProfile, profile);
});

test('missing asset objects still fail, but only when they are a real share of the index', () => {
  const { gameRoot } = makeRoot();
  fabricLayout(gameRoot, { count: 400, missing: 120 });

  const broken = instanceMod.verifyInstallation('1.21.1', 'Fabric');
  assert.equal(broken.installed, false);
  assert.equal(broken.reason, 'missing_assets');
  assert.equal(broken.missingAssets, 120);
});

test('a few straggler objects do not flip a complete install back to missing', () => {
  const { gameRoot } = makeRoot();
  fabricLayout(gameRoot, { count: 400, missing: 4 });

  const result = instanceMod.verifyInstallation('1.21.1', 'Fabric');

  assert.equal(result.installed, true);
  assert.equal(result.missingAssets, 4);
});

test('installedVersions reports a Fabric install that has no versions/<gameVersion> folder', () => {
  const { gameRoot } = makeRoot();
  fabricLayout(gameRoot);

  const list = instanceMod.installedVersions();

  assert.deepEqual(list, [{ version: '1.21.1', loader: 'Fabric' }]);
});

test('a requested loader that is not on disk is still reported as missing', () => {
  const { gameRoot } = makeRoot();
  fabricLayout(gameRoot);

  const result = instanceMod.verifyInstallation('1.21.1', 'Forge');

  assert.equal(result.installed, false);
  assert.equal(result.reason, 'missing_loader');
});
