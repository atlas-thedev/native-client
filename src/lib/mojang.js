/**
 * Minecraft version data.
 *
 * The Versions page used to render a hand-written list that included versions
 * that do not exist, so "play" could never work for them. This pulls the real
 * manifest instead, caches it, and degrades to a stale cache when offline.
 */

const MANIFEST_URLS = [
  'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json'
];

const FABRIC_GAME_URL = 'https://meta.fabricmc.net/v2/versions/game';

const CACHE_KEY = 'native.versionManifest';
const CACHE_TTL = 60 * 60 * 1000;

export const LOADERS = ['Vanilla', 'Fabric', 'Forge', 'NeoForge', 'Quilt'];

export const VERSION_TYPES = [
  { id: 'release', label: 'Releases' },
  { id: 'snapshot', label: 'Snapshots' },
  { id: 'old_beta', label: 'Beta' },
  { id: 'old_alpha', label: 'Alpha' }
];

let memoryManifest = null;
let inflight = null;

function readCache({ ignoreAge = false } = {}) {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.payload?.versions?.length) return null;
    if (!ignoreAge && Date.now() - (parsed.savedAt || 0) > CACHE_TTL) return null;
    return parsed.payload;
  } catch {
    return null;
  }
}

function writeCache(payload) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), payload }));
  } catch {
    /* quota or private mode — the in-memory copy still works */
  }
}

function normalise(json) {
  const versions = (json?.versions || [])
    .filter((entry) => entry && entry.id)
    .map((entry) => ({
      id: entry.id,
      type: entry.type || 'release',
      releaseTime: entry.releaseTime || entry.time || null
    }));

  return {
    latest: {
      release: json?.latest?.release || versions.find((v) => v.type === 'release')?.id || null,
      snapshot: json?.latest?.snapshot || versions[0]?.id || null
    },
    versions,
    offline: false
  };
}

export async function getVersionManifest({ force = false } = {}) {
  if (!force) {
    if (memoryManifest) return memoryManifest;
    if (inflight) return inflight;
    const cached = readCache();
    if (cached) {
      memoryManifest = cached;
      return cached;
    }
  }

  inflight = (async () => {
    for (const url of MANIFEST_URLS) {
      try {
        const response = await fetch(url);
        if (!response.ok) continue;
        const payload = normalise(await response.json());
        if (!payload.versions.length) continue;
        memoryManifest = payload;
        writeCache(payload);
        return payload;
      } catch {
        /* try the mirror */
      }
    }

    const stale = readCache({ ignoreAge: true });
    if (stale) {
      memoryManifest = { ...stale, offline: true };
      return memoryManifest;
    }

    return { latest: { release: null, snapshot: null }, versions: [], offline: true };
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/* ---------------------------------------------------------------- loaders */

let fabricVersions = null;
let fabricInflight = null;

export async function getFabricGameVersions() {
  if (fabricVersions) return fabricVersions;
  if (fabricInflight) return fabricInflight;

  fabricInflight = (async () => {
    try {
      const response = await fetch(FABRIC_GAME_URL);
      if (!response.ok) throw new Error('fabric meta unavailable');
      const json = await response.json();
      fabricVersions = new Set((json || []).map((entry) => entry.version).filter(Boolean));
    } catch {
      fabricVersions = null;
    }
    return fabricVersions;
  })();

  try {
    return await fabricInflight;
  } finally {
    fabricInflight = null;
  }
}

/** Numeric compare for release ids such as 1.21.4 vs 1.20.1. */
export function compareVersions(a, b) {
  const parse = (value) =>
    String(value || '')
      .split('.')
      .map((part) => parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));

  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function isReleaseId(id) {
  return /^\d+\.\d+(\.\d+)?$/.test(String(id || ''));
}

/** '1.21.4' -> '1.21'. Anything unparseable is grouped on its own. */
export function versionLine(id) {
  const match = /^(\d+\.\d+)/.exec(String(id || ''));
  return match ? match[1] : 'Other';
}

/**
 * Whether a loader can run a given Minecraft version.
 * Fabric is authoritative (from Fabric's own meta API); the rest use the
 * version each project actually started supporting.
 */
export function loaderAvailability(loader, versionId, fabricSet) {
  if (loader === 'Vanilla') return { available: true };

  if (!isReleaseId(versionId)) {
    if (loader === 'Fabric' && fabricSet?.has(versionId)) return { available: true };
    return {
      available: false,
      reason: `${loader} does not publish builds for snapshots like ${versionId}`,
      reasonKey: 'versions.loaderSnapshotUnavailable',
      reasonVars: { loader, version: versionId }
    };
  }

  if (loader === 'Fabric') {
    if (!fabricSet) return { available: true, unverified: true };
    return fabricSet.has(versionId)
      ? { available: true }
      : { available: false, reason: `Fabric has no build for ${versionId}`, reasonKey: 'versions.loaderNoBuild', reasonVars: { loader: 'Fabric', version: versionId } };
  }

  if (loader === 'Quilt') {
    return compareVersions(versionId, '1.14') >= 0
      ? { available: true }
      : { available: false, reason: 'Quilt supports 1.14 and newer', reasonKey: 'versions.loaderMinimum', reasonVars: { loader: 'Quilt', version: '1.14' } };
  }

  if (loader === 'NeoForge') {
    return compareVersions(versionId, '1.20.1') >= 0
      ? { available: true }
      : { available: false, reason: 'NeoForge supports 1.20.1 and newer', reasonKey: 'versions.loaderMinimum', reasonVars: { loader: 'NeoForge', version: '1.20.1' } };
  }

  if (loader === 'Forge') {
    return compareVersions(versionId, '1.1') >= 0
      ? { available: true }
      : { available: false, reason: 'Forge has no build for this version', reasonKey: 'versions.loaderNoBuild', reasonVars: { loader: 'Forge', version: versionId } };
  }

  return { available: true };
}

export function formatReleaseDate(iso, locale) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}
