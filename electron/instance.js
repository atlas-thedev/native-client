const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { shell, nativeImage } = require('electron');
const installRegistry = require('./installRegistry');

/**
 * Instance filesystem helpers (main process).
 *
 * Instance game directory lives at:
 *   {userData}/minecraft/instances/{instanceId}/
 */

let deps = null;

const rootDir = () => {
  try {
    if (deps?.app?.getPath) return path.join(deps.app.getPath('userData'), 'minecraft');
  } catch {}
  return path.join(require('os').homedir(), '.config', 'Noctra Client', 'minecraft');
};
const instancesDir = () => path.join(rootDir(), 'instances');

function resolveInside(base, ...parts) {
  const root = path.resolve(base);
  const target = path.resolve(root, ...parts.map((part) => String(part ?? '')));
  const relative = path.relative(root, target);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('Invalid path outside the instance directory');
  }
  return target;
}

const instanceDir = (id) => resolveInside(instancesDir(), id);

/* ── installation verification ───────────────────────────────── */

/**
 * Loader directories on disk are named inconsistently: Minecraft Launcher Core
 * writes `fabric-loader-0.16.9-1.21.1`, the Forge Wrapper can write either
 * `forge-1.21.1-52.0.1` or `1.21.1-forge-52.0.1`, and a Fabric install may keep
 * its vanilla metadata in `versions/<profile>/<gameVersion>.json`. Verification
 * therefore inspects the profile JSONs instead of trusting a name pattern.
 */
const LOADER_PREFIXES = {
  Fabric: 'fabric-loader-',
  Quilt: 'quilt-loader-',
  NeoForge: 'neoforge-',
  Forge: 'forge-'
};

/** `1.21.1` matches `1.21.1`, `fabric-loader-0.16.9-1.21.1`, `1.21.1-forge-52.0.1`. */
function nameCarriesVersion(name, version) {
  if (!name || !version) return false;
  const value = String(name).toLowerCase();
  const needle = String(version).toLowerCase();
  if (value === needle) return true;
  return (
    value.startsWith(`${needle}-`) ||
    value.endsWith(`-${needle}`) ||
    value.includes(`-${needle}-`) ||
    value.includes(`_${needle}_`)
  );
}

/** Which loader does this profile/directory belong to, if any. */
function loaderKindFor(name, profile) {
  const haystack = [name, profile?.id, profile?.mainClass]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (haystack.includes('quilt-loader') || haystack.includes('quilt_loader')) return 'Quilt';
  if (haystack.includes('neoforge')) return 'NeoForge';
  if (haystack.includes('fabric-loader') || haystack.includes('fabricloader')) return 'Fabric';
  if (haystack.includes('forge')) return 'Forge';
  return null;
}

function readJsonFile(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasValidFile(filePath, minBytes = 1) {
  if (!filePath) return false;
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size >= minBytes;
  } catch {
    return false;
  }
}

