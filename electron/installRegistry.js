const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./download');

/**
 * Launch-install registry (main process).
 *
 * Minecraft files are named inconsistently depending on *how* the version was
 * installed. minecraft-launcher-core names a Fabric/Forge asset index after the
 * launch profile it used (`assets/indexes/fabric-loader-0.16.9-1.21.1.json`)
 * while Mojang's own convention is to name it after the game version
 * (`assets/indexes/1.21.1.json`). A verifier that only knows the version name
 * therefore reports "assets not installed" forever, even after a successful
 * launch.
 *
 * Writes what the launch pipeline actually produced for every
 * `{version}:{loader}` pair, so verification can look for the exact files on
 * disk instead of guessing at names. Everything here is best-effort: a failed
 * registry write must never break a launch.
 */

const FILE_NAME = 'install-registry.json';
const MAX_ENTRIES = 200;

let deps = null;
let cache = null;

function init(dependencies) {
  deps = dependencies;
  cache = null;
}

function configured() {
  try {
    return Boolean(deps?.app?.getPath);
  } catch {
    return false;
  }
}

function rootDir() {
  if (!configured()) return null;
  try {
    return path.join(deps.app.getPath('userData'), 'minecraft');
  } catch {
    return null;
  }
}

function filePath() {
  const root = rootDir();
  return root ? path.join(root, FILE_NAME) : null;
}

function cacheKey(version, loader) {
  return `${String(version || '').trim()}:${String(loader || 'Vanilla').trim() || 'Vanilla'}`;
}

/** Stored paths are relative to the game root and always use forward slashes. */
function toRelative(root, absolute) {
  if (!root || !absolute) return null;
  try {
    return path.relative(root, absolute).split(path.sep).join('/');
  } catch {
    return null;
  }
}

function toAbsolute(root, relative) {
  if (!root || !relative) return null;
  return path.join(root, ...String(relative).split('/'));
}

function load() {
  if (cache) return cache;
  const file = filePath();
  if (!file) {
    cache = {};
    return cache;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    cache = {};
  }
  return cache;
}

function persist(store) {
  const root = rootDir();
  if (!root) return;
  try {
    fs.mkdirSync(root, { recursive: true });
    writeFileAtomic(filePath(), JSON.stringify(store, null, 2));
  } catch {
    /* best effort */
  }
}

/** Registry entry for a version + loader pair, or null. */
function get(version, loader = 'Vanilla') {
  if (!version) return null;
  const entry = load()[cacheKey(version, loader)];
  return entry && typeof entry === 'object' ? entry : null;
}

/** Every recorded install, newest launch first. */
function all() {
  const store = load();
  return Object.values(store)
    .filter((entry) => entry && typeof entry === 'object' && entry.version)
    .sort((a, b) => (b.launchedAt || 0) - (a.launchedAt || 0));
}

/**
 * Remember (or refresh) an install. `files` may hold absolute paths — they are
 * stored relative to the game root so the registry survives a moved userData
 * directory.
 */
function record({ version, loader = 'Vanilla', loaderVersion = null, files = {}, launchedAt = Date.now() }) {
  if (!version) return null;
  const root = rootDir();
  const store = load();
  const key = cacheKey(version, loader);
  const previous = store[key] || {};

  const entry = {
    version: String(version),
    loader: String(loader || 'Vanilla'),
    loaderVersion: loaderVersion || previous.loaderVersion || null,
    launchedAt,
    launches: (previous.launches || 0) + 1
  };

  for (const field of ['profile', 'versionJson', 'jar', 'assetIndex', 'assetObjects']) {
    const value = files[field];
    if (!value) {
      if (previous[field]) entry[field] = previous[field];
      continue;
    }
    entry[field] = path.isAbsolute(value) ? toRelative(root, value) : String(value).split(path.sep).join('/');
  }

  store[key] = entry;

  // Keep the file bounded — it only exists to disambiguate installed names.
  const keys = Object.keys(store).sort((a, b) => (store[b].launchedAt || 0) - (store[a].launchedAt || 0));
  for (const stale of keys.slice(MAX_ENTRIES)) delete store[stale];

  cache = store;
  persist(store);
  return entry;
}

/** Absolute path helper for consumers: resolve a stored file field. */
function fileFor(entry, field) {
  const root = rootDir();
  return entry ? toAbsolute(root, entry[field]) : null;
}

/** Drop a record (used when an instance and its files are removed). */
function forget(version, loader = 'Vanilla') {
  const store = load();
  const key = cacheKey(version, loader);
  if (!(key in store)) return false;
  delete store[key];
  cache = store;
  persist(store);
  return true;
}

/** Changes whenever the registry file is written (cheap: one stat). */
function stamp() {
  try { return Math.floor(fs.statSync(filePath()).mtimeMs); } catch { return 0; }
}

module.exports = { init, get, all, record, forget, fileFor, filePath, cacheKey, stamp };
