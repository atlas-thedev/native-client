const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { downloadFile, fetchJson, writeFileAtomic } = require('./download');

/**
 * Mod loaders: version lists, one-click installs and loader switching.
 *
 * Kinds (lowercase) are what the code compares; display names are what
 * instances store ("Fabric", "NeoForge", …) and what the UI shows.
 *
 *   fabric        meta.fabricmc.net        profile json + libraries
 *   legacyfabric  meta.legacyfabric.net    same API as Fabric, MC 1.3–1.13.2
 *   quilt         meta.quiltmc.org (v3)    profile json + libraries
 *   forge         files.minecraftforge.net installer jar -> ForgeWrapper
 *   neoforge      maven.neoforged.net      installer jar -> ForgeWrapper
 *
 * Fabric-like loaders are installed fully ahead of launch (profile + every
 * library verified). Forge-like loaders ship processors that only run with
 * the game files present, so "install" downloads and validates the installer
 * and ForgeWrapper finishes the job on first launch.
 */

const KINDS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge', 'legacyfabric'];
const DISPLAY = {
  vanilla: 'Vanilla',
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge',
  legacyfabric: 'Legacy Fabric'
};
const FABRIC_LIKE = new Set(['fabric', 'quilt', 'legacyfabric']);
const FORGE_LIKE = new Set(['forge', 'neoforge']);

const META = {
  fabric: 'https://meta.fabricmc.net/v2',
  legacyfabric: 'https://meta.legacyfabric.net/v2',
  quilt: 'https://meta.quiltmc.org/v3'
};
const FORGE_PROMOS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const FORGE_METADATA = 'https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json';
const NEOFORGE_VERSIONS = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge';
const NEOFORGE_LEGACY_VERSIONS = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/forge';

const CACHE_TTL = 10 * 60 * 1000;

function normalize(loader) {
  const value = String(loader || '').toLowerCase().replace(/[\s_-]+/g, '');
  if (!value || value === 'vanilla' || value === 'none') return 'vanilla';
  if (value.includes('legacy') && value.includes('fabric')) return 'legacyfabric';
  if (value.includes('neoforge') || value === 'neo') return 'neoforge';
  if (value.includes('quilt')) return 'quilt';
  if (value.includes('fabric')) return 'fabric';
  if (value.includes('forge')) return 'forge';
  return 'vanilla';
}

const displayName = (kind) => DISPLAY[normalize(kind)] || 'Vanilla';
const isFabricLike = (kind) => FABRIC_LIKE.has(normalize(kind));
const isForgeLike = (kind) => FORGE_LIKE.has(normalize(kind));

/* ── versions ---------------------------------------------------------- */

function parseMc(mc) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(mc || ''));
  return match ? match.slice(1).map((part) => Number(part || 0)) : null;
}

function compareMc(a, b) {
  const left = parseMc(a) || [0, 0, 0];
  const right = parseMc(b) || [0, 0, 0];
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

/** "0.16.10" > "0.16.9", "1.0.0" > "1.0.0-beta.3". */
function compareLoaderVersions(a, b) {
  const split = (value) => {
    const text = String(value || '');
    const dash = text.indexOf('-');
    return dash === -1 ? [text, ''] : [text.slice(0, dash), text.slice(dash + 1)];
  };
  const [aBase, aPre] = split(a);
  const [bBase, bPre] = split(b);
  const aParts = aBase.split(/[.+]/);
  const bParts = bBase.split(/[.+]/);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i += 1) {
    const x = aParts[i] ?? '0';
    const y = bParts[i] ?? '0';
    const nx = Number(x);
    const ny = Number(y);
    const diff = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x.localeCompare(y, 'en', { numeric: true });
    if (diff) return diff;
  }
  if (!aPre && bPre) return 1;
  if (aPre && !bPre) return -1;
  return aPre.localeCompare(bPre, 'en', { numeric: true });
}

const isPrerelease = (version) => /-(?:alpha|beta|pre|rc|snapshot)|[-+.](?:alpha|beta)\b/i.test(String(version || ''));

