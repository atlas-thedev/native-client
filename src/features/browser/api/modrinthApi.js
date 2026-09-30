const MODRINTH_API = 'https://api.modrinth.com/v2';

export const PAGE_SIZE = 20;

/**
 * Every content type Noctra can install, and where each one lands on disk.
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
export async function searchProjects({ contentType, filters, query, sort, offset = 0, limit = PAGE_SIZE, signal }) {
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
  return fetchJson(endpoint('/project/' + projectId), options);
}

/**
 * Lists project versions, optionally constrained to a game version / loader.
 */
export async function getVersions(projectId, { gameVersion, loader, signal } = {}) {
  const params = {};
  if (gameVersion) params.game_versions = JSON.stringify([gameVersion]);
  if (loader) params.loaders = JSON.stringify([loader]);
  const list = await fetchJson(endpoint('/project/' + projectId + '/version', params), { signal });
  return Array.isArray(list) ? list : [];
}

export function getVersion(versionId, options) {
  return fetchJson(endpoint('/version/' + versionId), options);
}

export async function getCategoryTags(options) {
  const tags = await fetchJson(endpoint('/tag/category'), options);
  return Array.isArray(tags) ? tags : [];
}
