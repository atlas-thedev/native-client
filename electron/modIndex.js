const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

/**
 * Crash-analysis index of an instance's mods folder.
 *
 * For every enabled jar it records what the crash analyser needs to turn a
 * stack trace or loader message back into a file on disk:
 *   - the mod ids the jar provides (its own id, `provides`, and bundled jars)
 *   - its declared dependencies
 *   - its Mixin config names (a failing `foo.mixins.json` names the mod)
 *   - the Java packages its classes live in (stack frames name classes)
 *
 * Results are cached next to the mods in `.native-crash-index.json`, keyed by
 * file name + size + mtime, so only new or changed jars are reopened.
 */

const CACHE_FILE = '.native-crash-index.json';
const CACHE_VERSION = 5;
const MAX_PACKAGES = 24;
const MAX_NESTED_BYTES = 48 * 1024 * 1024;
// Packages that never identify a mod on their own.
const IGNORED_PACKAGES = /^(?:net\.minecraft|com\.mojang|java|javax|jdk|sun|kotlin|org\.spongepowered|org\.objectweb|com\.google|org\.apache|it\.unimi|io\.netty|org\.lwjgl|org\.slf4j|com\.llamalad7\.mixinextras|META-INF)(?:\.|$)/;

function safeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch {
    // fabric.mod.json files in the wild often carry trailing commas or control characters.
    try {
      return JSON.parse(String(text).replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1').replace(/[\u0000-\u0019]+/g, ' '));
    } catch {
      return null;
    }
  }
}

