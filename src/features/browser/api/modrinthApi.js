import { cfHeaders } from '../../../lib/cfApi.js';

const MODRINTH_API = 'https://api.modrinth.com/v2';
const CF_API = 'https://api.curseforge.com/v1';

export const PAGE_SIZE = 20;

/**
 * Every content type Native can install, and where each one lands on disk.
 * `folder` maps to the allow-list in the main process; modpacks go through the
 * dedicated .mrpack installer instead of a plain file download.
 */
export const CONTENT_TYPES = [
  { id: 'modpack', labelKey: 'browse.modpacks', projectType: 'modpack', folder: null, icon: 'layers' },
  { id: 'mod', labelKey: 'browse.mods', projectType: 'mod', folder: 'mods', icon: 'package' },
  { id: 'shader', labelKey: 'browse.shaderpacks', projectType: 'shader', folder: 'shaderpacks', icon: 'sparkles' },
  {
    id: 'resourcepack',
    labelKey: 'browse.resourcepacks',
    projectType: 'resourcepack',
    folder: 'resourcepacks',
    icon: 'image'
  },
  { id: 'datapack', labelKey: 'browse.datapacks', projectType: 'datapack', folder: 'datapacks', icon: 'file' }
];

export const SORTS = [
  { id: 'relevance', key: 'browse.relevance' },
  { id: 'downloads', key: 'browse.downloads' },
  { id: 'follows', key: 'browse.followers' },
  { id: 'newest', key: 'browse.newest' },
  { id: 'updated', key: 'browse.updated' }
];

export const LOADER_FACETS = new Set(['fabric', 'forge', 'neoforge', 'quilt']);

export function contentTypeById(id) {
  return CONTENT_TYPES.find((entry) => entry.id === id) || null;
}

export function endpoint(path, params) {
  const base = MODRINTH_API + path;
  if (!params) return base;
  const search = new URLSearchParams(params).toString();
  return search ? base + '?' + search : base;
}

export async function fetchJson(url, options) {
  try {
    const response = await fetch(url, options);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

export function primaryFile(version) {
  return (version?.files || []).find((entry) => entry.primary) || version?.files?.[0] || null;
}

export function versionOf(instance) {
  return instance?.mc_version || instance?.version || '';
}

export function loaderOf(instance) {
  return instance?.mc_loader || instance?.loader || 'Vanilla';
}

export function isVanilla(instance) {
  if (!instance) return false;
  const loader = (loaderOf(instance) || '').toLowerCase();
  return !loader || loader === 'vanilla';
}

/**
 * Builds the Modrinth facet matrix for a search request.
 * `contentType` may be a CONTENT_TYPES entry or its id.
 * `filters` = { gameVersion, loader, environment, categories }.
 */
export function buildFacets(contentType, filters = {}) {
  const type = typeof contentType === 'string' ? contentTypeById(contentType) : contentType;
  const projectType = type?.projectType || 'mod';
  const facets = [[`project_type:${projectType}`]];

  const categories = Array.isArray(filters.categories) ? filters.categories : [];
  if (categories.length) {
    facets.push(categories.map((name) => `categories:${name}`));
  }
  if (filters.gameVersion) {
    facets.push([`versions:${filters.gameVersion}`]);
  }
  // Mods and modpacks are tagged by mod loader (Fabric, Forge, NeoForge, Quilt).
  // Shaders use iris/optifine/canvas and resourcepacks are not tagged, so skip for them.
  if ((type?.id === 'mod' || type?.id === 'modpack') && filters.loader) {
    facets.push([`categories:${filters.loader}`]);
  }
  if (filters.environment === 'client') {
    facets.push(['client_side:required', 'client_side:optional']);
  } else if (filters.environment === 'server') {
    facets.push(['server_side:required', 'server_side:optional']);
  }
  return facets;
}

/**
 * Runs a `/search` request. Throws on HTTP errors so callers can render
 * an error state; aborts propagate as AbortError.
 */
/* Short-lived search cache: switching Modrinth <-> CurseForge (or back to a
   previous query) is instant, and the other source is prefetched in the
   background. Shared requests are never aborted; callers race their signal. */
const SEARCH_TTL = 3 * 60 * 1000;
const searchCache = new Map();

function searchKey({ contentType, filters = {}, query, sort, offset = 0, limit = PAGE_SIZE, source }) {
  const type = typeof contentType === 'string' ? contentType : contentType?.id;
  return JSON.stringify([
    source || 'modrinth', type || 'mod', (query || '').trim().toLowerCase(), sort || 'relevance', offset, limit,
    filters.gameVersion || '', filters.loader || '', filters.environment || '', [...(filters.categories || [])].sort()
  ]);
}

function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); }
    );
  });
}

