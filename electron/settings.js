const path = require('path');
const fs = require('fs');
const os = require('os');
const javaRuntime = require('./javaRuntime');

const DEFAULTS = {
  onboarding: {
    // null distinguishes installs created before the onboarding flow existed.
    // Existing account/instance data is used to migrate those users without
    // making them repeat first-run setup.
    completed: null,
    language: 'en'
  },
  appearance: {
    theme: 'black',
    backgroundMotion: true,
    reducedMotion: false,
    compactDensity: false
  },
  memory: { min: 1, max: 4 }, // GB (0.5 GB steps)
  java: {
    // one configured path per Java major "slot" — resolved per MC version at launch
    paths: { 8: '', 17: '', 21: '', 25: '' }
  },
  // Launcher-wide JVM flags; an instance can override them.
  jvm: { preset: 'none', args: '' },
  resolution: { width: 854, height: 480, fullscreen: false },
  behavior: {
    startPage: 'play',
    launcherAction: 'keep', // keep | minimize | hide
    reopenOnExit: true,
    confirmInstanceDelete: true,
    discordRpc: true
  },
  apiKeys: {
    curseforge: ''
  },
  updates: {
    checkOnStartup: true,
    backgroundChecks: true,
    autoDownload: true,
    installOnQuit: true
  }
};

let deps = null;
let cache = null;

const filePath = () => path.join(deps.app.getPath('userData'), 'settings.json');

function deepMerge(base, override) {
  const out = { ...base };
  for (const key of Object.keys(override ?? {})) {
    if (
      override[key] &&
      typeof override[key] === 'object' &&
      !Array.isArray(override[key]) &&
      typeof base[key] === 'object'
    ) {
      out[key] = deepMerge(base[key], override[key]);
    } else {
      out[key] = override[key];
    }
  }
  return out;
}

function load() {
  if (!cache) {
    let saved = {};
    let shouldSave = false;
    try {
      saved = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    } catch {
      // first run — defaults
    }
    cache = deepMerge(DEFAULTS, saved);
    if (!cache.appearance || cache.appearance.theme !== 'black') {
      cache.appearance = { ...(cache.appearance || {}), theme: 'black' };
      shouldSave = true;
    }
    // 4.2: updates download in the background by default (the old default was off).
    if (cache.updates && !cache.updates.backgroundDefaults) {
      cache.updates = { ...cache.updates, autoDownload: true, installOnQuit: true, backgroundDefaults: true };
      shouldSave = true;
    }
    if (shouldSave && deps?.app) {
      try {
        fs.writeFileSync(filePath(), JSON.stringify(cache, null, 2));
      } catch {}
    }
  }
  return cache;
}

function save(next) {
  cache = deepMerge(DEFAULTS, next);
  fs.writeFileSync(filePath(), JSON.stringify(cache, null, 2));
  return cache;
}

/** Probe one java binary: { path, version, major, arch, bits, vendor, home } or null. */
function probeJava(javaPath) {
  return javaRuntime.probe(javaPath);
}

/**
 * Every Java runtime on this machine (PATH, JAVA_HOME, registry, all drives,
 * other launchers' runtimes…), each verified by running it.
 */
async function detectJava(options = {}) {
  const list = await javaRuntime.scan(options);
  return list.map((j) => ({ ...j, label: j.source }));
}

/** Recursively sum a directory's size in bytes. Returns 0 for missing dirs. */
function getDirSize(dirPath) {
  let total = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += getDirSize(full);
      } else if (entry.isFile()) {
        try { total += fs.statSync(full).size; } catch { /* locked / gone */ }
      }
    }
  } catch { /* unreadable — skip */ }
  return total;
}

/** Return per-category disk usage under userData. */
function getStorageInfo(userDataPath) {
  const categories = [
    { key: 'instances', label: 'Instances',     dir: path.join('minecraft', 'instances') },
    { key: 'runtimes',  label: 'Java Runtimes', dir: 'java' },
    { key: 'assets',    label: 'Game Assets',   dir: path.join('minecraft', 'assets') },
    { key: 'libraries', label: 'Libraries',     dir: path.join('minecraft', 'libraries') },
    { key: 'versions',  label: 'Version Jars',  dir: path.join('minecraft', 'versions') },
  ];
  return categories.map(({ key, label, dir }) => ({
    key,
    label,
    bytes: getDirSize(path.join(userDataPath, dir)),
  }));
}

function init(dependencies, ipcMain) {
  deps = dependencies;
  try { javaRuntime.setUserData(deps.app.getPath('userData')); } catch { /* tests */ }

  ipcMain.handle('settings:load', () => load());
  ipcMain.handle('settings:systemMemory', () => ({ totalGb: os.totalmem() / 1024 ** 3 }));
  ipcMain.handle('settings:save', (_e, next) => save(next));
  ipcMain.handle('settings:detectJava', () => detectJava());
  ipcMain.handle('settings:dataDir', () => deps.app.getPath('userData'));
  ipcMain.handle('settings:openDataDir', () => {
    const { shell } = require('electron');
    return shell.openPath(deps.app.getPath('userData'));
  });
  ipcMain.handle('settings:storageInfo', () =>
    getStorageInfo(deps.app.getPath('userData'))
  );
}

module.exports = { init, get: load, set: save, probeJava, detectJava };
