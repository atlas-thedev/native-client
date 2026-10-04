const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function pngInfo(file) {
  const data = fs.readFileSync(path.join(ROOT, file));
  assert.equal(data.subarray(1, 4).toString(), 'PNG');
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
    colorType: data[25]
  };
}

test('desktop icon assets include a 4K alpha master and standard platform sizes', () => {
  assert.deepEqual(pngInfo('src/assets/native-icon-4k.png'), { width: 4096, height: 4096, colorType: 6 });
  assert.deepEqual(pngInfo('src/assets/native-icon.png'), { width: 1024, height: 1024, colorType: 6 });

  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    assert.deepEqual(
      pngInfo(`buildResources/icons/${size}x${size}.png`),
      { width: size, height: size, colorType: 6 }
    );
  }

  const config = require('../package.json').build;
  assert.equal(config.win.icon, 'buildResources/icons');
  assert.equal(config.linux.icon, 'buildResources/icons');
  assert.equal(config.mac.icon, 'buildResources/icons');
  assert.equal(fs.readFileSync(path.join(ROOT, 'src/assets/native-icon.ico')).subarray(0, 4).toString('hex'), '00000100');
});