function tomlValue(block, key) {
  const match = String(block || '').match(new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|(true|false))`, 'm'));
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3];
}

/** Forge / NeoForge mods.toml: mod ids, names, versions and mandatory deps. */
function parseModsToml(text) {
  const out = { ids: [], name: '', version: '', depends: {} };
  if (!text) return out;
  const blocks = String(text).split(/^\s*\[\[/m);
  for (const block of blocks) {
    const header = block.slice(0, block.indexOf(']')).trim();
    if (header === 'mods') {
      const id = tomlValue(block, 'modId');
      if (id) out.ids.push(id);
      if (!out.name) out.name = tomlValue(block, 'displayName') || '';
      if (!out.version) out.version = tomlValue(block, 'version') || '';
    } else if (header.startsWith('dependencies')) {
      const id = tomlValue(block, 'modId');
      const mandatory = tomlValue(block, 'mandatory');
      const type = tomlValue(block, 'type');
      const required = mandatory === 'true' || String(type || '').toLowerCase() === 'required';
      const side = String(tomlValue(block, 'side') || 'BOTH').toUpperCase();
      if (id && required && side !== 'SERVER') out.depends[id] = tomlValue(block, 'versionRange') || '*';
    }
  }
  return out;
}

/**
 * Java packages a jar's classes live in, as `packages` (4 segments, e.g.
 * net.caffeinemc.mods.sodium) and `roots` (3 segments). Stack frames are
 * matched against the longest prefix; roots only count when unambiguous.
 */
function packagesOf(entries) {
  const deep = new Map();
  const shallow = new Map();
  for (const name of entries) {
    if (!name.endsWith('.class') || name.startsWith('META-INF/')) continue;
    const dir = name.slice(0, name.lastIndexOf('/'));
    if (!dir) continue;
    const parts = dir.split('/');
    const p4 = parts.slice(0, Math.min(parts.length, 4)).join('.');
    const p3 = parts.slice(0, Math.min(parts.length, 3)).join('.');
    if (IGNORED_PACKAGES.test(p4)) continue;
    deep.set(p4, (deep.get(p4) || 0) + 1);
    shallow.set(p3, (shallow.get(p3) || 0) + 1);
  }
  const top = (map, limit) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([key]) => key);
  return { packages: top(deep, MAX_PACKAGES), roots: top(shallow, 6) };
}

function mixinConfigsFromManifest(text) {
  const match = String(text || '').match(/^MixinConfigs:\s*(.+)$/m);
  return match ? match[1].split(',').map((item) => item.trim()).filter(Boolean) : [];
}

function mixinNames(list) {
  return (Array.isArray(list) ? list : [list])
    .map((item) => (typeof item === 'string' ? item : item?.config))
    .filter(Boolean);
}

/** Reads one jar (or a nested jar buffer). Returns null for non-mod archives. */
function readJar(source, depth = 0, budget = { bytes: MAX_NESTED_BYTES }) {
  let zip;
  try {
    zip = new AdmZip(source);
  } catch {
    return { corrupt: true };
  }
  let entries;
  try {
    entries = zip.getEntries();
  } catch {
    return { corrupt: true };
  }
  const names = entries.map((entry) => entry.entryName);
  const read = (name) => {
    const entry = zip.getEntry(name);
    try {
      return entry ? entry.getData().toString('utf8') : null;
    } catch {
      return null;
    }
  };

  const info = {
    ids: [],
    name: '',
    version: '',
    loader: 'unknown',
    depends: {},
    breaks: {},
    mixins: [],
    ...packagesOf(names),
    environment: '*'
  };

  const fabric = safeJson(read('fabric.mod.json'));
  const quilt = safeJson(read('quilt.mod.json'));
  const toml = read('META-INF/mods.toml');
  const neo = read('META-INF/neoforge.mods.toml');
  // Every loader this jar ships metadata for (multi-loader jars list several).
  info.platforms = [
    fabric && 'fabric',
    quilt?.quilt_loader && 'quilt',
    (toml || names.includes('mcmod.info')) && 'forge',
    neo && 'neoforge'
  ].filter(Boolean);

  if (fabric) {
    info.loader = 'fabric';
    if (fabric.id) info.ids.push(String(fabric.id));
    for (const alias of [].concat(fabric.provides || [])) if (typeof alias === 'string') info.ids.push(alias);
    info.name = String(fabric.name || fabric.id || '');
    info.version = String(fabric.version || '');
    info.environment = fabric.environment || '*';
    if (fabric.depends && typeof fabric.depends === 'object') {
      for (const [id, range] of Object.entries(fabric.depends)) info.depends[id] = Array.isArray(range) ? range.join(' || ') : String(range);
    }
    if (fabric.breaks && typeof fabric.breaks === 'object') {
      for (const [id, range] of Object.entries(fabric.breaks)) info.breaks[id] = Array.isArray(range) ? range.join(' || ') : String(range);
    }
    info.mixins.push(...mixinNames(fabric.mixins || []));
    // Jar-in-jar: fabric-api and many libraries bundle their modules.
    if (depth < 2) {
      for (const nested of [].concat(fabric.jars || [])) {
        const file = typeof nested === 'string' ? nested : nested?.file;
        const entry = file && zip.getEntry(file);
        if (!entry || entry.header.size > budget.bytes) continue;
        budget.bytes -= entry.header.size;
        let data;
        try {
          data = entry.getData();
        } catch {
          continue;
        }
        const child = readJar(data, depth + 1, budget);
        if (!child || child.corrupt) continue;
        info.ids.push(...child.ids);
        info.mixins.push(...child.mixins);
        info.packages.push(...child.packages.filter((pkg) => !info.packages.includes(pkg)).slice(0, 4));
        info.roots.push(...child.roots.filter((pkg) => !info.roots.includes(pkg)).slice(0, 2));
      }
    }
  } else if (quilt?.quilt_loader) {
    const q = quilt.quilt_loader;
    info.loader = 'quilt';
    if (q.id) info.ids.push(String(q.id));
    for (const alias of [].concat(q.provides || [])) info.ids.push(typeof alias === 'string' ? alias : alias?.id);
    info.name = String(q.metadata?.name || q.id || '');
    info.version = String(q.version || '');
    for (const dep of [].concat(q.depends || [])) {
      const id = typeof dep === 'string' ? dep : dep?.id;
      if (id && !dep?.optional) info.depends[id] = typeof dep === 'string' ? '*' : String(dep.versions || '*');
    }
    info.mixins.push(...mixinNames(quilt.mixin || []));
  } else if (toml || neo) {
    const parsed = parseModsToml(neo || toml);
    info.loader = neo ? 'neoforge' : 'forge';
    info.ids.push(...parsed.ids);
    info.name = parsed.name || parsed.ids[0] || '';
    info.version = parsed.version && !parsed.version.includes('${') ? parsed.version : '';
    info.depends = parsed.depends;
    info.mixins.push(...mixinConfigsFromManifest(read('META-INF/MANIFEST.MF')));
    const mixinBlocks = String(neo || toml).match(/\[\[mixins\]\][^[]*/g) || [];
    for (const block of mixinBlocks) {
      const config = tomlValue(block, 'config');
      if (config) info.mixins.push(config);
    }
  } else if (read('mcmod.info')) {
    const legacy = safeJson(read('mcmod.info'));
    const first = Array.isArray(legacy) ? legacy[0] : legacy?.modList?.[0];
    info.loader = 'forge';
    if (first?.modid) info.ids.push(String(first.modid));
    info.name = String(first?.name || first?.modid || '');
    info.version = String(first?.version || '');
    info.mixins.push(...mixinConfigsFromManifest(read('META-INF/MANIFEST.MF')));
  } else if (names.some((name) => /^(?:notch|net\/optifine)\//.test(name)) || names.includes('optifine/Config.class')) {
    info.loader = 'optifine';
    info.ids.push('optifine');
    info.name = 'OptiFine';
    info.platforms = ['optifine'];
  } else if (depth > 0) {
    return null;
  }

  info.ids = [...new Set(info.ids.filter(Boolean).map(String))];
  // The jar's own id (ids also lists bundled jar-in-jar modules).
  info.id = info.ids[0] || '';
  info.mixins = [...new Set(info.mixins)];
  return info;
}

function readCache(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, CACHE_FILE), 'utf8'));
    return parsed?.version === CACHE_VERSION ? parsed.entries || {} : {};
  } catch {
    return {};
  }
}

function writeCache(dir, entries) {
  try {
    fs.writeFileSync(path.join(dir, CACHE_FILE), JSON.stringify({ version: CACHE_VERSION, entries }));
  } catch {
    /* read-only folder: the index still works, just uncached */
  }
}

/** Indexes every enabled .jar in `dir`. Synchronous; run it in a worker for big folders. */
function buildIndex(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((name) => /\.jar$/i.test(name));
  } catch {
    return [];
  }
  const cache = readCache(dir);
  const next = {};
  const mods = [];
  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(path.join(dir, file));
    } catch {
      continue;
    }
    const key = `${stat.size}:${Math.round(stat.mtimeMs)}`;
    let data = cache[file]?.key === key ? cache[file].data : null;
    if (!data) data = readJar(path.join(dir, file)) || { ids: [], name: '', version: '', loader: 'unknown', platforms: [], depends: {}, breaks: {}, mixins: [], packages: [], roots: [] };
    next[file] = { key, data };
    mods.push({ file, size: stat.size, mtime: Math.round(stat.mtimeMs), ...data, name: data.name || file.replace(/\.jar$/i, '') });
  }
  writeCache(dir, next);
  return mods;
}

module.exports = { buildIndex, readJar, parseModsToml, CACHE_FILE };