/**
 * NeoForge numbers its releases after the game: MC 1.21.1 -> 21.1.x,
 * MC 1.21 -> 21.0.x, MC 26.1.2 -> 26.1.2.x. MC 1.20.1 is the exception: it
 * lives under the old `net.neoforged:forge` artifact as "1.20.1-47.1.x".
 */
function neoforgePrefix(mc) {
  const parts = parseMc(mc);
  if (!parts) return null;
  const [major, minor, patch] = parts;
  if (major === 1) return `${minor}.${patch}.`;
  return `${major}.${minor}.${patch}.`;
}

function minimumMc(kind) {
  return { quilt: '1.14', neoforge: '1.20.1', forge: '1.5.2', fabric: '1.14' }[kind] || null;
}

/** Cheap, offline availability rule (the version list is authoritative). */
function availability(kind, mc) {
  kind = normalize(kind);
  if (kind === 'vanilla') return { available: true };
  if (!parseMc(mc)) {
    // Fabric ships snapshot builds; its version list is the authority there.
    return kind === 'fabric'
      ? { available: true, unverified: true }
      : { available: false, reason: `${DISPLAY[kind]} does not publish builds for snapshots` };
  }
  if (kind === 'legacyfabric') {
    return compareMc(mc, '1.14') < 0 && compareMc(mc, '1.3') >= 0
      ? { available: true }
      : { available: false, reason: compareMc(mc, '1.14') >= 0 ? 'Legacy Fabric covers 1.3 – 1.13.2; use Fabric here' : 'Legacy Fabric starts at 1.3' };
  }
  const min = minimumMc(kind);
  if (min && compareMc(mc, min) < 0) return { available: false, reason: `${DISPLAY[kind]} supports ${min} and newer` };
  return { available: true };
}

const cache = new Map();

async function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function fetchList(url) {
  try {
    return await fetchJson(url, { retries: 1, timeoutMs: 15000 });
  } catch (error) {
    // Meta servers answer 404 / 400 for game versions they never supported.
    if (/\b(?:404|400)\b/.test(error.message)) return [];
    throw error;
  }
}

function friendlyNetworkError(kind, error) {
  const name = DISPLAY[kind];
  if (kind === 'legacyfabric') {
    return new Error(`Legacy Fabric's servers didn't respond (${error.message}). Try again later.`);
  }
  return new Error(`Couldn't reach ${name}'s servers: ${error.message}`);
}

async function fabricLikeVersions(kind, mc) {
  const list = await fetchList(`${META[kind]}/versions/loader/${encodeURIComponent(mc)}`);
  const versions = (Array.isArray(list) ? list : [])
    .map((entry) => entry?.loader?.version)
    .filter(Boolean)
    .map((version, index) => {
      const raw = list[index]?.loader;
      // Fabric's meta flags only the newest build as `stable`; older releases
      // are just as stable, so the flag only decides which one is recommended.
      return { version, stable: raw?.stable === true || !isPrerelease(version), flagged: raw?.stable === true };
    });
  // Quilt's meta lists builds in no particular order.
  versions.sort((a, b) => compareLoaderVersions(b.version, a.version));
  return versions;
}

let forgePromos = null;
async function forgePromotions() {
  if (forgePromos && Date.now() - forgePromos.at < CACHE_TTL) return forgePromos.value;
  const value = await fetchJson(FORGE_PROMOS, { retries: 1, timeoutMs: 15000 });
  forgePromos = { at: Date.now(), value };
  return value;
}

async function forgeVersions(mc) {
  const [metadata, promos] = await Promise.all([
    fetchJson(FORGE_METADATA, { retries: 1, timeoutMs: 20000 }),
    forgePromotions().catch(() => ({ promos: {} }))
  ]);
  const builds = (metadata?.[mc] || []).map((full) => (full.startsWith(`${mc}-`) ? full.slice(mc.length + 1) : full));
  const recommended = promos?.promos?.[`${mc}-recommended`] || null;
  const latest = promos?.promos?.[`${mc}-latest`] || null;
  return {
    versions: builds
      .map((version) => ({ version, stable: true }))
      .sort((a, b) => compareLoaderVersions(b.version, a.version)),
    recommended,
    latest
  };
}

