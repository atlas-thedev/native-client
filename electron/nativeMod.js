'use strict';

/**
 * Native Client mod integration.
 *
 * For Fabric / Quilt instances on Minecraft 1.16 → 26.x the launcher installs the
 * "Native Client" mod (built in the private native-mod repo, downloaded from github.com/atlas-thedev/native-mod-releases). The mod shows every
 * Native player's skin and cape live, and signs the game in to the player's
 * Native account through a short-lived, game-only ticket the launcher writes to
 * `<gameDir>/.native/session.json`. The account's real session token never
 * reaches the game.
 *
 * Everything here is best-effort: any failure returns `{ installed: false }`
 * and the caller falls back to CustomSkinLoader, so a launch never breaks.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MOD_REPO = process.env.NATIVE_MOD_REPO || 'atlas-thedev/native-mod-releases';
const LEGACY_MOD_REPO = 'atlas-thedev/noctra-mod';
const GITHUB = 'https://github.com/';
const MANIFEST_URL = process.env.NATIVE_MOD_MANIFEST ||
  GITHUB + MOD_REPO + '/releases/latest/download/manifest.json';
const DOWNLOAD_PREFIX = GITHUB + MOD_REPO + '/releases/download/';
const LEGACY_DOWNLOAD_PREFIX = GITHUB + LEGACY_MOD_REPO + '/releases/download/';
const JAR_NAME = /^(?:native|noctra)-client-[0-9A-Za-z.+-]+\.jar$/;
/** Every jar the launcher owns: the current mod and the pre-rename "noctra-client" builds. */
const OWNED_JAR = /^(?:native|noctra)-client-.*\.jar(\.disabled)?$/i;
const MAX_JAR_BYTES = 16 * 1024 * 1024;
const FIRST_SUPPORTED = [1, 16];

/** Fabric and Quilt only (Quilt loads fabric.mod.json mods). */
function supportsLoader(loader) {
  const value = String(loader || '').toLowerCase().replace(/[\s_-]+/g, '');
  if (!value || value.includes('legacy') || value.includes('forge')) return false;
  return value.includes('fabric') || value.includes('quilt');
}

/** 1.16+ and the 26.x year-style releases. Snapshots/unknown formats are not supported. */
function supportsMinecraft(version, min = FIRST_SUPPORTED) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(version || '').trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const [minMajor, minMinor] = min;
  return major > minMajor || (major === minMajor && minor >= minMinor);
}

function parseMin(manifest) {
  const match = /^(\d+)\.(\d+)/.exec(String(manifest?.minecraft?.min || ''));
  return match ? [Number(match[1]), Number(match[2])] : FIRST_SUPPORTED;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  if (manifest.schema !== 1) return null;
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+/.test(manifest.version)) return null;
  if (typeof manifest.file !== 'string' || !JAR_NAME.test(manifest.file)) return null;
  if (typeof manifest.url !== 'string' || (!manifest.url.startsWith(DOWNLOAD_PREFIX) && !manifest.url.startsWith(LEGACY_DOWNLOAD_PREFIX)) || !manifest.url.endsWith('/' + manifest.file)) return null;
  if (typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.sha256)) return null;
  const size = Number(manifest.size);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_JAR_BYTES) return null;
  return { ...manifest, sha256: manifest.sha256.toLowerCase(), size };
}

const sha256Of = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function writeFileAtomic(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, data, mode ? { mode } : undefined);
  fs.renameSync(temp, file);
}

async function fetchWithTimeout(fetchImpl, url, options = {}, ms = 10_000) {
  return fetchImpl(url, { ...options, signal: AbortSignal.timeout(ms) });
}

