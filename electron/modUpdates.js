const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { downloadFile, writeFileAtomic } = require('./download');
const loaders = require('./loaders');

/**
 * Batch content updates, dependency resolution and pre-launch conflict checks.
 *
 * Updates work by file hash, so they cover every file Modrinth knows — not
 * only ones Native installed: modpack downloads and hand-copied jars too.
 *
 *   check     hash folder -> /version_files (what is installed)
 *                         -> /version_files/update (newest build for this
 *                            game version + loader) -> new required deps
 *   apply     download + verify each new file, swap it in place (keeping the
 *             disabled state), update the manifest, install new deps
 *   problems  duplicate mods, declared `breaks`, Modrinth "incompatible",
 *             missing required mods, mods for another loader
 */

const API = 'https://api.modrinth.com/v2';
const META_CACHE = '.native-meta-cache.json';
const CONTENT = /\.(jar|zip)(\.disabled)?$/i;
const HEADERS = {
  'User-Agent': 'NativeClient (https://playnative.fun)',
  'Content-Type': 'application/json'
};

/* Mod ids a loader or the game itself provides. */
const BUILTIN_IDS = new Set([
  'minecraft', 'java', 'fabricloader', 'fabric-loader', 'quilt_loader', 'quilt_base', 'forge', 'neoforge',
  'fml', 'javafml', 'lowcodefml', 'mcp', 'mixinextras', 'mixin', 'legacy-fabric-api-base'
]);

let fetchImpl = (...args) => globalThis.fetch(...args);

async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetchImpl(url, { headers: HEADERS, ...options, signal: controller.signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Modrinth answered HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Modrinth did not respond in time');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const chunked = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/** Modrinth loader tags whose mods run on `loader`. */
function modrinthLoaders(loader, mcVersion) {
  const kind = loaders.normalize(loader);
  if (kind === 'quilt') return ['quilt', 'fabric'];
  if (kind === 'legacyfabric') return ['legacy-fabric', 'fabric'];
  if (kind === 'neoforge' && mcVersion === '1.20.1') return ['neoforge', 'forge'];
  if (kind === 'vanilla') return [];
  return [kind];
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** name -> sha1 for every content file, sharing the metadata cache's hashes. */
async function hashFolder(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => !name.startsWith('.') && CONTENT.test(name));
  } catch {
    return {};
  }
  let cache = { files: {}, byHash: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, META_CACHE), 'utf8'));
    cache = { files: parsed.files || {}, byHash: parsed.byHash || {} };
  } catch {}
  const out = {};
  let dirty = false;
  const pending = [...names];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (pending.length) {
      const name = pending.shift();
      try {
        const stat = fs.statSync(path.join(dir, name));
        const known = cache.files[name];
        if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs && known.sha1) {
          out[name] = known.sha1;
        } else {
          out[name] = await sha1File(path.join(dir, name));
          cache.files[name] = { size: stat.size, mtimeMs: stat.mtimeMs, sha1: out[name] };
          dirty = true;
        }
      } catch {
        /* unreadable: skip */
      }
    }
  }));
  if (dirty) {
    try {
      fs.writeFileSync(path.join(dir, META_CACHE), JSON.stringify(cache));
    } catch {}
  }
  return out;
}

async function versionsByHash(hashes) {
  const out = {};
  for (const batch of chunked(hashes, 200)) {
    Object.assign(out, (await request(`${API}/version_files`, {
      method: 'POST',
      body: JSON.stringify({ hashes: batch, algorithm: 'sha1' })
    })) || {});
  }
  return out;
}

async function latestByHash(hashes, { loaderTags, mcVersion }) {
  const out = {};
  for (const batch of chunked(hashes, 200)) {
    const body = { hashes: batch, algorithm: 'sha1', game_versions: [mcVersion] };
    if (loaderTags?.length) body.loaders = loaderTags;
    Object.assign(out, (await request(`${API}/version_files/update`, { method: 'POST', body: JSON.stringify(body) })) || {});
  }
  return out;
}

async function projectsById(ids) {
  const out = {};
  for (const batch of chunked([...new Set(ids)].filter(Boolean), 80)) {
    const list = await request(`${API}/projects?ids=${encodeURIComponent(JSON.stringify(batch))}`);
    for (const project of list || []) out[project.id] = project;
  }
  return out;
}

