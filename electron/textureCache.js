'use strict';
/**
 * Shared, content-addressed texture cache (<userData>/cache/textures/<sha256>.png).
 *
 * Store capes downloaded by the launcher (previews, locker sync) land here, and the Native
 * Client mod reads the same folder (told via <gameDir>/.noctra/launcher.json), so a cape the
 * launcher already has is never downloaded again in game. Files are named by the sha256 of
 * their bytes, exactly like the API's /csl/textures/<hash> URLs, and verified on read.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HASH_RE = /^[a-f0-9]{64}$/;
const MAX_FILES = 1500; // store items + every worn texture; bounded by size below too
const MAX_BYTES = 512 * 1024 * 1024;
const TOUCH_EVERY_MS = 6 * 60 * 60 * 1000; // re-mark a used file at most every 6h (cheap LRU)
let root = null;

function init(userDataDir) {
  root = path.join(userDataDir, 'cache', 'textures');
  setTimeout(prune, 20_000).unref?.();
  return root;
}

const dir = () => root;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** The texture hash at the end of an API texture URL, or null. */
function hashFromUrl(url) {
  const match = String(url || '').match(/([a-f0-9]{64})(?:\.png)?(?:[?#].*)?$/i);
  return match ? match[1].toLowerCase() : null;
}

function read(hash) {
  if (!root || !HASH_RE.test(String(hash || ''))) return null;
  const file = path.join(root, `${hash}.png`);
  try {
    const bytes = fs.readFileSync(file);
    if (sha(bytes) === hash) { touch(file); return bytes; }
    fs.rmSync(file, { force: true });
  } catch { /* not cached */ }
  return null;
}

/** Marks a file as recently used (mtime), so pruning keeps what the Locker/Store/game actually use. */
function touch(file) {
  try {
    const now = Date.now();
    if (now - fs.statSync(file).mtimeMs < TOUCH_EVERY_MS) return;
    const at = new Date(now);
    fs.utimesSync(file, at, at);
  } catch { /* best-effort */ }
}

let writes = 0;
/** Stores bytes under their own sha256. Returns the hash (or null when there is no cache). */
function write(bytes) {
  if (!root || !bytes || bytes.length < 24) return null;
  const hash = sha(bytes);
  const file = path.join(root, `${hash}.png`);
  try {
    if (fs.existsSync(file)) return hash;
    fs.mkdirSync(root, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, file);
    if (++writes % 25 === 0) prune();
  } catch { /* cache is best-effort */ }
  return hash;
}

/**
 * Keeps the folder bounded and clean: removes leftover .tmp files, then drops the least recently
 * used textures beyond MAX_FILES or MAX_BYTES. Files used recently are touched in read(), so
 * worn/owned items stay and only old, unused downloads are cleaned.
 */
function prune() {
  if (!root) return;
  try {
    const now = Date.now();
    const files = [];
    for (const name of fs.readdirSync(root)) {
      const full = path.join(root, name);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (name.endsWith('.tmp')) { if (now - stat.mtimeMs > 10 * 60 * 1000) fs.rmSync(full, { force: true }); continue; }
      if (!name.endsWith('.png')) continue;
      files.push({ full, at: Math.max(stat.mtimeMs, stat.atimeMs || 0), size: stat.size });
    }
    files.sort((a, b) => b.at - a.at);
    let total = 0;
    files.forEach((file, index) => {
      total += file.size;
      if (index >= MAX_FILES || total > MAX_BYTES) fs.rmSync(file.full, { force: true });
    });
  } catch { /* ignore */ }
}

/** Size of the cache folder, for the Storage panel. */
function stats() {
  if (!root) return { files: 0, bytes: 0 };
  try {
    let bytes = 0; let files = 0;
    for (const name of fs.readdirSync(root)) {
      if (!name.endsWith('.png')) continue;
      try { bytes += fs.statSync(path.join(root, name)).size; files += 1; } catch {}
    }
    return { files, bytes };
  } catch { return { files: 0, bytes: 0 }; }
}

/** Cached bytes for a texture URL, else downloads (and caches) them. */
async function fetchCached(url, { maxBytes = 32 * 1024 * 1024, timeoutMs = 25_000, fetchImpl = fetch } = {}) {
  const hash = hashFromUrl(url);
  const cached = hash ? read(hash) : null;
  if (cached) return cached;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length <= 24 || bytes.length > maxBytes) return null;
  if (!hash || sha(bytes) === hash) write(bytes);
  return bytes;
}

module.exports = { init, dir, read, write, fetchCached, hashFromUrl, sha, prune, stats };
