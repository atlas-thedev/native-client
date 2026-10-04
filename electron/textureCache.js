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
const MAX_FILES = 400;
let root = null;

function init(userDataDir) {
  root = path.join(userDataDir, 'cache', 'textures');
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
  try {
    const bytes = fs.readFileSync(path.join(root, `${hash}.png`));
    if (sha(bytes) === hash) return bytes;
    fs.rmSync(path.join(root, `${hash}.png`), { force: true });
  } catch { /* not cached */ }
  return null;
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

/** Keeps the folder bounded: drops the least recently used files beyond MAX_FILES. */
function prune() {
  try {
    const files = fs.readdirSync(root).filter((name) => name.endsWith('.png'))
      .map((name) => ({ name, at: fs.statSync(path.join(root, name)).atimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const extra of files.slice(MAX_FILES)) fs.rmSync(path.join(root, extra.name), { force: true });
  } catch { /* ignore */ }
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

module.exports = { init, dir, read, write, fetchCached, hashFromUrl, sha };