/** Newest build of a project for this game version + loader (releases first). */
async function bestVersion(projectId, { loaderTags, mcVersion, includeBetas = false, newerThan = null }) {
  const params = new URLSearchParams({ game_versions: JSON.stringify([mcVersion]) });
  if (loaderTags?.length) params.set('loaders', JSON.stringify(loaderTags));
  const list = (await request(`${API}/project/${encodeURIComponent(projectId)}/version?${params}`)) || [];
  const after = (version) => !newerThan || Date.parse(version.date_published) > Date.parse(newerThan);
  return list.find((v) => v.version_type === 'release' && after(v))
    || (includeBetas ? list.find(after) : null)
    || (newerThan ? null : list[0] || null);
}

const primaryFile = (version) => version?.files?.find((file) => file.primary) || version?.files?.[0] || null;

function fileInfo(version) {
  const file = primaryFile(version);
  if (!file?.url || !file?.filename) return null;
  return { url: file.url, filename: path.basename(file.filename), sha1: file.hashes?.sha1 || null, sha512: file.hashes?.sha512 || null, size: file.size || null };
}

function fitsInstance(version, { loaderTags, mcVersion }) {
  if (!version) return false;
  const gameOk = !version.game_versions?.length || version.game_versions.includes(mcVersion);
  const loaderOk = !loaderTags?.length || !version.loaders?.length || version.loaders.some((tag) => loaderTags.includes(tag));
  return gameOk && loaderOk;
}

/* ── updates --------------------------------------------------------------- */

async function checkUpdates({ dir, folder = 'mods', loader, mcVersion, includeBetas = false }) {
  const fileHash = await hashFolder(dir);
  const names = Object.keys(fileHash);
  const result = { checked: names.length, known: 0, updates: [], dependencies: [], unknown: [], checkedAt: Date.now() };
  if (!names.length) return result;

  const loaderTags = folder === 'mods' ? modrinthLoaders(loader, mcVersion) : [];
  const hashes = [...new Set(Object.values(fileHash))];
  const [current, latest] = await Promise.all([
    versionsByHash(hashes),
    latestByHash(hashes, { loaderTags, mcVersion })
  ]);

  const installedProjects = new Set(Object.values(current).map((version) => version.project_id));
  const candidates = [];
  for (const name of names) {
    const now = current[fileHash[name]];
    if (!now) {
      result.unknown.push(name);
      continue;
    }
    result.known += 1;
    let next = latest[fileHash[name]];
    if (!next || next.id === now.id) continue;
    const fixesMismatch = !fitsInstance(now, { loaderTags, mcVersion });
    // The bulk endpoint ignores release channels: keep release installs on releases.
    if (!includeBetas && next.version_type !== 'release' && now.version_type === 'release') {
      next = await bestVersion(now.project_id, { loaderTags, mcVersion, includeBetas: false, newerThan: fixesMismatch ? null : now.date_published }).catch(() => null);
      if (!next || next.id === now.id) continue;
    }
    if (!fixesMismatch && Date.parse(next.date_published) <= Date.parse(now.date_published)) continue;
    const file = fileInfo(next);
    if (!file) continue;
    candidates.push({ name, now, next, file, fixesMismatch });
  }

  const projects = await projectsById(candidates.map((item) => item.now.project_id)).catch(() => ({}));
  result.updates = candidates.map(({ name, now, next, file, fixesMismatch }) => ({
    file: name,
    enabled: !/\.disabled$/i.test(name),
    projectId: now.project_id,
    title: projects[now.project_id]?.title || name,
    iconUrl: projects[now.project_id]?.icon_url || '',
    from: now.version_number,
    to: next.version_number,
    versionId: next.id,
    channel: next.version_type,
    date: next.date_published,
    fixesMismatch,
    ...file,
    requires: (next.dependencies || []).filter((dep) => dep.dependency_type === 'required').map((dep) => dep.project_id).filter(Boolean)
  }));

  // New builds can pull in libraries the old one did not need.
  const needed = new Map();
  for (const update of result.updates) {
    for (const projectId of update.requires) {
      if (installedProjects.has(projectId)) continue;
      if (!needed.has(projectId)) needed.set(projectId, []);
      needed.get(projectId).push(update.title);
    }
  }
  result.dependencies = await resolveDependencies(needed, { loaderTags, mcVersion });
  return result;
}

