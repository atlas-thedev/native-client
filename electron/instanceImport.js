'use strict';
/**
 * Import instances from other launchers, or from an exported pack file.
 *
 * Found on disk (default install folders on Windows, macOS and Linux):
 *   Modrinth App    profiles/<path>, names + versions from app.db: the `instances` + `instance_content_sets`
 *                   tables (app from mid 2026), the `profiles` table before that, profile.json on the very old app.
 *                   The folders move to settings.custom_dir when the user picked another app directory.
 *   CurseForge      minecraft/Instances/<name>/minecraftinstance.json
 *   Prism, PolyMC, MultiMC   instances/<name>/{instance.cfg, mmc-pack.json, .minecraft}
 *   ATLauncher      instances/<name>/instance.json
 *   TLauncher / Minecraft Launcher   .minecraft/versions/<id>/<id>.json, named after the launcher's installations
 *                   (launcher_profiles.json / launcher_profiles_microsoft_store.json) when there are any
 * Files: .mrpack (Modrinth), CurseForge .zip (manifest.json), Prism/MultiMC .zip export, or any instance folder.
 *
 * Importing copies the chosen parts (mods + configs, worlds, resource/shader packs, settings, screenshots)
 * into a new Native instance; the other launcher's files are never changed. The other launcher's game
 * assets, libraries and vanilla jar are linked (or copied) into Native's shared folder too, so the first
 * launch doesn't download them again.
 *
 * IPC: import:scan -> { launchers }, import:instance { source, dir, include } -> instance,
 *      import:pick { kind: 'file'|'folder' } -> path|null, import:file { path, include } -> instance,
 *      events import:progress { key, percent, detail }
 */
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { readTables } = require('./sqliteRead');

let deps = null; // { app, getWin }

const rootDir = () => path.join(deps.app.getPath('userData'), 'minecraft');
const instanceDir = (id) => path.join(rootDir(), 'instances', id);

/* ── where things live ─────────────────────────────────────────── */

function bases(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return { appData, data: appData, home, docs: path.join(home, 'Documents'), mc: path.join(appData, '.minecraft') };
  }
  if (platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    return { appData: support, data: support, home, docs: path.join(home, 'Documents'), mc: path.join(support, 'minecraft') };
  }
  const data = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return { appData: config, data, home, docs: path.join(home, 'Documents'), mc: path.join(home, '.minecraft') };
}

function candidates(b) {
  const flat = (id) => path.join(b.home, '.var', 'app', id, 'data');
  return {
    modrinth: [path.join(b.appData, 'ModrinthApp'), path.join(b.data, 'ModrinthApp'), path.join(b.appData, 'com.modrinth.theseus'), path.join(b.data, 'com.modrinth.theseus')],
    curseforge: [path.join(b.home, 'curseforge', 'minecraft', 'Instances'), path.join(b.docs, 'curseforge', 'minecraft', 'Instances')],
    prism: [path.join(b.appData, 'PrismLauncher'), path.join(b.data, 'PrismLauncher'), path.join(flat('org.prismlauncher.PrismLauncher'), 'PrismLauncher')],
    polymc: [path.join(b.appData, 'PolyMC'), path.join(b.data, 'PolyMC')],
    multimc: [path.join(b.appData, 'MultiMC'), path.join(b.data, 'multimc'), path.join(b.home, 'MultiMC')],
    atlauncher: [path.join(b.appData, 'ATLauncher'), path.join(b.data, 'ATLauncher')],
    minecraft: [b.mc]
  };
}

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const subdirs = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(p, e.name)); } catch { return []; } };
const countIn = (dir, test) => { try { return fs.readdirSync(dir).filter(test).length; } catch { return 0; } };

const LOADER_NAMES = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt', vanilla: 'Vanilla', minecraft: 'Vanilla' };
const loaderName = (value) => LOADER_NAMES[String(value || '').toLowerCase().replace(/[^a-z]/g, '')] || 'Vanilla';

/** A small instance icon as a data URL (skipped when it is missing or big). */
function iconData(file) {
  try {
    if (!file || !exists(file)) return null;
    const st = fs.statSync(file);
    if (st.size > 256 * 1024) return null;
    const ext = path.extname(file).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : null;
    return mime ? `data:${mime};base64,${fs.readFileSync(file).toString('base64')}` : null;
  } catch { return null; }
}

