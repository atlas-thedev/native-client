'use strict';
/**
 * Animated capes + the Noctra cape store.
 *
 * An animated cape is published as TWO textures so nothing that only knows
 * static capes can ever break:
 *   - `cape`      the first frame, a normal cape texture (vanilla, CustomSkinLoader,
 *                 older launchers and the website all keep working with it);
 *   - `capeAnim`  the whole frame strip (frames stacked vertically) plus frame
 *                 count and speed, used by clients that can animate it.
 *
 * Every frame is `width x (height / frames)`. Standard cape art is 2:1
 * (64x32, 128x64 ... 2048x1024), but any frame size is accepted; the strip is
 * simply cut into `frames` equal rows.
 */
const fs = require('fs');
const path = require('path');

const STORE_DIR = path.join(__dirname, 'store');
const ASSET_DIR = path.join(STORE_DIR, 'assets');
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const LIMITS = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxWidth: 4096,
  maxHeight: 32768,
  maxPixels: 33_554_432,
  minFrames: 2,
  maxFrames: 240,
  minFps: 1,
  maxFps: 30,
  minFrameWidth: 16,
  minFrameHeight: 8
});

function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE) || buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Invalid PNG texture.');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) throw new Error('Invalid PNG texture.');
  return { width, height };
}

/** Base64 (or data URL) -> Buffer, or null for empty input. */
function pngFromBase64(value, maxBytes = LIMITS.maxBytes) {
  if (value == null || value === '') return null;
  const raw = String(value).replace(/^data:image\/png;base64,/i, '');
  const data = Buffer.from(raw, 'base64');
  if (data.length <= 24 || data.length > maxBytes) throw new Error('That PNG is empty or too large.');
  pngSize(data);
  return data;
}

/**
 * Checks an animated cape submission and returns its normalised description.
 * `strip` and `still` are PNG buffers.
 */
function validateAnimation({ strip, still, frames, fps }) {
  const count = Number(frames);
  const speed = Number(fps);
  if (!Number.isInteger(count) || count < LIMITS.minFrames || count > LIMITS.maxFrames) {
    throw new Error(`An animated cape needs ${LIMITS.minFrames}-${LIMITS.maxFrames} frames.`);
  }
  if (!Number.isFinite(speed) || speed < LIMITS.minFps || speed > LIMITS.maxFps) {
    throw new Error(`Animation speed must be between ${LIMITS.minFps} and ${LIMITS.maxFps} frames per second.`);
  }
  const { width, height } = pngSize(strip);
  if (width > LIMITS.maxWidth || height > LIMITS.maxHeight) throw new Error('That animation is too large.');
  if (width * height > LIMITS.maxPixels) throw new Error('That animation is too large. Use fewer frames or a lower resolution.');
  if (height % count !== 0) throw new Error(`The strip height (${height}px) is not divisible by ${count} frames.`);
  const frameHeight = height / count;
  if (width < LIMITS.minFrameWidth || frameHeight < LIMITS.minFrameHeight) throw new Error('Each frame must be at least 16x8 pixels.');
  const first = pngSize(still);
  if (first.width !== width || first.height !== frameHeight) {
    throw new Error(`The still frame must be ${width}x${frameHeight}px.`);
  }
  return { frames: count, fps: Math.round(speed * 100) / 100, width, frameHeight };
}

/* ── Store catalogue ──────────────────────────────────────────────────── */

/**
 * Reads a bundled base64 asset. Big strips are split into `<name>.part0`, `<name>.part1`, …
 * (each under 1 MB so they stay easy to review and push); the parts are joined in order.
 */
function readAsset(name) {
  const file = path.join(ASSET_DIR, name);
  if (!fs.existsSync(`${file}.part0`)) return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  const parts = [];
  for (let i = 0; fs.existsSync(`${file}.part${i}`); i += 1) parts.push(fs.readFileSync(`${file}.part${i}`, 'utf8').trim());
  if (!parts.length) throw new Error(`Missing asset ${name}.`);
  return Buffer.from(parts.join(''), 'base64');
}

/**
 * Loads the bundled catalogue and publishes its textures through `storeTexture`
 * (which hashes + writes them like any other texture).
 */
function loadCatalog(storeTexture) {
  const meta = JSON.parse(fs.readFileSync(path.join(STORE_DIR, 'catalog.json'), 'utf8'));
  const items = [];
  for (const item of meta.items || []) {
    try {
      const strip = readAsset(`${item.id}.strip.png.b64`);
      const still = readAsset(`${item.id}.still.png.b64`);
      const description = validateAnimation({ strip, still, frames: item.frames, fps: item.fps });
      items.push({
        id: item.id,
        section: item.section || 'capes',
        name: item.name,
        description: item.description || '',
        tags: Array.isArray(item.tags) ? item.tags : [],
        author: item.author || 'Noctra',
        featured: Boolean(item.featured),
        exclusive: Boolean(item.exclusive),
        art: Math.max(1, Math.floor(Number(item.art) || 1)),
        price: 0,
        animated: true,
        frames: description.frames,
        fps: description.fps,
        width: description.width,
        frameHeight: description.frameHeight,
        strip: storeTexture(strip),
        still: storeTexture(still)
      });
    } catch (error) {
      console.warn(`[Noctra Store] Skipping "${item.id}": ${error.message}`);
    }
  }
  return { sections: meta.sections || [], items };
}

module.exports = { LIMITS, pngSize, pngFromBase64, validateAnimation, loadCatalog };