/** projectId -> [requiredBy titles]  =>  installable entries (unresolvable ones flagged). */
async function resolveDependencies(needed, { loaderTags, mcVersion }) {
  if (!needed.size) return [];
  const projects = await projectsById([...needed.keys()]).catch(() => ({}));
  const out = [];
  for (const [projectId, requiredBy] of needed) {
    const project = projects[projectId];
    let version = null;
    try {
      version = await bestVersion(projectId, { loaderTags, mcVersion, includeBetas: true });
    } catch {}
    const file = fileInfo(version);
    out.push({
      projectId,
      title: project?.title || projectId,
      iconUrl: project?.icon_url || '',
      requiredBy: [...new Set(requiredBy)],
      ...(file && version ? { versionId: version.id, version: version.version_number, ...file } : { unavailable: `No build for Minecraft ${mcVersion}` })
    });
  }
  return out;
}

function safeName(name) {
  const base = path.basename(String(name || ''));
  if (!base || base !== name || base.startsWith('.') || !CONTENT.test(base)) throw new Error(`Invalid file name: ${name}`);
  return base;
}

function readManifest(modsDir) {
  for (const file of ['.native-mods.json', '.native-mods.json']) {
    try {
      return JSON.parse(fs.readFileSync(path.join(modsDir, file), 'utf8'));
    } catch {}
  }
  return {};
}

/**
 * Applies updates and installs dependencies. Every file is downloaded and
 * hash-checked before the old one is removed, so a failure leaves the
 * instance exactly as it was for that mod.
 */
async function applyUpdates({ dir, folder = 'mods', updates = [], installs = [], onProgress = () => {} }) {
  const manifest = readManifest(dir);
  const done = { updated: [], installed: [], failed: [] };
  const total = updates.length + installs.length;
  let index = 0;

  const fetchOne = async (item, targetName) => {
    const url = new URL(item.url);
    if (url.protocol !== 'https:') throw new Error('Unsupported download URL');
    if (!/(^|\.)modrinth\.com$|(^|\.)modrinth\.net$/i.test(url.hostname)) throw new Error('Updates only download from Modrinth');
    const expectedHashes = item.sha512 ? { sha512: item.sha512 } : item.sha1 ? { sha1: item.sha1 } : {};
    await downloadFile(item.url, path.join(dir, targetName), {
      retries: 3,
      expectedHashes,
      onProgress: ({ percent }) => onProgress({ projectId: item.projectId, folder, title: item.title, iconUrl: item.iconUrl, percent: percent == null ? null : Math.max(1, Math.min(99, percent)), detail: `Updating ${item.title}…`, task: index + 1, total })
    });
  };

  for (const item of updates) {
    try {
      const oldName = safeName(item.file);
      const disabled = /\.disabled$/i.test(oldName);
      const newName = safeName(path.basename(item.filename)) + (disabled ? '.disabled' : '');
      if (!fs.existsSync(path.join(dir, oldName))) throw new Error('The file is gone');
      if (newName !== oldName && fs.existsSync(path.join(dir, newName))) throw new Error(`${newName} already exists`);
      await fetchOne(item, newName);
      if (newName !== oldName) fs.rmSync(path.join(dir, oldName), { force: true });
      for (const [key, raw] of Object.entries(manifest)) {
        const entry = typeof raw === 'string' ? { filename: raw, folder: 'mods' } : raw;
        if (entry?.filename !== oldName) continue;
        manifest[key] = { ...entry, filename: newName, metadata: { ...(entry.metadata || {}), version: item.to || entry.metadata?.version || '' } };
      }
      done.updated.push({ file: oldName, newFile: newName, title: item.title, to: item.to });
      onProgress({ projectId: item.projectId, folder, title: item.title, iconUrl: item.iconUrl, percent: 100, detail: 'Updated' });
    } catch (error) {
      done.failed.push({ file: item.file, title: item.title, error: error.message });
      onProgress({ projectId: item.projectId, folder, title: item.title, percent: 100, detail: 'Failed', error: true });
    }
    index += 1;
  }

  for (const item of installs) {
    try {
      if (!item.url) throw new Error(item.unavailable || 'No compatible build');
      const name = safeName(path.basename(item.filename));
      await fetchOne(item, name);
      manifest[item.projectId] = {
        filename: name,
        folder,
        metadata: { title: item.title || name, iconUrl: item.iconUrl || '', version: item.version || '', source: 'modrinth', description: '', author: '', gameVersions: [], loaders: [] }
      };
      done.installed.push({ file: name, title: item.title });
      onProgress({ projectId: item.projectId, folder, title: item.title, iconUrl: item.iconUrl, percent: 100, detail: 'Installed' });
    } catch (error) {
      done.failed.push({ file: item.filename, title: item.title, error: error.message });
      onProgress({ projectId: item.projectId, folder, title: item.title, percent: 100, detail: 'Failed', error: true });
    }
    index += 1;
  }

  if (done.updated.length || done.installed.length) {
    writeFileAtomic(path.join(dir, '.native-mods.json'), JSON.stringify(manifest, null, 2));
  }
  return done;
}

