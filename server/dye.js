'use strict';
/**
 * Dyeable cosmetics.
 *
 * A dyeable item keeps an undyed base texture (`dyeBase`), an optional mask (`dyeMask`, same size as
 * the texture: the mask's alpha says how strongly each pixel takes the colour; no mask = the whole
 * texture) and a default colour (`dyeDefault`). Its regular `texture` is the base dyed with the
 * default colour, so everything that knows nothing about dyes still shows the item as designed.
 *
 * A dyed pixel is the colour times the pixel's brightness (how Minecraft tints a texture), so the
 * shading of the base stays. Players pick a colour per item (`profile.cosmeticDyes = { itemId: '#rrggbb' }`)
 * and the server bakes and serves that texture like any other one (content-addressed by sha256),
 * which is why the game mod needs nothing new to show it.
 */
const zlib = require('node:zlib');

const HEX = /^#[0-9a-f]{6}$/;
/** '#RGB' / 'rrggbb' / '#RRGGBB' -> '#rrggbb', anything else -> null. */
function cleanHex(value) {
  let s = String(value ?? '').trim().toLowerCase();
  if (!s) return null;
  if (!s.startsWith('#')) s = `#${s}`;
  if (/^#[0-9a-f]{3}$/.test(s)) s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return HEX.test(s) ? s : null;
}

const MAX_SIDE = 4096;

/** 8-bit, non-interlaced PNG -> { width, height, data: RGBA Buffer } or null. */
function decodePng(buffer) {
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
  if (depth !== 8 || interlace !== 0 || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) return null;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels || (type === 3 && !palette)) return null;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[row + x - channels] : 0;
      const b = y > 0 ? px[row - stride + x] : 0;
      const c = x >= channels && y > 0 ? px[row - stride + x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[row + x] = v & 255;
    }
  }
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    const o = i * 4;
    if (type === 6) { px.copy(out, o, i * 4, i * 4 + 4); continue; }
    if (type === 2) { out[o] = px[i * 3]; out[o + 1] = px[i * 3 + 1]; out[o + 2] = px[i * 3 + 2]; out[o + 3] = 255; continue; }
    if (type === 0) { out[o] = out[o + 1] = out[o + 2] = px[i]; out[o + 3] = 255; continue; }
    if (type === 4) { out[o] = out[o + 1] = out[o + 2] = px[i * 2]; out[o + 3] = px[i * 2 + 1]; continue; }
    const k = px[i]; // palette
    out[o] = palette[k * 3] || 0; out[o + 1] = palette[k * 3 + 1] || 0; out[o + 2] = palette[k * 3 + 2] || 0;
    out[o + 3] = trns && k < trns.length ? trns[k] : 255;
  }
  return { width, height, data: out };
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(kind, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(kind, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
/** RGBA -> PNG (deterministic, so the same dye always gives the same hash). */
function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const rgbOf = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

/**
 * The base texture dyed `hex`. `mask` (PNG, optional) limits where: its alpha is the strength
 * (a mask of another size is stretched to the texture). Returns a PNG buffer.
 */
function bake(baseBuffer, maskBuffer, hex) {
  const color = cleanHex(hex);
  const base = decodePng(baseBuffer);
  if (!base) throw new Error('The texture can’t be dyed (use an 8-bit PNG).');
  if (!color) return encodePng(base);
  const mask = maskBuffer ? decodePng(maskBuffer) : null;
  if (maskBuffer && !mask) throw new Error('The dye mask must be an 8-bit PNG.');
  const [cr, cg, cb] = rgbOf(color);
  const out = Buffer.from(base.data);
  const { width, height } = base;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (!out[o + 3]) continue;
      let k = 1;
      if (mask) {
        const mx = mask.width === width ? x : Math.min(mask.width - 1, Math.floor((x * mask.width) / width));
        const my = mask.height === height ? y : Math.min(mask.height - 1, Math.floor((y * mask.height) / height));
        k = mask.data[(my * mask.width + mx) * 4 + 3] / 255;
        if (!k) continue;
      }
      const r = out[o], g = out[o + 1], b = out[o + 2];
      const lum = Math.min(255, Math.max(r, g, b) * 0.35 + (0.299 * r + 0.587 * g + 0.114 * b) * 0.65) / 255;
      out[o] = Math.round(r + (cr * lum - r) * k);
      out[o + 1] = Math.round(g + (cg * lum - g) * k);
      out[o + 2] = Math.round(b + (cb * lum - b) * k);
    }
  }
  return encodePng({ width, height, data: out });
}

/** A mask (PNG) that is valid for `base`: decodes, and has something in it. */
function checkMask(maskBuffer) {
  const mask = decodePng(maskBuffer);
  if (!mask) throw new Error('The dye mask must be an 8-bit PNG.');
  let any = false;
  for (let i = 3; i < mask.data.length; i += 4) if (mask.data[i]) { any = true; break; }
  if (!any) throw new Error('The dye mask is empty: paint the parts that take the colour.');
  return mask;
}

/** Colours offered as quick picks in the launcher and on the website. */
const SWATCHES = ['#f2f2f2', '#9a9aa2', '#2b2b30', '#e5484d', '#ff8a3d', '#ffd23f', '#7ed957', '#2fbf71', '#3ec7e0', '#3d7bff', '#8a5cff', '#ff6fb5', '#8b5a2b', '#d4af37'];

module.exports = { HEX, cleanHex, decodePng, encodePng, bake, checkMask, SWATCHES };