async function neoforgeVersions(mc) {
  if (mc === '1.20.1') {
    const data = await fetchJson(NEOFORGE_LEGACY_VERSIONS, { retries: 1, timeoutMs: 15000 });
    return (data?.versions || [])
      .filter((version) => version.startsWith('1.20.1-'))
      .map((version) => version.slice('1.20.1-'.length))
      .map((version) => ({ version, stable: !isPrerelease(version) }))
      .sort((a, b) => compareLoaderVersions(b.version, a.version));
  }
  const prefix = neoforgePrefix(mc);
  if (!prefix) return [];
  const data = await fetchJson(NEOFORGE_VERSIONS, { retries: 1, timeoutMs: 15000 });
  const depth = prefix.split('.').length; // "21.1." -> 3 parts, "26.1.0." -> 4 parts
  return (data?.versions || [])
    .filter((version) => version.startsWith(prefix) && version.split('-')[0].split('.').length === depth)
    .map((version) => ({ version, stable: !isPrerelease(version) }))
    .sort((a, b) => compareLoaderVersions(b.version, a.version));
}

/**
 * Every build of `loader` for Minecraft `mc`, newest first:
 * { kind, loader, mcVersion, versions: [{ version, stable, recommended, latest }], recommended, latest }.
 */
async function listVersions(loader, mc) {
  const kind = normalize(loader);
  const base = { kind, loader: DISPLAY[kind], mcVersion: mc, versions: [], recommended: null, latest: null };
  if (kind === 'vanilla') return base;
  const rule = availability(kind, mc);
  if (!rule.available) return { ...base, unavailable: rule.reason };

  let versions;
  let recommended = null;
  let latest = null;
  try {
    if (FABRIC_LIKE.has(kind)) {
      versions = await cached(`${kind}:${mc}`, () => fabricLikeVersions(kind, mc));
    } else if (kind === 'forge') {
      const result = await cached(`forge:${mc}`, () => forgeVersions(mc));
      versions = result.versions;
      recommended = result.recommended;
      latest = result.latest;
    } else {
      versions = await cached(`neoforge:${mc}`, () => neoforgeVersions(mc));
    }
  } catch (error) {
    throw friendlyNetworkError(kind, error);
  }

  latest = latest || versions[0]?.version || null;
  recommended = recommended || versions.find((entry) => entry.flagged)?.version || versions.find((entry) => entry.stable)?.version || latest;
  return {
    ...base,
    versions: versions.map(({ flagged, ...entry }) => ({
      ...entry,
      recommended: entry.version === recommended,
      latest: entry.version === latest
    })),
    recommended,
    latest,
    unavailable: versions.length ? null : `${DISPLAY[kind]} has no builds for Minecraft ${mc}`
  };
}

/* ── library verification (Fabric-like) ------------------------------------ */

function mavenArtifact(library) {
  const artifactUrl = (relativePath, repository) => {
    const url = repository ? new URL(relativePath, repository) : new URL(relativePath);
    // Historical Fabric profiles contain HTTP Maven Central links, which the
    // repository now rejects. All repositories used here support HTTPS.
    if (url.protocol === 'http:') url.protocol = 'https:';
    return url.toString();
  };
  const artifact = library?.downloads?.artifact;
  if (artifact?.path) {
    const repository = library.url || 'https://libraries.minecraft.net/';
    return {
      relativePath: artifact.path,
      url: artifactUrl(artifact.url || artifact.path, artifact.url ? undefined : repository),
      sha1: artifact.sha1 || library.sha1 || null,
      size: artifact.size || library.size || null
    };
  }

  const [coordinate, extension = 'jar'] = String(library?.name || '').split('@', 2);
  const [group, artifactId, version, classifier] = coordinate.split(':');
  if (!group || !artifactId || !version) {
    throw new Error(`Invalid Fabric library coordinate: ${library?.name || '(missing)'}`);
  }

  const filename = `${artifactId}-${version}${classifier ? `-${classifier}` : ''}.${extension}`;
  const relativePath = `${group.replace(/\./g, '/')}/${artifactId}/${version}/${filename}`;
  return {
    relativePath,
    // The Minecraft version format uses the official library repository when
    // a Maven entry does not provide its own repository URL.
    url: artifactUrl(relativePath, library.url || 'https://libraries.minecraft.net/'),
    sha1: library.sha1 || null,
    size: library.size || null
  };
}

