const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const settingsMod = require('./settings');
const javaRuntime = require('./javaRuntime');
const { downloadFile, fetchJson } = require('./download');

/**
 * Version-based Java system.
 *
 * Every Minecraft version declares its required Java major version in its
 * version JSON (javaVersion.majorVersion). We keep one configured path per
 * "slot" (8 / 17 / 21) and resolve automatically at launch:
 *   1. configured slot path (verified)
 *   2. previously downloaded managed runtime (userData/java/<slot>)
 *   3. any matching system installation (auto-detected, then remembered)
 *   4. fresh Temurin JRE downloaded from the Adoptium API
 */

const SLOTS = [8, 17, 21, 25];

let deps = null; // { app }

const runtimesDir = () => path.join(deps.app.getPath('userData'), 'java');

/** "1.8.0_392" -> 8, "17.0.2" -> 17, "21.0.7" -> 21 */
function majorOf(versionString) {
  const legacy = versionString.match(/^1\.(\d+)/);
  if (legacy) return Number(legacy[1]);
  const modern = versionString.match(/^(\d+)/);
  return modern ? Number(modern[1]) : null;
}

function slotFor(major) {
  for (const slot of SLOTS) if (slot >= major) return slot;
  return SLOTS[SLOTS.length - 1];
}

/** Old MC (Java 8 era) breaks on modern JVMs; modern MC runs on anything >= requirement. */
function acceptable(slot, major) {
  return slot === 8 ? major === 8 : major >= slot;
}

let manifestCache = null;
const versionJsonCache = new Map();

/**
 * The Java requirement recorded in an installed version JSON. Installed
 * instances never need the network to work out which Java they run on.
 */
function localRequiredMajor(mcVersion) {
  try {
    if (!deps?.app || !mcVersion) return null;
    const file = path.join(deps.app.getPath('userData'), 'minecraft', 'versions', String(mcVersion), `${mcVersion}.json`);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const major = Number(json?.javaVersion?.majorVersion);
    if (Number.isFinite(major) && major > 0) return major;
    // Pre-1.17 version JSONs carry no javaVersion; those all run on Java 8.
    return json?.id ? 8 : null;
  } catch {
    return null;
  }
}

async function requiredMajor(mcVersion) {
  const local = localRequiredMajor(mcVersion);
  if (local) return local;
  if (!manifestCache) {
    // Short timeout: offline launches fall back to fallbackMajor() quickly.
    manifestCache = await fetchJson(
      'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
      { retries: 0, timeoutMs: 8000 }
    );
  }
  const entry = manifestCache.versions.find((v) => v.id === mcVersion);
  if (!entry) return 21;
  if (!versionJsonCache.has(mcVersion)) {
    versionJsonCache.set(mcVersion, await fetchJson(entry.url, { retries: 0, timeoutMs: 8000 }));
  }
  const versionJson = versionJsonCache.get(mcVersion);
  return versionJson.javaVersion?.majorVersion ?? 8;
}

/**
 * Offline guess at the Java a version needs, used only when Mojang's version
 * manifest is unreachable. Mirrors javaVersion.majorVersion:
 *   <= 1.16 -> 8, 1.17 -> 16 (slot 17), 1.18 - 1.20.4 -> 17,
 *   1.20.5 - 1.21.x -> 21, 26.x+ -> 25. Snapshots ("24w14a") go by year/week.
 */
function fallbackMajor(mcVersion) {
  const value = String(mcVersion || '').trim().toLowerCase();
  const snapshot = value.match(/^(\d{2})w(\d{2})[a-z]?$/);
  if (snapshot) {
    const year = Number(snapshot[1]);
    const week = Number(snapshot[2]);
    if (year >= 26) return 25;
    if (year > 24 || (year === 24 && week >= 14)) return 21;
    if (year >= 21 || (year === 20 && week >= 45)) return 17;
    return 8;
  }
  const [major = 0, minor = 0, patch = 0] = value
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
  if (major > 1 || minor >= 22) return 25;
  if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 17) return 17;
  return 8;
}