/** What a game folder holds, for the list. */
function summary(gameDir) {
  return {
    mods: countIn(path.join(gameDir, 'mods'), (n) => /\.jar$/i.test(n)),
    worlds: countIn(path.join(gameDir, 'saves'), (n) => !n.startsWith('.')),
    packs: countIn(path.join(gameDir, 'resourcepacks'), (n) => !n.startsWith('.')) + countIn(path.join(gameDir, 'shaderpacks'), (n) => !n.startsWith('.'))
  };
}

/** Version + loader from the last game log, when a launcher stores them somewhere we can't read. */
function fromLog(gameDir) {
  let text = '';
  try { text = fs.readFileSync(path.join(gameDir, 'logs', 'latest.log'), 'utf8').slice(0, 200000); } catch { return null; }
  let m = /Loading Minecraft (\S+) with Fabric Loader (\S+)/.exec(text);
  if (m) return { version: m[1], loader: 'Fabric', loaderVersion: m[2] };
  m = /Loading Minecraft (\S+) with Quilt Loader (\S+)/.exec(text);
  if (m) return { version: m[1], loader: 'Quilt', loaderVersion: m[2] };
  const mc = /--fml\.mcVersion,\s*([\w.-]+)/.exec(text);
  m = /--fml\.neoForgeVersion,\s*([\w.-]+)/.exec(text);
  if (m && mc) return { version: mc[1], loader: 'NeoForge', loaderVersion: m[1] };
  m = /--fml\.forgeVersion,\s*([\w.-]+)/.exec(text);
  if (m && mc) return { version: mc[1], loader: 'Forge', loaderVersion: m[1] };
  return null;
}

/* ── per launcher ──────────────────────────────────────────────── */

/** Instance rows from a Modrinth app.db, in one shape whatever the app version: { path, name, icon_path, ... }. */
function modrinthRows(dbFile) {
  let t;
  try { t = readTables(dbFile, ['instances', 'instance_content_sets', 'profiles', 'settings']); } catch { return { rows: [], customDir: null }; }
  const customDir = t.settings.find((row) => row.custom_dir)?.custom_dir || null;
  if (t.instances.length) {
    const sets = new Map(t.instance_content_sets.map((set) => [set.id, set]));
    const firstSet = new Map();
    for (const set of t.instance_content_sets) if (!firstSet.has(set.instance_id) || set.status === 'active') firstSet.set(set.instance_id, set);
    const rows = t.instances.map((row) => {
      const set = sets.get(row.applied_content_set_id) || firstSet.get(row.id) || {};
      return {
        path: row.path, name: row.name, icon_path: row.icon_path, last_played: row.last_played,
        game_version: set.game_version, mod_loader: set.loader, mod_loader_version: set.loader_version
      };
    });
    return { rows, customDir };
  }
  return { rows: t.profiles, customDir }; // the app before the 2026 instances rework
}

function scanModrinth(dir) {
  const { rows, customDir } = exists(path.join(dir, 'app.db')) ? modrinthRows(path.join(dir, 'app.db')) : { rows: [], customDir: null };
  // "App directory" in Modrinth's settings moves profiles/ and meta/ out of the default folder
  const home = customDir && isDir(path.join(customDir, 'profiles')) ? customDir : dir;
  const profiles = path.join(home, 'profiles');
  if (!isDir(profiles)) return [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const gameDir = path.join(profiles, String(row.path || ''));
    if (!row.path || !row.game_version || !isDir(gameDir) || seen.has(path.resolve(gameDir))) continue;
    seen.add(path.resolve(gameDir));
    const played = Number(row.last_played) || 0;
    out.push({
      name: String(row.name || '').trim() || row.path, gameDir, version: row.game_version, loader: loaderName(row.mod_loader),
      loaderVersion: row.mod_loader_version || null,
      icon: iconData(row.icon_path && path.resolve(home, String(row.icon_path))),
      lastPlayed: played ? played * (played < 1e12 ? 1000 : 1) : null
    });
  }
  for (const gameDir of subdirs(profiles)) {
    if (seen.has(path.resolve(gameDir))) continue;
    const meta = readJson(path.join(gameDir, 'profile.json'))?.metadata; // the old app
    const guess = meta ? { version: meta.game_version, loader: loaderName(meta.loader), loaderVersion: meta.loader_version?.id || null } : fromLog(gameDir);
    if (!guess?.version) continue;
    out.push({ name: meta?.name || path.basename(gameDir), gameDir, ...guess, icon: iconData(meta?.icon), lastPlayed: meta?.last_played ? Date.parse(meta.last_played) || null : null });
  }
  return out;
}