/** Asset index files present on disk, newest first. */
function listAssetIndexes(indexesDir) {
  try {
    return fs
      .readdirSync(indexesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map((entry) => {
        const full = path.join(indexesDir, entry.name);
        let modified = 0;
        try {
          modified = fs.statSync(full).mtimeMs;
        } catch {
          /* unreadable entry — keep it, just unranked */
        }
        return { name: entry.name.replace(/\.json$/i, ''), path: full, modified };
      })
      .sort((a, b) => b.modified - a.modified);
  } catch {
    return [];
  }
}

/**
 * Locate the loader profile directory for a `{version, loader}` pair by reading
 * the profile JSONs, falling back to directory-name matching.
 */
function findLoaderInstall(versionsDir, version, loader) {
  const prefix = LOADER_PREFIXES[loader] || null;
  let entries = [];
  try {
    entries = fs.readdirSync(versionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return null;
  }

  let best = null;
  for (const entry of entries) {
    const dir = path.join(versionsDir, entry.name);
    const profilePath = path.join(dir, `${entry.name}.json`);
    const profile = readJsonFile(profilePath);
    const kind = loaderKindFor(entry.name, profile);
    const nameMatchesLoader = prefix ? entry.name.startsWith(prefix) : kind === loader;
    const inherits = profile?.inheritsFrom || null;
    const versionMatches = inherits === version || nameCarriesVersion(entry.name, version);

    if (!versionMatches) continue;
    if (prefix && !nameMatchesLoader && kind !== loader) continue;
    if (!prefix && kind !== loader) continue;
    // A directory that matches the loader but belongs to another game version
    // (e.g. `fabric-loader-0.15.0-1.20.1`) must not satisfy this version.
    if (inherits && inherits !== version) continue;

    let score = 0;
    if (inherits === version) score += 6;
    if (nameMatchesLoader) score += 4;
    if (kind === loader) score += 3;
    if (profile) score += 2;
    if (hasValidFile(profilePath, 10)) score += 1;

    const candidate = {
      dir,
      name: entry.name,
      profile,
      profilePath,
      // MCLC keeps the vanilla metadata inside the loader directory as
      // versions/<profile>/<gameVersion>.json.
      baseJsonPath: path.join(dir, `${version}.json`),
      kind,
      score
    };
    if (!best || candidate.score > best.score) best = candidate;
  }

  return best;
}

/**
 * Fully verifies whether a Minecraft version is installed on disk: client jar
 * (>1MB), version JSON, mod loader profile (Fabric/Forge/Quilt/NeoForge), asset
 * index, asset objects, and libraries.
 *
 * The asset index is looked up under every name the launch pipeline may have
 * used (game version, loader profile, vanilla `assets` id, plus whatever a
 * previous successful launch recorded), so a Fabric/Forge install no longer
 * reads as "assets not installed" just because Minecraft Launcher Core named
 * the index after the profile instead of the game version.
 */
function verifyInstallation(version, loader = 'Vanilla') {
  if (!version) return { installed: false, reason: 'no_version' };

  const root = rootDir();
  const versionsDir = path.join(root, 'versions');
  if (!fs.existsSync(versionsDir)) {
    return { installed: false, reason: 'no_versions_dir' };
  }

  const record = installRegistry.get(version, loader);
  const expectsLoader = Boolean(loader) && loader !== 'Vanilla';

  let loaderInstall = null;
  if (expectsLoader) {
    loaderInstall = findLoaderInstall(versionsDir, version, loader);
    if (!loaderInstall || !loaderInstall.profile) {
      // No profile on disk — trust a launch record only if its files are intact.
      if (!record) return { installed: false, reason: 'missing_loader', loader };
    }
  }

  /* 1. client jar (> 1MB) ------------------------------------- */
  const jarCandidates = [
    loaderInstall ? path.join(loaderInstall.dir, `${loaderInstall.name}.jar`) : null,
    loaderInstall ? path.join(loaderInstall.dir, `${version}.jar`) : null,
    installRegistry.fileFor(record, 'jar'),
    path.join(versionsDir, version, `${version}.jar`)
  ];
  const jarPath = jarCandidates.find((candidate) => hasValidFile(candidate, 1000000));
  if (!jarPath) {
    return { installed: false, reason: 'missing_client_jar' };
  }

  /* 2. version JSON ------------------------------------------- */
  const jsonParts = [];
  const vanillaJsonPath = [path.join(versionsDir, version, `${version}.json`), loaderInstall?.baseJsonPath]
    .filter(Boolean)
    .find((candidate) => hasValidFile(candidate, 10));
  const vanillaJson = vanillaJsonPath ? readJsonFile(vanillaJsonPath) : null;
  if (vanillaJson) jsonParts.push(vanillaJson);

  const loaderJsonPath = loaderInstall?.profilePath;
  const loaderJson = loaderJsonPath && loaderJsonPath !== vanillaJsonPath ? readJsonFile(loaderJsonPath) : null;
  if (loaderJson) jsonParts.push(loaderJson);

  const recordedJson = readJsonFile(installRegistry.fileFor(record, 'versionJson'));
  if (recordedJson) jsonParts.push(recordedJson);

  if (!jsonParts.length) {
    return { installed: false, reason: 'missing_version_json' };
  }

  let versionData = Object.assign({}, ...jsonParts);
  const visited = new Set([versionData.id].filter(Boolean));
  while (versionData?.inheritsFrom && !visited.has(versionData.inheritsFrom)) {
    visited.add(versionData.inheritsFrom);
    const parent = readJsonFile(path.join(versionsDir, versionData.inheritsFrom, `${versionData.inheritsFrom}.json`));
    if (!parent) break;
    versionData = { ...parent, ...versionData };
  }

  /* 3. asset index -------------------------------------------- */
  const indexesDir = path.join(root, 'assets', 'indexes');
  const assetIds = [
    typeof versionData?.assetIndex?.id === 'string' ? versionData.assetIndex.id : null,
    typeof versionData?.assets === 'string' ? versionData.assets : null,
    version,
    loaderInstall?.name,
    loaderInstall?.profile?.id,
    record?.profile
  ].filter(Boolean);

  const assetIndexId = assetIds[0] || version;
  const namedCandidates = [
    installRegistry.fileFor(record, 'assetIndex'),
    ...assetIds.map((id) => path.join(indexesDir, `${id}.json`))
  ].filter(Boolean);

  let assetIndexFile = namedCandidates.find((candidate) => hasValidFile(candidate, 10));
  let assetIndexName = assetIndexFile ? path.basename(assetIndexFile, '.json') : null;

  if (!assetIndexFile) {
    // Last resort: the index exists but is named after something else entirely.
    const fallback = listAssetIndexes(indexesDir).find((entry) => nameCarriesVersion(entry.name, version));
    if (fallback) {
      assetIndexFile = fallback.path;
      assetIndexName = fallback.name;
    }
  }

  if (!assetIndexFile) {
    return { installed: false, reason: 'missing_asset_index', assetIndexId };
  }

  const assetIndex = readJsonFile(assetIndexFile);
  if (!assetIndex) {
    return { installed: false, reason: 'invalid_asset_index', assetIndexId, assetIndex: assetIndexName };
  }

  const objects = assetIndex?.objects;
  if (!objects || typeof objects !== 'object') {
    return { installed: false, reason: 'empty_asset_index', assetIndexId, assetIndex: assetIndexName };
  }

  const objectKeys = Object.keys(objects);
  const totalAssets = objectKeys.length;
  if (totalAssets === 0) {
    return { installed: false, reason: 'no_assets_listed', assetIndexId, assetIndex: assetIndexName };
  }

  const objectsDir = path.join(root, 'assets', 'objects');
  if (!fs.existsSync(objectsDir)) {
    return { installed: false, reason: 'missing_assets_dir', totalAssets, assetIndexId };
  }

  /* 4. asset objects ------------------------------------------ */
  let missingAssets = 0;
  const missingSamples = [];
  for (const key of objectKeys) {
    const hash = objects[key]?.hash;
    if (typeof hash !== 'string' || hash.length < 2) continue;
    if (!hasValidFile(path.join(objectsDir, hash.slice(0, 2), hash), 1)) {
      missingAssets += 1;
      if (missingSamples.length < 5) missingSamples.push(key);
    }
  }

  // A couple of stragglers (one 404'd object, one aborted download) used to
  // flip an otherwise complete install back to "not installed" for good. Only a
  // real share of missing objects means the assets were never fetched.
  const tolerance = Math.max(5, Math.ceil(totalAssets * 0.02));
  if (missingAssets > tolerance) {
    return {
      installed: false,
      reason: 'missing_assets',
      missingAssets,
      totalAssets,
      assetIndexId,
      assetIndex: assetIndexName,
      samples: missingSamples
    };
  }

  /* 5. libraries ---------------------------------------------- */
  const librariesDir = path.join(root, 'libraries');
  if (!fs.existsSync(librariesDir)) {
    return { installed: false, reason: 'missing_libraries_dir' };
  }

  return {
    installed: true,
    reason: null,
    totalAssets,
    missingAssets,
    assetIndexId,
    assetIndex: assetIndexName,
    jar: jarPath,
    versionJson: vanillaJsonPath || loaderJsonPath || null,
    loaderProfile: loaderInstall?.name || record?.profile || null,
    verifiedBy: record ? 'launch-record' : 'disk-scan'
  };
}

function isInstalled(version, loader) {
  try {
    return Boolean(verifyInstallation(version, loader)?.installed);
  } catch {
    return false;
  }
}

/**
 * Every version + loader pair that is really on disk. Launch records are read
 * first because they are the only source that knows the exact names the launch
 * pipeline wrote; the directory scan then picks up installs made elsewhere.
 */
function installedVersions() {
  const root = rootDir();
  const versionsDir = path.join(root, 'versions');

  const verified = [];
  const seen = new Set();
  const addVerified = (version, loader) => {
    if (!version) return;
    const key = `${version}:${loader}`;
    if (seen.has(key) || !verifyInstallation(version, loader).installed) return;
    seen.add(key);
    verified.push({ version, loader });
  };

  for (const entry of installRegistry.all()) {
    addVerified(entry.version, entry.loader || 'Vanilla');
  }

  let entries = [];
  try {
    entries = fs.readdirSync(versionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return verified;
  }

  for (const entry of entries) {
    const profile = readJsonFile(path.join(versionsDir, entry.name, `${entry.name}.json`));
    const kind =
      loaderKindFor(entry.name, profile) ||
      Object.entries(LOADER_PREFIXES).find(([, prefix]) => entry.name.startsWith(prefix))?.[0] ||
      null;

    if (kind && profile?.inheritsFrom) {
      // MCLC can install only the loader profile directory, without a separate
      // versions/<gameVersion> folder.
      addVerified(profile.inheritsFrom, kind);
      continue;
    }

    if (kind) {
      // A loader directory without its profile JSON cannot be tied to a game
      // version — leave it out rather than guessing.
      continue;
    }

    addVerified(entry.name, 'Vanilla');
    addVerified(entry.name, 'Fabric');
    addVerified(entry.name, 'Forge');
    addVerified(entry.name, 'NeoForge');
    addVerified(entry.name, 'Quilt');
  }

  return verified;
}

/* ── helpers ────────────────────────────────────────────────── */

function getDirSize(dirPath) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) total += getDirSize(full);
      else { try { total += fs.statSync(full).size; } catch { /* locked */ } }
    }
  } catch { /* unreadable */ }
  return total;
}

