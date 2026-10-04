const { app, BrowserWindow, Notification, ipcMain, shell, nativeImage } = require('electron');
const path = require('path');
const safeFile = require('./safeFile');
const fs = require('fs');
const gameLauncher = require('./launcher');
const mods = require('./mods');
const authMod = require('./auth');
const settingsMod = require('./settings');
const javaMod = require('./java');
const modpacksMod = require('./modpacks');
const updaterMod = require('./updater');
const instanceMod = require('./instance');
const newsMod = require('./news');
const serverPingMod = require('./serverPing');
const wardrobeMod = require('./wardrobe');
const socialMod = require('./social');
const relayMod = require('./relay');
const adminMod = require('./admin');
const discordRpcMod = require('./discordRpc');
const crashReporterMod = require('./crashReporter');
const gameConsoleMod = require('./gameConsole');
const loadersMod = require('./loaders');
const modUpdatesMod = require('./modUpdates');

let win;
const appIcon = path.join(__dirname, '..', 'src', 'assets', 'noctra-icon.png');

app.setName('Native Client');
app.setAppUserModelId('xyz.nativelaunch.desktop');

// Keep existing installations on their current data directory so the rename
// never makes accounts, instances, or downloaded game files appear missing.
const nativeUserData = path.join(app.getPath('appData'), 'Native');
const noctraUserData = path.join(app.getPath('appData'), 'Native Client');
const legacyUserData = path.join(app.getPath('appData'), 'native-client');
if (fs.existsSync(nativeUserData)) {
  app.setPath('userData', nativeUserData);
} else if (fs.existsSync(noctraUserData)) {
  app.setPath('userData', noctraUserData);
} else if (fs.existsSync(legacyUserData)) {
  app.setPath('userData', legacyUserData);
} else {
  app.setPath('userData', nativeUserData);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1160,
    height: 750,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    backgroundColor: '#000000',
    icon: appIcon,
    title: 'Native Client',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer shows the version in a few places. Passing it as an
      // argument lets preload expose it synchronously, so nothing has to
      // render a placeholder while an IPC round-trip resolves.
      additionalArguments: [`--app-version=${app.getVersion()}`]
    }
  });

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  win.webContents.on('did-finish-load', () => {
    if (win && !win.isVisible()) {
      win.show();
      win.focus();
    }
  });

  // Failsafe in case ready-to-show is dropped or delayed
  setTimeout(() => {
    if (win && !win.isVisible()) {
      win.show();
      win.focus();
    }
  }, 1000);

  win.on('maximize', () => win.webContents.send('window:maximized', true));
  win.on('unmaximize', () => win.webContents.send('window:maximized', false));

  // Never let untrusted pages replace the renderer that owns the privileged
  // preload bridge. Web links are opened by the OS instead.
  win.webContents.on('will-navigate', (event, url) => {
    const currentUrl = win.webContents.getURL();
    if (url === currentUrl) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    win.loadURL(devServerUrl);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

const instancesPath = () => path.join(app.getPath('userData'), 'instances.json');

ipcMain.handle('instances:load', () => safeFile.readJson(instancesPath(), null));

ipcMain.on('instances:loadSync', (event) => {
  event.returnValue = safeFile.readJson(instancesPath(), null);
});

ipcMain.handle('instances:save', (_event, data) => {
  // Never replace the user's instances with something that isn't a store.
  if (!data || typeof data !== 'object') return false;
  safeFile.writeJsonAtomic(instancesPath(), data);
  return true;
});

ipcMain.on('window:minimize', () => win?.minimize());
ipcMain.on('window:maximize', () => {
  if (win?.isMaximized()) win.unmaximize();
  else win?.maximize();
});
ipcMain.on('window:close', () => win?.close());
// Native+ members get the N+ app icon (window/taskbar, and the macOS dock).
const plusIconUrl = require('./plusIcon');
let plusIconOn = false;
ipcMain.on('app:setPlusIcon', (_event, on) => {
  const next = Boolean(on);
  if (next === plusIconOn) return;
  plusIconOn = next;
  try {
    const image = next ? nativeImage.createFromDataURL(plusIconUrl) : nativeImage.createFromPath(appIcon);
    if (image.isEmpty()) return;
    win?.setIcon?.(image);
    if (process.platform === 'darwin') app.dock?.setIcon(image);
  } catch {}
});

ipcMain.handle('external:open', async (_event, value) => {
  const url = new URL(String(value));
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Unsupported link');
  await shell.openExternal(url.href);
});

// Native OS toast. The renderer's own Notification constructor is unreliable
// inside a frameless Electron window, so Relay routes every ping through here.
ipcMain.handle('app:showNotification', (_event, payload = {}) => {
  if (!Notification.isSupported()) return { ok: false };

  const notification = new Notification({
    title: String(payload.title || 'Native Relay').slice(0, 120),
    body: String(payload.body || '').slice(0, 300),
    icon: appIcon,
    silent: true // the chime is played by the renderer
  });

  notification.on('click', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  notification.show();
  return { ok: true };
});

gameLauncher.init({ app, getWin: () => win }, ipcMain);
crashReporterMod.init({ app, getWin: () => win }, ipcMain);
gameConsoleMod.init({ app, getWin: () => win }, ipcMain);
mods.init({ app, getWin: () => win }, ipcMain);
authMod.init({ app, getWin: () => win }, ipcMain);
settingsMod.init({ app }, ipcMain);
javaMod.init({ app, getWin: () => win }, ipcMain);
loadersMod.init({ app, getWin: () => win }, ipcMain);
modUpdatesMod.init({ app, getWin: () => win }, ipcMain);
modpacksMod.init({ app, getWin: () => win }, ipcMain);
updaterMod.init({ app, getWin: () => win, getSettings: () => settingsMod.get() }, ipcMain);
instanceMod.init({ app }, ipcMain);
newsMod.init({ app }, ipcMain);
serverPingMod.init({ app }, ipcMain);
wardrobeMod.init({ app, auth: authMod }, ipcMain);
socialMod.init({ app, getWin: () => win }, ipcMain);
relayMod.init();
adminMod.init();
discordRpcMod.init({ app, getSettings: () => settingsMod.get() }, ipcMain);

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  discordRpcMod.destroy();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
