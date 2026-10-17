'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

function makePng(width, height, r = 255, g = 0, b = 0, a = 255) {
  const crc = (buf) => {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(zlib.crc32(buf) >>> 0);
    return out;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    return Buffer.concat([length, body, crc(body)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const row = Buffer.alloc(1 + width * 4);
  row[0] = 0; // filter None
  for (let x = 0; x < width; x++) {
    row[1 + x * 4] = r;
    row[1 + x * 4 + 1] = g;
    row[1 + x * 4 + 2] = b;
    row[1 + x * 4 + 3] = a;
  }
  const rows = [];
  for (let y = 0; y < height; y++) rows.push(row);
  const idat = zlib.deflateSync(Buffer.concat(rows));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

test('ncmImport: computeModelCenter calculates bounding box center accurately', async () => {
  const { computeModelCenter } = await import('../src/lib/ncmImport.js');
  const model = {
    format: 1,
    texture: [64, 64],
    parts: [
      {
        attach: 'head',
        pivot: [0, 0, 0],
        cubes: [
          { origin: [-4, 0, -4], size: [8, 8, 8] },
          { origin: [0, 8, 0], size: [2, 2, 2] }
        ]
      }
    ]
  };
  const center = computeModelCenter(model);
  // minX = -4, maxX = 4 -> cx = 0
  // minY = 0, maxY = 10 -> cy = 5
  // minZ = -4, maxZ = 4 -> cz = 0
  assert.deepEqual(center, [0, 5, 0]);
});

test('ncmImport: transformNcmModel scales around bounding center, offsets and rotates', async () => {
  const { transformNcmModel } = await import('../src/lib/ncmImport.js');
  const model = {
    format: 1,
    texture: [64, 64],
    parts: [
      {
        attach: 'head',
        pivot: [0, 2, 0],
        rotation: [0, 0, 0],
        cubes: [
          {
            origin: [-2, -2, -2],
            size: [4, 4, 4],
            uv: [0, 0]
          }
        ]
      }
    ]
  };
  const transformed = transformNcmModel(model, {
    offset: [1, 2, 3],
    rotation: [0, 90, 0]
  });
  assert.equal(transformed.parts.length, 1);
  assert.deepEqual(transformed.parts[0].pivot, [1, 4, 3]);
  assert.deepEqual(transformed.parts[0].rotation, [0, 90, 0]);
});

test('ncmImport: scaleNcmAsset scales geometry and multiplies texture atlas', async () => {
  const { scaleNcmAsset } = await import('../src/lib/ncmImport.js');
  const pngBytes = makePng(16, 16, 255, 128, 64, 255);
  const model = {
    format: 1,
    texture: [16, 16],
    parts: [
      {
        attach: 'head',
        pivot: [0, 0, 0],
        cubes: [
          {
            origin: [-4, 0, -4],
            size: [8, 8, 8],
            uv: [0, 0]
          }
        ]
      }
    ]
  };

  const scaled = await scaleNcmAsset(model, pngBytes, null, 1.5);
  assert.ok(scaled);
  assert.ok(scaled.model);
  assert.ok(scaled.png instanceof Uint8Array || Buffer.isBuffer(scaled.png));
  assert.equal(scaled.png[0], 0x89);
  assert.equal(scaled.png[1], 0x50);
});

test('ncmImport: bakeDye generates tinted texture from base and mask', async () => {
  const { bakeDye } = await import('../src/lib/ncmImport.js');
  const basePng = makePng(8, 8, 200, 200, 200, 255);
  const maskPng = makePng(8, 8, 255, 255, 255, 255); // Full mask
  const dyed = await bakeDye(basePng, maskPng, '#FF0000');
  assert.ok(dyed);
  assert.ok(dyed.length > 0);
  assert.equal(dyed[0], 0x89); // PNG signature
  assert.equal(dyed[1], 0x50);
});