/* ── problems -------------------------------------------------------------- */

const stripBuild = (version) => String(version || '').split('+')[0];

/** Fabric-style version predicates: "*", ">=1.2 <2", "^1.2", "~1.2.3", "1.2.x", "a || b". */
function matchesRange(version, range) {
  const text = String(range ?? '*').trim();
  if (!text || text === '*') return true;
  const v = stripBuild(version);
  if (!v) return null;
  const cmp = (a, b) => loaders.compareLoaderVersions(stripBuild(a), stripBuild(b));
  const one = (term) => {
    const match = /^(>=|<=|>|<|=|\^|~)?\s*v?(.+)$/.exec(term);
    if (!match) return null;
    const [, op = '', raw] = match;
    if (/[x*]$/i.test(raw)) {
      const prefix = raw.replace(/\.?[x*]$/i, '');
      return !prefix || v === prefix || v.startsWith(`${prefix}.`);
    }
    if (!/^\d/.test(raw)) return null;
    const diff = cmp(v, raw);
    const parts = raw.split('.');
    switch (op) {
      case '>=': return diff >= 0;
      case '<=': return diff <= 0;
      case '>': return diff > 0;
      case '<': return diff < 0;
      case '^': return diff >= 0 && v.split('.')[0] === parts[0];
      case '~': return diff >= 0 && v.split('.').slice(0, 2).join('.') === parts.slice(0, 2).join('.');
      default: return diff === 0;
    }
  };
  let unknown = false;
  for (const alternative of text.split('||')) {
    const terms = alternative.trim().split(/\s+/).filter(Boolean);
    const results = terms.map(one);
    if (results.includes(null)) {
      unknown = true;
      continue;
    }
    if (results.every(Boolean)) return true;
  }
  return unknown ? null : false;
}

function olderOf(a, b) {
  const diff = loaders.compareLoaderVersions(stripBuild(a.version), stripBuild(b.version));
  if (diff) return diff < 0 ? a : b;
  return (a.mtime || 0) <= (b.mtime || 0) ? a : b;
}

