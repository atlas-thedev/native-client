'use strict';
/**
 * Builds the setup's side artwork (24-bit BMPs at 100/150/200 % DPI) from the
 * launcher's login art. Runs as electron-builder's beforePack hook, so the
 * binary BMPs never need to live in git. Dependency-free: tiny PNG decoder
 * (8-bit RGB/RGBA, non-interlaced) + area-average downscale + BMP writer.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src/assets/native-login-side.png');
const OUT = path.join(ROOT, 'buildResources/installer');
const PANEL = { w: 300, h: 420 };

function decodePng(buf) {
  let pos = 8, width = 0, height = 0, colorType = 0, depth = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || (colorType !== 2 && colorType !== 6) || interlace) throw new Error('Unsupported PNG');
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = Buffer.alloc(width * height * 3);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const f = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = v & 255;
    }
    for (let x = 0; x < width; x += 1) line.copy(px, (y * width + x) * 3, x * bpp, x * bpp + 3);
    prev = line;
  }
  return { width, height, px };
}

/** Crop (sx, sy, sw, sh) and area-average down to (w, h). */
function resample(img, sx, sy, sw, sh, w, h) {
  const out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y += 1) {
    const y0 = sy + (y * sh) / h, y1 = sy + ((y + 1) * sh) / h;
    for (let x = 0; x < w; x += 1) {
      const x0 = sx + (x * sw) / w, x1 = sx + ((x + 1) * sw) / w;
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy += 1) {
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx += 1) {
          const i = (yy * img.width + xx) * 3;
          r += img.px[i]; g += img.px[i + 1]; b += img.px[i + 2]; n += 1;
        }
      }
      const o = (y * w + x) * 3;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n);
    }
  }
  return out;
}

function bmp(px, w, h) {
  const row = Math.ceil((w * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + row * h);
  buf.write('BM', 0); buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14); buf.writeInt32LE(w, 18); buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28); buf.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y += 1) {
    const dst = 54 + (h - 1 - y) * row;
    for (let x = 0; x < w; x += 1) {
      const s = (y * w + x) * 3, d = dst + x * 3;
      buf[d] = px[s + 2]; buf[d + 1] = px[s + 1]; buf[d + 2] = px[s];
    }
  }
  return buf;
}

function build() {
  const img = decodePng(fs.readFileSync(SRC));
  const sw = Math.round((img.height * PANEL.w) / PANEL.h);
  const sx = Math.max(0, Math.round((img.width - sw) / 2));
  fs.mkdirSync(OUT, { recursive: true });
  for (const [scale, name] of [[1, '100'], [1.5, '150'], [2, '200']]) {
    const w = Math.round(PANEL.w * scale), h = Math.round(PANEL.h * scale);
    fs.writeFileSync(path.join(OUT, `art-${name}.bmp`), bmp(resample(img, sx, 0, sw, img.height, w, h), w, h));
  }
}

module.exports = async function beforePack() { build(); };
if (require.main === module) build();