/** Latest manifest from GitHub, falling back to the last good copy when offline. */
async function loadManifest({ cacheDir, fetchImpl = fetch, url = MANIFEST_URL } = {}) {
  const cacheFile = cacheDir ? path.join(cacheDir, 'manifest.json') : null;
  try {
    const response = await fetchWithTimeout(fetchImpl, url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = validateManifest(await response.json());
    if (!manifest) throw new Error('unexpected manifest');
    if (cacheFile) { try { writeFileAtomic(cacheFile, JSON.stringify(manifest, null, 2)); } catch { /* cache is optional */ } }
    return manifest;
  } catch (error) {
    const cached = readCachedManifest(cacheDir);
    if (cached) return cached;
    throw new Error(`Could not read the Native mod manifest (${error.message}).`);
  }
}

function readCachedManifest(cacheDir) {
  if (!cacheDir) return null;
  try {
    return validateManifest(JSON.parse(fs.readFileSync(path.join(cacheDir, 'manifest.json'), 'utf8')));
  } catch {
    return null;
  }
}

/** True when the file exists and matches the manifest's size and sha256. */
function verified(file, manifest) {
  try {
    const data = fs.readFileSync(file);
    return data.length === manifest.size && sha256Of(data) === manifest.sha256;
  } catch {
    return false;
  }
}

/** Returns the path of a verified jar in the cache, downloading it when needed. */
async function ensureJar(manifest, { cacheDir, fetchImpl = fetch } = {}) {
  const target = path.join(cacheDir, manifest.file);
  if (verified(target, manifest)) return target;

  const response = await fetchWithTimeout(fetchImpl, manifest.url, {}, 60_000);
  if (!response.ok) throw new Error(`Download failed (HTTP ${response.status}).`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length !== manifest.size || sha256Of(data) !== manifest.sha256) {
    throw new Error('The downloaded Native mod did not match its checksum.');
  }
  writeFileAtomic(target, data);
  return target;
}

/**
 * Offline: only a jar that still matches the last good manifest is used. Any other
 * native-client-*.jar in the mods folder (tampered, half-written, unknown) is not trusted.
 */
function offlineJar(gameDir, cacheDir) {
  const manifest = readCachedManifest(cacheDir);
  if (!manifest) return null;
  const modsDir = path.join(gameDir, 'mods');
  if (verified(path.join(modsDir, manifest.file), manifest)) return manifest.file;
  const cached = path.join(cacheDir, manifest.file);
  if (verified(cached, manifest)) {
    try { return installJar(cached, modsDir); } catch { return null; }
  }
  return null;
}

/** Puts exactly one Native mod jar into the instance's mods folder. */
function installJar(jarPath, modsDir) {
  fs.mkdirSync(modsDir, { recursive: true });
  const name = path.basename(jarPath);
  const destination = path.join(modsDir, name);
  for (const entry of fs.readdirSync(modsDir)) {
    // Older versions, and any copy someone renamed to .jar.disabled: the launcher owns this mod.
    if (entry !== name && OWNED_JAR.test(entry)) {
      try { fs.rmSync(path.join(modsDir, entry), { force: true }); } catch { /* in use: next launch */ }
    }
  }
  const source = fs.readFileSync(jarPath);
  let current = null;
  try { current = fs.readFileSync(destination); } catch { /* not installed yet */ }
  if (!current || !current.equals(source)) writeFileAtomic(destination, source);
  return name;
}

/** Trades the account's launcher session for a game-only ticket. */
async function requestTicket(roots, sessionToken, { fetchImpl = fetch } = {}) {
  if (!sessionToken) return null;
  for (const root of roots) {
    try {
      const response = await fetchWithTimeout(fetchImpl, `${root}/v1/auth/game-ticket`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
        body: '{}'
      }, 10_000);
      if (response.status === 401) return null;
      if (!response.ok) continue;
      const data = await response.json();
      if (data?.ok && typeof data.ticket === 'string' && data.ticket.startsWith('nmt1.')) {
        return { ticket: data.ticket, expiresAt: data.expiresAt || null, account: data.account || null, api: root };
      }
    } catch { /* try the next root */ }
  }
  return null;
}

/** The ticket is written to .native only: a second copy is just one more place to leak it from. */
const sessionPath = (gameDir) => path.join(gameDir, '.native', 'session.json');
/** Clearing still covers the old .noctra mirror, so a stale ticket from an older launcher is removed. */
const handoffPaths = (gameDir) => [
  sessionPath(gameDir),
  path.join(gameDir, '.noctra', 'session.json')
];

function writeHandoff(gameDir, { ticket, api, expiresAt, account }) {
  const body = {
    v: 1,
    ticket,
    api,
    expiresAt: expiresAt || null,
    account: {
      id: account?.id ?? null,
      name: account?.name ?? account?.username ?? null,
      uuid: account?.minecraft_uuid ?? account?.minecraftUuid ?? null
    },
    launcher: 'native-client'
  };
  try { writeFileAtomic(sessionPath(gameDir), JSON.stringify(body, null, 2), 0o600); } catch { /* ignore */ }
}

/**
 * Tells the mod where the launcher's shared texture cache lives (<gameDir>/.native/launcher.json),
 * so capes the launcher already downloaded are read from disk instead of the network.
 */