async function fileMatches(filePath, { sha1, size }) {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size === 0 || (size && stat.size !== size)) return false;
    if (!sha1) {
      // Fabric's loader and intermediary entries currently omit checksums.
      // Parsing the central directory still catches empty, HTML, and truncated downloads.
      return new AdmZip(filePath).getEntries().length > 0;
    }

    const hash = crypto.createHash('sha1');
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
    return hash.digest('hex').toLowerCase() === String(sha1).toLowerCase();
  } catch {
    return false;
  }
}

const noop = () => {};

/** Verify and repair a Fabric-like profile's complete runtime. */
async function ensureLibraries(profile, { root, kind = 'fabric', report = noop } = {}) {
  const name = DISPLAY[normalize(kind)] || 'Fabric';
  const libraries = Array.isArray(profile?.libraries) ? profile.libraries : [];
  if (kind !== 'legacyfabric' && !libraries.some((library) => library.name?.includes(':sponge-mixin:'))) {
    throw new Error(`The ${name} profile is missing its SpongePowered Mixin dependency.`);
  }

  const libraryRoot = path.join(root, 'libraries');
  for (let index = 0; index < libraries.length; index += 1) {
    const library = libraries[index];
    const artifact = mavenArtifact(library);
    const targetPath = path.resolve(libraryRoot, artifact.relativePath);
    const relative = path.relative(path.resolve(libraryRoot), targetPath);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error(`Invalid ${name} library path: ${artifact.relativePath}`);
    }
    if (await fileMatches(targetPath, artifact)) continue;
    if (!artifact.url) throw new Error(`${name} did not provide a download URL for ${library.name}`);

    report({ status: 'downloading', detail: `Downloading ${name} libraries (${index + 1}/${libraries.length})…` });
    await downloadFile(artifact.url, targetPath, {
      retries: 3,
      expectedHashes: artifact.sha1 ? { sha1: artifact.sha1 } : {},
      onProgress: ({ percent, received }) => {
        report({
          key: `${kind}:${artifact.relativePath}`,
          received,
          fraction: (index + (percent ?? 0) / 100) / Math.max(1, libraries.length),
          detail: `Downloading ${name} libraries`,
          task: index + 1,
          total: libraries.length
        });
      }
    });
    if (!(await fileMatches(targetPath, artifact))) {
      throw new Error(`Downloaded ${name} library is invalid: ${library.name}`);
    }
  }
}

/* ── installs -------------------------------------------------------------- */

const PROFILE_PREFIX = { fabric: 'fabric-loader', legacyfabric: 'fabric-loader', quilt: 'quilt-loader' };

/* ── offline fallbacks ------------------------------------------------------ */

/** Reads an installed Fabric-like profile, or null when it is missing/invalid. */
function readLocalProfile(root, id) {
  try {
    const profile = JSON.parse(fs.readFileSync(path.join(root, 'versions', id, `${id}.json`), 'utf8'));
    return profile?.id === id && typeof profile.mainClass === 'string' && profile.mainClass ? profile : null;
  } catch {
    return null;
  }
}

/** Loader versions of `kind` already installed for `mc`, newest first. */
function installedFabricLikeVersions(root, kind, mc) {
  const prefix = `${PROFILE_PREFIX[kind]}-`;
  const suffix = `-${mc}`;
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(root, 'versions'));
  } catch {
    return [];
  }
  return entries
    .filter((id) => id.startsWith(prefix) && id.endsWith(suffix))
    .map((id) => ({ id, version: id.slice(prefix.length, id.length - suffix.length), profile: readLocalProfile(root, id) }))
    .filter((entry) => entry.version && entry.profile)
    // Fabric and Legacy Fabric share the fabric-loader prefix; their
    // intermediary mappings come from different Maven repositories.
    .filter((entry) => {
      if (kind !== 'fabric' && kind !== 'legacyfabric') return true;
      const legacy = JSON.stringify(entry.profile.libraries || []).includes('legacyfabric');
      return kind === 'legacyfabric' ? legacy : !legacy;
    })
    .sort((a, b) => compareLoaderVersions(b.version, a.version));
}

