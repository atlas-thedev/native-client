const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { shell } = require('electron');
const { analyzeCrash, reportToText } = require('./crashAnalyzer');
const { buildIndex } = require('./modIndex');
const { downloadFile, writeFileAtomic } = require('./download');

/**
 * Crash reporter (main process).
 *
 * The launcher opens a session when the game starts and feeds it the game's
 * output. When the process ends abnormally, or leaves a crash report or JVM
 * error file behind, the session gathers every artefact, indexes the mods
 * folder and runs the analyser. The result is saved under
 * userData/crash-reports and pushed to the renderer, which shows it with
 * one-click fixes applied here.
 */

const MAX_LOG_CHARS = 1_500_000;
const MAX_REPORTS = 30;
const MODRINTH = 'https://api.modrinth.com/v2';
const HEADERS = { 'User-Agent': 'NativeClient (https://github.com/atlas-thedev/native-client)' };

let deps = null;
let session = null;

const userData = () => deps.app.getPath('userData');
const reportsDir = () => path.join(userData(), 'crash-reports');
const rootDir = () => path.join(userData(), 'minecraft');
const instanceDir = (id) => resolveInside(path.join(rootDir(), 'instances'), String(id || ''));

function resolveInside(base, ...parts) {
  const root = path.resolve(base);
  const target = path.resolve(root, ...parts.map((p) => String(p || '')));
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Path escapes its folder');
  return target;
}

function send(channel, payload) {
  const win = deps?.getWin?.();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function pickInstance(instance = {}) {
  return {
    id: instance.id || null,
    name: instance.name || instance.version || 'Minecraft',
    version: instance.version || instance.mc_version || '',
    loader: instance.loader || instance.mc_loader || 'Vanilla',
    loaderVersion: instance.loaderVersion || instance.mc_loader_version || null,
    overrides: {
      java: instance.overrides?.java?.enabled ? { enabled: true } : undefined,
      jvmArgs: instance.overrides?.jvmEnabled !== false && instance.overrides?.jvmArgs ? String(instance.overrides.jvmArgs) : undefined
    }
  };
}

/* --------------------------------------------------------------- session */

function beginSession({ instance, memoryMaxGb, javaPath }) {
  const picked = pickInstance(instance);
  session = {
    instance: picked,
    gameDir: picked.id ? instanceDir(picked.id) : rootDir(),
    startedAt: Date.now(),
    memoryMaxGb: Number(memoryMaxGb) || null,
    javaPath: javaPath || null,
    chunks: [],
    size: 0,
    killed: false
  };
}

function capture(data) {
  if (!session) return;
  const text = String(data);
  session.chunks.push(text);
  session.size += text.length;
  while (session.size > MAX_LOG_CHARS && session.chunks.length > 1) session.size -= session.chunks.shift().length;
}

function markKilled() {
  if (session) session.killed = true;
}

function newestFile(dir, pattern, since) {
  try {
    let best = null;
    for (const name of fs.readdirSync(dir)) {
      if (!pattern.test(name)) continue;
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.mtimeMs < since) continue;
      if (!best || stat.mtimeMs > best.mtime) best = { path: full, mtime: stat.mtimeMs };
    }
    return best?.path || null;
  } catch {
    return null;
  }
}

function readTail(file, maxBytes = 600_000) {
  try {
    const stat = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    fs.closeSync(fd);
    return buffer.toString('utf8');
  } catch {
    return '';
  }
}

/** Mod index built in a worker so big packs never freeze the launcher window. */
function indexMods(dir) {
  if (!fs.existsSync(dir)) return Promise.resolve([]);
  return new Promise((resolve) => {
    let settled = false;
    const done = (mods) => {
      if (settled) return;
      settled = true;
      resolve(mods);
    };
    const fallback = () => {
      try {
        done(buildIndex(dir));
      } catch {
        done([]);
      }
    };
    let worker;
    try {
      worker = new Worker(path.join(__dirname, 'modIndexWorker.js'), { workerData: { dir } });
    } catch {
      fallback();
      return;
    }
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      fallback();
    }, 30_000);
    worker.once('message', (msg) => {
      clearTimeout(timer);
      if (msg?.ok) done(msg.mods);
      else fallback();
    });
    worker.once('error', () => {
      clearTimeout(timer);
      fallback();
    });
  });
}