/** Problems visible from the jars alone (no network). */
function localProblems(mods, { loader, mcVersion }) {
  const problems = [];
  const enabled = (mods || []).filter((mod) => !mod.corrupt);
  const provided = new Map();
  for (const mod of enabled) {
    for (const id of mod.ids || []) {
      if (!provided.has(id)) provided.set(id, mod);
    }
  }

  // The same mod twice (usually an old copy left next to an update).
  const byId = new Map();
  for (const mod of enabled) {
    if (!mod.id || /customskinloader/i.test(mod.file)) continue;
    if (!byId.has(mod.id)) byId.set(mod.id, []);
    byId.get(mod.id).push(mod);
  }
  for (const [id, copies] of byId) {
    if (copies.length < 2) continue;
    let keep = copies[0];
    for (const mod of copies.slice(1)) keep = olderOf(keep, mod) === keep ? mod : keep;
    const extra = copies.filter((mod) => mod !== keep);
    problems.push({
      id: `duplicate:${id}`,
      kind: 'duplicate',
      severity: 'error',
      title: `${keep.name || id} is installed ${copies.length} times`,
      detail: `The game refuses to start with duplicate mods. Keeping ${keep.file}${keep.version ? ` (${keep.version})` : ''}.`,
      files: copies.map((mod) => mod.file),
      fix: { type: 'disable', files: extra.map((mod) => mod.file), label: extra.length === 1 ? `Disable ${extra[0].file}` : `Disable ${extra.length} older copies` }
    });
  }

  // Mods that declare they break another installed mod.
  for (const mod of enabled) {
    for (const [id, range] of Object.entries(mod.breaks || {})) {
      const other = provided.get(id);
      if (!other || other === mod) continue;
      const hit = matchesRange(other.version, range);
      if (hit === false) continue;
      problems.push({
        id: `breaks:${mod.file}:${id}`,
        kind: 'breaks',
        severity: hit ? 'error' : 'warn',
        title: `${mod.name || mod.file} is incompatible with ${other.name || id}`,
        detail: `${mod.name || mod.file} declares it breaks ${other.name || id}${range && range !== '*' ? ` ${range}` : ''}${other.version ? ` (installed: ${other.version})` : ''}.`,
        files: [mod.file, other.file],
        fix: { type: 'disable', files: [other.file], label: `Disable ${other.name || other.file}` }
      });
    }
  }

  // Required mods that are not installed at all.
  for (const mod of enabled) {
    for (const id of Object.keys(mod.depends || {})) {
      if (BUILTIN_IDS.has(id) || provided.has(id)) continue;
      // Fabric API modules are bundled inside fabric-api.
      if ((id === 'fabric' || /^fabric(-|_)/.test(id)) && provided.has('fabric-api')) continue;
      if (/^quilted_fabric_api|^qsl|^quilt_/.test(id) && (provided.has('quilted_fabric_api') || provided.has('qsl'))) continue;
      // Forge jars can bundle libraries (jar-in-jar) this index cannot see.
      const forgeLike = mod.loader === 'forge' || mod.loader === 'neoforge';
      problems.push({
        id: `missing:${mod.file}:${id}`,
        kind: 'missing',
        severity: forgeLike ? 'warn' : 'error',
        title: `${mod.name || mod.file} needs ${id}`,
        detail: `${id} is not installed. ${mod.name || mod.file} will stop the game from starting without it.`,
        files: [mod.file],
        missingId: id
      });
    }
  }

  // Jars made for another loader.
  if (loaders.normalize(loader) !== 'vanilla') {
    const { incompatible } = loaders.classifyMods(enabled, loader, mcVersion);
    if (incompatible.length) {
      problems.push({
        id: 'wrong-loader',
        kind: 'wrong-loader',
        severity: 'error',
        title: incompatible.length === 1 ? `${incompatible[0].name} is a ${incompatible[0].loader} mod` : `${incompatible.length} mods are for a different loader`,
        detail: `This instance runs ${loaders.displayName(loader)}. ${incompatible.slice(0, 4).map((mod) => `${mod.name} (${mod.loader})`).join(', ')}${incompatible.length > 4 ? '…' : ''} will not load.`,
        files: incompatible.map((mod) => mod.file),
        fix: { type: 'disable', files: incompatible.map((mod) => mod.file), label: incompatible.length === 1 ? 'Disable it' : `Disable ${incompatible.length} mods` }
      });
    }
  }
  return problems;
}