/** Forge/NeoForge builds whose installer is already cached for `mc`, newest first. */
function installedForgeLikeVersions(root, kind, mc) {
  let files = [];
  try {
    files = fs.readdirSync(path.join(root, 'forge-installers'));
  } catch {
    return [];
  }
  const versions = [];
  for (const file of files) {
    const match = /^(forge|neoforge)-(.+)-installer\.jar$/i.exec(file);
    if (!match || match[1].toLowerCase() !== kind) continue;
    const full = match[2];
    if (kind === 'forge') {
      if (full.startsWith(`${mc}-`)) versions.push(full.slice(mc.length + 1));
    } else if (mc === '1.20.1') {
      if (full.startsWith('1.20.1-')) versions.push(full.slice('1.20.1-'.length));
    } else {
      const prefix = neoforgePrefix(mc);
      if (prefix && full.startsWith(prefix)) versions.push(full);
    }
  }
  return versions.sort((a, b) => compareLoaderVersions(b, a));
}

/** Installs (or verifies) a Fabric-like profile and returns its version id. */
async function installFabricLike(kind, mc, requested, { root, report = noop }) {
  kind = normalize(kind);
  const name = DISPLAY[kind];
  let loader = requested;
  if (!loader) {
    let list = null;
    try {
      list = await listVersions(kind, mc);
    } catch (error) {
      // Offline: keep using the newest build that is already installed.
      const installed = installedFabricLikeVersions(root, kind, mc)[0];
      if (!installed) throw error;
      loader = installed.version;
    }
    if (!loader) {
      if (!list.versions.length) throw new Error(list.unavailable || `${name} does not support Minecraft ${mc}`);
      loader = list.recommended;
    }
  }

  const id = `${PROFILE_PREFIX[kind]}-${loader}-${mc}`;
  const jsonPath = path.join(root, 'versions', id, `${id}.json`);
  report({ status: 'preparing', detail: `Installing ${name} loader ${loader}…` });

  // An installed profile for this exact build never changes: use it without
  // touching the network so installed instances launch offline instantly.
  let profile = readLocalProfile(root, id);
  if (profile) {
    await ensureLibraries(profile, { root, kind, report });
    return { id, version: loader };
  }
  try {
    profile = await fetchJson(`${META[kind]}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loader)}/profile/json`, { retries: 2 });
  } catch (error) {
    // Offline: an already installed profile still launches.
    try {
      const existing = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      if (existing?.id === id) profile = existing;
    } catch {}
    if (!profile) {
      if (/\b(?:404|400)\b/.test(error.message)) {
        throw new Error(`${name} loader ${loader} is not available for Minecraft ${mc}`);
      }
      throw friendlyNetworkError(kind, error);
    }
  }
  if (profile?.id !== id || typeof profile?.mainClass !== 'string' || !profile.mainClass) {
    throw new Error(`${name} returned an invalid launch profile for Minecraft ${mc}`);
  }
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  writeFileAtomic(jsonPath, JSON.stringify(profile, null, 2));
  await ensureLibraries(profile, { root, kind, report });
  return { id, version: loader };
}

