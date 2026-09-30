/* ============================================================
   Noctra — official version artwork

   Mojang ships a banner image with every Java patch note entry.
   We use those as the real per-version artwork instead of
   recycling the same handful of bundled images.
   ============================================================ */

const PATCH_NOTES_ORIGIN = 'https://launchercontent.mojang.com';
const PATCH_NOTES_PATH = '/v2/javaPatchNotes.json';

const CACHE_KEY = 'native.patchNotes';
const CACHE_TTL = 3 * 60 * 60 * 1000;

let inflight = null;
let memory = null;

function absoluteUrl(path) {
  if (!path) return null;
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  return PATCH_NOTES_ORIGIN + (path.startsWith('/') ? path : '/' + path);
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.savedAt || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(entries) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), entries }));
  } catch {
    /* storage full or unavailable is fine */
  }
}

function normalize(json) {
  const raw = Array.isArray(json?.entries) ? json.entries : [];

  return raw
    .map((entry) => ({
      version: entry.version || '',
      title: entry.title || entry.version || '',
      type: entry.type || 'release',
      date: entry.date || '',
      image: absoluteUrl(entry.image?.url),
      shortText: entry.shortText || ''
    }))
    .filter((entry) => entry.version);
}

/** Returns the patch note entries, cached for a day. Never throws. */
export async function getPatchNotes({ force = false } = {}) {
  if (memory && !force) return memory;

  const cached = readCache();
  if (cached && !force && Date.now() - cached.savedAt < CACHE_TTL) {
    memory = cached.entries;
    return memory;
  }

  if (inflight) return inflight;

  inflight = fetch(PATCH_NOTES_ORIGIN + PATCH_NOTES_PATH)
    .then((response) => {
      if (!response.ok) throw new Error('patch notes unavailable');
      return response.json();
    })
    .then((json) => {
      const entries = normalize(json);
      if (entries.length) {
        writeCache(entries);
        memory = entries;
      }
      return memory || cached?.entries || [];
    })
    .catch(() => {
      memory = cached?.entries || [];
      return memory;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/** version id -> { image, title, date, shortText } */
export async function getVersionBanners(options) {
  const entries = await getPatchNotes(options);
  const map = new Map();

  entries.forEach((entry) => {
    if (!map.has(entry.version)) map.set(entry.version, entry);
  });

  return map;
}

/**
 * Best banner for a version id. Falls back to the newest banner inside the
 * same release line (1.21.4 -> 1.21.3 -> 1.21) before giving up.
 */
export function bannerFor(banners, versionId, lineVersions = []) {
  if (!banners || !versionId) return null;

  const exact = banners.get(versionId);
  if (exact?.image) return exact;

  for (const candidate of lineVersions) {
    const id = typeof candidate === 'string' ? candidate : candidate?.id;
    const match = id && banners.get(id);
    if (match?.image) return match;
  }

  return null;
}