function curseForgeLoader(base) {
  const name = String(base?.name || '');
  const m = /^(forge|fabric|neoforge|quilt)-([^-]+)/i.exec(name);
  if (!m) return { loader: 'Vanilla', loaderVersion: null };
  return { loader: loaderName(m[1]), loaderVersion: m[2] };
}

function scanCurseForge(dir) {
  return subdirs(dir).map((gameDir) => {
    const meta = readJson(path.join(gameDir, 'minecraftinstance.json'));
    if (!meta) return null;
    const version = meta.gameVersion || meta.baseModLoader?.minecraftVersion;
    if (!version) return null;
    return {
      name: meta.name || path.basename(gameDir), gameDir, version, ...curseForgeLoader(meta.baseModLoader),
      icon: iconData(path.join(gameDir, 'instance.png')), lastPlayed: Date.parse(meta.lastPlayed) || null,
      memoryMb: Number(meta.allocatedMemory) || null
    };
  }).filter(Boolean);
}

function cfg(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  } catch { /* missing */ }
  return out;
}

/** One Prism / PolyMC / MultiMC instance folder (instance.cfg + mmc-pack.json). */
function prismInstance(instDir, iconsDir = null) {
  if (!exists(path.join(instDir, 'instance.cfg'))) return null;
  const conf = cfg(path.join(instDir, 'instance.cfg'));
  const pack = readJson(path.join(instDir, 'mmc-pack.json'));
  const parts = Array.isArray(pack?.components) ? pack.components : [];
  const part = (uid) => parts.find((c) => c.uid === uid);
  const version = part('net.minecraft')?.version || conf.IntendedVersion;
  if (!version) return null;
  const loaders = [['net.fabricmc.fabric-loader', 'Fabric'], ['org.quiltmc.quilt-loader', 'Quilt'], ['net.neoforged', 'NeoForge'], ['net.minecraftforge', 'Forge']];
  const found = loaders.find(([uid]) => part(uid));
  const gameDir = [path.join(instDir, '.minecraft'), path.join(instDir, 'minecraft')].find(isDir) || path.join(instDir, '.minecraft');
  const iconKey = conf.iconKey && conf.iconKey !== 'default' ? conf.iconKey : null;
  const icon = iconKey ? [path.join(instDir, `${iconKey}.png`), iconsDir && path.join(iconsDir, `${iconKey}.png`)].filter(Boolean).map(iconData).find(Boolean) || null : null;
  return {
    name: conf.name || path.basename(instDir), gameDir, version,
    loader: found ? found[1] : 'Vanilla', loaderVersion: found ? part(found[0]).version || null : null,
    icon, lastPlayed: Number(conf.lastLaunchTime) || null, memoryMb: conf.OverrideMemory === 'true' ? Number(conf.MaxMemAlloc) || null : null
  };
}

function scanPrism(dir, configName) {
  const conf = cfg(path.join(dir, configName));
  const instancesDir = conf.InstanceDir ? path.resolve(dir, conf.InstanceDir) : path.join(dir, 'instances');
  const iconsDir = conf.IconsDir ? path.resolve(dir, conf.IconsDir) : path.join(dir, 'icons');
  return subdirs(instancesDir).map((d) => prismInstance(d, iconsDir)).filter(Boolean);
}

function scanAtLauncher(dir) {
  return subdirs(path.join(dir, 'instances')).map((gameDir) => {
    const meta = readJson(path.join(gameDir, 'instance.json'));
    if (!meta?.id) return null;
    const lv = meta.launcher?.loaderVersion;
    return {
      name: meta.launcher?.name || path.basename(gameDir), gameDir, version: meta.id,
      loader: lv ? loaderName(lv.type) : 'Vanilla', loaderVersion: lv?.version || null,
      icon: iconData(path.join(gameDir, 'instance.png')), lastPlayed: Date.parse(meta.launcher?.lastPlayed) || null
    };
  }).filter(Boolean);
}