function forgeCoordinates(kind, mc, version) {
  if (kind === 'forge') {
    const full = version.startsWith(`${mc}-`) ? version : `${mc}-${version}`;
    return {
      full,
      file: `forge-${full}-installer.jar`,
      url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`
    };
  }
  if (mc === '1.20.1') {
    const full = version.startsWith('1.20.1-') ? version : `1.20.1-${version}`;
    return {
      full,
      file: `neoforge-${full}-installer.jar`,
      url: `https://maven.neoforged.net/releases/net/neoforged/forge/${full}/forge-${full}-installer.jar`
    };
  }
  return {
    full: version,
    file: `neoforge-${version}-installer.jar`,
    url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`
  };
}

/**
 * Picks the jar Minecraft Launcher Core should be given. Modern installers
 * carry `version.json` (ForgeWrapper runs them). Installers from before
 * Forge 1.12.2-14.23.5.2851 only carry the universal jar, which itself holds
 * the launch profile — that is what MCLC's legacy path expects.
 */
function launchableForgeJar(installerPath, kind) {
  const zip = new AdmZip(installerPath);
  if (zip.getEntry('version.json')) return installerPath;
  const universal = zip.getEntries().find((entry) => !entry.isDirectory && !entry.entryName.includes('/') && /universal.*\.jar$/i.test(entry.entryName));
  if (!universal) {
    throw new Error(`This ${DISPLAY[kind]} build uses an installer format Native can't launch. Pick a newer build.`);
  }
  const target = installerPath.replace(/-installer\.jar$/i, '-universal.jar');
  let valid = false;
  try {
    valid = fs.statSync(target).size === universal.header.size && new AdmZip(target).getEntry('version.json');
  } catch {}
  if (!valid) {
    const data = universal.getData();
    if (!new AdmZip(data).getEntry('version.json')) {
      throw new Error(`This ${DISPLAY[kind]} build has no launch profile. Pick a newer build.`);
    }
    writeFileAtomic(target, data);
  }
  return target;
}

/** Downloads and validates a Forge/NeoForge installer; returns the jar for opts.forge. */
async function installForgeLike(kind, mc, requested, { root, report = noop }) {
  kind = normalize(kind);
  const name = DISPLAY[kind];
  let version = requested;
  if (!version) {
    try {
      if (kind === 'forge') {
        try {
          const promos = await forgePromotions();
          version = promos?.promos?.[`${mc}-recommended`] ?? promos?.promos?.[`${mc}-latest`] ?? null;
        } catch (error) {
          throw friendlyNetworkError(kind, error);
        }
      } else {
        version = (await listVersions(kind, mc)).recommended;
      }
    } catch (error) {
      // Offline: keep using the newest build whose installer is cached.
      version = installedForgeLikeVersions(root, kind, mc)[0] || null;
      if (!version) throw error;
    }
  }
  if (!version) throw new Error(`${name} does not support Minecraft ${mc}`);
  const cachedBuild = installedForgeLikeVersions(root, kind, mc).find((entry) => entry === version || entry === `${mc}-${version}`);
  if (kind === 'forge' && !cachedBuild) {
    // Promotions say "11.15.1.2318"; some branches publish it as
    // "1.8.9-11.15.1.2318-1.8.9". The Maven listing has the real name.
    const bare = version.startsWith(`${mc}-`) ? version.slice(mc.length + 1) : version;
    try {
      const { versions } = await cached(`forge:${mc}`, () => forgeVersions(mc));
      const match = versions.find((entry) => entry.version === bare) || versions.find((entry) => entry.version.startsWith(`${bare}-`));
      if (match) version = match.version;
    } catch {
      /* offline: try the plain name */
    }
  }

  const coords = forgeCoordinates(kind, mc, version);
  const jarPath = path.join(root, 'forge-installers', coords.file);
  if (!(await fileMatches(jarPath, {}))) {
    report({ status: 'preparing', detail: `Downloading ${name} ${version}…` });
    try {
      await downloadFile(coords.url, jarPath, {
        retries: 3,
        onProgress: ({ percent, received, retrying, attempt }) => {
          const detail = `Downloading ${name} ${version}${retrying ? ` — retry ${attempt}` : ''}`;
          report({ status: 'downloading', detail, key: `${kind}:${coords.full}`, received, fraction: percent !== null && percent !== undefined ? percent / 100 : null });
        }
      });
    } catch (error) {
      if (/\b404\b/.test(error.message)) throw new Error(`${name} ${version} has no installer for Minecraft ${mc}`);
      throw error;
    }
    if (!(await fileMatches(jarPath, {}))) {
      fs.rmSync(jarPath, { force: true });
      throw new Error(`The ${name} installer download was damaged. Try again.`);
    }
  }
  return { jar: launchableForgeJar(jarPath, kind), installer: jarPath, version: coords.full.startsWith(`${mc}-`) ? coords.full.slice(mc.length + 1) : coords.full };
}