/* ── listDir ────────────────────────────────────────────────── */

function listDir(instanceId, subpath) {
  const base = resolveInside(instanceDir(instanceId), subpath);
  try {
    return fs.readdirSync(base, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => {
        const full = path.join(base, e.name);
        let size = 0, modified = 0;
        try { const s = fs.statSync(full); size = s.size; modified = s.mtimeMs; } catch {}
        return { name: e.name, isDir: e.isDirectory(), size, modified };
      })
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/* ── screenshot manager ─────────────────────────────────────── */

const SCREENSHOT_EXTENSIONS = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp']
]);
const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024;

function screenshotsDir(instanceId) {
  return resolveInside(instanceDir(instanceId), 'screenshots');
}

function screenshotPath(instanceId, filename) {
  const name = String(filename || '');
  if (!name || path.basename(name) !== name || !SCREENSHOT_EXTENSIONS.has(path.extname(name).toLowerCase())) {
    throw new Error('Invalid screenshot filename.');
  }
  const directory = screenshotsDir(instanceId);
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error('Invalid screenshots directory.');
  }
  const target = resolveInside(directory, name);
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new Error('Screenshot links are not supported.');
  }
  return target;
}

function screenshotList(instanceId) {
  const directory = screenshotsDir(instanceId);
  try {
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Invalid screenshots directory.');
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && SCREENSHOT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => {
        const stat = fs.statSync(path.join(directory, entry.name));
        return { name: entry.name, size: stat.size, modified: stat.mtimeMs };
      })
      .sort((a, b) => b.modified - a.modified);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function screenshotData(instanceId, filename, options = {}) {
  const filePath = screenshotPath(instanceId, filename);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Screenshot file not found.');
  if (!stat.size || stat.size > MAX_SCREENSHOT_BYTES) throw new Error('Screenshot must be smaller than 25MB.');

  if (options.thumbnail && nativeImage?.createFromPath) {
    const source = nativeImage.createFromPath(filePath);
    if (!source.isEmpty()) {
      const { width, height } = source.getSize();
      const scale = Math.min(1, 640 / width, 360 / height);
      const image = scale < 1
        ? source.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' })
        : source;
      return `data:image/jpeg;base64,${image.toJPEG(82).toString('base64')}`;
    }
  }

  const mime = SCREENSHOT_EXTENSIONS.get(path.extname(filePath).toLowerCase());
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

function revealScreenshot(instanceId, filename) {
  const filePath = screenshotPath(instanceId, filename);
  if (!fs.existsSync(filePath)) throw new Error('Screenshot file not found.');
  shell.showItemInFolder?.(filePath);
  return { ok: true };
}

function deleteScreenshot(instanceId, filename) {
  const filePath = screenshotPath(instanceId, filename);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Screenshot file not found.');
  fs.rmSync(filePath);
  return { ok: true };
}

/* ── worldList ──────────────────────────────────────────────── */

function worldList(instanceId) {
  const savesDir = path.join(instanceDir(instanceId), 'saves');
  try {
    return fs.readdirSync(savesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const worldPath = path.join(savesDir, e.name);
        let modified = 0, sizeBytes = 0;
        try { modified = fs.statSync(worldPath).mtimeMs; } catch {}
        sizeBytes = getDirSize(worldPath);
        let iconUrl = null;
        try {
          const iconPath = resolveInside(worldPath, 'icon.png');
          const iconStat = fs.lstatSync(iconPath);
          if (iconStat.isFile() && !iconStat.isSymbolicLink() && iconStat.size > 0 && iconStat.size <= 1024 * 1024) {
            iconUrl = `data:image/png;base64,${fs.readFileSync(iconPath).toString('base64')}`;
          }
        } catch {}
        const artSeed = cryptoSeed(e.name);
        return { name: e.name, modified, sizeBytes, iconUrl, artSeed };
      })
      .sort((a, b) => b.modified - a.modified);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function cryptoSeed(value) {
  let hash = 2166136261;
  for (const character of String(value || 'world')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/* ── getLogFile ─────────────────────────────────────────────── */

function getLogFile(instanceId) {
  const logPath = path.join(instanceDir(instanceId), 'logs', 'latest.log');
  try {
    const raw = fs.readFileSync(logPath, 'utf8');
    const lines = raw.split('\n');
    return lines.slice(-800).join('\n');
  } catch {
    return null;
  }
}

/* ── recent multiplayer servers ─────────────────────────────── */

function cleanServerAddress(raw) {
  let value = String(raw || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .trim()
    .replace(/^\//, '')
    .replace(/[.)]+$/, '');

  const commaAddress = value.match(/^(.+?),\s*(\d{1,5})$/);
  if (commaAddress) value = `${commaAddress[1].trim()}:${commaAddress[2]}`;
  if (!value || value.length > 255 || /\s/.test(value)) return null;
  return value;
}

function logDate(fileName, modified, hours, minutes, seconds) {
  const datedName = fileName.match(/(\d{4})-(\d{2})-(\d{2})/);
  const base = datedName
    ? new Date(
      Number(datedName[1]),
      Number(datedName[2]) - 1,
      Number(datedName[3]),
      hours,
      minutes,
      seconds
    )
    : new Date(modified);

  if (!datedName) {
    base.setHours(hours, minutes, seconds, 0);
    // latest.log may cross midnight before being rotated.
    if (base.getTime() > modified + 60 * 60 * 1000) base.setDate(base.getDate() - 1);
  }
  return base.getTime();
}

function parseServerConnections(text, { fileName = 'latest.log', modified = Date.now() } = {}) {
  const connections = [];
  const timePattern = /\[(\d{2}):(\d{2}):(\d{2})\]/;
  // Capture the host token precisely (and optional ", port") instead of
  // greedily grabbing to end-of-line, so modded/client logs that append text
  // after the address (e.g. "Connecting to hypixel.net, 25565 [via proxy]")
  // are still picked up rather than rejected for containing spaces.
  const connectPattern = /\bConnecting to\s+([^\s,]+)(?:,\s*(\d{1,5}))?/i;

  for (const line of String(text || '').split(/\r?\n/)) {
    const connect = line.match(connectPattern);
    if (!connect) continue;
    const address = cleanServerAddress(connect[2] ? `${connect[1]}:${connect[2]}` : connect[1]);
    if (!address) continue;
    const time = line.match(timePattern);
    connections.push({
      address,
      connectedAt: time
        ? logDate(fileName, modified, Number(time[1]), Number(time[2]), Number(time[3]))
        : modified
    });
  }
  return connections;
}

function readInstanceNames() {
  try {
    const data = JSON.parse(fs.readFileSync(
      path.join(deps.app.getPath('userData'), 'instances.json'),
      'utf8'
    ));
    return new Map((data?.instances || []).map((instance) => [
      String(instance.id),
      String(instance.name || instance.id)
    ]));
  } catch {
    return new Map();
  }
}

function readLogText(filePath) {
  const buffer = fs.readFileSync(filePath);
  return filePath.endsWith('.gz') ? zlib.gunzipSync(buffer).toString('utf8') : buffer.toString('utf8');
}

function scanLogsDir(logsDir) {
  const found = [];
  let logFiles = [];
  try {
    logFiles = fs.readdirSync(logsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /(?:\.log|\.log\.gz)$/i.test(entry.name))
      .map((entry) => {
        const filePath = resolveInside(logsDir, entry.name);
        return { filePath, fileName: entry.name, stat: fs.statSync(filePath) };
      })
      .filter((file) => file.stat.size <= 16 * 1024 * 1024)
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, 20);
  } catch {
    return found;
  }

  for (const file of logFiles) {
    try {
      const connections = parseServerConnections(readLogText(file.filePath), {
        fileName: file.fileName,
        modified: file.stat.mtimeMs
      });
      found.push(...connections);
    } catch {
      // A partially written or corrupt compressed log should not hide other history.
    }
  }
  return found;
}

function recentServers() {
  const names = readInstanceNames();
  let directories = [];
  try {
    directories = fs.readdirSync(instancesDir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
  } catch {
    directories = [];
  }

  const found = [];
  for (const directory of directories) {
    const logsDir = resolveInside(instanceDir(directory.name), 'logs');
    const instanceName = names.get(directory.name) || directory.name;
    for (const connection of scanLogsDir(logsDir)) {
      found.push({ ...connection, instanceId: directory.name, instanceName });
    }
  }

  // Safety net: some launches (or older data) write to the shared root game
  // directory instead of a per-instance one, so its logs are scanned too.
  for (const connection of scanLogsDir(path.join(rootDir(), 'logs'))) {
    found.push({ ...connection, instanceId: null, instanceName: 'Minecraft' });
  }

  for (const entry of require('./playHistory').readServers()) {
    const address = cleanServerAddress(entry?.address);
    if (!address || !Number.isFinite(entry.connectedAt)) continue;
    const instanceId = entry.instanceId ? String(entry.instanceId) : null;
    found.push({
      address,
      connectedAt: entry.connectedAt,
      instanceId,
      instanceName: (instanceId && names.get(instanceId)) || entry.instanceName || 'Minecraft'
    });
  }

  const servers = new Map();
  for (const connection of found.sort((a, b) => b.connectedAt - a.connectedAt)) {
    const key = connection.address.toLowerCase().replace(/:25565$/, '');
    const existing = servers.get(key);
    if (!existing) {
      servers.set(key, { ...connection, visits: 1 });
    } else {
      existing.visits += 1;
    }
  }
  return [...servers.values()].slice(0, 8);
}

/** Most recently played singleplayer worlds across every instance. */
function recentWorlds(limit = 8) {
  const names = readInstanceNames();
  let directories = [];
  try {
    directories = fs.readdirSync(instancesDir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }

  const worlds = [];
  for (const directory of directories) {
    let saves = [];
    const savesDir = resolveInside(instanceDir(directory.name), 'saves');
    try {
      saves = fs.readdirSync(savesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      continue;
    }
    for (const save of saves) {
      const worldPath = resolveInside(savesDir, save.name);
      let playedAt = 0;
      // level.dat is rewritten on every save, so it tracks "last played"
      // better than the folder mtime.
      try { playedAt = fs.statSync(path.join(worldPath, 'level.dat')).mtimeMs; } catch {
        try { playedAt = fs.statSync(worldPath).mtimeMs; } catch {}
      }
      worlds.push({
        name: save.name,
        folder: save.name,
        playedAt,
        worldPath,
        instanceId: directory.name,
        instanceName: names.get(directory.name) || directory.name
      });
    }
  }

  return worlds
    .sort((a, b) => b.playedAt - a.playedAt)
    .slice(0, limit)
    .map(({ worldPath, ...world }) => {
      let iconUrl = null;
      try {
        const iconPath = resolveInside(worldPath, 'icon.png');
        const stat = fs.lstatSync(iconPath);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 1024 * 1024) {
          iconUrl = `data:image/png;base64,${fs.readFileSync(iconPath).toString('base64')}`;
        }
      } catch {}
      return { ...world, iconUrl };
    });
}

/* ── init ───────────────────────────────────────────────────── */

function init(dependencies, ipcMain) {
  deps = dependencies;

  ipcMain.handle('instance:listDir', (_e, instanceId, subpath) =>
    listDir(instanceId, subpath || '')
  );

  ipcMain.handle('instance:openFolder', async (_e, instanceId, subpath) => {
    const target = resolveInside(instanceDir(instanceId), subpath || '');
    fs.mkdirSync(target, { recursive: true });
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
  });

  ipcMain.handle('instance:worldList', (_e, instanceId) => worldList(instanceId));

  ipcMain.handle('instance:screenshotList', (_e, instanceId) => screenshotList(instanceId));
  ipcMain.handle('instance:screenshotData', (_e, instanceId, filename, options) =>
    screenshotData(instanceId, filename, options || {}));
  ipcMain.handle('instance:revealScreenshot', (_e, instanceId, filename) =>
    revealScreenshot(instanceId, filename));
  ipcMain.handle('instance:deleteScreenshot', (_e, instanceId, filename) =>
    deleteScreenshot(instanceId, filename));

  ipcMain.handle('instance:deleteWorld', (_e, instanceId, worldName) => {
    const savesDir = resolveInside(instanceDir(instanceId), 'saves');
    const worldPath = resolveInside(savesDir, worldName);
    if (worldPath === savesDir) throw new Error('A world name is required');
    fs.rmSync(worldPath, { recursive: true, force: true });
  });

  ipcMain.handle('instance:getLogFile', (_e, instanceId) => getLogFile(instanceId));

  ipcMain.handle('instance:recentServers', () => recentServers());
  ipcMain.handle('instance:recentWorlds', () => recentWorlds());

  ipcMain.handle('instance:isInstalled', (_e, version, loader) => isInstalled(version, loader));
  ipcMain.handle('instance:verifyInstallation', (_e, version, loader) => verifyInstallation(version, loader));
  ipcMain.handle('instance:installedVersions', () => installedVersions());

  ipcMain.handle('instance:toggleFile', async (_e, instanceId, subpath, filename, enabled) => {
    const dir = resolveInside(instanceDir(instanceId), subpath || '');
    if (!filename || filename.includes('/') || filename.includes('\\')) throw new Error('Invalid filename');
    const cleanName = filename.replace(/\.disabled$/, '');
    const newName = enabled ? cleanName : `${cleanName}.disabled`;
    const src = resolveInside(dir, filename);
    const dst = resolveInside(dir, newName);
    if (src !== dst) {
      if (fs.existsSync(dst)) throw new Error('A file with that name already exists');
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    }
    return newName;
  });
}

module.exports = {
  init,
  resolveInside,
  isInstalled,
  verifyInstallation,
  installedVersions,
  cleanServerAddress,
  parseServerConnections,
  screenshotList,
  screenshotData,
  deleteScreenshot,
  worldList
};