export function searchProjects(params) {
  const key = searchKey(params);
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.at < SEARCH_TTL) return withAbort(cached.promise, params.signal);
  const promise = runSearchRequest({ ...params, signal: undefined });
  searchCache.set(key, { at: Date.now(), promise });
  promise.catch(() => { if (searchCache.get(key)?.promise === promise) searchCache.delete(key); });
  if (searchCache.size > 80) searchCache.delete(searchCache.keys().next().value);
  return withAbort(promise, params.signal);
}

/** Warms the cache (e.g. the other source's first page). Never throws. */
export function prefetchSearch(params) {
  searchProjects({ ...params, signal: undefined }).catch(() => {});
}

async function runSearchRequest({ contentType, filters, query, sort, offset = 0, limit = PAGE_SIZE, signal, source }) {
  if (source === 'curseforge') return cfSearch({ contentType, filters, query, sort, offset, limit, signal });
  const params = {
    limit: String(limit),
    offset: String(offset),
    index: sort || 'relevance',
    facets: JSON.stringify(buildFacets(contentType, filters))
  };
  const trimmed = (query || '').trim();
  if (trimmed) params.query = trimmed;

  const response = await fetch(endpoint('/search', params), { signal });
  if (!response.ok) throw new Error('Search failed');
  const json = await response.json();
  return {
    hits: Array.isArray(json?.hits) ? json.hits : [],
    totalHits: Number(json?.total_hits) || 0
  };
}

export function getProject(projectId, options) {
  if (isCfId(projectId)) return cfGetProject(projectId, options);
  return fetchJson(endpoint('/project/' + projectId), options);
}

/**
 * Lists project versions, optionally constrained to a game version / loader.
 */
export async function getVersions(projectId, { gameVersion, loader, signal } = {}) {
  if (isCfId(projectId)) return cfGetVersions(projectId, { gameVersion, loader, signal });
  const params = {};
  if (gameVersion) params.game_versions = JSON.stringify([gameVersion]);
  if (loader) params.loaders = JSON.stringify([loader]);
  const list = await fetchJson(endpoint('/project/' + projectId + '/version', params), { signal });
  return Array.isArray(list) ? list : [];
}

export function getVersion(versionId, options) {
  if (isCfId(versionId)) return cfGetVersion(versionId, options);
  return fetchJson(endpoint('/version/' + versionId), options);
}

export async function getCategoryTags(options) {
  const tags = await fetchJson(endpoint('/tag/category'), options);
  return Array.isArray(tags) ? tags : [];
}

/* ================================================================ CurseForge
   Adapter that maps CurseForge API responses onto the Modrinth shapes the
   Discover UI already understands. Ids are prefixed with `cf:` so every
   lookup can dispatch to the right provider. */

export const SOURCES = [
  { id: 'modrinth', label: 'Modrinth' },
  { id: 'curseforge', label: 'CurseForge' }
];

const CF_CLASS_IDS = { mod: 6, modpack: 4471, resourcepack: 12, shader: 6552, datapack: 6945 };
const CF_LOADER_TYPES = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
const CF_SORT_FIELDS = { relevance: 2, downloads: 6, follows: 12, newest: 11, updated: 3 };
const CF_LOADER_NAMES = new Set(['forge', 'fabric', 'quilt', 'neoforge']);
const CF_RELEASE_TYPES = { 1: 'release', 2: 'beta', 3: 'alpha' };

