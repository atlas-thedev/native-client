const { autoUpdater, CancellationToken } = require('electron-updater');
const log = require('electron-log');

const STARTUP_CHECK_DELAY_MS = 5_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;
const RESUME_CHECK_DELAY_MS = 10_000;

autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.allowPrerelease = false;
autoUpdater.allowDowngrade = false;
autoUpdater.disableDifferentialDownload = false;
autoUpdater.fullChangelog = true;

const PRIMARY_FEED = {
  provider: 'github',
  owner: 'atlas-thedev',
  repo: 'native-client'
};
const LEGACY_FEED = {
  provider: 'github',
  owner: 'atlas-thedev',
  repo: 'native-client'
};

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
let latestInfo = null;
let checkPromise = null;
let downloadPromise = null;
let downloadCancellation = null;
let activeCheckSilent = false;
let currentStatus = { type: 'idle', currentVersion: null, updatedAt: Date.now() };

function init({ app, getWin, getSettings }, ipcMain) {
  appRef = app;
  mainWindow = getWin;
  readSettings = getSettings;
  currentStatus = statusWithMeta('idle');

  try {
    autoUpdater.setFeedURL(PRIMARY_FEED);
  } catch (err) {
    log.warn('Could not set autoUpdater initial feed URL:', err);
  }

  ipcMain.handle('updater:status', () => currentStatus);
  ipcMain.handle('updater:check', () => checkForUpdates({ silent: false }));
  ipcMain.handle('updater:download', () => downloadUpdate());
  ipcMain.handle('updater:cancel', () => cancelDownload());
  ipcMain.handle('updater:install', () => installUpdate());

  autoUpdater.on('checking-for-update', () => {
    log.info('Checking for updates...');
    setStatus(statusWithMeta('checking', { silent: activeCheckSilent }));
  });

  autoUpdater.on('update-available', (info) => {
    latestInfo = info;
    log.info(`Update available: ${app.getVersion()} -> ${info.version}`);
    setStatus(statusWithMeta('available', updateMeta(info)));
    if (updatePreferences().autoDownload) {
      const timer = setTimeout(() => downloadUpdate(), 0);
      timer.unref?.();
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    latestInfo = info;
    log.info(`No update available (current: ${app.getVersion()})`);
    setStatus(statusWithMeta('not-available', {
      version: info?.version ?? app.getVersion(),
      checkedAt: Date.now()
    }));
  });

  autoUpdater.on('download-progress', (progress) => {
    const fullSize = getUpdateSize(latestInfo);
    const total = Number(progress.total) || 0;
    setStatus(statusWithMeta('downloading', {
      ...updateMeta(latestInfo),
      percent: clampPercent(progress.percent),
      transferred: Number(progress.transferred) || 0,
      total,
      bytesPerSecond: Number(progress.bytesPerSecond) || 0,
      fullSize,
      optimized: fullSize > 0 && total > 0 && total < fullSize * 0.9
    }));
  });

  autoUpdater.on('update-downloaded', (info) => {
    latestInfo = info ?? latestInfo;
    log.info(`Update downloaded: ${latestInfo?.version ?? 'unknown'}`);
    setStatus(statusWithMeta('downloaded', {
      ...updateMeta(latestInfo),
      downloadedAt: Date.now()
    }));
  });

  autoUpdater.on('error', (error) => {
    log.error('Update error:', error);
    if (downloadCancellation?.cancelled) {
      log.info('Update download cancelled by user');
    } else if (!activeCheckSilent) {
      setStatus(statusWithMeta('error', {
        ...updateMeta(latestInfo),
        operation: downloadPromise ? 'download' : 'check',
        message: friendlyError(error)
      }));
    }
  });

  app.whenReady().then(() => {
    if (!app.isPackaged) {
      setStatus(statusWithMeta('disabled', {
        message: 'Update checks are available in packaged builds.'
      }));
      return;
    }

    if (updatePreferences().checkOnStartup) {
      const initialTimer = setTimeout(
        () => checkForUpdates({ silent: true }),
        STARTUP_CHECK_DELAY_MS
      );
      initialTimer.unref?.();
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
        const timer = setTimeout(
          () => checkForUpdates({ silent: true }),
          RESUME_CHECK_DELAY_MS
        );
        timer.unref?.();
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
    autoDownload: updates.autoDownload === true
  };
}

async function checkForUpdates({ silent = false } = {}) {
  if (!appRef?.isPackaged) {
    const result = { ok: false, disabled: true, error: 'Update checks require a packaged build.' };
    setStatus(statusWithMeta('disabled', { message: result.error }));
    return result;
  }
  if (downloadPromise) return { ok: false, busy: true, error: 'An update is downloading.' };
  if (checkPromise) return checkPromise;

  activeCheckSilent = silent;
  const previousStatus = currentStatus;
  checkPromise = (async () => {
    try {
      let result = null;
      // The primary feed is authoritative. The legacy (pre-rename) feed is only
      // consulted when the primary one can't be reached, so it can never
      // override a newer or equal primary release.
      try {
        autoUpdater.setFeedURL(PRIMARY_FEED);
        result = await autoUpdater.checkForUpdates();
      } catch (primaryError) {
        log.warn('Primary update feed check (native-client) failed, trying legacy (native-launcher):', primaryError);
        try {
          autoUpdater.setFeedURL(LEGACY_FEED);
          result = await autoUpdater.checkForUpdates();
        } catch {
          throw primaryError;
        } finally {
          autoUpdater.setFeedURL(PRIMARY_FEED);
        }
      }

      const currentVer = result?.currentVersion?.version ?? appRef.getVersion();
      const latestVer = result?.updateInfo?.version ?? currentVer;
      return {
        ok: true,
        updateAvailable: compareVersions(latestVer, currentVer) > 0,
        currentVersion: currentVer,
        latestVersion: latestVer
      };
    } catch (error) {
      log.error('Check for updates error:', error);
      if (silent) {
        setStatus({
          ...previousStatus,
          lastCheckError: friendlyError(error),
          checkedAt: Date.now(),
          updatedAt: Date.now()
        });
      }
      return { ok: false, error: friendlyError(error) };
    } finally {
      checkPromise = null;
      activeCheckSilent = false;
    }
  })();
  return checkPromise;
}

async function downloadUpdate() {
  if (!appRef?.isPackaged) return { ok: false, error: 'Updates require a packaged build.' };
  if (currentStatus.type === 'downloaded') return { ok: true, alreadyDownloaded: true };
  if (downloadPromise) return downloadPromise;
  if (!latestInfo || currentStatus.type === 'not-available') {
    return { ok: false, error: 'Check for updates before downloading.' };
  }

  setStatus(statusWithMeta('preparing', updateMeta(latestInfo)));
  downloadCancellation = new CancellationToken();
  downloadPromise = (async () => {
    try {
      await autoUpdater.downloadUpdate(downloadCancellation);
      return { ok: true };
    } catch (error) {
      if (downloadCancellation?.cancelled) {
        setStatus(statusWithMeta('available', updateMeta(latestInfo)));
        return { ok: false, cancelled: true };
      }
      log.error('Download error:', error);
      setStatus(statusWithMeta('error', {
        ...updateMeta(latestInfo),
        operation: 'download',
        message: friendlyError(error)
      }));
      return { ok: false, error: friendlyError(error) };
    } finally {
      downloadPromise = null;
      downloadCancellation = null;
    }
  })();
  return downloadPromise;
}

function cancelDownload() {
  if (!downloadPromise || !downloadCancellation) return { ok: false, error: 'No download is active.' };
  downloadCancellation.cancel();
  return { ok: true };
}

function installUpdate() {
  if (currentStatus.type !== 'downloaded') {
    return { ok: false, error: 'The update has not finished downloading.' };
  }
  setStatus(statusWithMeta('installing', updateMeta(latestInfo)));
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
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
  const extension = process.platform === 'win32' ? '.exe'
    : process.platform === 'linux' ? '.AppImage'
      : '.zip';
  const match = files.find((file) => {
    const pathname = file?.url?.pathname ?? file?.url ?? '';
    return String(pathname).toLowerCase().endsWith(extension.toLowerCase());
  });
  return Number(match?.size) || Number(files[0]?.size) || 0;
}

function statusWithMeta(type, extra = {}) {
  return {
    type,
    currentVersion: appRef?.getVersion?.() ?? null,
    ...extra,
    updatedAt: Date.now()
  };
}

function setStatus(status) {
  currentStatus = status;
  const win = mainWindow?.();
  if (win && !win.isDestroyed()) win.webContents.send('updater:status', status);
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, Number(value) || 0));
}

function friendlyError(error) {
  const first = String(error?.message ?? '').split('\n')[0].trim();
  return first || 'Unknown update error';
}

module.exports = { init };
