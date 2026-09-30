const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'noctra-crash-'));
process.env.NOCTRA_TEST_USER_DATA = userData;
require('./electron-stub.js');
const AdmZip = require('adm-zip');
const { buildIndex } = require('../electron/modIndex');
const crashReporter = require('../electron/crashReporter');

const app = { getPath: () => userData };
crashReporter.init({ app, getWin: () => null }, { handle() {}, on() {} });

const instanceId = 'inst-a';
const gameDir = path.join(userData, 'minecraft', 'instances', instanceId);
const modsDir = path.join(gameDir, 'mods');

function makeJar(file, json, classes = []) {
  const zip = new AdmZip();
  zip.addFile('fabric.mod.json', Buffer.from(JSON.stringify(json)));
  for (const cls of classes) zip.addFile(cls, Buffer.from([0xca, 0xfe]));
  zip.writeZip(path.join(modsDir, file));
}

test('mod index reads ids, deps, mixins and packages', () => {
  fs.mkdirSync(modsDir, { recursive: true });
  makeJar('coolmod-1.0.jar', { id: 'coolmod', name: 'Cool Mod', version: '1.0', depends: { 'fabric-api': '*' }, mixins: ['coolmod.mixins.json'] }, ['com/example/coolmod/client/Hud.class', 'com/example/coolmod/Main.class']);
  const mods = buildIndex(modsDir);
  assert.equal(mods.length, 1);
  assert.deepEqual(mods[0].ids, ['coolmod']);
  assert.deepEqual(mods[0].mixins, ['coolmod.mixins.json']);
  assert.ok(mods[0].packages.includes('com.example.coolmod.client'));
  assert.equal(mods[0].depends['fabric-api'], '*');
  assert.ok(fs.existsSync(path.join(modsDir, '.noctra-crash-index.json')));
});

test('a crashed session is analysed, saved, and fixes apply on disk', async () => {
  crashReporter.beginSession({ instance: { id: instanceId, name: 'A', version: '1.20.1', loader: 'Fabric' }, memoryMaxGb: 4 });
  crashReporter.capture('[main/ERROR]: boom\njava.lang.NullPointerException: x\n\tat com.example.coolmod.client.Hud.render(Hud.java:1)\n');
  const record = await crashReporter.endSession(1, null);
  assert.ok(record?.id);
  assert.equal(record.report.suspects[0].file, 'coolmod-1.0.jar');
  assert.ok(fs.existsSync(path.join(userData, 'crash-reports', `${record.id}.json`)));

  const { applyFix } = crashReporter._internals;
  const res = await applyFix(record.id, { id: 'disable-mod:coolmod-1.0.jar', kind: 'disable-mod', file: 'coolmod-1.0.jar', name: 'Cool Mod' });
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(path.join(modsDir, 'coolmod-1.0.jar.disabled')));

  fs.mkdirSync(path.join(gameDir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'config', 'broken.json'), '{ nope');
  await applyFix(record.id, { id: 'r', kind: 'reset-config', path: 'config/broken.json' });
  assert.equal(fs.existsSync(path.join(gameDir, 'config', 'broken.json')), false);
  assert.ok(fs.readdirSync(path.join(gameDir, '.noctra-backup')).length === 1);

  await applyFix(record.id, { id: 's', kind: 'disable-shaders' });
  assert.match(fs.readFileSync(path.join(gameDir, 'config', 'iris.properties'), 'utf8'), /enableShaders=false/);

  fs.writeFileSync(path.join(gameDir, 'config', 'fml.toml'), 'earlyWindowControl = true\nother = 1\n');
  await applyFix(record.id, { id: 'f', kind: 'forge-early-window' });
  assert.match(fs.readFileSync(path.join(gameDir, 'config', 'fml.toml'), 'utf8'), /^earlyWindowControl = false$/m);

  await assert.rejects(applyFix(record.id, { id: 'x', kind: 'reset-config', path: '../../escape.txt' }));
});

test('a clean exit or a user kill is not a crash', async () => {
  crashReporter.beginSession({ instance: { id: instanceId, name: 'A', version: '1.20.1', loader: 'Fabric' } });
  assert.equal(await crashReporter.endSession(0, null), null);
  crashReporter.beginSession({ instance: { id: instanceId, name: 'A', version: '1.20.1', loader: 'Fabric' } });
  crashReporter.markKilled();
  assert.equal(await crashReporter.endSession(1, null), null);
});
