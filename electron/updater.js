const path = require('node:path');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { autoUpdater, CancellationToken } = require('electron-updater');
const log = require('electron-log');
const parts = require('./partDownloader');
const diff = require('./diffDownloader');

/**
 * Launcher updates, all in the background.
 *
 * - Checks on startup, every few hours, and after the PC wakes up.
 * - Downloads by itself (unless turned off in Settings).
 *   Windows: if the installer of the version that's installed now is still in
 *   the update cache, only the blocks that changed are downloaded (blockmap
 *   diff, usually a few MB) and the rest is copied from that installer.
 *   Otherwise the installer is fetched in 4 MB parts over a few parallel
 *   connections. Finished parts are saved, so a download that was paused,
 *   lost its connection or was cut off by closing Native picks up where it
 *   stopped, even after a restart. While Minecraft runs it uses one
 *   connection so it never fights the game for bandwidth.
 *   macOS / Linux: electron-updater (differential where available).
 * - Installs when Native closes (silent), or right away with "Restart now",
 *   which shows the compact "Updating Native Client" setup and reopens Native.
 */

const STARTUP_CHECK_DELAY_MS = 5_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;
const RESUME_CHECK_DELAY_MS = 10_000;
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];

const FEED = { provider: 'github', owner: 'atlas-thedev', repo: 'native-client' };
const USE_PARTS = process.platform === 'win32';

autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = !USE_PARTS;
autoUpdater.allowPrerelease = false;
autoUpdater.allowDowngrade = false;
autoUpdater.disableDifferentialDownload = false;
autoUpdater.fullChangelog = true;

/** Numeric semver compare ("3.10.0" > "3.9.110"); pre-release tags sort first. */
function compareVersions(a, b) {
  const parse = (v) => String(v || '0').replace(/^v/i, '').split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const diff = (x[i] || 0) - (y[i] || 0);
    if (diff) return Math.sign(diff);
  }
  const preA = String(a || '').includes('-');
  const preB = String(b || '').includes('-');
  return preA === preB ? 0 : (preA ? -1 : 1);
}

let appRef = null;
let mainWindow = null;
let readSettings = null;
let gameRunning = () => false;
let latestInfo = null;
let checkPromise = null;
let downloadPromise = null;
let downloadSignal = null; // parts downloader
let downloadCancellation = null; // electron-updater
let activeCheckSilent = false;
let readyInstaller = null; // Windows: verified installer path
let installStarted = false;
let retryTimer = null;
let retryCount = 0;
let lastEmit = 0;
let currentStatus = { type: 'idle', currentVersion: null, updatedAt: Date.now() };

function cacheDir() { return path.join(appRef.getPath('userData'), 'updates'); }