function writeLauncherInfo(gameDir, { textureCache, local = null, presence = null } = {}) {
  // `local`: an offline account's own skin/cape ({ name, skin, cape, slim } hashes in the
  // texture cache). The mod shows it on this PC only, for that player name only.
  // `presence`: { discord } - the launcher's Discord Rich Presence switch (the mod shows it).
  const info = {
    v: 1,
    launcher: 'native-client',
    textureCache: textureCache || null,
    ...(local ? { local } : {}),
    presence: { discord: presence?.discord !== false }
  };
  for (const dirName of ['.native', '.noctra']) {
    try {
      writeFileAtomic(path.join(gameDir, dirName, 'launcher.json'), JSON.stringify(info, null, 2));
    } catch { /* optional */ }
  }
}

/**
 * Puts an offline account's own textures straight into Minecraft's skin cache
 * (<assets>/skins), so the game loads them from disk: they are never uploaded,
 * so there is nothing to download. Older versions name the file by the SHA-1 of
 * the texture hash (UTF-16 chars, as Guava's hashUnencodedChars), newer by the hash.
 */
function seedSkinCache(skinsDir, entries) {
  for (const { hash, bytes } of entries || []) {
    if (!/^[a-f0-9]{64}$/.test(String(hash || '')) || !bytes) continue;
    const legacy = crypto.createHash('sha1').update(Buffer.from(hash, 'utf16le')).digest('hex');
    for (const name of [hash, legacy]) {
      const file = path.join(skinsDir, name.slice(0, 2), name);
      try {
        if (fs.existsSync(file)) continue;
        writeFileAtomic(file, bytes);
      } catch { /* best-effort */ }
    }
  }
}

function clearHandoff(gameDir) {
  for (const p of handoffPaths(gameDir)) {
    try { fs.rmSync(p, { force: true }); } catch { /* already gone */ }
  }
}

/**
 * Install the mod into an instance and hand it the account ticket.
 *
 *   instance      { id, version, loader }
 *   identity      Native identity of the launching account ({ token, name, … }) or null
 *   gameDir       the instance directory
 *   cacheDir      launcher cache for the manifest + jar
 *   roots         Native API roots
 *
 * @returns {{installed:boolean, version?:string, filename?:string, signedIn?:boolean, warning?:string, reason?:string}}
 */
async function prepare({ instance, identity, gameDir, cacheDir, roots, textureCache = null, local = null, presence = null, fetchImpl = fetch, onState = () => {} }) {
  const loader = instance?.loader || instance?.mc_loader;
  const mcVersion = String(instance?.version || instance?.mc_version || '');
  if (!supportsLoader(loader)) return { installed: false, reason: 'loader' };
  if (!supportsMinecraft(mcVersion)) return { installed: false, reason: 'version' };

  let manifest;
  let jarPath;
  try {
    onState('Checking the Native Client mod…');
    manifest = await loadManifest({ cacheDir, fetchImpl });
    if (!supportsMinecraft(mcVersion, parseMin(manifest))) return { installed: false, reason: 'version' };
    jarPath = await ensureJar(manifest, { cacheDir, fetchImpl });
  } catch (error) {
    // Offline: keep using the jar only when it still matches the last good manifest.
    const existing = offlineJar(gameDir, cacheDir);
    if (!existing) return { installed: false, warning: error.message, reason: 'unavailable' };
    clearHandoff(gameDir);
    writeLauncherInfo(gameDir, { textureCache, local, presence });
    const signedIn = await handoff(gameDir, identity, roots, fetchImpl);
    return { installed: true, filename: existing, signedIn, warning: `Using the installed mod: ${error.message}` };
  }

  const filename = installJar(jarPath, path.join(gameDir, 'mods'));
  clearHandoff(gameDir);
  writeLauncherInfo(gameDir, { textureCache, local, presence });
  const signedIn = await handoff(gameDir, identity, roots, fetchImpl);
  return { installed: true, version: manifest.version, filename, signedIn };
}

async function handoff(gameDir, identity, roots, fetchImpl) {
  if (!identity?.token) return false;
  const ticket = await requestTicket(roots, identity.token, { fetchImpl });
  if (!ticket) return false;
  writeHandoff(gameDir, { ...ticket, account: ticket.account || identity });
  return true;
}

module.exports = {
  seedSkinCache,
  prepare,
  clearHandoff,
  loadManifest,
  ensureJar,
  installJar,
  requestTicket,
  writeHandoff,
  writeLauncherInfo,
  supportsLoader,
  supportsMinecraft,
  validateManifest,
  MANIFEST_URL
};