/**
 * MCLC caches the Forge launch profile at forge/<mc>/version.json, keyed only
 * by the game version, so switching Forge builds — or Forge <-> NeoForge on
 * the same game version — would keep launching the old one. A marker next to
 * it records which jar produced it; a different jar forces regeneration.
 */
function prepareForgeCache(root, mc, jarPath) {
  const dir = path.join(root, 'forge', mc);
  const marker = path.join(dir, '.native-source');
  const source = path.basename(jarPath);
  let previous = null;
  try {
    previous = fs.readFileSync(marker, 'utf8').trim();
  } catch {}
  if (previous === source) return false;
  fs.rmSync(path.join(dir, 'version.json'), { force: true });
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(marker, source);
  return true;
}

let mclcPatched = false;
/**
 * MCLC decides "modern Forge" from the second number of the game version
 * (1.12+). Calendar-versioned releases (26.1) would read as ancient, so treat
 * every major above 1 as modern.
 */
function patchMclc() {
  if (mclcPatched) return;
  mclcPatched = true;
  try {
    const Handler = require('minecraft-launcher-core/components/handler');
    const original = Handler.prototype.isModernForge;
    Handler.prototype.isModernForge = function isModernForge(json) {
      const major = Number(String(json?.inheritsFrom || '').split('.')[0]);
      if (Number.isFinite(major) && major > 1) return true;
      return original.call(this, json);
    };
  } catch {
    /* library layout changed; the stock rule still covers 1.x */
  }
}

/* ── switching --------------------------------------------------------------- */

/** Whether a jar built for `modLoader` loads under `target` on Minecraft `mc`. */
function loaderAccepts(target, modLoader, mc) {
  target = normalize(target);
  const mod = String(modLoader || '').toLowerCase();
  if (target === 'vanilla') return false;
  if (mod === 'fabric') return target === 'fabric' || target === 'quilt' || target === 'legacyfabric';
  if (mod === 'quilt') return target === 'quilt';
  if (mod === 'forge') return target === 'forge' || (target === 'neoforge' && mc === '1.20.1');
  if (mod === 'neoforge') return target === 'neoforge';
  if (mod === 'optifine') return target === 'forge';
  return true;
}

/**
 * Sorts indexed mods into ones that keep working under `target` and ones that
 * will not load. Jars shipping metadata for several loaders count as
 * compatible when any of them fits. CustomSkinLoader is swapped automatically.
 */
function classifyMods(mods, target, mc) {
  const result = { target: normalize(target), compatible: 0, incompatible: [], unknown: [] };
  for (const mod of mods || []) {
    if (/customskinloader/i.test(mod.file || '')) continue;
    const platforms = Array.isArray(mod.platforms) && mod.platforms.length ? mod.platforms : [mod.loader || 'unknown'];
    if (platforms.every((platform) => platform === 'unknown')) {
      result.unknown.push({ file: mod.file, name: mod.name || mod.file });
      continue;
    }
    if (platforms.some((platform) => loaderAccepts(target, platform, mc))) {
      result.compatible += 1;
    } else {
      result.incompatible.push({ file: mod.file, name: mod.name || mod.file, loader: DISPLAY[normalize(platforms[0])] || platforms[0] });
    }
  }
  return result;
}