/** Locate bin/java inside an extracted runtime directory (archive adds a top-level folder). */
function findJavaBinary(dir) {
  const bin = process.platform === 'win32' ? 'java.exe' : 'java';
  const direct = path.join(dir, 'bin', bin);
  if (fs.existsSync(direct)) return direct;
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir)) {
    const candidate =
      process.platform === 'darwin'
        ? path.join(dir, entry, 'Contents', 'Home', 'bin', bin)
        : path.join(dir, entry, 'bin', bin);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Adoptium's published package (download link + SHA-256) for this OS/arch. */
async function adoptiumPackage(major, osName, arch) {
  const query = new URLSearchParams({ architecture: arch, image_type: 'jre', os: osName, vendor: 'eclipse' });
  const assets = await fetchJson(`https://api.adoptium.net/v3/assets/latest/${major}/hotspot?${query}`);
  const pkg = Array.isArray(assets) ? assets.find((a) => a?.binary?.package?.link)?.binary?.package : null;
  if (!pkg || !/^[a-f0-9]{64}$/i.test(String(pkg.checksum || ''))) {
    throw new Error(`No Java ${major} runtime is published for ${osName} ${arch}.`);
  }
  const link = new URL(pkg.link);
  if (link.protocol !== 'https:' || !/(^|\.)github\.com$|(^|\.)adoptium\.net$/i.test(link.hostname)) {
    throw new Error('Unexpected Java download location.');
  }
  return { url: pkg.link, sha256: String(pkg.checksum).toLowerCase(), name: String(pkg.name || '') };
}

function extractArchive(archivePath, dest, isZip) {
  return new Promise((resolve, reject) => {
    const proc = isZip
      // Paths go in through environment variables, never interpolated into
      // the script, so quotes or $ in the user folder can't break or inject.
      ? spawn('powershell', [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy', 'Bypass',
          '-Command',
          'Expand-Archive -LiteralPath $env:NOCTRA_ARCHIVE -DestinationPath $env:NOCTRA_DEST -Force'
        ], { env: { ...process.env, NOCTRA_ARCHIVE: archivePath, NOCTRA_DEST: dest }, windowsHide: true })
      : spawn('tar', ['-xzf', archivePath, '-C', dest]);
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`Java archive extraction failed (${code})`))
    );
  });
}

/**
 * Download + extract a Temurin JRE for `major` from Adoptium. Returns the java
 * binary path. Everything happens in a staging folder; the existing runtime is
 * only replaced once the new one is verified and extracted, so a failed or
 * interrupted download never leaves the player without Java.
 */