export function isCfId(id) {
  return typeof id === 'string' && id.startsWith('cf:');
}

function cfNum(id) {
  return String(id).replace(/^cf:/, '');
}

async function cfFetch(path, params, options = {}) {
  const search = params ? new URLSearchParams(params).toString() : '';
  const response = await fetch(CF_API + path + (search ? '?' + search : ''), {
    headers: cfHeaders,
    signal: options.signal
  });
  if (!response.ok) throw new Error('CurseForge request failed');
  return response.json();
}

function cfSplitVersions(list) {
  const gameVersions = [];
  const loaders = [];
  for (const raw of list || []) {
    const value = String(raw || '');
    const lower = value.toLowerCase();
    if (CF_LOADER_NAMES.has(lower)) {
      if (!loaders.includes(lower)) loaders.push(lower);
    } else if (/^\d+\.\d+(\.\d+)?$/.test(value) && !gameVersions.includes(value)) {
      gameVersions.push(value);
    }
  }
  return { gameVersions, loaders };
}

function cfProjectType(classId) {
  const entry = Object.entries(CF_CLASS_IDS).find(([, value]) => value === classId);
  return entry ? entry[0] : 'mod';
}

function mapCfProject(mod) {
  if (!mod) return null;
  const gameVersions = [];
  const loaders = [];
  for (const file of mod.latestFilesIndexes || []) {
    if (file.gameVersion && !gameVersions.includes(file.gameVersion)) gameVersions.push(file.gameVersion);
    const loaderName = Object.keys(CF_LOADER_TYPES).find((key) => CF_LOADER_TYPES[key] === file.modLoader);
    if (loaderName && !loaders.includes(loaderName)) loaders.push(loaderName);
  }
  const categories = (mod.categories || []).map((entry) => entry.slug || entry.name).filter(Boolean);
  const gallery = (mod.screenshots || []).map((shot) => ({
    url: shot.url,
    raw_url: shot.url,
    title: shot.title || '',
    description: shot.description || ''
  }));
  const id = 'cf:' + mod.id;
  return {
    project_id: id,
    id,
    cf_id: mod.id,
    source: 'cf',
    slug: mod.slug,
    title: mod.name,
    description: mod.summary || '',
    icon_url: mod.logo?.thumbnailUrl || mod.logo?.url || '',
    author: mod.authors?.[0]?.name || '',
    downloads: Number(mod.downloadCount) || 0,
    follows: Number(mod.thumbsUpCount) || 0,
    categories,
    display_categories: categories,
    project_type: cfProjectType(mod.classId),
    featured_gallery: gallery[0]?.url || null,
    gallery,
    web_url: mod.links?.websiteUrl || '',
    source_url: mod.links?.sourceUrl || null,
    issues_url: mod.links?.issuesUrl || null,
    wiki_url: mod.links?.wikiUrl || null,
    date_created: mod.dateCreated,
    date_modified: mod.dateModified,
    published: mod.dateCreated,
    updated: mod.dateModified,
    versions: gameVersions,
    game_versions: gameVersions,
    loaders
  };
}

function cfFileUrl(file) {
  if (file.downloadUrl) return file.downloadUrl;
  const id = Number(file.id);
  return `https://mediafilez.forgecdn.net/files/${Math.floor(id / 1000)}/${id % 1000}/${encodeURIComponent(file.fileName)}`;
}

function mapCfFile(file) {
  if (!file) return null;
  const { gameVersions, loaders } = cfSplitVersions(file.gameVersions);
  return {
    id: `cf:${file.modId}:${file.id}`,
    project_id: 'cf:' + file.modId,
    name: file.displayName || file.fileName,
    version_number: file.displayName || file.fileName,
    version_type: CF_RELEASE_TYPES[file.releaseType] || 'release',
    date_published: file.fileDate,
    downloads: Number(file.downloadCount) || 0,
    game_versions: gameVersions,
    loaders,
    files: [{ url: cfFileUrl(file), filename: file.fileName, primary: true, size: file.fileLength || 0 }],
    dependencies: (file.dependencies || [])
      .filter((dep) => dep.relationType === 3 || dep.relationType === 2)
      .map((dep) => ({
        project_id: 'cf:' + dep.modId,
        version_id: null,
        dependency_type: dep.relationType === 3 ? 'required' : 'optional'
      }))
  };
}

