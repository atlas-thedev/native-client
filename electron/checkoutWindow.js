'use strict';

/**
 * In-launcher checkout: shows the Tebex payment page (pay.tebex.io) or the Native billing page in a
 * locked-down child window instead of the system browser. No preload, no Node, sandboxed, its own
 * in-memory session. Tebex sends buyers to playnative.fun/checkout?done=1 when they've paid; we
 * catch that redirect and close the window.
 */
const { BrowserWindow, session } = require('electron');

const PARTITION = 'native-checkout'; // not persisted: nothing payment-related outlives the launcher session
// nativelaunch.xyz is the old domain; keep recognising it while it redirects.
const isSite = (host) => ['playnative.fun', 'nativelaunch.xyz'].some((d) => host === d || host.endsWith(`.${d}`));
const isTebex = (host) => host === 'tebex.io' || host.endsWith('.tebex.io');

let prepared = false;
function checkoutSession() {
  const ses = session.fromPartition(PARTITION);
  if (!prepared) {
    prepared = true;
    // Payment pages (and PayPal) treat unknown browsers with suspicion; look like plain Chrome.
    ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|native-client|Native[\w-]*)\/\S+/gi, ''));
    // Card forms need nothing beyond the basics; deny camera, mic, notifications, geolocation…
    ses.setPermissionRequestHandler((_wc, permission, done) => done(permission === 'clipboard-sanitized-write' || permission === 'fullscreen'));
    ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write' || permission === 'fullscreen');
    ses.on('will-download', (event) => event.preventDefault());
  }
  return ses;
}

const parse = (raw) => { try { return new URL(String(raw || '')); } catch { return null; } };

let current = null; // one checkout at a time

/**
 * @param {object} o
 * @param {string} o.url        page to show (https only)
 * @param {BrowserWindow} [o.parent]
 * @param {'checkout'|'portal'} [o.kind]
 * @param {(result: {paid: boolean}) => void} [o.onClose]
 * @returns {boolean} whether the window opened
 */
function openCheckoutWindow({ url, parent = null, kind = 'checkout', onClose = () => {} }) {
  const start = parse(url);
  if (!start || start.protocol !== 'https:' || !(isTebex(start.hostname) || isSite(start.hostname))) return false;

  if (current && !current.isDestroyed()) current.close();
  const ses = checkoutSession();
  const bg = parent && !parent.isDestroyed() ? parent.getBackgroundColor?.() : undefined;
  const win = new BrowserWindow({
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    modal: process.platform !== 'darwin' && Boolean(parent && !parent.isDestroyed()), // macOS would make it a sheet
    width: 560,
    height: 820,
    minWidth: 420,
    minHeight: 560,
    show: false,
    title: kind === 'portal' ? 'Native · Billing' : 'Native · Checkout',
    autoHideMenuBar: true,
    backgroundColor: bg || '#111111',
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !require('electron').app.isPackaged
    }
  });
  current = win;
  win.removeMenu?.();
  let paid = false;
  let reported = false;
  const finish = () => {
    if (reported) return;
    reported = true;
    try { onClose({ paid }); } catch { /* renderer gone */ }
  };

  /** true = let it load here; false = blocked (and handled). */
  const route = (raw) => {
    const next = parse(raw);
    if (!next || next.protocol !== 'https:') return false;
    if (isSite(next.hostname)) {
      if (kind === 'checkout') {
        // complete_url → paid; return_url (or anything else on our site) → buyer backed out.
        if (next.pathname.replace(/\/+$/, '') === '/checkout' && next.searchParams.get('done') === '1') paid = true;
        setImmediate(() => { if (!win.isDestroyed()) win.close(); });
        return false;
      }
      return true; // portal page lives on our site
    }
    return true; // Tebex and the payment providers it hands off to (PayPal, 3-D Secure, banks)
  };

  const guard = (event, raw) => { if (!route(raw)) event.preventDefault(); };
  win.webContents.on('will-navigate', guard);
  win.webContents.on('will-redirect', guard);
  win.webContents.on('will-frame-navigate', (event) => { if (event.isMainFrame) guard(event, event.url); });

  // PayPal & co. open popups and talk back through window.opener — keep them inside the launcher too.
  win.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
    const next = parse(popupUrl);
    if (!next || next.protocol !== 'https:') return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        parent: win,
        width: 520,
        height: 720,
        autoHideMenuBar: true,
        webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, devTools: false }
      }
    };
  });
  win.webContents.on('did-create-window', (child) => {
    child.removeMenu?.();
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    child.webContents.on('will-navigate', (event, raw) => { const next = parse(raw); if (!next || next.protocol !== 'https:') event.preventDefault(); });
  });

  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
  win.webContents.on('did-fail-load', (_e, code, _desc, failedUrl, isMainFrame) => {
    if (isMainFrame && code !== -3 && !win.isVisible()) win.show(); // show Chromium's error page rather than nothing
  });
  win.on('closed', () => {
    if (current === win) current = null;
    finish();
  });

  win.loadURL(start.toString()).catch(() => { /* error page shown via did-fail-load */ });
  return true;
}

module.exports = { openCheckoutWindow };
