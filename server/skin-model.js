'use strict';
/**
 * Works out whether a skin PNG is a slim (3px arm, "Alex") skin from the pixels themselves, so a
 * slim skin that was saved as classic never shows black/cut arm edges on the website, in the
 * launcher or in game. Only the unambiguous case is detected: every pixel of the right arm's
 * unused slim columns (x 54-55, y 20-31 and x 50-51, y 16-19) is fully transparent.
 */
const zlib = require('node:zlib');

function decodeRgba(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
  let off = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  while (off + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(off);
    const kind = buffer.toString('latin1', off + 4, off + 8);
    const data = buffer.subarray(off + 8, off + 8 + len);
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (kind === 'PLTE') palette = data;
    else if (kind === 'tRNS') trns = data;
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || width < 1 || height < 1 || width > 1024 || height > 1024) return null;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels) return null;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = v & 255;
    }
  }
  const alpha = (x, y) => {
    const i = (y * width + x) * channels;
    if (type === 6) return px[i + 3];
    if (type === 4) return px[i + 1];
    if (type === 3) return trns && px[i] < trns.length ? trns[px[i]] : 255;
    return 255;
  };
  return { width, height, alpha };
}

function isSlimSkinPng(buffer) {
  const img = decodeRgba(buffer);
  if (!img || img.width !== 64 || img.height !== 64) return false;
  const clear = (x0, y0, w, h) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (img.alpha(x, y) !== 0) return false;
    return true;
  };
  return clear(54, 20, 2, 12) && clear(50, 16, 2, 4);
}

module.exports = { isSlimSkinPng, decodeRgba };