async function cfSearch({ contentType, filters = {}, query, sort, offset = 0, limit = PAGE_SIZE, signal }) {
  const type = typeof contentType === 'string' ? contentTypeById(contentType) : contentType;
  const typeId = type?.id || 'mod';
  const pageSize = Math.min(50, limit);
  if (offset + pageSize > 10000) return { hits: [], totalHits: 10000 };
  const params = {
    gameId: '432',
    classId: String(CF_CLASS_IDS[typeId] || 6),
    sortField: String(CF_SORT_FIELDS[sort] || 2),
    sortOrder: 'desc',
    index: String(offset),
    pageSize: String(pageSize)
  };
  const trimmed = (query || '').trim();
  if (trimmed) params.searchFilter = trimmed;
  if (filters.gameVersion) params.gameVersion = filters.gameVersion;
  if ((typeId === 'mod' || typeId === 'modpack') && filters.loader && CF_LOADER_TYPES[filters.loader]) {
    params.modLoaderType = String(CF_LOADER_TYPES[filters.loader]);
  }
  const json = await cfFetch('/mods/search', params, { signal });
  const hits = (json?.data || []).map(mapCfProject).filter(Boolean);
  return {
    hits,
    totalHits: Math.min(10000, Number(json?.pagination?.totalCount) || 0)
  };
}

async function cfGetProject(projectId, options) {
  const id = cfNum(projectId);
  try {
    const [mod, description] = await Promise.all([
      cfFetch('/mods/' + id, null, options),
      cfFetch('/mods/' + id + '/description', null, options).catch(() => null)
    ]);
    const record = mapCfProject(mod?.data);
    if (record && typeof description?.data === 'string') record.body = description.data;
    return record;
  } catch {
    return null;
  }
}

async function cfGetVersions(projectId, { gameVersion, loader, signal } = {}) {
  const params = { pageSize: '50' };
  if (gameVersion) params.gameVersion = gameVersion;
  if (loader && CF_LOADER_TYPES[loader]) params.modLoaderType = String(CF_LOADER_TYPES[loader]);
  try {
    const json = await cfFetch('/mods/' + cfNum(projectId) + '/files', params, { signal });
    return (json?.data || [])
      .filter((file) => file.isAvailable !== false && !file.isServerPack)
      .sort((a, b) => new Date(b.fileDate) - new Date(a.fileDate))
      .map(mapCfFile);
  } catch {
    return [];
  }
}

async function cfGetVersion(versionId, options) {
  const [, modId, fileId] = String(versionId).split(':');
  if (!modId || !fileId) return null;
  try {
    const json = await cfFetch(`/mods/${modId}/files/${fileId}`, null, options);
    return mapCfFile(json?.data);
  } catch {
    return null;
  }
}

/** Quick-search helper: CurseForge projects across installable classes. */
export async function searchCurseForgeQuick({ query, limit = 5, signal }) {
  const trimmed = (query || '').trim();
  if (!trimmed) return [];
  const allowed = new Set([CF_CLASS_IDS.mod, CF_CLASS_IDS.modpack, CF_CLASS_IDS.shader, CF_CLASS_IDS.resourcepack, CF_CLASS_IDS.datapack]);
  const json = await cfFetch('/mods/search', {
    gameId: '432',
    searchFilter: trimmed,
    sortField: '2',
    sortOrder: 'desc',
    pageSize: String(Math.min(50, limit * 3))
  }, { signal });
  return (json?.data || [])
    .filter((mod) => allowed.has(mod.classId))
    .slice(0, limit)
    .map(mapCfProject)
    .filter(Boolean);
}