async function runAnalysis({ instance, gameDir, log, since, exitCode, signal, memoryMaxGb, javaPath, manual = false }) {
  const crashFile = newestFile(path.join(gameDir, 'crash-reports'), /\.txt$/i, since);
  const hsErrFile = newestFile(gameDir, /^hs_err_pid\d+\.log$/i, since) || newestFile(rootDir(), /^hs_err_pid\d+\.log$/i, since);
  const latestLog = path.join(gameDir, 'logs', 'latest.log');
  let logText = log || '';
  let logFile = null;
  try {
    if (fs.statSync(latestLog).mtimeMs >= since && logText.length < 20_000) {
      const tail = readTail(latestLog);
      logText = logText ? `${tail}\n${logText}` : tail;
      logFile = latestLog;
    }
  } catch {
    /* no latest.log */
  }

  const crashReport = crashFile ? readTail(crashFile, 400_000) : '';
  const hsErr = hsErrFile ? readTail(hsErrFile, 300_000) : '';
  const mods = String(instance.loader).toLowerCase() === 'vanilla' ? [] : await indexMods(path.join(gameDir, 'mods'));

  const report = analyzeCrash({
    log: logText,
    crashReport,
    crashReportFile: crashFile ? path.basename(crashFile) : null,
    hsErr,
    hsErrFile: hsErrFile ? path.basename(hsErrFile) : null,
    exitCode,
    instance,
    mods,
    memoryMaxGb,
    totalMemGb: os.totalmem() / 1024 ** 3,
    platform: process.platform
  });

  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const record = {
    id,
    at: Date.now(),
    manual,
    instance: { id: instance.id, name: instance.name, version: instance.version, loader: instance.loader, loaderVersion: instance.loaderVersion },
    exitCode: exitCode ?? null,
    signal: signal || null,
    javaPath: javaPath || null,
    files: { crashReport: crashFile, hsErr: hsErrFile, log: logFile },
    applied: [],
    shareUrl: null,
    report
  };

  fs.mkdirSync(reportsDir(), { recursive: true });
  const fullLog = [
    crashReport && `==== ${path.basename(crashFile)} ====\n${crashReport}`,
    hsErr && `==== ${path.basename(hsErrFile)} ====\n${hsErr}`,
    logText && `==== Game output ====\n${logText}`
  ].filter(Boolean).join('\n\n');
  fs.writeFileSync(path.join(reportsDir(), `${id}.log`), fullLog);
  writeFileAtomic(path.join(reportsDir(), `${id}.json`), JSON.stringify(record));
  prune();
  return record;
}

async function endSession(code, signal) {
  const current = session;
  session = null;
  if (!current || current.killed) return null;
  const since = current.startedAt - 5000;
  const crashFile = newestFile(path.join(current.gameDir, 'crash-reports'), /\.txt$/i, since);
  const hsErr = newestFile(current.gameDir, /^hs_err_pid\d+\.log$/i, since) || newestFile(rootDir(), /^hs_err_pid\d+\.log$/i, since);
  const abnormal = (code !== 0 && code !== null) || (code === null && signal && !['SIGTERM', 'SIGINT'].includes(signal));
  if (!abnormal && !crashFile && !hsErr) return null;

  send('crash:analyzing', { instance: current.instance, at: Date.now() });
  try {
    const record = await runAnalysis({
      instance: current.instance,
      gameDir: current.gameDir,
      log: current.chunks.join(''),
      since,
      exitCode: code,
      signal,
      memoryMaxGb: current.memoryMaxGb,
      javaPath: current.javaPath
    });
    send('crash:detected', record);
    return record;
  } catch (error) {
    send('crash:detected', { id: null, error: error?.message || String(error), instance: current.instance, at: Date.now() });
    return null;
  }
}

/* --------------------------------------------------------------- storage */

function recordPath(id) {
  if (!/^[\w-]+$/.test(String(id || ''))) throw new Error('Invalid report id');
  return path.join(reportsDir(), `${id}.json`);
}

function readRecord(id) {
  return JSON.parse(fs.readFileSync(recordPath(id), 'utf8'));
}

function saveRecord(record) {
  writeFileAtomic(recordPath(record.id), JSON.stringify(record));
}