function init({ app, getWin, getSettings, isGameRunning }, ipcMain) {
  appRef = app;
  mainWindow = getWin;
  readSettings = getSettings;
  if (typeof isGameRunning === 'function') gameRunning = isGameRunning;
  currentStatus = statusWithMeta('idle');

  try { autoUpdater.setFeedURL(FEED); } catch (err) { log.warn('Could not set update feed:', err); }

  ipcMain.handle('updater:status', () => currentStatus);
  ipcMain.handle('updater:check', () => checkForUpdates({ silent: false }));
  ipcMain.handle('updater:download', () => downloadUpdate({ background: false }));
  ipcMain.handle('updater:cancel', () => pauseDownload());
  ipcMain.handle('updater:pause', () => pauseDownload());
  ipcMain.handle('updater:install', () => installUpdate());

  autoUpdater.on('checking-for-update', () => {
    if (!activeCheckSilent) setStatus(statusWithMeta('checking'));
  });

  autoUpdater.on('update-available', (info) => {
    latestInfo = info;
    log.info(`Update available: ${app.getVersion()} -> ${info.version}`);
    if (downloadPromise || currentStatus.type === 'downloaded') return;
    setStatus(statusWithMeta('available', updateMeta(info)));
    savedProgress(info).then((saved) => {
      if (saved && currentStatus.type === 'available') setStatus(statusWithMeta('available', { ...updateMeta(info), saved }));
    });
    if (updatePreferences().autoDownload) {
      const timer = setTimeout(() => downloadUpdate({ background: true }), 0);
      timer.unref?.();
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    latestInfo = info;
    if (downloadPromise || currentStatus.type === 'downloaded') return;
    setStatus(statusWithMeta('not-available', { version: info?.version ?? app.getVersion(), checkedAt: Date.now() }));
  });

  // electron-updater download events (macOS / Linux only)
  autoUpdater.on('download-progress', (progress) => {
    if (USE_PARTS) return;
    const fullSize = getUpdateSize(latestInfo);
    const total = Number(progress.total) || 0;
    setStatus(statusWithMeta('downloading', {
      ...updateMeta(latestInfo),
      background: currentStatus.background === true,
      percent: clampPercent(progress.percent),
      transferred: Number(progress.transferred) || 0,
      total,
      bytesPerSecond: Number(progress.bytesPerSecond) || 0,
      fullSize,
      optimized: fullSize > 0 && total > 0 && total < fullSize * 0.9
    }), true);
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (USE_PARTS) return;
    latestInfo = info ?? latestInfo;
    setStatus(statusWithMeta('downloaded', { ...updateMeta(latestInfo), downloadedAt: Date.now() }));
  });

  autoUpdater.on('error', (error) => {
    log.error('Update error:', error);
  });

  // Windows: install the verified update when Native closes.
  app.on('will-quit', () => {
    if (!USE_PARTS || installStarted || !readyInstaller) return;
    if (updatePreferences().installOnQuit === false) return;
    runInstaller({ silent: true, relaunch: false });
  });

  app.whenReady().then(() => {
    if (!app.isPackaged) {
      setStatus(statusWithMeta('disabled', { message: 'Update checks are available in packaged builds.' }));
      return;
    }
    cleanupInstalled().catch(() => {});

    if (updatePreferences().checkOnStartup) {
      const t = setTimeout(() => checkForUpdates({ silent: true }), STARTUP_CHECK_DELAY_MS);
      t.unref?.();
    }

    const interval = setInterval(() => {
      if (updatePreferences().backgroundChecks && !downloadPromise && currentStatus.type !== 'downloaded') {
        checkForUpdates({ silent: true });
      }
    }, CHECK_INTERVAL_MS);
    interval.unref?.();

    try {
      const { powerMonitor } = require('electron');
      powerMonitor.on('resume', () => {
        if (!updatePreferences().backgroundChecks) return;
        const t = setTimeout(() => checkForUpdates({ silent: true }), RESUME_CHECK_DELAY_MS);
        t.unref?.();
      });
    } catch (error) {
      log.warn('Could not register updater resume check:', error);
    }
  });
}

function updatePreferences() {
  const updates = readSettings?.()?.updates ?? {};
  return {
    checkOnStartup: updates.checkOnStartup !== false,
    backgroundChecks: updates.backgroundChecks !== false,
    autoDownload: updates.autoDownload !== false,
    installOnQuit: updates.installOnQuit !== false
  };
}

async function checkForUpdates({ silent = false } = {}) {
  if (!appRef?.isPackaged) {
    const result = { ok: false, disabled: true, error: 'Update checks require a packaged build.' };
    setStatus(statusWithMeta('disabled', { message: result.error }));
    return result;
  }
  if (downloadPromise) return { ok: true, busy: true, updateAvailable: true, latestVersion: latestInfo?.version };
  if (currentStatus.type === 'downloaded') return { ok: true, updateAvailable: true, latestVersion: currentStatus.version };
  if (checkPromise) return checkPromise;

  activeCheckSilent = silent;
  const previousStatus = currentStatus;
  checkPromise = (async () => {
    try {
      autoUpdater.setFeedURL(FEED);
      const result = await autoUpdater.checkForUpdates();
      const currentVer = result?.currentVersion?.version ?? appRef.getVersion();
      const latestVer = result?.updateInfo?.version ?? currentVer;
      return { ok: true, updateAvailable: compareVersions(latestVer, currentVer) > 0, currentVersion: currentVer, latestVersion: latestVer };
    } catch (error) {
      log.error('Check for updates error:', error);
      if (silent) {
        setStatus({ ...previousStatus, lastCheckError: friendlyError(error), checkedAt: Date.now(), updatedAt: Date.now() });
      } else {
        setStatus(statusWithMeta('error', { operation: 'check', message: friendlyError(error) }));
      }
      return { ok: false, error: friendlyError(error) };
    } finally {
      checkPromise = null;
      activeCheckSilent = false;
    }
  })();
  return checkPromise;
}

// --- Windows: resumable part download --------------------------------------

function windowsAsset(info) {
  const files = info?.files ?? [];
  const file = files.find((f) => /\.exe$/i.test(String(f?.url ?? ''))) || null;
  const name = String(file?.url ?? info?.path ?? '');
  if (!name || !/\.exe$/i.test(name)) return null;
  const size = Number(file?.size) || 0;
  const sha512 = file?.sha512 || info?.sha512;
  if (!size || !sha512) return null;
  const safe = path.basename(name);
  const releaseUrl = (version, file) => `https://github.com/${FEED.owner}/${FEED.repo}/releases/download/v${version}/${encodeURIComponent(file)}`;
  const url = /^https:\/\//.test(name) ? name : releaseUrl(info.version, safe);
  return {
    name: safe,
    size,
    sha512,
    url,
    blockmapUrl: `${url}.blockmap`,
    /** The same installer for another version, e.g. the one that's installed now. */
    forVersion: (version) => {
      const file = safe.split(String(info.version)).join(String(version));
      return file === safe ? null : { name: file, blockmapUrl: `${releaseUrl(version, file)}.blockmap` };
    }
  };
}

async function savedProgress(info) {
  if (!USE_PARTS || !appRef?.isPackaged) return null;
  const asset = windowsAsset(info);
  if (!asset) return null;
  const saved = await parts.inspect(path.join(cacheDir(), asset.name)).catch(() => null);
  if (!saved || saved.sha512 !== asset.sha512 || !saved.doneParts) return null;
  return { parts: saved.parts, doneParts: saved.doneParts, percent: Math.round((saved.doneParts / saved.parts) * 100) };
}

async function cleanupInstalled() {
  if (!USE_PARTS) return;
  const dir = cacheDir();
  const names = await fsp.readdir(dir).catch(() => []);
  const current = appRef.getVersion();
  await Promise.all(names.map((n) => {
    const v = (n.match(/(\d+\.\d+\.\d+)/) || [])[1];
    if (!v) return null;
    const order = compareVersions(v, current);
    // keep the installer of the version that's installed now: the next update is built from it
    const keepAsBase = order === 0 && /\.exe$/i.test(n);
    return order <= 0 && !keepAsBase ? fsp.rm(path.join(dir, n), { force: true }) : null;
  }));
}

/** Installer of the running version, kept from the last update (Windows). */
async function baseInstaller(asset) {
  const base = asset?.forVersion(appRef.getVersion());
  if (!base) return null;
  const file = path.join(cacheDir(), base.name);
  const st = await fsp.stat(file).catch(() => null);
  return st?.isFile() && st.size > 0 ? { ...base, file } : null;
}

async function pruneOthers(keep, alsoKeep = null) {
  const dir = cacheDir();
  const names = await fsp.readdir(dir).catch(() => []);
  await Promise.all(names.filter((n) => !n.startsWith(keep) && n !== alsoKeep).map((n) => fsp.rm(path.join(dir, n), { force: true, recursive: true })));
}

function downloadWithParts(info, background) {
  const asset = windowsAsset(info);
  if (!asset) throw new Error('This release has no Windows installer.');
  const dest = path.join(cacheDir(), asset.name);
  downloadSignal = { cancelled: false };
  const signal = downloadSignal;
  const meta = { ...updateMeta(info), background, fullSize: asset.size };
  setStatus(statusWithMeta('downloading', { ...meta, percent: 0, transferred: 0, total: asset.size, bytesPerSecond: 0 }));

  const run = async (partSize) => {
    await pruneOthers(asset.name, asset.forVersion(appRef.getVersion())?.name);
    return parts.download({
      url: asset.url,
      dest,
      size: asset.size,
      sha512: asset.sha512,
      partSize,
      signal,
      getConnections: () => (gameRunning() ? 1 : 4),
      onProgress: (p) => setStatus(statusWithMeta('downloading', {
        ...meta,
        percent: clampPercent(p.percent),
        transferred: p.transferred,
        total: p.total,
        bytesPerSecond: p.bytesPerSecond,
        parts: p.parts,
        doneParts: p.doneParts,
        map: p.map,
        resumed: p.resumed,
        throttled: gameRunning()
      }), true)
    });
  };

  const full = () => run().catch((err) => {
    if (/does not support ranges/i.test(err?.message)) return run(asset.size); // one big part
    throw err;
  });

  // Only what changed, built from the installer of the version that's installed now.
  const patch = async () => {
    const base = await baseInstaller(asset);
    if (!base) return null;
    const saved = await parts.inspect(dest).catch(() => null);
    if (saved && saved.sha512 === asset.sha512 && saved.doneParts / saved.parts > 0.5) return null; // nearly there already
    await pruneOthers(asset.name, base.name);
    setStatus(statusWithMeta('preparing', { ...meta, optimized: true }));
    let planned = null;
    try {
      const result = await diff.download({
        url: asset.url,
        dest,
        size: asset.size,
        sha512: asset.sha512,
        baseFile: base.file,
        oldBlockmapUrl: base.blockmapUrl,
        newBlockmapUrl: asset.blockmapUrl,
        signal,
        getConnections: () => (gameRunning() ? 1 : 4),
        onPlan: (p) => {
          planned = p;
          log.info(`Differential update: downloading ${p.downloadBytes} of ${asset.size} bytes, reusing ${p.copyBytes}`);
          setStatus(statusWithMeta('downloading', { ...meta, optimized: true, percent: 0, transferred: 0, total: p.downloadBytes, bytesPerSecond: 0 }));
        },
        onProgress: (p) => setStatus(statusWithMeta('downloading', {
          ...meta,
          optimized: true,
          percent: clampPercent(p.percent),
          transferred: p.transferred,
          total: p.total,
          bytesPerSecond: p.bytesPerSecond,
          throttled: gameRunning()
        }), true)
      });
      return { path: result.path, resumed: false, patched: true };
    } catch (err) {
      if (err?.cancelled || signal.cancelled) throw err;
      log.warn(`Differential update not used (${err?.message || err}); downloading the full installer${planned ? ' instead' : ''}.`);
      setStatus(statusWithMeta('downloading', { ...meta, percent: 0, transferred: 0, total: asset.size, bytesPerSecond: 0 }));
      return null;
    }
  };

  return patch().then((done) => done || full()).then(({ path: file, resumed, patched }) => {
    readyInstaller = file;
    log.info(`Update ${info.version} downloaded${patched ? ' (only what changed)' : resumed ? ' (resumed)' : ''}: ${file}`);
    setStatus(statusWithMeta('downloaded', { ...updateMeta(info), downloadedAt: Date.now(), resumed, optimized: !!patched }));
  });
}

async function downloadUpdate({ background = false } = {}) {
  if (!appRef?.isPackaged) return { ok: false, error: 'Updates require a packaged build.' };
  if (currentStatus.type === 'downloaded') return { ok: true, alreadyDownloaded: true };
  if (downloadPromise) {
    if (!background && currentStatus.background) setStatus({ ...currentStatus, background: false, updatedAt: Date.now() });
    return downloadPromise;
  }
  if (!latestInfo || compareVersions(latestInfo.version, appRef.getVersion()) <= 0) {
    return { ok: false, error: 'Check for updates before downloading.' };
  }
  clearTimeout(retryTimer);
  const info = latestInfo;

  downloadPromise = (async () => {
    try {
      if (USE_PARTS) {
        await downloadWithParts(info, background);
      } else {
        setStatus(statusWithMeta('preparing', { ...updateMeta(info), background }));
        downloadCancellation = new CancellationToken();
        await autoUpdater.downloadUpdate(downloadCancellation);
      }
      retryCount = 0;
      return { ok: true };
    } catch (error) {
      const cancelled = error?.cancelled || downloadSignal?.cancelled || downloadCancellation?.cancelled;
      if (cancelled) {
        const saved = await savedProgress(info);
        setStatus(statusWithMeta('paused', { ...updateMeta(info), saved }));
        return { ok: false, cancelled: true };
      }
      log.error('Update download error:', error);
      const saved = await savedProgress(info);
      const retryIn = updatePreferences().autoDownload ? RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)] : 0;
      setStatus(statusWithMeta('error', {
        ...updateMeta(info), operation: 'download', message: friendlyError(error), saved,
        retryAt: retryIn ? Date.now() + retryIn : null
      }));
      if (retryIn) {
        retryCount += 1;
        retryTimer = setTimeout(() => downloadUpdate({ background: true }), retryIn);
        retryTimer.unref?.();
      }
      return { ok: false, error: friendlyError(error) };
    } finally {
      downloadPromise = null;
      downloadSignal = null;
      downloadCancellation = null;
    }
  })();
  return downloadPromise;
}