/** Loader of a .minecraft/versions/<id>/<id>.json (TLauncher writes Fabric / Forge / OptiFine versions there). */
function versionLoader(json) {
  const libs = (Array.isArray(json?.libraries) ? json.libraries : []).map((l) => String(l?.name || ''));
  const has = (re) => libs.some((n) => re.test(n)) || re.test(String(json?.mainClass || '')) || re.test(String(json?.id || ''));
  const lib = (re) => (libs.find((n) => re.test(n)) || '').split(':')[2] || null;
  if (has(/net\.fabricmc[.:]fabric-loader/)) return { loader: 'Fabric', loaderVersion: lib(/net\.fabricmc:fabric-loader:/) };
  if (has(/org\.quiltmc[.:]quilt-loader/)) return { loader: 'Quilt', loaderVersion: lib(/org\.quiltmc:quilt-loader:/) };
  if (has(/net\.neoforged/i)) return { loader: 'NeoForge', loaderVersion: lib(/net\.neoforged:(neoforge|forge):/) };
  if (has(/net\.minecraftforge|cpw\.mods|forge/i)) {
    const v = lib(/net\.minecraftforge:(forge|fmlloader):/);
    return { loader: 'Forge', loaderVersion: v ? v.split('-').pop() : null };
  }
  return { loader: 'Vanilla', loaderVersion: null };
}

const VANILLA_ID = /^\d+\.\d+(\.\d+)?(-(pre|rc|snapshot)-?\d+| Pre-Release \d+)?$|^\d\dw\d\d[a-z]$/;
/** Files the official Minecraft Launcher writes next to its profiles (TLauncher doesn't). */
const OFFICIAL_MARKERS = ['launcher_accounts.json', 'launcher_accounts_microsoft_store.json', 'launcher_ui_state.json', 'launcher_product_state.json', 'launcher_msa_credentials.bin'];

/** A launcher installation icon is a data URL, or the name of a block we don't have a picture of. */
const profileIcon = (icon) => (/^data:image\/(png|jpeg|webp|gif);base64,/.test(String(icon || '')) && String(icon).length < 400000 ? String(icon) : null);

function scanMinecraftDir(dir) {
  const profiles = Object.values({
    ...(readJson(path.join(dir, 'launcher_profiles.json'))?.profiles || {}),
    ...(readJson(path.join(dir, 'launcher_profiles_microsoft_store.json'))?.profiles || {})
  }).filter((p) => p && typeof p === 'object');
  const tlauncher = Boolean(readJson(path.join(dir, 'TlauncherProfiles.json'))) || exists(path.join(dir, 'tlauncher-2.0.properties')) || exists(path.join(os.homedir(), '.tlauncher'));
  const official = OFFICIAL_MARKERS.some((name) => exists(path.join(dir, name)));

  // every version folder that holds a version json
  const versions = new Map();
  for (const vdir of subdirs(path.join(dir, 'versions'))) {
    const id = path.basename(vdir);
    const json = readJson(path.join(vdir, `${id}.json`));
    if (!json) continue;
    const plain = !json.inheritsFrom && (['release', 'snapshot', 'old_beta', 'old_alpha'].includes(json.type) || VANILLA_ID.test(json.id || id));
    const version = json.inheritsFrom || (plain ? json.id || id : null);
    if (!version) continue;
    versions.set(id, { id, version, plain, type: json.type, time: Date.parse(json.releaseTime || json.time) || 0, played: Date.parse(json.time) || null, ...versionLoader(json) });
  }
  const newest = (type) => [...versions.values()].filter((v) => v.plain && v.type === type).sort((a, c) => c.time - a.time)[0] || null;

  // the launcher's installations ("Latest release", "My 1.20 world", ...)
  const installs = [];
  const used = new Set();
  for (const p of profiles) {
    const v = p.type === 'latest-release' ? newest('release') : p.type === 'latest-snapshot' ? newest('snapshot') : versions.get(String(p.lastVersionId || ''));
    if (!v) continue;
    const own = p.gameDir && isDir(p.gameDir) ? p.gameDir : null;
    const name = String(p.name || '').trim() || (p.type === 'latest-release' ? 'Latest release' : p.type === 'latest-snapshot' ? 'Latest snapshot' : v.id);
    used.add(v.id);
    installs.push({ name, gameDir: own || dir, version: v.version, loader: v.loader, loaderVersion: v.loaderVersion, shared: !own, icon: profileIcon(p.icon), lastPlayed: Date.parse(p.lastUsed) || v.played });
  }
  const rest = [...versions.values()].filter((v) => !used.has(v.id))
    .map((v) => ({ name: v.id, gameDir: dir, version: v.version, loader: v.loader, loaderVersion: v.loaderVersion, shared: true, icon: null, lastPlayed: v.played }));

  // One .minecraft can hold both launchers: installations go to the Minecraft Launcher, the rest to TLauncher.
  if (tlauncher && official) return { minecraft: installs, tlauncher: rest };
  if (tlauncher) return { tlauncher: [...installs, ...rest] };
  return { minecraft: [...installs, ...rest] };
}

/* ── scan ─────────────────────────────────────────────────────── */