/** Renames jars to `.disabled` and keeps Native's mod manifest in step. */
function disableMods(modsDir, files) {
  const disabled = [];
  for (const file of files || []) {
    const name = path.basename(String(file || ''));
    if (!name || !/\.jar$/i.test(name)) continue;
    const source = path.join(modsDir, name);
    if (!fs.existsSync(source)) continue;
    let target = `${name}.disabled`;
    for (let suffix = 1; fs.existsSync(path.join(modsDir, target)); suffix += 1) target = `${name}.${suffix}.disabled`;
    fs.renameSync(source, path.join(modsDir, target));
    disabled.push({ file: name, disabledFile: target });
  }
  if (!disabled.length) return disabled;

  const primary = path.join(modsDir, '.native-mods.json');
  const legacy = path.join(modsDir, '.native-mods.json');
  const manifestFile = fs.existsSync(primary) ? primary : fs.existsSync(legacy) ? legacy : null;
  if (manifestFile) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      for (const item of disabled) {
        for (const [projectId, raw] of Object.entries(manifest)) {
          const entry = typeof raw === 'string' ? { filename: raw, folder: 'mods' } : raw;
          if (entry?.filename !== item.file) continue;
          manifest[projectId] = { ...entry, filename: item.disabledFile, enabled: false };
        }
      }
      writeFileAtomic(primary, JSON.stringify(manifest, null, 2));
    } catch {
      /* the files are already disabled; the manifest heals on the next scan */
    }
  }
  return disabled;
}

/* ── IPC --------------------------------------------------------------------- */

let deps = null;
const rootDir = () => path.join(deps.app.getPath('userData'), 'minecraft');
function instanceModsDir(instanceId) {
  const id = String(instanceId || '');
  if (!id || id.includes('/') || id.includes('\\') || id === '..' || id === '.') throw new Error('Invalid instance');
  return path.join(rootDir(), 'instances', id, 'mods');
}

function send(channel, payload) {
  const win = deps?.getWin?.();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

async function indexMods(dir) {
  // Lazy: the crash reporter pulls in the launcher, which pulls in this file.
  const { indexMods: index } = require('./crashReporter');
  return index(dir);
}

async function install({ loader, mcVersion, version = null, instanceId = null } = {}) {
  const kind = normalize(loader);
  const mc = String(mcVersion || '');
  if (!parseMc(mc) && kind !== 'fabric' && kind !== 'vanilla') throw new Error('Pick a release version of Minecraft first');
  const report = (progress) => send('loaders:progress', { instanceId, loader: DISPLAY[kind], ...progress });
  if (kind === 'vanilla') return { loader: 'Vanilla', version: null };
  const root = rootDir();
  if (FABRIC_LIKE.has(kind)) {
    const result = await installFabricLike(kind, mc, version, { root, report });
    report({ status: 'done', detail: `${DISPLAY[kind]} ${result.version} is installed`, fraction: 1 });
    return { loader: DISPLAY[kind], version: result.version, profile: result.id, complete: true };
  }
  const result = await installForgeLike(kind, mc, version, { root, report });
  report({ status: 'done', detail: `${DISPLAY[kind]} ${result.version} is ready`, fraction: 1 });
  // Processors run with the game files on first launch.
  return { loader: DISPLAY[kind], version: result.version, complete: false };
}

function init(appDeps, ipcMain) {
  deps = appDeps;
  patchMclc();
  ipcMain.handle('loaders:versions', (_event, { loader, mcVersion } = {}) => listVersions(loader, String(mcVersion || '')));
  ipcMain.handle('loaders:available', (_event, { mcVersion } = {}) =>
    Object.fromEntries(KINDS.map((kind) => [DISPLAY[kind], availability(kind, String(mcVersion || ''))])));
  ipcMain.handle('loaders:install', (_event, payload) => install(payload || {}));
  ipcMain.handle('loaders:check', async (_event, { instanceId, loader, mcVersion } = {}) => {
    const mods = await indexMods(instanceModsDir(instanceId));
    return classifyMods(mods, loader, String(mcVersion || ''));
  });
  ipcMain.handle('loaders:disableMods', (_event, { instanceId, files } = {}) => disableMods(instanceModsDir(instanceId), files));
}

module.exports = {
  init,
  KINDS,
  DISPLAY,
  normalize,
  displayName,
  isFabricLike,
  isForgeLike,
  availability,
  listVersions,
  compareLoaderVersions,
  neoforgePrefix,
  mavenArtifact,
  fileMatches,
  ensureLibraries,
  installFabricLike,
  installForgeLike,
  installedFabricLikeVersions,
  installedForgeLikeVersions,
  launchableForgeJar,
  prepareForgeCache,
  patchMclc,
  loaderAccepts,
  classifyMods,
  disableMods,
  _cache: cache
};
