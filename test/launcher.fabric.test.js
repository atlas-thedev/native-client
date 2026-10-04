const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

// electron/launcher.js requires the Electron main-process module.
require('./electron-stub');
const { _internals } = require('../electron/launcher');

test('Fabric Maven coordinates use the correct repository and artifact path', () => {
  const artifact = _internals.mavenArtifact({
    name: 'net.fabricmc:sponge-mixin:0.17.4+mixin.0.8.7',
    url: 'https://maven.fabricmc.net/'
  });

  assert.equal(
    artifact.relativePath,
    'net/fabricmc/sponge-mixin/0.17.4+mixin.0.8.7/sponge-mixin-0.17.4+mixin.0.8.7.jar'
  );
  assert.equal(
    artifact.url,
    `https://maven.fabricmc.net/${artifact.relativePath}`
  );
});

test('legacy Fabric Maven entries get secure default repositories', () => {
  const defaultArtifact = _internals.mavenArtifact({ name: 'net.minecraft:launchwrapper:1.12' });
  assert.equal(
    defaultArtifact.url,
    'https://libraries.minecraft.net/net/minecraft/launchwrapper/1.12/launchwrapper-1.12.jar'
  );

  const legacyHttpArtifact = _internals.mavenArtifact({
    name: 'org.ow2.asm:asm:7.0',
    url: 'http://repo.maven.apache.org/maven2/'
  });
  assert.equal(legacyHttpArtifact.url, 'https://repo.maven.apache.org/maven2/org/ow2/asm/asm/7.0/asm-7.0.jar');
});

test('Fabric library validation rejects corrupt cached JARs', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-fabric-unit-'));
  const jarPath = path.join(temp, 'library.jar');
  try {
    const zip = new AdmZip();
    zip.addFile('org/spongepowered/asm/launch/MixinBootstrap.class', Buffer.from('test'));
    zip.writeZip(jarPath);

    const contents = fs.readFileSync(jarPath);
    const sha1 = crypto.createHash('sha1').update(contents).digest('hex');
    assert.equal(await _internals.fileMatches(jarPath, { sha1, size: contents.length }), true);
    assert.equal(await _internals.fileMatches(jarPath, { sha1: null, size: null }), true);

    fs.writeFileSync(jarPath, 'partial download');
    assert.equal(await _internals.fileMatches(jarPath, { sha1, size: contents.length }), false);
    assert.equal(await _internals.fileMatches(jarPath, { sha1: null, size: null }), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('a loader-named asset index is mirrored under the game version', () => {
  const launcherMod = require('../electron/launcher');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-index-unit-'));
  const indexes = path.join(temp, 'minecraft', 'assets', 'indexes');
  fs.mkdirSync(indexes, { recursive: true });
  const profileIndex = path.join(indexes, 'fabric-loader-0.16.9-1.21.1.json');
  fs.writeFileSync(profileIndex, JSON.stringify({ objects: { 'minecraft/sounds.json': { hash: 'a'.repeat(40) } } }));

  try {
    launcherMod.init({ app: { getPath: () => temp }, getWin: () => null }, { on() {}, handle() {} });

    const canonical = launcherMod._internals.ensureCanonicalAssetIndex('1.21.1', 'fabric-loader-0.16.9-1.21.1');
    assert.equal(canonical, path.join(indexes, '1.21.1.json'));
    assert.deepEqual(
      JSON.parse(fs.readFileSync(canonical, 'utf8')),
      JSON.parse(fs.readFileSync(profileIndex, 'utf8'))
    );

    // An existing canonical index is never overwritten.
    fs.writeFileSync(canonical, JSON.stringify({ objects: { keep: { hash: 'b'.repeat(40) } } }));
    launcherMod._internals.ensureCanonicalAssetIndex('1.21.1', 'fabric-loader-0.16.9-1.21.1');
    assert.deepEqual(JSON.parse(fs.readFileSync(canonical, 'utf8')), { objects: { keep: { hash: 'b'.repeat(40) } } });

    // Vanilla installs never need mirroring.
    assert.equal(launcherMod._internals.ensureCanonicalAssetIndex('1.21.1', null), null);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('legacy crosshair rendering jars are recoverably disabled on Minecraft 1.21.6+', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-crosshair-'));
  const modsDir = path.join(temp, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  const jarPath = path.join(modsDir, 'custom-crosshair-x.jar');
  const zip = new AdmZip();
  zip.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ id: 'custom_crosshair_x', name: 'Custom Crosshair X' })));
  zip.addFile(
    'dev/native/CrosshairMixin.class',
    Buffer.from('com/mojang/blaze3d/systems/RenderSystem\0enableBlend')
  );
  zip.writeZip(jarPath);
  fs.writeFileSync(path.join(modsDir, '.native-mods.json'), JSON.stringify({
    crosshair: { filename: 'custom-crosshair-x.jar', folder: 'mods', enabled: true }
  }));

  try {
    assert.equal(_internals.usesPost1216Rendering('1.21.5'), false);
    assert.equal(_internals.usesPost1216Rendering('1.21.6'), true);
    const result = _internals.quarantineIncompatibleMods(temp, '1.21.6');
    assert.equal(result.length, 1);
    assert.equal(fs.existsSync(jarPath), false);
    assert.equal(fs.existsSync(`${jarPath}.disabled`), true);
    const manifest = JSON.parse(fs.readFileSync(path.join(modsDir, '.native-mods.json'), 'utf8'));
    assert.equal(manifest.crosshair.filename, 'custom-crosshair-x.jar.disabled');
    assert.equal(manifest.crosshair.enabled, false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('jars explicitly built for another Minecraft version are disabled before launch', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-wrong-mc-'));
  const modsDir = path.join(temp, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  const jarPath = path.join(modsDir, 'sodium-fabric-0.7.3+mc1.21.8.jar');
  const zip = new AdmZip();
  zip.addFile('fabric.mod.json', Buffer.from(JSON.stringify({
    id: 'sodium',
    name: 'Sodium',
    version: '0.7.3+mc1.21.8'
  })));
  zip.writeZip(jarPath);

  try {
    const result = _internals.quarantineIncompatibleMods(temp, '1.21.6');
    assert.equal(result.length, 1);
    assert.match(result[0].reason, /targets Minecraft 1\.21\.8/);
    assert.equal(fs.existsSync(jarPath), false);
    assert.equal(fs.existsSync(`${jarPath}.disabled`), true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('launch handles payload object without throwing ReferenceError on payload', async () => {
  const launcherMod = require('../electron/launcher');
  let errorCaught = null;
  try {
    await launcherMod._internals.launch({
      instance: { id: 'test-inst', version: '1.20.1', loader: 'Vanilla' },
      account: { name: 'Player' }
    });
  } catch (err) {
    errorCaught = err;
  }
  if (errorCaught) {
    assert.notEqual(errorCaught.name, 'ReferenceError');
    assert.ok(!errorCaught.message.includes('payload is not defined'));
  }
});