const LAUNCHERS = [
  { id: 'modrinth', name: 'Modrinth App' },
  { id: 'curseforge', name: 'CurseForge' },
  { id: 'prism', name: 'Prism Launcher' },
  { id: 'multimc', name: 'MultiMC' },
  { id: 'polymc', name: 'PolyMC' },
  { id: 'atlauncher', name: 'ATLauncher' },
  { id: 'tlauncher', name: 'TLauncher' },
  { id: 'minecraft', name: 'Minecraft Launcher' }
];

function scan(b = bases()) {
  const where = candidates(b);
  const results = new Map(LAUNCHERS.map((l) => [l.id, { ...l, found: false, dir: null, instances: [] }]));
  const take = (id, dir, list) => {
    const entry = results.get(id);
    entry.found = true;
    entry.dir = entry.dir || dir;
    const known = new Set(entry.instances.map((i) => path.resolve(i.gameDir) + '|' + i.name));
    for (const item of list) if (!known.has(path.resolve(item.gameDir) + '|' + item.name)) entry.instances.push(item);
  };
  for (const dir of where.modrinth) if (isDir(dir)) take('modrinth', dir, scanModrinth(dir));
  for (const dir of where.curseforge) if (isDir(dir)) take('curseforge', dir, scanCurseForge(dir));
  for (const dir of where.prism) if (isDir(dir)) take('prism', dir, scanPrism(dir, 'prismlauncher.cfg'));
  for (const dir of where.polymc) if (isDir(dir)) take('polymc', dir, scanPrism(dir, 'polymc.cfg'));
  for (const dir of where.multimc) if (isDir(dir)) take('multimc', dir, scanPrism(dir, 'multimc.cfg'));
  for (const dir of where.atlauncher) if (isDir(dir)) take('atlauncher', dir, scanAtLauncher(dir));
  for (const dir of where.minecraft) {
    if (!isDir(dir)) continue;
    for (const [id, instances] of Object.entries(scanMinecraftDir(dir))) take(id, dir, instances);
  }
  const list = [...results.values()].map((entry) => ({
    ...entry,
    instances: entry.instances
      .map((i) => ({ ...i, key: `${entry.id}:${i.gameDir}:${i.name}`, ...summary(i.gameDir) }))
      .sort((a, c) => (c.lastPlayed || 0) - (a.lastPlayed || 0) || a.name.localeCompare(c.name))
  }));
  return list; // a launcher that is not installed is still listed (greyed out)
}

/** Works out what kind of instance folder the user picked. */
function detectFolder(dir) {
  if (exists(path.join(dir, 'instance.cfg'))) return { source: 'prism', ...prismInstance(dir) };
  const cf = scanCurseForge(path.dirname(dir)).find((i) => path.resolve(i.gameDir) === path.resolve(dir));
  if (cf) return { source: 'curseforge', ...cf };
  const atl = readJson(path.join(dir, 'instance.json'));
  if (atl?.id && atl.launcher) return { source: 'atlauncher', ...scanAtLauncher(path.dirname(path.dirname(dir))).find((i) => path.resolve(i.gameDir) === path.resolve(dir)) };
  const meta = readJson(path.join(dir, 'profile.json'))?.metadata;
  if (meta?.game_version) return { source: 'modrinth', name: meta.name || path.basename(dir), gameDir: dir, version: meta.game_version, loader: loaderName(meta.loader), loaderVersion: meta.loader_version?.id || null };
  const log = fromLog(dir);
  if (log) return { source: 'folder', name: path.basename(dir), gameDir: dir, ...log };
  if (isDir(path.join(dir, 'versions')) && isDir(path.join(dir, 'mods')) === false && exists(path.join(dir, 'launcher_profiles.json'))) {
    throw new Error('That is a whole .minecraft folder. Pick it from TLauncher / Minecraft Launcher in the list instead.');
  }
  throw new Error('Could not tell which Minecraft version this folder is for. Play it once in its launcher, or import its exported pack file instead.');
}

/* ── copying ──────────────────────────────────────────────────── */

const SKIP = new Set(['logs', 'crash-reports', 'natives', 'versions', 'libraries', 'assets', '.fabric', '.mixin.out', '.cache', 'cache', 'downloads', 'debug', 'webcache', 'webcache2', 'temp', '.tmp', 'launcher_profiles.json', 'usercache.json', 'usernamecache.json', 'instance.cfg', 'mmc-pack.json', 'minecraftinstance.json', 'profile.json', 'instance.json']);
const GROUPS = {
  worlds: ['saves'],
  packs: ['resourcepacks', 'shaderpacks', 'texturepacks'],
  settings: ['options.txt', 'optionsof.txt', 'optionsshaders.txt', 'servers.dat', 'servers.dat_old'],
  screenshots: ['screenshots']
};
/** What a shared .minecraft brings: only well-known content, never the launcher's own files. */
const SHARED_MODS = ['mods', 'config'];

