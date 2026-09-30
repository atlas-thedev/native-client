const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

/**
 * Content metadata (title, icon, author, version) for files that Noctra did not
 * install itself: modpack downloads, mods dropped into the folder by hand, etc.
 *
 * Resolution order per file:
 *   1. Modrinth, by SHA-1 of the file (exact project + version match)
 *   2. The jar itself (fabric.mod.json / quilt.mod.json / mods.toml + bundled logo)
 *
 * Results are cached per folder in `.noctra-meta-cache.json`, keyed by file hash,
 * so toggling (renaming) a file never triggers another lookup.
 */

const API = 'https://api.modrinth.com/v2';
const CACHE_FILE = '.noctra-meta-cache.json';
const CONTENT_EXT = /\.(jar|zip)(\.disabled)?$/i;
const MAX_ICON_BYTES = 256 * 1024;
const CHUNK = 50;

const headers = {
  'User-Agent': 'NoctraClient (https://github.com/atlas-thedev/noctra-client)',
  'Content-Type': 'application/json'
};

const inflight = new Map();

function readCache(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, CACHE_FILE), 'utf8'));
    return { files: parsed.files || {}, byHash: parsed.byHash || {} };
  } catch {
    return { files: {}, byHash: {} };
  }
}

function writeCache(dir, cache) {
  try {
    fs.writeFileSync(path.join(dir, CACHE_FILE), JSON.stringify(cache));
  } catch {
    /* the cache is an optimisation only */
  }
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

function chunked(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function request(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetchImpl(url, { headers, ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** hash -> { title, iconUrl, author, version, source, projectId } for hashes Modrinth knows. */
async function lookupModrinth(hashes, fetchImpl) {
  const found = {};
  if (hashes.length === 0) return found;

  const versions = {};
  for (const batch of chunked(hashes, 200)) {
    const result = await request(fetchImpl, `${API}/version_files`, {
      method: 'POST',
      body: JSON.stringify({ hashes: batch, algorithm: 'sha1' })
    });
    Object.assign(versions, result || {});
  }

  const projectIds = [...new Set(Object.values(versions).map((v) => v.project_id).filter(Boolean))];
  const projects = {};
  for (const batch of chunked(projectIds, CHUNK)) {
    const list = await request(fetchImpl, `${API}/projects?ids=${encodeURIComponent(JSON.stringify(batch))}`);
    for (const project of list || []) projects[project.id] = project;
  }

  // Authors are best-effort: a failure here must not lose titles and icons.
  const owners = {};
  try {
    const teamIds = [...new Set(Object.values(projects).map((p) => p.team).filter(Boolean))];
    for (const batch of chunked(teamIds, CHUNK)) {
      const teams = await request(fetchImpl, `${API}/teams?ids=${encodeURIComponent(JSON.stringify(batch))}`);
      for (const members of teams || []) {
        const owner = members.find((m) => m.role === 'Owner') || members[0];
        if (owner?.team_id) owners[owner.team_id] = owner.user?.username || '';
      }
    }
  } catch {
    /* ignore */
  }

  for (const [hash, version] of Object.entries(versions)) {
    const project = projects[version.project_id];
    if (!project) continue;
    found[hash] = {
      title: project.title || '',
      iconUrl: project.icon_url || '',
      author: owners[project.team] || '',
      version: version.version_number || '',
      source: 'modrinth',
      projectId: project.id
    };
  }
  return found;
}

function tomlString(text, key) {
  const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'm'));
  return match ? match[1] ?? match[2] : '';
}

function cleanVersion(value) {
  const text = String(value || '').trim();
  return text && !text.includes('${') ? text : '';
}

function iconFromZip(zip, iconPath) {
  if (!iconPath) return '';
  const entry = zip.getEntry(String(iconPath).replace(/^\/+/, ''));
  if (!entry || entry.isDirectory || entry.header.size > MAX_ICON_BYTES) return '';
  const ext = path.extname(entry.entryName).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : '';
  if (!mime) return '';
  return `data:${mime};base64,${entry.getData().toString('base64')}`;
}

/** Reads display name, author, version and bundled logo straight out of a mod jar. */
function readJarMetadata(file) {
  let zip;
  try {
    zip = new AdmZip(file);
  } catch {
    return null;
  }
  const read = (name) => {
    const entry = zip.getEntry(name);
    return entry ? entry.getData().toString('utf8') : null;
  };

  try {
    const fabric = read('fabric.mod.json') || read('quilt.mod.json');
    if (fabric) {
      const json = JSON.parse(fabric.replace(/^\uFEFF/, ''));
      const info = json.quilt_loader ? { ...json.quilt_loader, ...(json.quilt_loader.metadata || {}) } : json;
      const icon = info.icon;
      const iconPath = typeof icon === 'string'
        ? icon
        : icon && typeof icon === 'object'
          ? icon[Object.keys(icon).map(Number).sort((a, b) => b - a)[0]]
          : '';
      const authors = info.authors || info.contributors;
      const first = Array.isArray(authors) ? authors[0] : Object.keys(authors || {})[0];
      return {
        title: String(info.name || info.id || '').trim(),
        iconUrl: iconFromZip(zip, iconPath),
        author: typeof first === 'string' ? first : first?.name || '',
        version: cleanVersion(info.version),
        source: 'jar'
      };
    }

    const toml = read('META-INF/mods.toml') || read('META-INF/neoforge.mods.toml');
    if (toml) {
      return {
        title: tomlString(toml, 'displayName'),
        iconUrl: iconFromZip(zip, tomlString(toml, 'logoFile')),
        author: tomlString(toml, 'authors'),
        version: cleanVersion(tomlString(toml, 'version')),
        source: 'jar'
      };
    }

    const legacy = read('mcmod.info');
    if (legacy) {
      const parsed = JSON.parse(legacy);
      const info = Array.isArray(parsed) ? parsed[0] : parsed.modList?.[0];
      if (info) {
        return {
          title: String(info.name || info.modid || '').trim(),
          iconUrl: iconFromZip(zip, info.logoFile),
          author: Array.isArray(info.authorList) ? info.authorList[0] || '' : '',
          version: cleanVersion(info.version),
          source: 'jar'
        };
      }
    }

    // Resource / shader packs: pack.png is the icon.
    const packIcon = iconFromZip(zip, 'pack.png');
    if (packIcon) return { title: '', iconUrl: packIcon, author: '', version: '', source: 'jar' };
  } catch {
    /* malformed metadata: fall through */
  }
  return null;
}

async function enrichFolderUncached(dir, { fetchImpl = globalThis.fetch } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => !name.startsWith('.') && CONTENT_EXT.test(name));
  } catch {
    return {};
  }
  if (names.length === 0) return {};

  const cache = readCache(dir);
  const fileHash = {};
  let dirty = false;

  // 1. hash files whose size / mtime changed since the last run
  const pending = [...names];
  const workers = Array.from({ length: 4 }, async () => {
    while (pending.length) {
      const name = pending.shift();
      try {
        const stat = fs.statSync(path.join(dir, name));
        const known = cache.files[name];
        if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) {
          fileHash[name] = known.sha1;
        } else {
          const sha1 = await sha1File(path.join(dir, name));
          cache.files[name] = { size: stat.size, mtimeMs: stat.mtimeMs, sha1 };
          fileHash[name] = sha1;
          dirty = true;
        }
      } catch {
        /* unreadable file: skip */
      }
    }
  });
  await Promise.all(workers);

  // drop cache rows for files that no longer exist
  for (const name of Object.keys(cache.files)) {
    if (!names.includes(name)) {
      delete cache.files[name];
      dirty = true;
    }
  }

  // 2. ask Modrinth about hashes we have not resolved yet
  const unresolved = [...new Set(Object.values(fileHash))].filter((hash) => !(hash in cache.byHash));
  let online = false;
  let modrinth = {};
  if (unresolved.length && typeof fetchImpl === 'function') {
    try {
      modrinth = await lookupModrinth(unresolved, fetchImpl);
      online = true;
    } catch {
      online = false;
    }
  }

  // 3. fall back to the jar for anything Modrinth does not know
  const result = {};
  for (const name of names) {
    const hash = fileHash[name];
    if (!hash) continue;
    let meta = cache.byHash[hash];
    if (meta === undefined) {
      if (modrinth[hash]) {
        meta = modrinth[hash];
        cache.byHash[hash] = meta;
        dirty = true;
      } else {
        const fromJar = readJarMetadata(path.join(dir, name));
        meta = fromJar;
        if (online) {
          // Modrinth answered and does not know this file: remember the jar data.
          cache.byHash[hash] = fromJar;
          dirty = true;
        }
      }
    }
    if (meta) result[name] = meta;
  }

  if (dirty) writeCache(dir, cache);
  return result;
}

/** Resolves metadata for every content file in `dir`. Concurrent calls share one run. */
function enrichFolder(dir, options) {
  const key = path.resolve(dir);
  if (inflight.has(key)) return inflight.get(key);
  const run = enrichFolderUncached(dir, options).finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

module.exports = { enrichFolder, lookupModrinth, readJarMetadata, CACHE_FILE };
