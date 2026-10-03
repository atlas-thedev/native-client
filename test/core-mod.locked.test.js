const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { isNoctraCoreMod, assertNotCoreMod } = require('../electron/coreMods');

test('the Noctra mod is recognised in every form the launcher writes', () => {
  assert.ok(isNoctraCoreMod('noctra-client-1.2.0.jar'));
  assert.ok(isNoctraCoreMod('noctra-client-1.2.0.jar.disabled'));
  assert.ok(!isNoctraCoreMod('sodium-fabric-0.6.jar'));
  assert.ok(!isNoctraCoreMod('noctra-client.txt'));
});

test('it can not be disabled or removed from the mods folder', () => {
  assert.throws(() => assertNotCoreMod('mods', 'noctra-client-1.2.0.jar'), /required/);
  assert.throws(() => assertNotCoreMod(undefined, 'noctra-client-1.2.0.jar'), /required/);
  assert.doesNotThrow(() => assertNotCoreMod('mods', 'sodium.jar'));
  assert.doesNotThrow(() => assertNotCoreMod('resourcepacks', 'noctra-client-1.2.0.jar'));
});

test('renderer and main process use the same pattern', async () => {
  const ui = await import('../src/features/cluster/coreMods.js');
  const main = require('../electron/coreMods');
  assert.strictEqual(ui.NOCTRA_MOD_FILE.source, main.NOCTRA_MOD_FILE.source);
  assert.strictEqual(ui.noctraModVersion('noctra-client-1.2.0.jar'), '1.2.0');
});

test('the launcher removes a disabled copy when it installs the mod', () => {
  const os = require('node:os');
  const { installJar } = require('../electron/noctraMod');
  if (typeof installJar !== 'function') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noctra-core-'));
  const mods = path.join(dir, 'mods');
  fs.mkdirSync(mods);
  fs.writeFileSync(path.join(mods, 'noctra-client-1.1.0.jar.disabled'), 'old');
  const jar = path.join(dir, 'noctra-client-1.2.0.jar');
  fs.writeFileSync(jar, 'new');
  installJar(jar, mods);
  assert.deepStrictEqual(fs.readdirSync(mods), ['noctra-client-1.2.0.jar']);
  fs.rmSync(dir, { recursive: true, force: true });
});