/** Adds Modrinth knowledge: declared incompatibilities and installable fixes for missing mods. */
async function onlineProblems(problems, { dir, mods, loader, mcVersion }) {
  const loaderTags = modrinthLoaders(loader, mcVersion);
  const enabledNames = new Set((mods || []).map((mod) => mod.file));
  const fileHash = await hashFolder(dir);
  const hashes = Object.entries(fileHash).filter(([name]) => enabledNames.has(name));
  if (!hashes.length) return problems;
  const current = await versionsByHash([...new Set(hashes.map(([, hash]) => hash))]);
  const projectOf = new Map();
  for (const [name, hash] of hashes) if (current[hash]) projectOf.set(current[hash].project_id, name);

  const incompatibleIds = [];
  for (const [name, hash] of hashes) {
    for (const dep of current[hash]?.dependencies || []) {
      if (dep.dependency_type === 'incompatible' && dep.project_id && projectOf.has(dep.project_id) && projectOf.get(dep.project_id) !== name) {
        incompatibleIds.push({ name, other: projectOf.get(dep.project_id), projectId: dep.project_id });
      }
    }
  }
  if (incompatibleIds.length) {
    const projects = await projectsById(incompatibleIds.map((item) => item.projectId)).catch(() => ({}));
    const titleOf = (file) => mods.find((mod) => mod.file === file)?.name || file;
    for (const item of incompatibleIds) {
      const key = [item.name, item.other].sort().join('|');
      if (problems.some((problem) => problem.kind === 'incompatible' && problem.key === key)) continue;
      problems.push({
        id: `incompatible:${key}`,
        key,
        kind: 'incompatible',
        severity: 'error',
        title: `${titleOf(item.name)} does not work with ${projects[item.projectId]?.title || titleOf(item.other)}`,
        detail: `Its Modrinth page marks ${projects[item.projectId]?.title || titleOf(item.other)} as incompatible.`,
        files: [item.name, item.other],
        fix: { type: 'disable', files: [item.other], label: `Disable ${projects[item.projectId]?.title || titleOf(item.other)}` }
      });
    }
  }

  // Missing mods: Modrinth slugs usually equal mod ids.
  const missing = problems.filter((problem) => problem.kind === 'missing');
  const slugs = [...new Set(missing.map((problem) => problem.missingId))];
  for (const slug of slugs) {
    let project = null;
    for (const candidate of [slug, slug.replace(/_/g, '-')]) {
      project = await request(`${API}/project/${encodeURIComponent(candidate)}`).catch(() => null);
      if (project) break;
    }
    if (!project) continue;
    const version = await bestVersion(project.id, { loaderTags, mcVersion, includeBetas: true }).catch(() => null);
    const file = fileInfo(version);
    for (const problem of missing.filter((item) => item.missingId === slug)) {
      problem.title = problem.title.replace(new RegExp(`${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), project.title);
      problem.detail = `${project.title} is not installed. ${problem.files[0]} will stop the game from starting without it.`;
      if (file) {
        problem.fix = {
          type: 'install',
          label: `Install ${project.title}`,
          item: { projectId: project.id, title: project.title, iconUrl: project.icon_url || '', versionId: version.id, version: version.version_number, ...file }
        };
      } else {
        problem.detail += ` Modrinth has no ${project.title} build for Minecraft ${mcVersion}.`;
      }
    }
  }
  return problems;
}

async function findProblems({ dir, loader, mcVersion, online = true, indexMods }) {
  if (loaders.normalize(loader) === 'vanilla') return { problems: [], checked: 0 };
  const mods = await indexMods(dir);
  let problems = localProblems(mods, { loader, mcVersion });
  let offline = false;
  if (online) {
    try {
      problems = await onlineProblems(problems, { dir, mods, loader, mcVersion });
    } catch {
      offline = true;
    }
  }
  const rank = { error: 0, warn: 1 };
  problems.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { problems: problems.map(({ key, ...problem }) => problem), checked: mods.length, offline };
}

/* ── IPC ------------------------------------------------------------------- */

const FOLDERS = new Set(['mods', 'shaderpacks', 'resourcepacks']);
let deps = null;

function instanceInfo(instanceId) {
  const id = String(instanceId || '');
  if (!id || /[\\/]/.test(id) || id === '.' || id === '..') throw new Error('Invalid instance');
  return path.join(deps.app.getPath('userData'), 'minecraft', 'instances', id);
}

function folderDir(instanceId, folder) {
  if (!FOLDERS.has(folder)) throw new Error('Unsupported content folder');
  return path.join(instanceInfo(instanceId), folder);
}

function send(channel, payload) {
  const win = deps?.getWin?.();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function init(appDeps, ipcMain) {
  deps = appDeps;
  ipcMain.handle('mods:checkUpdates', (_event, { instanceId, folder = 'mods', loader, mcVersion, includeBetas = false } = {}) =>
    checkUpdates({ dir: folderDir(instanceId, folder), folder, loader, mcVersion: String(mcVersion || ''), includeBetas: Boolean(includeBetas) }));
  ipcMain.handle('mods:applyUpdates', (_event, { instanceId, folder = 'mods', updates = [], installs = [] } = {}) =>
    applyUpdates({
      dir: folderDir(instanceId, folder),
      folder,
      updates: Array.isArray(updates) ? updates.slice(0, 500) : [],
      installs: Array.isArray(installs) ? installs.slice(0, 100) : [],
      onProgress: (progress) => send('mods:progress', progress)
    }));
  ipcMain.handle('mods:problems', (_event, { instanceId, loader, mcVersion, online = true } = {}) =>
    findProblems({
      dir: folderDir(instanceId, 'mods'),
      loader,
      mcVersion: String(mcVersion || ''),
      online,
      indexMods: (dir) => require('./crashReporter').indexMods(dir)
    }));
}

module.exports = {
  init,
  modrinthLoaders,
  hashFolder,
  checkUpdates,
  applyUpdates,
  matchesRange,
  localProblems,
  findProblems,
  _setFetch: (impl) => { fetchImpl = impl || ((...args) => globalThis.fetch(...args)); }
};
