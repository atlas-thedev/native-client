const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const { isSlimSkinPng } = require('../server/skin-model');

// builds a 64x64 RGBA PNG; `clear(x, y)` decides which pixels are fully transparent
function png(clear) {
  const rows = [];
  for (let y = 0; y < 64; y++) {
    const row = Buffer.alloc(1 + 64 * 4);
    for (let x = 0; x < 64; x++) row.set([120, 90, 60, clear(x, y) ? 0 : 255], 1 + x * 4);
    rows.push(row);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(64, 0); ihdr.writeUInt32BE(64, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const slimHole = (x, y) => (x >= 54 && x < 56 && y >= 20 && y < 32) || (x >= 50 && x < 52 && y >= 16 && y < 20);

test('a skin whose unused slim arm columns are empty is slim', () => {
  assert.strictEqual(isSlimSkinPng(png(slimHole)), true);
});
test('a fully painted classic skin is not slim', () => {
  assert.strictEqual(isSlimSkinPng(png(() => false)), false);
});
test('one stray transparent pixel does not make a classic skin slim', () => {
  assert.strictEqual(isSlimSkinPng(png((x, y) => x === 54 && y === 25)), false);
});
test('garbage and non-skin sizes are never slim', () => {
  assert.strictEqual(isSlimSkinPng(Buffer.from('nope')), false);
  assert.strictEqual(isSlimSkinPng(null), false);
});
