const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { isNativeCoreMod, assertNotCoreMod } = require('../electron/coreMods');

test('the Native mod is recognised in every form the launcher writes', () => {
  assert.ok(isNativeCoreMod('native-client-1.2.0.jar'));
  assert.ok(isNativeCoreMod('native-client-1.2.0.jar.disabled'));
  assert.ok(!isNativeCoreMod('sodium-fabric-0.6.jar'));
  assert.ok(!isNativeCoreMod('native-client.txt'));
});

test('it can not be disabled or removed from the mods folder', () => {
  assert.throws(() => assertNotCoreMod('mods', 'native-client-1.2.0.jar'), /required/);
  assert.throws(() => assertNotCoreMod(undefined, 'native-client-1.2.0.jar'), /required/);
  assert.doesNotThrow(() => assertNotCoreMod('mods', 'sodium.jar'));
  assert.doesNotThrow(() => assertNotCoreMod('resourcepacks', 'native-client-1.2.0.jar'));
});

test('renderer and main process use the same pattern', async () => {
  const ui = await import('../src/features/cluster/coreMods.js');
  const main = require('../electron/coreMods');
  assert.strictEqual(ui.NATIVE_MOD_FILE.source, main.NATIVE_MOD_FILE.source);
  assert.strictEqual(ui.nativeModVersion('native-client-1.2.0.jar'), '1.2.0');
});

test('the launcher removes a disabled copy when it installs the mod', () => {
  const os = require('node:os');
  const { installJar } = require('../electron/nativeMod');
  if (typeof installJar !== 'function') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-core-'));
  const mods = path.join(dir, 'mods');
  fs.mkdirSync(mods);
  fs.writeFileSync(path.join(mods, 'native-client-1.1.0.jar.disabled'), 'old');
  const jar = path.join(dir, 'native-client-1.2.0.jar');
  fs.writeFileSync(jar, 'new');
  installJar(jar, mods);
  assert.deepStrictEqual(fs.readdirSync(mods), ['native-client-1.2.0.jar']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the launcher also removes pre-rename noctra-client jars so only one Native mod loads', () => {
  const os = require('node:os');
  const { installJar } = require('../electron/nativeMod');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-core-'));
  const mods = path.join(dir, 'mods');
  fs.mkdirSync(mods);
  fs.writeFileSync(path.join(mods, 'noctra-client-1.0.0.jar'), 'old');
  fs.writeFileSync(path.join(mods, 'noctra-client-1.0.1.jar.disabled'), 'old');
  fs.writeFileSync(path.join(mods, 'sodium.jar'), 'keep');
  const jar = path.join(dir, 'native-client-1.3.1.jar');
  fs.writeFileSync(jar, 'new');
  installJar(jar, mods);
  assert.deepStrictEqual(fs.readdirSync(mods).sort(), ['native-client-1.3.1.jar', 'sodium.jar']);
  fs.rmSync(dir, { recursive: true, force: true });
});