function pauseDownload() {
  clearTimeout(retryTimer);
  if (downloadSignal) { downloadSignal.cancelled = true; return { ok: true }; }
  if (downloadCancellation) { downloadCancellation.cancel(); return { ok: true }; }
  return { ok: false, error: 'No download is active.' };
}

function runInstaller({ silent, relaunch }) {
  if (!readyInstaller) return false;
  const args = ['--updated'];
  if (silent) args.push('/S');
  if (relaunch) args.push('--force-run');
  try {
    spawn(readyInstaller, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    installStarted = true;
    log.info(`Started update installer ${silent ? '(silent)' : ''}: ${readyInstaller}`);
    return true;
  } catch (err) {
    log.error('Could not start the update installer:', err);
    return false;
  }
}

function installUpdate() {
  if (currentStatus.type !== 'downloaded') {
    return { ok: false, error: 'The update has not finished downloading.' };
  }
  setStatus(statusWithMeta('installing', updateMeta(latestInfo)));
  setImmediate(() => {
    if (USE_PARTS) {
      if (runInstaller({ silent: false, relaunch: true })) appRef.quit();
      else setStatus(statusWithMeta('error', { ...updateMeta(latestInfo), operation: 'install', message: 'Could not start the installer.' }));
    } else {
      autoUpdater.quitAndInstall(false, true);
    }
  });
  return { ok: true };
}

function updateMeta(info) {
  if (!info) return {};
  return {
    version: info.version,
    releaseName: info.releaseName ?? null,
    releaseNotes: info.releaseNotes ?? null,
    releaseDate: info.releaseDate ?? null,
    fullSize: getUpdateSize(info)
  };
}

function getUpdateSize(info) {
  const files = info?.files ?? [];
  const extension = process.platform === 'win32' ? '.exe' : process.platform === 'linux' ? '.AppImage' : '.zip';
  const match = files.find((file) => String(file?.url?.pathname ?? file?.url ?? '').toLowerCase().endsWith(extension.toLowerCase()));
  return Number(match?.size) || Number(files[0]?.size) || 0;
}

function statusWithMeta(type, extra = {}) {
  return { type, currentVersion: appRef?.getVersion?.() ?? null, ...extra, updatedAt: Date.now() };
}

/** Progress updates are throttled to ~6/s so a fast download doesn't flood the renderer. */
function setStatus(status, progress = false) {
  currentStatus = status;
  const now = Date.now();
  if (progress && now - lastEmit < 160) return;
  lastEmit = now;
  const win = mainWindow?.();
  if (win && !win.isDestroyed()) win.webContents.send('updater:status', status);
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, Number(value) || 0));
}

function friendlyError(error) {
  const first = String(error?.message ?? '').split('\n')[0].trim();
  if (/ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(first)) return 'Lost the connection. The download is saved and continues by itself.';
  return first || 'Unknown update error';
}

module.exports = { init, _internals: { compareVersions, windowsAsset, diffPlan: diff.plan } };
