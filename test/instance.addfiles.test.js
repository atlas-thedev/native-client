require('./electron-stub');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

const instanceMod = require('../electron/instance');

function setup() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'native-add-'));
  instanceMod.init({ app: { getPath: () => userData } }, { handle() {}, on() {} });
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'native-src-'));
  return { userData, src };
}
const instanceFolder = (userData, id) => {
  // instances live under <userData>/instances or the shared game root; find the one addContentFiles used
  const found = [];
  const walk = (dir, depth) => { if (depth > 4) return; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (!e.isDirectory()) continue; const full = path.join(dir, e.name); if (e.name === id) found.push(full); else walk(full, depth + 1); } };
  walk(userData, 0);
  return found[0];
};

test('adds dropped mods and skips the wrong file types', () => {
  const { userData, src } = setup();
  fs.writeFileSync(path.join(src, 'sodium.jar'), 'jar');
  fs.writeFileSync(path.join(src, 'notes.txt'), 'txt');
  const result = instanceMod.addContentFiles('i1', 'mods', [path.join(src, 'sodium.jar'), path.join(src, 'notes.txt')]);
  assert.deepEqual(result.added, ['sodium.jar']);
  assert.equal(result.skipped.length, 1);
  assert.ok(fs.existsSync(path.join(instanceFolder(userData, 'i1'), 'mods', 'sodium.jar')));
  const again = instanceMod.addContentFiles('i1', 'mods', [path.join(src, 'sodium.jar')]);
  assert.deepEqual(again.added, []);
  assert.equal(again.skipped[0].reason, 'already added');
});

test('unpacks a world zip and copies pack folders', () => {
  const { userData, src } = setup();
  const zip = new AdmZip();
  zip.addFile('My World/level.dat', Buffer.from('dat'));
  zip.addFile('My World/region/r.0.0.mca', Buffer.from('mca'));
  zip.writeZip(path.join(src, 'world.zip'));
  const worlds = instanceMod.addContentFiles('i2', 'saves', [path.join(src, 'world.zip')]);
  assert.deepEqual(worlds.added, ['My World']);
  const saves = path.join(instanceFolder(userData, 'i2'), 'saves');
  assert.ok(fs.existsSync(path.join(saves, 'My World', 'region', 'r.0.0.mca')));
  // same world again gets its own folder
  assert.deepEqual(instanceMod.addContentFiles('i2', 'saves', [path.join(src, 'world.zip')]).added, ['My World (2)']);
  fs.mkdirSync(path.join(src, 'Faithful'));
  fs.writeFileSync(path.join(src, 'Faithful', 'pack.mcmeta'), '{}');
  assert.deepEqual(instanceMod.addContentFiles('i2', 'resourcepacks', [path.join(src, 'Faithful')]).added, ['Faithful']);
  assert.throws(() => instanceMod.addContentFiles('i2', '../x', []));
});
