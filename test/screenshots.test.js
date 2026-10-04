require('./electron-stub');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const instance = require('../electron/instance');

const FAKE_IPC = { handle() {}, on() {}, removeHandler() {} };
const PNG = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10,
  0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0, 1, 0, 0, 0, 1,
  8, 6, 0, 0, 0
]);

function createInstanceFixture() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'noctra-screenshots-'));
  instance.init({ app: { getPath: () => userData } }, FAKE_IPC);
  const gameDir = path.join(userData, 'minecraft', 'instances', 'instance-1');
  fs.mkdirSync(path.join(gameDir, 'screenshots'), { recursive: true });
  fs.mkdirSync(path.join(gameDir, 'saves', 'Color World'), { recursive: true });
  return { userData, gameDir };
}

test('screenshot manager lists, reads, validates and deletes local captures', () => {
  const { userData, gameDir } = createInstanceFixture();
  try {
    const screenshots = path.join(gameDir, 'screenshots');
    fs.writeFileSync(path.join(screenshots, '2026-09-15_15.00.00.png'), PNG);
    fs.writeFileSync(path.join(screenshots, 'notes.txt'), 'not an image');

    const rows = instance.screenshotList('instance-1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, '2026-09-15_15.00.00.png');
    assert.equal(rows[0].size, PNG.length);
    assert.match(instance.screenshotData('instance-1', rows[0].name), /^data:image\/png;base64,/);
    assert.throws(() => instance.screenshotData('instance-1', '../secret.png'), /Invalid screenshot filename/);

    const linked = path.join(screenshots, 'linked.png');
    try {
      fs.symlinkSync(path.join(screenshots, rows[0].name), linked);
      assert.throws(() => instance.screenshotData('instance-1', 'linked.png'), /links are not supported/);
      fs.rmSync(linked);
    } catch (err) {
      if (err.code !== 'EPERM') throw err;
    }

    instance.deleteScreenshot('instance-1', rows[0].name);
    assert.deepEqual(instance.screenshotList('instance-1'), []);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('world list exposes Minecraft world icons and stable colored-art seeds', () => {
  const { userData, gameDir } = createInstanceFixture();
  try {
    fs.writeFileSync(path.join(gameDir, 'saves', 'Color World', 'icon.png'), PNG);
    const first = instance.worldList('instance-1');
    const second = instance.worldList('instance-1');

    assert.equal(first.length, 1);
    assert.match(first[0].iconUrl, /^data:image\/png;base64,/);
    assert.equal(Number.isInteger(first[0].artSeed), true);
    assert.equal(first[0].artSeed, second[0].artSeed);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('screenshot manager refuses a linked screenshots directory', () => {
  const { userData, gameDir } = createInstanceFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'noctra-outside-screenshots-'));
  try {
    fs.rmSync(path.join(gameDir, 'screenshots'), { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(gameDir, 'screenshots'));
      assert.throws(() => instance.screenshotList('instance-1'), /Invalid screenshots directory/);
    } catch (err) {
      if (err.code !== 'EPERM') throw err;
    }
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