function listRecords() {
  try {
    return fs.readdirSync(reportsDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        try {
          const record = JSON.parse(fs.readFileSync(path.join(reportsDir(), name), 'utf8'));
          return {
            id: record.id,
            at: record.at,
            manual: Boolean(record.manual),
            instance: record.instance,
            exitCode: record.exitCode,
            headline: record.report?.headline,
            category: record.report?.category,
            confidence: record.report?.confidence
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

function prune() {
  const all = listRecords();
  for (const item of all.slice(MAX_REPORTS)) {
    for (const ext of ['.json', '.log']) fs.rmSync(path.join(reportsDir(), `${item.id}${ext}`), { force: true });
  }
}

/* ------------------------------------------------------------------ fixes */

function modsDir(instanceId) {
  return resolveInside(instanceDir(instanceId), 'mods');
}

function manifestFile(instanceId) {
  return path.join(modsDir(instanceId), '.native-mods.json');
}

function readManifest(instanceId) {
  try {
    return JSON.parse(fs.readFileSync(manifestFile(instanceId), 'utf8'));
  } catch {
    return {};
  }
}

function writeManifest(instanceId, manifest) {
  fs.mkdirSync(modsDir(instanceId), { recursive: true });
  writeFileAtomic(manifestFile(instanceId), JSON.stringify(manifest, null, 2));
}

/** Points manifest entries at a renamed / replaced file. */
function remapManifest(instanceId, from, to, patch = {}) {
  const manifest = readManifest(instanceId);
  let changed = false;
  for (const [key, raw] of Object.entries(manifest)) {
    const entry = typeof raw === 'string' ? { filename: raw, folder: 'mods' } : raw;
    if ((entry.folder || 'mods') !== 'mods' || entry.filename !== from) continue;
    manifest[key] = { ...entry, filename: to, ...patch, metadata: { ...(entry.metadata || {}), ...(patch.metadata || {}) } };
    changed = true;
  }
  if (changed) writeManifest(instanceId, manifest);
}

function safeModFile(instanceId, file) {
  if (!file || path.basename(file) !== file) throw new Error('Invalid mod file');
  return resolveInside(modsDir(instanceId), file);
}

function modrinthLoaders(loader) {
  const kind = String(loader || '').toLowerCase();
  if (kind === 'quilt') return ['quilt', 'fabric'];
  if (kind === 'neoforge') return ['neoforge'];
  if (kind === 'forge') return ['forge'];
  return ['fabric'];
}

async function modrinth(url, options = {}) {
  const response = await fetch(`${MODRINTH}${url}`, { ...options, headers: { ...HEADERS, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Modrinth request failed (HTTP ${response.status})`);
  return response.json();
}

function sha1(file) {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

function primaryFile(version) {
  return version?.files?.find((file) => file.primary) || version?.files?.[0] || null;
}

function sendModProgress(payload) {
  send('mods:progress', { folder: 'mods', ...payload });
}

async function downloadVersion(instanceId, version, project) {
  const file = primaryFile(version);
  if (!file) throw new Error('That version has no downloadable file');
  const target = safeModFile(instanceId, path.basename(file.filename));
  const projectId = project?.id || version.project_id;
  const title = project?.title || file.filename;
  sendModProgress({ projectId, percent: 1, title, iconUrl: project?.icon_url || null, detail: `Downloading ${title}\u2026` });
  try {
    await downloadFile(file.url, target, {
      retries: 3,
      onProgress: ({ percent }) => sendModProgress({ projectId, percent: percent == null ? null : Math.max(1, Math.min(99, Math.round(percent))), title, iconUrl: project?.icon_url || null, detail: `Downloading ${title}\u2026` })
    });
  } catch (error) {
    sendModProgress({ projectId, percent: 100, title, detail: 'Failed', error: true });
    throw error;
  }
  sendModProgress({ projectId, percent: 100, title, detail: 'Installed' });
  return { filename: path.basename(file.filename), target };
}

async function installFromModrinth(record, slug, depth = 0) {
  const instance = record.instance;
  const loaders = modrinthLoaders(instance.loader);
  let project = await modrinth(`/project/${encodeURIComponent(slug)}`);
  if (!project) {
    const facets = encodeURIComponent(JSON.stringify([['project_type:mod'], [`versions:${instance.version}`], loaders.map((l) => `categories:${l}`)]));
    const search = await modrinth(`/search?query=${encodeURIComponent(slug)}&limit=1&facets=${facets}`);
    const hit = search?.hits?.[0];
    if (hit) project = await modrinth(`/project/${hit.project_id}`);
  }
  if (!project) throw new Error(`Could not find "${slug}" on Modrinth`);
  const versions = await modrinth(`/project/${project.id}/version?loaders=${encodeURIComponent(JSON.stringify(loaders))}&game_versions=${encodeURIComponent(JSON.stringify([instance.version]))}`);
  const version = (versions || []).find((v) => v.version_type === 'release') || (versions || [])[0];
  if (!version) throw new Error(`${project.title} has no ${instance.loader} build for Minecraft ${instance.version}`);

  const manifest = readManifest(instance.id);
  if (manifest[project.id] && fs.existsSync(safeModFile(instance.id, String(manifest[project.id].filename || '').replace(/\.disabled$/, '')))) {
    return `${project.title} is already installed`;
  }
  const { filename } = await downloadVersion(instance.id, version, project);
  const next = readManifest(instance.id);
  next[project.id] = {
    filename,
    folder: 'mods',
    metadata: {
      title: project.title, description: project.description || '', iconUrl: project.icon_url || '', author: '',
      source: 'modrinth', version: version.version_number || '', gameVersions: version.game_versions || [], loaders: version.loaders || []
    }
  };
  writeManifest(instance.id, next);

  // Its own required dependencies, one level deep.
  const extra = [];
  if (depth === 0) {
    for (const dep of version.dependencies || []) {
      if (dep.dependency_type !== 'required' || !dep.project_id || next[dep.project_id]) continue;
      try {
        await installFromModrinth(record, dep.project_id, 1);
        extra.push(dep.project_id);
      } catch {
        /* best effort */
      }
    }
  }
  return `Installed ${project.title} ${version.version_number}${extra.length ? ` and ${extra.length} dependenc${extra.length === 1 ? 'y' : 'ies'}` : ''}`;
}

async function updateFromModrinth(record, fix) {
  const instance = record.instance;
  const current = safeModFile(instance.id, fix.file);
  if (!fs.existsSync(current)) throw new Error(`${fix.file} is no longer in the mods folder`);
  const hash = sha1(current);
  const latest = await modrinth(`/version_file/${hash}/update?algorithm=sha1`, {
    method: 'POST',
    body: JSON.stringify({ loaders: modrinthLoaders(instance.loader), game_versions: [instance.version] })
  });
  if (!latest) {
    return { ok: false, message: `${fix.name} is not on Modrinth or has no build for Minecraft ${instance.version}. Disable it or update it by hand.` };
  }
  const file = primaryFile(latest);
  if (file?.hashes?.sha1 === hash) {
    return { ok: false, message: `You already have the newest ${fix.name} for ${instance.version}. Try disabling it instead.`, alreadyLatest: true };
  }
  const project = await modrinth(`/project/${latest.project_id}`).catch(() => null);
  const { filename } = await downloadVersion(instance.id, latest, project);
  if (filename !== fix.file) fs.rmSync(current, { force: true });
  remapManifest(instance.id, fix.file, filename, { metadata: { version: latest.version_number || '' } });
  return { ok: true, message: `Updated ${fix.name} to ${latest.version_number}` };
}

function backupFile(instanceId, relative) {
  const base = instanceDir(instanceId);
  const source = resolveInside(base, relative);
  if (!fs.existsSync(source)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = resolveInside(base, '.native-backup', stamp, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return target;
}

function setProperty(file, key, value, separator = '=') {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    /* new file */
  }
  const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*${separator.trim() === ':' ? ':' : '='}.*$`, 'm');
  const line = separator === ' = ' ? `${key} = ${value}` : `${key}${separator}${value}`;
  text = re.test(text) ? text.replace(re, line) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

async function applyFix(id, fix) {
  const record = readRecord(id);
  const instance = record.instance;
  if (!fix || typeof fix !== 'object') throw new Error('Unknown fix');
  let result = { ok: true, message: 'Done' };

  switch (fix.kind) {
    case 'disable-mod': {
      const source = safeModFile(instance.id, fix.file);
      if (!fs.existsSync(source)) {
        result = { ok: true, message: `${fix.name} is already gone` };
        break;
      }
      const target = `${source}.disabled`;
      fs.rmSync(target, { force: true });
      fs.renameSync(source, target);
      remapManifest(instance.id, fix.file, `${fix.file}.disabled`, { enabled: false });
      result = { ok: true, message: `Disabled ${fix.name}. Re-enable it any time from the Mods tab.` };
      break;
    }
    case 'install-mod':
      result = { ok: true, message: await installFromModrinth(record, fix.slug) };
      break;
    case 'update-mod':
      result = await updateFromModrinth(record, fix);
      break;
    case 'reset-config': {
      const rel = String(fix.path || '').replace(/\\/g, '/');
      if (!/^(?:config|defaultconfigs)\//.test(rel)) throw new Error('Only files inside config/ can be reset');
      const backup = backupFile(instance.id, rel);
      fs.rmSync(resolveInside(instanceDir(instance.id), rel), { force: true });
      result = { ok: true, message: `Reset ${path.basename(rel)}${backup ? ' (backup kept in .native-backup)' : ''}` };
      break;
    }
    case 'repair': {
      const removed = [];
      for (const item of fix.paths || []) {
        if (item === 'natives') {
          fs.rmSync(path.join(rootDir(), 'natives'), { recursive: true, force: true });
          removed.push('native libraries');
        } else if (item === 'versions') {
          const dir = resolveInside(path.join(rootDir(), 'versions'), instance.version);
          fs.rmSync(path.join(dir, `${instance.version}.jar`), { force: true });
          removed.push(`Minecraft ${instance.version}`);
        } else if (/^(?:libraries|versions)\//.test(item)) {
          fs.rmSync(resolveInside(rootDir(), item), { force: true });
          removed.push(path.basename(item));
        }
      }
      result = { ok: true, message: removed.length ? `Removed ${removed.join(', ')}. They download again on the next launch.` : 'Files are verified again on the next launch.' };
      break;
    }
    case 'disable-shaders': {
      const cfg = resolveInside(instanceDir(instance.id), 'config');
      let touched = 0;
      for (const name of ['iris.properties', 'oculus.properties']) {
        const file = path.join(cfg, name);
        if (fs.existsSync(file) || name === 'iris.properties') {
          setProperty(file, 'enableShaders', 'false');
          touched += 1;
        }
      }
      const optifine = resolveInside(instanceDir(instance.id), 'optionsshaders.txt');
      if (fs.existsSync(optifine)) {
        setProperty(optifine, 'shaderPack', 'OFF');
        touched += 1;
      }
      result = { ok: true, message: touched ? 'Shaders are off. Turn them back on in Video Settings > Shader Packs.' : 'No shader settings found' };
      break;
    }
    case 'reset-resourcepacks': {
      const options = resolveInside(instanceDir(instance.id), 'options.txt');
      if (!fs.existsSync(options)) {
        result = { ok: true, message: 'No resource packs are active' };
        break;
      }
      backupFile(instance.id, 'options.txt');
      setProperty(options, 'resourcePacks', '["vanilla"]', ':');
      setProperty(options, 'incompatibleResourcePacks', '[]', ':');
      result = { ok: true, message: 'Resource packs are off. Your pack files were not touched.' };
      break;
    }
    case 'forge-early-window': {
      const file = resolveInside(instanceDir(instance.id), 'config', 'fml.toml');
      setProperty(file, 'earlyWindowControl', 'false', ' = ');
      result = { ok: true, message: 'The early loading screen is off' };
      break;
    }
    case 'java': {
      const major = Number(fix.major);
      if (!Number.isInteger(major) || major < 8 || major > 30) throw new Error('Invalid Java version');
      const javaMod = require('./java');
      const binary = await javaMod.runtimeFor(major, ({ percent } = {}) => send('java:progress', { major, percent }));
      result = { ok: true, message: `Java ${major} is ready for this instance`, instancePatch: { java: { enabled: true, path: binary } } };
      break;
    }
    case 'open-url': {
      const url = new URL(String(fix.url));
      if (url.protocol !== 'https:') throw new Error('Only https links can be opened');
      await shell.openExternal(url.toString());
      result = { ok: true, message: 'Opened in your browser', silent: true };
      break;
    }
    case 'open-folder': {
      const dir = resolveInside(instanceDir(instance.id), String(fix.sub || ''));
      await shell.openPath(fs.existsSync(dir) ? dir : instanceDir(instance.id));
      result = { ok: true, message: 'Opened the folder', silent: true };
      break;
    }
    default:
      throw new Error(`Native cannot apply "${fix.kind}" here`);
  }

  if (result.ok && !result.silent) {
    const fresh = readRecord(id);
    fresh.applied = [...new Set([...(fresh.applied || []), fix.id])];
    saveRecord(fresh);
  }
  return result;
}

/* ------------------------------------------------------------------ share */

async function share(id) {
  const record = readRecord(id);
  if (record.shareUrl) return { ok: true, url: record.shareUrl };
  let text = '';
  try {
    text = fs.readFileSync(path.join(reportsDir(), `${id}.log`), 'utf8');
  } catch {
    text = '';
  }
  const header = reportToText(record.report, { ...record.instance, instanceName: record.instance?.name, at: record.at });
  // mclo.gs keeps 25k lines / 10 MB; keep the head (crash report) and the tail.
  let lines = `${header}\n\n${text}`.split('\n');
  if (lines.length > 24000) lines = [...lines.slice(0, 4000), '... (trimmed by Native) ...', ...lines.slice(-19000)];
  const body = new URLSearchParams({ content: lines.join('\n').slice(0, 9_000_000) });
  const response = await fetch('https://api.mclo.gs/1/log', { method: 'POST', body, headers: HEADERS });
  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.success) throw new Error(json?.error || `Upload failed (HTTP ${response.status})`);
  record.shareUrl = json.url;
  saveRecord(record);
  return { ok: true, url: json.url };
}

/* -------------------------------------------------------------------- ipc */

function init(dependencies, ipcMain) {
  deps = dependencies;

  ipcMain.handle('crash:list', (_e, instanceId) => {
    const all = listRecords();
    return instanceId ? all.filter((item) => item.instance?.id === instanceId) : all;
  });
  ipcMain.handle('crash:get', (_e, id) => readRecord(id));
  ipcMain.handle('crash:log', (_e, id) => {
    recordPath(id);
    return readTail(path.join(reportsDir(), `${id}.log`), 2_000_000);
  });
  ipcMain.handle('crash:applyFix', (_e, id, fix) => applyFix(id, fix));
  ipcMain.handle('crash:share', (_e, id) => share(id));
  ipcMain.handle('crash:text', (_e, id) => {
    const record = readRecord(id);
    return reportToText(record.report, { ...record.instance, instanceName: record.instance?.name, at: record.at, shareUrl: record.shareUrl });
  });
  ipcMain.handle('crash:delete', (_e, id) => {
    for (const ext of ['.json', '.log']) fs.rmSync(path.join(reportsDir(), `${path.basename(recordPath(id), '.json')}${ext}`), { force: true });
    return true;
  });
  ipcMain.handle('crash:open', async (_e, id, target) => {
    const record = readRecord(id);
    const file = target === 'crash' ? record.files?.crashReport : target === 'jvm' ? record.files?.hsErr : null;
    if (file && fs.existsSync(file)) return shell.openPath(file);
    if (target === 'log') return shell.openPath(path.join(reportsDir(), `${id}.log`));
    const dir = record.instance?.id ? resolveInside(instanceDir(record.instance.id), target === 'mods' ? 'mods' : target === 'logs' ? 'logs' : '') : rootDir();
    return shell.openPath(fs.existsSync(dir) ? dir : rootDir());
  });
  // Re-run the analyser on an instance's most recent crash report / log.
  ipcMain.handle('crash:analyzeInstance', async (_e, rawInstance) => {
    const instance = pickInstance(rawInstance);
    if (!instance.id) throw new Error('No instance selected');
    const gameDir = instanceDir(instance.id);
    const record = await runAnalysis({ instance, gameDir, log: '', since: 0, exitCode: null, memoryMaxGb: Number(rawInstance?.overrides?.memory?.enabled ? rawInstance.overrides.memory.max : require('./settings').get()?.memory?.max) || null, manual: true });
    return record;
  });
}

module.exports = { init, beginSession, capture, markKilled, endSession, indexMods, _internals: { applyFix, runAnalysis, setProperty } };