function groupOf(name) {
  for (const [group, names] of Object.entries(GROUPS)) if (names.includes(name)) return group;
  return 'mods'; // mods, config and everything mods keep next to them (kubejs, defaultconfigs, ...)
}

/** Top-level entries of a game folder to copy for the chosen groups. */
function plan(gameDir, include, shared) {
  const want = { mods: true, worlds: true, packs: true, settings: true, screenshots: false, ...(include || {}) };
  let names = [];
  try { names = fs.readdirSync(gameDir); } catch { return []; }
  return names.filter((name) => {
    if (SKIP.has(name) || name.startsWith('.')) return false;
    const group = groupOf(name);
    if (shared && group === 'mods' && !SHARED_MODS.includes(name)) return false;
    return Boolean(want[group]);
  });
}

async function listFiles(dir, out = []) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await listFiles(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

async function copyInto(gameDir, target, names, onProgress) {
  const files = [];
  for (const name of names) {
    const full = path.join(gameDir, name);
    const st = await fsp.stat(full).catch(() => null);
    if (!st) continue;
    if (st.isDirectory()) await listFiles(full, files);
    else files.push(full);
  }
  const sizes = await Promise.all(files.map((f) => fsp.stat(f).then((s) => s.size).catch(() => 0)));
  const total = sizes.reduce((a, c) => a + c, 0) || 1;
  let done = 0, last = 0;
  for (let i = 0; i < files.length; i += 1) {
    const rel = path.relative(gameDir, files[i]);
    const dest = path.join(target, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(files[i], dest);
    done += sizes[i];
    const now = Date.now();
    if (now - last > 120 || i === files.length - 1) {
      last = now;
      onProgress(done / total, files.length);
    }
  }
  return { files: files.length, bytes: done };
}

/* ── shared game files ─────────────────────────────────────────── */

/**
 * Folders holding another launcher's shared game files (assets/, libraries/, versions/), found by walking up
 * from the instance: Prism / MultiMC / ATLauncher / .minecraft keep them at the root, the Modrinth App under
 * meta/, CurseForge under Install/. The default .minecraft is added too, since every vanilla install fills it.
 */
function sharedStores(gameDir, b = bases()) {
  const roots = [];
  const add = (dir) => {
    if (!dir || !isDir(path.join(dir, 'assets', 'objects'))) return;
    const resolved = path.resolve(dir);
    const own = deps ? path.resolve(rootDir()) : null;
    if (resolved !== own && !roots.includes(resolved)) roots.push(resolved);
  };
  let dir = path.resolve(gameDir);
  for (let up = 0; up < 5; up += 1) {
    add(dir);
    add(path.join(dir, 'meta'));
    add(path.join(dir, 'Install'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  add(b.mc);
  return roots;
}

async function walkFiles(dir, visit, depth = 0) {
  if (depth > 24) return;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkFiles(full, visit, depth + 1);
    else if (e.isFile()) await visit(full, e.name);
  }
}

/** Any one asset object in a store (to test whether it can be hard-linked). */
function firstObject(objects) {
  for (const sub of subdirs(objects)) {
    try {
      const name = fs.readdirSync(sub).find((n) => /^[0-9a-f]{40}$/.test(n));
      if (name) return path.join(sub, name);
    } catch { /* unreadable */ }
  }
  return null;
}

/** The version json another launcher keeps for a game version (Mojang's format), if it has one. */
function storeVersionJson(store, version) {
  return [
    path.join(store, 'versions', version, `${version}.json`),
    path.join(path.dirname(store), 'meta', 'net.minecraft', `${version}.json`), // Prism / MultiMC meta cache
    path.join(store, 'meta', 'net.minecraft', `${version}.json`)
  ].map(readJson).find((json) => json && (json.assetIndex || json.libraries)) || null;
}

/** Can a hard link be made from `src`'s drive into Native's folder? */
async function canLink(src, dir) {
  const probe = path.join(dir, `.link-probe-${process.pid}-${Date.now()}`);
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.link(src, probe);
    return true;
  } catch { return false; } finally { await fsp.rm(probe, { force: true }).catch(() => {}); }
}

/**
 * Brings the other launcher's game assets, libraries and vanilla jar into Native's shared folder, so the
 * first launch doesn't download them again. Only files Native doesn't have yet; nothing is ever replaced.
 * On the same drive everything is hard-linked (no extra space). Across drives only what this version
 * needs is copied. Asset objects are named by their hash and checked again before launch; libraries and
 * jars only come from the exact path every launcher uses for them. Returns how many files were added.
 */
async function reuseSharedFiles(stores, version, onProgress = () => {}) {
  const target = rootDir();
  let added = 0;
  const place = async (src, dest, link) => {
    try { await fsp.access(dest); return; } catch { /* not there yet */ }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (link) {
      try { await fsp.link(src, dest); added += 1; return; } catch (error) { if (error?.code === 'EEXIST') return; }
    }
    const tmp = `${dest}.${process.pid}.import`;
    try {
      await fsp.copyFile(src, tmp, fs.constants.COPYFILE_FICLONE);
      await fsp.rename(tmp, dest);
      added += 1;
    } catch { await fsp.rm(tmp, { force: true }).catch(() => {}); }
  };
  const queue = [];
  const flush = async () => { await Promise.all(queue.splice(0)); };
  const push = async (job) => { queue.push(job); if (queue.length >= 32) await flush(); };

  for (let i = 0; i < stores.length; i += 1) {
    const store = stores[i];
    const step = (f, detail) => onProgress((i + f) / stores.length, detail);
    const objects = path.join(store, 'assets', 'objects');
    const libs = path.join(store, 'libraries');
    const sample = firstObject(objects);
    if (!sample) continue;
    const link = await canLink(sample, path.join(target, 'assets'));
    const json = version ? storeVersionJson(store, version) : null;

    // assets: all of them when linking, only this version's index when copying
    let wanted = null;
    if (!link) {
      const index = json && readJson(path.join(store, 'assets', 'indexes', `${json.assetIndex?.id || json.assets}.json`));
      if (!index?.objects) continue; // can't tell what this version needs; the launch downloads it
      wanted = new Set(Object.values(index.objects).map((o) => o?.hash).filter(Boolean));
    }
    step(0, 'Reusing game assets…');
    await walkFiles(objects, (file, name) => {
      if (!/^[0-9a-f]{40}$/.test(name) || (wanted && !wanted.has(name))) return null;
      return push(place(file, path.join(target, 'assets', 'objects', name.slice(0, 2), name), link));
    });
    await flush();

    step(0.6, 'Reusing game libraries…');
    if (link) {
      await walkFiles(libs, (file, name) => (/\.jar$/i.test(name) ? push(place(file, path.join(target, 'libraries', path.relative(libs, file)), true)) : null));
    } else {
      for (const lib of Array.isArray(json?.libraries) ? json.libraries : []) {
        const rel = lib?.downloads?.artifact?.path;
        if (rel && !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes('..') && exists(path.join(libs, rel))) await push(place(path.join(libs, rel), path.join(target, 'libraries', rel), false));
      }
    }
    await flush();

    if (version && VANILLA_ID.test(version)) {
      const jar = [path.join(store, 'versions', version, `${version}.jar`), path.join(libs, 'com', 'mojang', 'minecraft', version, `minecraft-${version}-client.jar`)].find(exists);
      if (jar) await place(jar, path.join(target, 'versions', version, `${version}.jar`), link);
    }
  }
  onProgress(1, 'Game files ready');
  return added;
}

function emit(key, percent, detail, extra = {}) {
  const win = deps?.getWin?.();
  if (win && !win.isDestroyed()) win.webContents.send('import:progress', { key, percent, detail, ...extra });
}

const SOURCE_COLORS = { modrinth: '#1bd96a', curseforge: '#f16436', prism: '#df6277', multimc: '#d8a12e', polymc: '#8f5bd6', atlauncher: '#89c236', tlauncher: '#2d8cf0', minecraft: '#62b47a', folder: '#71717a' };

/** Copies a found / picked instance into a new Native instance and returns its record. */
async function importInstance({ source, gameDir, name, version, loader, loaderVersion = null, icon = null, memoryMb = null, shared = false, include = null, key = null }) {
  if (!gameDir || !isDir(gameDir)) throw new Error('That instance folder is gone.');
  if (!version) throw new Error('Unknown Minecraft version.');
  const id = crypto.randomUUID();
  const dir = instanceDir(id);
  const tag = key || id;
  fs.mkdirSync(dir, { recursive: true });
  try {
    emit(tag, 0, 'Looking at the files…');
    const names = plan(gameDir, include, shared);
    const result = await copyInto(gameDir, dir, names, (f, n) => emit(tag, Math.round(f * 80), `Copying ${n} files…`));
    let reused = 0;
    try {
      reused = await reuseSharedFiles(sharedStores(gameDir), version, (f, detail) => emit(tag, 80 + Math.round(f * 16), detail));
    } catch { /* the launch downloads whatever is still missing */ }
    for (const folder of ['mods', 'resourcepacks', 'shaderpacks']) {
      try {
        await require('./modMetadata').enrichFolder(path.join(dir, folder));
      } catch { /* titles and icons are cosmetic; the instance page fills them in later */ }
    }
    emit(tag, 100, 'Imported', { done: true });
    const launcher = LAUNCHERS.find((l) => l.id === source)?.name || 'another launcher';
    return {
      id,
      name: String(name || 'Imported instance').slice(0, 60),
      version,
      loader: loaderName(loader),
      loaderVersion,
      icon,
      ...(memoryMb ? { memoryMb } : {}),
      color: SOURCE_COLORS[source] || SOURCE_COLORS.folder,
      created: Date.now(),
      lastPlayed: null,
      description: `Imported from ${launcher}`,
      imported: { from: source, files: result.files, bytes: result.bytes, reused }
    };
  } catch (error) {
    emit(tag, 100, 'Failed', { error: true });
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Imports a pack file: .mrpack, a CurseForge zip, or a Prism / MultiMC export. */
async function importFile({ path: file, include = null }) {
  const tag = `file:${file}`;
  const progress = (percent, detail, extra) => emit(tag, percent, detail, extra);
  if (isDir(file)) {
    const found = detectFolder(file);
    return importInstance({ ...found, include, key: tag });
  }
  let zip;
  try { zip = new AdmZip(file); } catch { throw new Error('That file is not a modpack (.mrpack or .zip).'); }
  const modpacks = require('./modpacks');
  const base = path.basename(file).replace(/\.(mrpack|zip)$/i, '');
  if (zip.getEntry('modrinth.index.json')) return modpacks.installMrpackZip(zip, { emit: progress, name: null });
  if (zip.getEntry('manifest.json')) return modpacks.installCurseForgeZip(zip, { emit: progress, name: null });
  // Prism / MultiMC export: instance.cfg at the root or inside one folder
  const cfgEntry = zip.getEntries().find((e) => !e.isDirectory && /(^|\/)instance\.cfg$/.test(e.entryName) && e.entryName.split('/').length <= 2);
  if (cfgEntry) {
    const tmp = path.join(rootDir(), '.downloads', `import-${crypto.randomUUID()}`);
    fs.mkdirSync(tmp, { recursive: true });
    try {
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        const target = path.resolve(tmp, entry.entryName);
        if (!target.startsWith(path.resolve(tmp) + path.sep)) continue; // zip-slip
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, entry.getData());
      }
      const instDir = path.dirname(path.join(tmp, cfgEntry.entryName));
      const found = prismInstance(instDir);
      if (!found) throw new Error('This export has no Minecraft version in it.');
      return await importInstance({ source: 'prism', ...found, name: found.name || base, include, key: tag });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  throw new Error('That zip is not a modpack Native knows (.mrpack, CurseForge or Prism / MultiMC export).');
}

function init(dependencies, ipcMain) {
  deps = dependencies;
  ipcMain.handle('import:scan', () => scan());
  ipcMain.handle('import:instance', (_e, payload) => importInstance(payload || {}));
  ipcMain.handle('import:file', (_e, payload) => importFile(payload || {}));
  ipcMain.handle('import:pick', async (event, { kind = 'file' } = {}) => {
    const { dialog, BrowserWindow } = require('electron');
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), kind === 'folder'
      ? { title: 'Pick an instance folder', properties: ['openDirectory'] }
      : { title: 'Import a modpack', properties: ['openFile'], filters: [{ name: 'Modpacks', extensions: ['mrpack', 'zip'] }] });
    return result.canceled ? null : result.filePaths[0] || null;
  });
}

module.exports = { init, scan, bases, candidates, detectFolder, importInstance, importFile, plan, versionLoader, curseForgeLoader, prismInstance, fromLog, sharedStores, reuseSharedFiles, _internals: { scanModrinth, modrinthRows, scanCurseForge, scanPrism, scanAtLauncher, scanMinecraftDir } };