async function downloadRuntime(major, onProgress = () => {}) {
  const osName =
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const pkg = await adoptiumPackage(major, osName, arch);

  const dest = path.join(runtimesDir(), String(major));
  const staging = `${dest}.staging-${process.pid}-${Date.now()}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  try {
    const isZip = osName === 'windows' || /\.zip$/i.test(pkg.name);
    const archivePath = path.join(staging, isZip ? 'jre.zip' : 'jre.tar.gz');
    await downloadFile(pkg.url, archivePath, {
      retries: 3,
      timeoutMs: 10 * 60 * 1000,
      expectedHashes: { sha256: pkg.sha256 },
      onProgress: ({ percent, received, total }) => {
        if (percent !== null) onProgress({ percent, received, total });
      }
    });

    await extractArchive(archivePath, staging, isZip);
    fs.rmSync(archivePath, { force: true });
    if (!findJavaBinary(staging)) throw new Error('Downloaded Java runtime is missing its java binary');

    // Swap in the verified runtime.
    const previous = `${dest}.old-${Date.now()}`;
    if (fs.existsSync(dest)) fs.renameSync(dest, previous);
    try {
      fs.renameSync(staging, dest);
    } catch (error) {
      if (fs.existsSync(previous)) fs.renameSync(previous, dest);
      throw error;
    }
    fs.rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  const binary = findJavaBinary(dest);
  if (!binary) throw new Error('Downloaded Java runtime is missing its java binary');
  return binary;
}

function rememberPath(slot, javaPath) {
  const current = settingsMod.get();
  settingsMod.set({
    ...current,
    java: {
      ...current.java,
      paths: { ...current.java.paths, [String(slot)]: javaPath }
    }
  });
}

/**
 * Best detected runtime for a slot: an acceptable version, native to this
 * CPU and 64-bit first, then the closest major (Java 17 for a 17 slot rather
 * than 25, which some older mods dislike).
 */
function pickRuntime(list, slot) {
  const host = javaRuntime.hostArch();
  return list
    .filter((j) => j.major !== null && acceptable(slot, j.major))
    .filter((j) => !(host === 'x64' && j.arch === 'arm64'))
    .sort((a, b) =>
      Number(b.arch === host) - Number(a.arch === host)
      || Number(b.bits !== 32) - Number(a.bits !== 32)
      || (a.major - slot) - (b.major - slot)
      || Number(b.source === 'Noctra') - Number(a.source === 'Noctra'))[0] || null;
}

/** A runtime that is fine to reuse for `slot` (right version, can run here). */
function usable(info, slot) {
  if (!info || info.major === null) return Boolean(info);
  if (!acceptable(slot, info.major)) return false;
  return !(javaRuntime.hostArch() === 'x64' && info.arch === 'arm64');
}

/**
 * Work out which Java a launch would use without downloading anything.
 * Returns { requiredMajor, slot, path, runtime, source } — path is null when
 * Noctra would have to download one.
 */
async function resolveAuto(mcVersion, { scan = true } = {}) {
  const major = await requiredMajor(mcVersion).catch(() => fallbackMajor(mcVersion));
  const slot = slotFor(major);
  const configured = settingsMod.get().java?.paths?.[String(slot)];
  if (configured) {
    const info = await javaRuntime.probe(configured);
    if (usable(info, slot)) return { requiredMajor: major, slot, path: configured, runtime: info, source: 'configured' };
  }
  const managed = findJavaBinary(path.join(runtimesDir(), String(slot)));
  if (managed) {
    const info = await javaRuntime.probe(managed);
    if (usable(info, slot)) return { requiredMajor: major, slot, path: managed, runtime: info, source: 'managed' };
  }
  if (scan) {
    const match = pickRuntime(await javaRuntime.scan(), slot);
    if (match) return { requiredMajor: major, slot, path: match.path, runtime: match, source: 'detected' };
  }
  return { requiredMajor: major, slot, path: null, runtime: null, source: 'download' };
}

/** Resolve (and if needed install) the right Java for a Minecraft version. */
async function ensureJava(mcVersion, { setState = () => {}, sendProgress = () => {} } = {}) {
  setState('preparing', 'Resolving Java requirement…');
  const major = await requiredMajor(mcVersion).catch(() => fallbackMajor(mcVersion));
  const slot = slotFor(major);

  // 1. configured path for this slot
  const configured = settingsMod.get().java?.paths?.[String(slot)];
  if (configured && usable(await javaRuntime.probe(configured), slot)) return configured;

  // 2. managed runtime from an earlier download
  const managed = findJavaBinary(path.join(runtimesDir(), String(slot)));
  if (managed && usable(await javaRuntime.probe(managed), slot)) {
    rememberPath(slot, managed);
    return managed;
  }

  // 3. system installation with an acceptable version
  setState('preparing', `Looking for Java ${slot}…`);
  const match = pickRuntime(await javaRuntime.scan(), slot);
  if (match) {
    rememberPath(slot, match.path);
    return match.path;
  }

  // 4. download a fresh runtime
  setState('downloading', `Downloading Java ${slot}…`);
  const binary = await downloadRuntime(slot, ({ percent, received, total }) =>
    sendProgress({
      percent,
      detail: `Downloading Java ${slot}`,
      phase: 'downloading',
      bytes: received,
      size: total
    })
  );
  rememberPath(slot, binary);
  return binary;
}

function init(dependencies, ipcMain) {
  deps = dependencies;

  const send = (channel, payload) => {
    const win = deps.getWin?.();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  ipcMain.handle('java:test', (_e, javaPath) => settingsMod.probeJava(javaPath));

  ipcMain.handle('java:detectFor', async (_e, major) => {
    const match = pickRuntime(await javaRuntime.scan({ force: true }), Number(major));
    if (!match) return null;
    rememberPath(major, match.path);
    return match.path;
  });

  // Every Java on this machine, verified: [{ path, version, major, arch, bits, vendor, source, native }]
  ipcMain.handle('java:scan', (_e, options) => javaRuntime.scan({ force: Boolean(options?.force) }));
  ipcMain.handle('java:probe', (_e, javaPath) => javaRuntime.probe(javaPath));
  ipcMain.handle('java:host', () => ({ arch: javaRuntime.hostArch(), platform: process.platform }));
  ipcMain.handle('java:presets', () => javaRuntime.GC_PRESETS);

  // The Java each slot resolves to right now (configured, Noctra-managed or detected).
  ipcMain.handle('java:slots', async () => {
    const configured = settingsMod.get().java?.paths || {};
    return Promise.all(SLOTS.map(async (slot) => {
      const chosen = configured[String(slot)] || findJavaBinary(path.join(runtimesDir(), String(slot)));
      const info = chosen ? await javaRuntime.probe(chosen) : null;
      return { slot, path: chosen || '', runtime: info, ok: usable(info, slot) && Boolean(info) };
    }));
  });

  ipcMain.handle('java:setSlot', (_e, slot, javaPath) => {
    rememberPath(Number(slot), javaPath || '');
    return true;
  });

  /**
   * Pre-launch check for the UI: which Java an instance would use and whether
   * it can run it with these memory / JVM settings.
   */
  ipcMain.handle('java:check', (_e, payload) => checkLaunch(payload || {}));
}

async function checkLaunch({ javaPath = null, mcVersion, loader = 'vanilla', memoryMaxGb = 4, preset = 'none', args = '' } = {}) {
  let requirement;
  let runtime = null;
  let resolvedPath = javaPath || null;
  let source = 'custom';
  if (javaPath) {
    const major = await requiredMajor(mcVersion).catch(() => fallbackMajor(mcVersion));
    requirement = { requiredMajor: major, slot: slotFor(major) };
    runtime = await javaRuntime.probe(javaPath);
  } else {
    const auto = await resolveAuto(mcVersion);
    requirement = auto;
    runtime = auto.runtime;
    resolvedPath = auto.path;
    source = auto.source;
  }
  const flags = javaRuntime.buildJvmArgs({ preset, args, major: runtime?.major ?? requirement.slot, memoryMaxGb });
  const compat = source === 'download'
    ? { status: 'ok', issues: [{ level: 'info', code: 'will-download', message: `Noctra will download Java ${requirement.slot} on first launch.` }] }
    : javaRuntime.checkCompat({ runtime, requiredMajor: requirement.requiredMajor, mcVersion, loader, memoryMaxGb, jvmArgs: flags.join(' '), preset });
  return {
    requiredMajor: requirement.requiredMajor,
    slot: requirement.slot,
    path: resolvedPath,
    source,
    runtime,
    flags,
    host: javaRuntime.hostArch(),
    ...compat
  };

  ipcMain.handle('java:install', async (_e, major) => {
    const binary = await downloadRuntime(major, (percent) =>
      send('java:progress', { major, percent })
    );
    rememberPath(major, binary);
    return binary;
  });

  ipcMain.handle('java:browse', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog({
      title: 'Select the java executable',
      properties: ['openFile']
    });
    return result.canceled ? null : result.filePaths[0];
  });
}

/** A managed runtime for `major`: reuses an existing download, otherwise fetches Temurin. */
async function runtimeFor(major, onProgress) {
  const existing = findJavaBinary(path.join(runtimesDir(), String(major)));
  if (existing) return existing;
  return downloadRuntime(major, onProgress);
}

module.exports = { init, ensureJava, runtimeFor, resolveAuto, checkLaunch, requiredMajor, fallbackMajor, slotFor, acceptable, SLOTS, _internals: { pickRuntime, usable } };
