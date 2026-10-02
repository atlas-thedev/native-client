const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { BrowserWindow, safeStorage } = require('electron');
const safeFile = require('./safeFile');
const { Auth } = require('msmc');

/**
 * Multi-account authentication (main process).
 *
 * Storage: accounts.json in userData
 *   { activeId: string|null, accounts: [{ id, name, uuid, type, refresh? }] }
 *
 * Automatically migrates the old single-account account.json on first run.
 */

let deps = null;
let mcSessions = {}; // id -> msmc mc token object
let activeAuthWindow = null;
let microsoftLoginPromise = null;

const appIcon = path.join(__dirname, '..', 'icon.png');

const userDataDir = () => deps.app.getPath('userData');
const accountsPath = (dir = userDataDir()) => path.join(dir, 'accounts.json');
const legacyPath  = (dir = userDataDir()) => path.join(dir, 'account.json');

// Secrets at rest: Microsoft refresh data and Noctra session tokens are
// encrypted with the OS keychain (safeStorage) whenever it is available.
const SECRET_FIELDS = ['token', 'sessionToken', 'noctraToken'];

/** `dir` lets other main-process modules read accounts before auth.init(). */
function readAccounts(dir) {
  const { value, status } = safeFile.readJsonDetailed(accountsPath(dir), null);
  if (value && Array.isArray(value.accounts)) {
    return { ...value, accounts: value.accounts.map(revealAccount) };
  }
  // The file exists but couldn't be read: don't migrate over it or treat the
  // user as signed out permanently; the unreadable copy has been moved aside.
  if (status === 'corrupt') return { activeId: null, accounts: [] };

  // Migrate legacy single-account file
  try {
    const legacy = JSON.parse(fs.readFileSync(legacyPath(dir), 'utf8'));
    if (legacy?.name) {
      const id = legacy.uuid || `ms-${Date.now()}`;
      const migrated = {
        activeId: id,
        accounts: [{ id, name: legacy.name, uuid: legacy.uuid, type: 'microsoft', refresh: legacy.refresh }]
      };
      saveAccounts(migrated, dir);
      return migrated;
    }
  } catch { /* no legacy either */ }

  return { activeId: null, accounts: [] };
}

function revealAccount(account) {
  if (!account || typeof account !== 'object') return account;
  const next = { ...account };
  for (const field of SECRET_FIELDS) {
    if (typeof next[field] === 'string' && next[field].startsWith('safe:v1:')) {
      try {
        next[field] = JSON.parse(safeStorage.decryptString(Buffer.from(next[field].slice(8), 'base64')));
      } catch {
        // Encrypted on another machine/user: the session must be renewed.
        next[field] = null;
      }
    }
  }
  return next;
}

function saveAccounts(data, dir) {
  const protectedData = {
    ...data,
    accounts: (data.accounts || []).map((account) => {
      const next = { ...account, refresh: protectRefresh(account.refresh) };
      for (const field of SECRET_FIELDS) {
        if (next[field]) next[field] = protectRefresh(next[field]);
      }
      return next;
    })
  };
  safeFile.writeJsonAtomic(accountsPath(dir), protectedData);
}

function protectRefresh(refresh) {
  if (!refresh || (typeof refresh === 'string' && refresh.startsWith('safe:v1:'))) return refresh;
  try {
    if (safeStorage?.isEncryptionAvailable?.()) {
      return `safe:v1:${safeStorage.encryptString(JSON.stringify(refresh)).toString('base64')}`;
    }
  } catch {}
  return refresh;
}

function revealRefresh(refresh) {
  if (typeof refresh !== 'string' || !refresh.startsWith('safe:v1:')) return refresh;
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(refresh.slice(8), 'base64')));
  } catch {
    throw new Error('The encrypted Microsoft session could not be unlocked on this computer.');
  }
}

function microsoftAuthCode(authManager) {
  return new Promise((resolve, reject) => {
    const parent = deps?.getWin?.();
    const authWindow = new BrowserWindow({
      width: 520,
      height: 720,
      minWidth: 440,
      minHeight: 560,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      modal: false,
      frame: true,
      show: false,
      center: true,
      resizable: true,
      maximizable: false,
      fullscreenable: false,
      backgroundColor: '#f4f4f4',
      icon: appIcon,
      title: 'Sign in to Microsoft — Noctra Client',
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        partition: 'persist:native-microsoft-auth'
      }
    });

    activeAuthWindow = authWindow;

    let settled = false;
    const complete = (error, code) => {
      if (settled) return false;
      settled = true;
      if (error) reject(error);
      else resolve(code);
      if (!authWindow.isDestroyed()) authWindow.close();
      return true;
    };

    const inspectRedirect = (url) => {
      if (!url?.startsWith(authManager.token.redirect)) return false;

      try {
        const callback = new URL(url);
        const code = callback.searchParams.get('code');
        if (code) return complete(null, code);

        const detail = callback.searchParams.get('error_description')
          || callback.searchParams.get('error')
          || 'Microsoft sign-in was not completed.';
        return complete(new Error(detail));
      } catch {
        return complete(new Error('Microsoft returned an invalid sign-in response.'));
      }
    };

    authWindow.on('closed', () => {
      if (activeAuthWindow === authWindow) activeAuthWindow = null;
      if (!settled) {
        settled = true;
        reject(new Error('Microsoft sign-in cancelled.'));
      }
    });

    authWindow.once('ready-to-show', () => {
      if (!authWindow.isDestroyed()) authWindow.show();
    });

    const contents = authWindow.webContents;
    contents.on('will-redirect', (event, url) => {
      if (inspectRedirect(url)) event.preventDefault();
    });
    contents.on('did-navigate', (_event, url) => inspectRedirect(url));
    contents.on('did-finish-load', () => inspectRedirect(contents.getURL()));
    contents.on('did-fail-load', (_event, errorCode, description, url, isMainFrame) => {
      // Chromium reports an aborted load while an OAuth redirect is being intercepted.
      if (!isMainFrame || errorCode === -3 || inspectRedirect(url)) return;
      complete(new Error(`Could not load Microsoft sign-in: ${description}`));
    });

    authWindow.loadURL(authManager.createLink()).catch((error) => {
      // Redirect interception can reject loadURL after the login has already completed.
      if (!settled) complete(error);
    });
  });
}

async function performMicrosoftLogin() {
  const authManager = new Auth('select_account');
  const code = await microsoftAuthCode(authManager);
  const xbox = await authManager.login(code);
  const mc = await xbox.getMinecraft();

  const id = mc.profile?.id || `ms-${Date.now()}`;
  const profile = { name: mc.profile?.name, uuid: mc.profile?.id };

  mcSessions[id] = mc;

  const data = readAccounts();
  // Replace if same uuid already exists (re-auth)
  const previous = data.accounts.find(a => a.id === id);
  data.accounts = data.accounts.filter(a => a.id !== id);
  data.accounts.push({
    id,
    name: profile.name,
    uuid: profile.uuid,
    type: 'microsoft',
    refresh: xbox.save(),
    // Re-signing into Microsoft keeps the connected Noctra account.
    ...(previous?.noctraToken ? { noctraToken: previous.noctraToken, noctraLink: previous.noctraLink } : {})
  });
  data.activeId = id;
  saveAccounts(data);

  return { id, ...profile };
}

async function loginMicrosoft() {
  if (microsoftLoginPromise) {
    if (activeAuthWindow && !activeAuthWindow.isDestroyed()) {
      activeAuthWindow.show();
      activeAuthWindow.focus();
    }
    return microsoftLoginPromise;
  }

  microsoftLoginPromise = performMicrosoftLogin();
  try {
    return await microsoftLoginPromise;
  } finally {
    microsoftLoginPromise = null;
  }
}

async function getMinecraftSession(accountId, { forceRefresh = false } = {}) {
  try {
    const { accounts, activeId } = readAccounts();
    const targetId = typeof accountId === 'object' ? (accountId?.id || accountId?.uuid) : accountId;
    const acc = accounts.find(a => 
      a.id === (targetId || activeId) || 
      (targetId && a.uuid === targetId) || 
      (targetId && a.name?.toLowerCase() === targetId?.toLowerCase())
    );
    if (!acc || acc.type !== 'microsoft') return null;

    if (forceRefresh) {
      delete mcSessions[acc.id];
    }

    const cached = mcSessions[acc.id];
    if (cached && (typeof cached.validate !== 'function' || cached.validate())) {
      return cached;
    }

    if (!acc.refresh) return null;

    const authManager = new Auth('select_account');
    const xbox = await authManager.refresh(revealRefresh(acc.refresh));
    const mc = await xbox.getMinecraft();
    mcSessions[acc.id] = mc;

    const data = readAccounts();
    const idx = data.accounts.findIndex(a => a.id === acc.id);
    if (idx >= 0) {
      data.accounts[idx].refresh = xbox.save();
      data.accounts[idx].name = mc.profile?.name;
      data.accounts[idx].uuid = mc.profile?.id;
      saveAccounts(data);
    }

    return mc;
  } catch {
    return null;
  }
}

/** MCLC-compatible auth for the current active account. Returns null if not an MS account or token expired. */
async function getMclcAuth() {
  const mc = await getMinecraftSession();
  return mc?.mclc?.() || null;
}

function generateOfflinePlayerUuid(username) {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${username}`).digest();
  md5[6] = (md5[6] & 0x0f) | 0x30; // version 3
  md5[8] = (md5[8] & 0x3f) | 0x80; // variant 2
  const hex = md5.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Minecraft's own rule for player names; servers reject anything else.
const OFFLINE_NAME = /^[A-Za-z0-9_]{3,16}$/;

function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); })
  ]).finally(() => clearTimeout(timer));
}

function dashedUuid(value) {
  const hex = String(value || '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A local (offline-mode) session. Nothing here touches the network, so it
 * works without internet: singleplayer, LAN and servers running with
 * online-mode=false. The UUID is Minecraft's own OfflinePlayer UUID, the
 * same one offline-mode servers assign, so inventories and stats stay put.
 */
function offlineAuthorization(name, uuid = null) {
  const id = dashedUuid(uuid) || generateOfflinePlayerUuid(name);
  const token = id.replace(/-/g, '');
  return {
    access_token: token,
    client_token: token,
    uuid: id,
    name,
    user_properties: '{}',
    meta: { type: 'mojang', demo: false }
  };
}

/**
 * The session a launch should use. Never blocks a launch on the network:
 *   - Microsoft: a live session when Microsoft is reachable, otherwise the
 *     saved premium profile in offline mode (singleplayer / LAN / offline servers).
 *   - Offline and Noctra accounts: always a local session.
 * Returns { authorization, mode: 'microsoft' | 'microsoft-offline' | 'offline' }.
 */
async function getLaunchAuth(account = {}) {
  const name = String(account?.name || account?.username || 'Player').trim() || 'Player';
  const isMicrosoft = account?.type === 'microsoft' || Boolean(account?.useMicrosoft || account?.isMicrosoft);
  if (isMicrosoft) {
    const mc = await withTimeout(getMinecraftSession(account?.id || null), 20_000).catch(() => null);
    const live = mc?.mclc?.() || null;
    if (live) return { authorization: live, mode: 'microsoft' };
    let saved = null;
    try {
      saved = readAccounts().accounts.find((a) => a.id === account?.id && a.type === 'microsoft') || null;
    } catch { /* fall back to what the renderer sent */ }
    return {
      authorization: offlineAuthorization(saved?.name || name, saved?.uuid || account?.uuid || null),
      mode: 'microsoft-offline'
    };
  }
  return { authorization: offlineAuthorization(name, account?.uuid || null), mode: 'offline' };
}

async function getMinecraftAccessToken(accountId, options = {}) {
  const mc = await getMinecraftSession(accountId, options);
  return mc?.mclc?.().access_token || null;
}

async function getMinecraftProfile(accountId, options = {}) {
  const mc = await getMinecraftSession(accountId, options);
  if (mc?.profile) {
    return mc.profile;
  }
  return null;
}

async function noctraAccountFetch(noctraAccount, endpoint, { method = 'GET', body } = {}) {
  const token = noctraAccount?.token || noctraAccount?.sessionToken;
  if (!token) return { ok: false, error: 'Log in to this Noctra account again before connecting Minecraft.' };

  const request = async (root) => {
    const response = await fetch(`${root}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000)
    });
    return response.json();
  };

  for (const root of apiRoots()) {
    try {
      return await request(root);
    } catch { /* try the next configured root */ }
  }
  return { ok: false, error: 'Could not connect to the Noctra account service.' };
}

// Hosted API, plus a self-hosted one only when NOCTRA_LOCAL_API is set.
// Credentials are never sent to whatever happens to listen on localhost.
function apiRoots() {
  return require('./social').API_ROOTS;
}

// ── Premium ↔ Noctra connection ───────────────────────────────────────────
// A Microsoft account can carry a Noctra session (`noctraToken`, encrypted at
// rest) for the Noctra account it is connected to. While that premium account
// is active, Relay, friends and every other Noctra feature use that session,
// so the player never has to switch accounts. The server only hands such a
// session out to someone who proves they own the premium account (a live
// Minecraft access token), so connecting once works on every device.

const NOT_LINKED_RECHECK_MS = 6 * 60 * 60 * 1000;

const cleanUuid = (value) => String(value || '').replace(/-/g, '').toLowerCase();

async function apiRequest(endpoint, { method = 'POST', body, token } = {}) {
  let last = { status: 0, data: { ok: false, error: 'Could not connect to Noctra. Check your connection and try again.' } };
  for (const root of apiRoots()) {
    try {
      const response = await fetch(`${root}${endpoint}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000)
      });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : {}; } catch { data = null; }
      last = { status: response.status, data: data || { ok: false, error: `Noctra returned HTTP ${response.status}.` } };
      if (response.status < 500) return last;
    } catch { /* try the next configured root */ }
  }
  return last;
}

/** What the renderer may know about a connection (never the token). */
function publicLink(account) {
  if (!account || account.type !== 'microsoft' || !account.noctraToken || !account.noctraLink?.userId) return null;
  const { userId, name, email, uuid, model, linkedAt } = account.noctraLink;
  return { connected: true, userId, name, email: email || null, uuid: uuid || null, model: model || 'classic', linkedAt: linkedAt || null };
}

/** The Noctra identity a connected premium account acts as. */
function linkedIdentity(account) {
  const link = publicLink(account);
  if (!link) return null;
  return {
    id: link.userId,
    name: link.name,
    email: link.email,
    uuid: link.uuid,
    model: link.model,
    type: 'noctra',
    token: account.noctraToken,
    linkedFrom: account.id
  };
}

function updateMicrosoftAccount(microsoftId, patch) {
  const data = readAccounts();
  const index = data.accounts.findIndex((a) => a.id === microsoftId && a.type === 'microsoft');
  if (index < 0) return null;
  const next = { ...data.accounts[index], ...patch };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
  }
  data.accounts[index] = next;
  saveAccounts(data);
  return next;
}

function storeLink(microsoftId, noctraAccount, token) {
  const updated = updateMicrosoftAccount(microsoftId, {
    noctraToken: token,
    noctraLink: {
      userId: noctraAccount.id,
      name: noctraAccount.name,
      email: noctraAccount.email || null,
      uuid: noctraAccount.uuid || null,
      model: noctraAccount.model || 'classic',
      linkedAt: Date.now()
    },
    noctraNotLinkedAt: undefined
  });
  return publicLink(updated);
}

function clearLink(microsoftId, { notLinked = false } = {}) {
  updateMicrosoftAccount(microsoftId, {
    noctraToken: undefined,
    noctraLink: undefined,
    noctraNotLinkedAt: notLinked ? Date.now() : undefined
  });
}

/** Sign into the Noctra account connected to this premium account. */
async function premiumSignIn(microsoftId) {
  let minecraftAccessToken = await getMinecraftAccessToken(microsoftId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!minecraftAccessToken) {
      minecraftAccessToken = await getMinecraftAccessToken(microsoftId, { forceRefresh: true });
    }
    if (!minecraftAccessToken) {
      return { ok: false, code: 'microsoft_expired', error: 'Your Microsoft sign-in expired. Sign in with Microsoft again.' };
    }
    const { status, data } = await apiRequest('/v1/auth/minecraft', { body: { minecraftAccessToken } });
    if (data?.ok && data.token && data.account) {
      return { ok: true, link: storeLink(microsoftId, data.account, data.token) };
    }
    if (status === 404 && data?.code === 'not_linked') {
      clearLink(microsoftId, { notLinked: true });
      return { ok: false, code: 'not_linked', error: data.error };
    }
    if (status === 401 && attempt === 0) {
      // A cached Minecraft token can expire early; refresh it once.
      minecraftAccessToken = null;
      continue;
    }
    return { ok: false, code: status === 0 ? 'offline' : 'error', error: data?.error || 'Could not connect to Noctra.' };
  }
  return { ok: false, code: 'error', error: 'Could not connect to Noctra.' };
}

/**
 * Makes sure a premium account is signed into its connected Noctra account:
 * keeps a working session, renews an expired one, and picks up a connection
 * made on another device. `force` skips the "not connected" back-off.
 */
async function ensurePremiumLink(microsoftId, { force = false } = {}) {
  const account = readAccounts().accounts.find((a) => a.id === microsoftId);
  if (!account || account.type !== 'microsoft') return { ok: false, code: 'not_microsoft' };

  if (account.noctraToken) {
    const { status, data } = await apiRequest('/v1/account/minecraft', { method: 'GET', token: account.noctraToken });
    if (status === 0 || status >= 500) {
      // Offline: keep the saved connection, it is checked again later.
      return { ok: true, link: publicLink(account), offline: true };
    }
    if (status === 200 && data?.ok) {
      if (data.profile?.uuid && cleanUuid(data.profile.uuid) === cleanUuid(account.uuid)) {
        return { ok: true, link: publicLink(account) };
      }
      // Disconnected (or moved) on another device.
      clearLink(microsoftId);
    } else {
      clearLink(microsoftId);
    }
    return premiumSignIn(microsoftId);
  }

  if (!force && account.noctraNotLinkedAt && Date.now() - account.noctraNotLinkedAt < NOT_LINKED_RECHECK_MS) {
    return { ok: false, code: 'not_linked' };
  }
  return premiumSignIn(microsoftId);
}

/** Connect a premium account to a Noctra account (saved, or by password). */
async function connectNoctra({ microsoftAccountId, noctraAccountId, login, password } = {}) {
  const accounts = readAccounts().accounts;
  const microsoftAccount = accounts.find((a) => a.id === microsoftAccountId && a.type === 'microsoft');
  if (!microsoftAccount) return { ok: false, error: 'Choose a Microsoft account to connect.' };

  let noctraToken = null;
  let noctraAccount = null;
  let ownSession = false;
  if (noctraAccountId) {
    const saved = accounts.find((a) => a.id === noctraAccountId && a.type === 'noctra');
    noctraToken = saved?.token || saved?.sessionToken || null;
    noctraAccount = saved || null;
    if (!noctraToken) return { ok: false, error: 'Sign in to that Noctra account again, then connect.' };
  } else {
    if (!String(login || '').trim() || !password) {
      return { ok: false, error: 'Enter your Noctra username or email and password.' };
    }
    const { data } = await apiRequest('/v1/auth/login', { body: { login: String(login).trim(), password: String(password) } });
    if (!data?.ok || !data.token || !data.account) return { ok: false, error: data?.error || 'Could not sign in to Noctra.' };
    noctraToken = data.token;
    noctraAccount = data.account;
    ownSession = true;
  }

  const minecraftAccessToken = await getMinecraftAccessToken(microsoftAccountId, { forceRefresh: true });
  if (!minecraftAccessToken) {
    return { ok: false, error: 'Your Microsoft sign-in expired. Sign in with Microsoft again to prove you own Minecraft.' };
  }
  const { data: linked } = await apiRequest('/v1/account/minecraft', {
    method: 'POST',
    token: noctraToken,
    body: { minecraftAccessToken }
  });
  if (!linked?.ok) return { ok: false, error: linked?.error || 'Could not connect the accounts.' };

  if (ownSession) {
    return { ok: true, link: storeLink(microsoftAccountId, noctraAccount, noctraToken), profile: linked.profile };
  }
  // A saved Noctra account: give the premium account its own session so
  // signing out of one never signs out the other.
  const signedIn = await premiumSignIn(microsoftAccountId);
  if (signedIn.ok) return { ...signedIn, profile: linked.profile };
  return { ok: true, link: storeLink(microsoftAccountId, noctraAccount, noctraToken), profile: linked.profile };
}

async function disconnectNoctra(microsoftAccountId) {
  const account = readAccounts().accounts.find((a) => a.id === microsoftAccountId && a.type === 'microsoft');
  if (!account) return { ok: false, error: 'Microsoft account not found.' };
  if (account.noctraToken) {
    const { status, data } = await apiRequest('/v1/account/minecraft', { method: 'DELETE', token: account.noctraToken });
    if (status === 0 || status >= 500) {
      return { ok: false, error: data?.error || 'Could not reach Noctra. Try again when you are online.' };
    }
  }
  clearLink(microsoftAccountId, { notLinked: true });
  return { ok: true, link: null };
}

function init(dependencies, ipcMain) {
  deps = dependencies;

  ipcMain.on('auth-window:minimize', (event) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (target && target === activeAuthWindow) target.minimize();
  });

  ipcMain.on('auth-window:close', (event) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (target && target === activeAuthWindow) target.close();
  });

  // ── Legacy single-account handlers (kept for backward compat) ──────────

  ipcMain.handle('auth:login', async () => {
    try {
      const profile = await loginMicrosoft();
      // Premium accounts connected to Noctra (on any device) sign in automatically.
      const link = await ensurePremiumLink(profile.id, { force: true }).catch(() => null);
      return { ok: true, profile, link: link?.ok ? link.link : null };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  });

  ipcMain.handle('auth:restore', () => {
    const { accounts, activeId } = readAccounts();
    const acc = accounts.find(a => a.id === activeId);
    return acc ? { name: acc.name, uuid: acc.uuid } : null;
  });

  ipcMain.handle('auth:logout', () => {
    const data = readAccounts();
    const id = data.activeId;
    if (id) {
      delete mcSessions[id];
      data.accounts = data.accounts.filter(a => a.id !== id);
      data.activeId = data.accounts[0]?.id ?? null;
      saveAccounts(data);
    }
    return true;
  });

  // ── Multi-account handlers ─────────────────────────────────────────────

  ipcMain.handle('accounts:list', () => {
    const { accounts, activeId } = readAccounts();
    return {
      activeId,
      // never send refresh tokens to the renderer
      accounts: accounts.map(({ refresh: _r, noctraToken: _n, noctraNotLinkedAt: _l, noctraLink: _k, ...rest }, index) => (
        rest.type === 'microsoft' ? { ...rest, noctraLink: publicLink(accounts[index]) } : rest
      ))
    };
  });


  const handleAddNoctraAccount = (_event, payload) => {
    const rawName = typeof payload === 'string' ? payload : payload?.name;
    const name = String(rawName || '').trim();
    const model = payload?.model === 'slim' ? 'slim' : 'classic';
    if (!name) return { ok: false, error: 'Name is required' };
    const data = readAccounts();
    const id = `noctra-${crypto.randomBytes(4).toString('hex')}`;
    const uuid = generateOfflinePlayerUuid(name);
    const account = { id, name, uuid, type: 'noctra', model };
    data.accounts.push(account);
    data.activeId = id;
    saveAccounts(data);
    return { ok: true, account };
  };

  ipcMain.handle('accounts:addNoctra', handleAddNoctraAccount);
  ipcMain.handle('accounts:addNative', handleAddNoctraAccount);

  const authFetch = async (endpoint, payload) => {
    const options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    };
    for (const root of apiRoots()) {
      try {
        const res = await fetch(`${root}${endpoint}`, { ...options, signal: AbortSignal.timeout(20_000) });
        const text = await res.text();
        try { return JSON.parse(text); } catch { return { ok: false, error: `Noctra Auth returned HTTP ${res.status}.` }; }
      } catch { /* try the next configured root */ }
    }
    return { ok: false, error: 'Could not connect to Noctra Auth server.' };
  };

  ipcMain.handle('accounts:noctraSendCode', async (_event, payload) => {
    return authFetch('/v1/auth/register/send-code', payload);
  });

  ipcMain.handle('accounts:noctraResendCode', async (_event, payload) => {
    return authFetch('/v1/auth/resend-code', payload);
  });

  ipcMain.handle('accounts:noctraForgotPassword', async (_event, payload) => {
    return authFetch('/v1/auth/password/forgot', { email: String(payload?.email || '').trim() });
  });

  ipcMain.handle('accounts:noctraResetPassword', async (_event, payload) => {
    const res = await authFetch('/v1/auth/password/reset', {
      email: String(payload?.email || '').trim(),
      code: String(payload?.code || '').trim(),
      password: String(payload?.password || '')
    });
    if (res?.ok) {
      // Every old session for this account was ended on the server; drop the
      // stale local copy so nothing keeps using a dead token.
      const email = String(payload?.email || '').trim().toLowerCase();
      const data = readAccounts();
      const before = data.accounts.length;
      data.accounts = data.accounts.filter((a) => !(a.type === 'noctra' && String(a.email || '').toLowerCase() === email));
      if (data.accounts.length !== before) {
        if (!data.accounts.some((a) => a.id === data.activeId)) data.activeId = data.accounts[0]?.id ?? null;
        saveAccounts(data);
      }
    }
    return res;
  });

  ipcMain.handle('accounts:noctraVerifyRegister', async (_event, payload) => {
    const res = await authFetch('/v1/auth/register/verify', payload);
    if (res?.ok && res?.account) {
      const data = readAccounts();
      const account = {
        id: res.account.id,
        name: res.account.name,
        email: res.account.email,
        uuid: res.account.uuid,
        type: 'noctra',
        model: res.account.model || 'classic',
        token: res.token
      };
      data.accounts = data.accounts.filter(a => a.id !== account.id && a.email !== account.email);
      data.accounts.push(account);
      data.activeId = account.id;
      saveAccounts(data);
      return { ok: true, account };
    }
    return res;
  });

  ipcMain.handle('accounts:noctraLogin', async (_event, payload) => {
    const res = await authFetch('/v1/auth/login', payload);
    if (res?.ok && res?.account) {
      const data = readAccounts();
      const account = {
        id: res.account.id,
        name: res.account.name,
        email: res.account.email,
        uuid: res.account.uuid,
        type: 'noctra',
        model: res.account.model || 'classic',
        token: res.token
      };
      data.accounts = data.accounts.filter(a => a.id !== account.id && a.email !== account.email);
      data.accounts.push(account);
      data.activeId = account.id;
      saveAccounts(data);
      return { ok: true, account };
    }
    return res;
  });

  ipcMain.handle('accounts:addOffline', (_event, name) => {
    const cleanName = String(name || '').trim();
    if (!cleanName) return { ok: false, error: 'Name is required' };
    if (!OFFLINE_NAME.test(cleanName)) {
      return { ok: false, error: 'Use 3–16 letters, numbers or underscores (no spaces).' };
    }
    const data = readAccounts();
    const existing = data.accounts.find((a) => a.type === 'offline' && a.name.toLowerCase() === cleanName.toLowerCase());
    if (existing) {
      data.activeId = existing.id;
      saveAccounts(data);
      return { ok: true, account: existing };
    }
    const id = `offline-${crypto.randomBytes(4).toString('hex')}`;
    const uuid = generateOfflinePlayerUuid(cleanName);
    const account = { id, name: cleanName, uuid, type: 'offline' };
    data.accounts.push(account);
    data.activeId = id;
    saveAccounts(data);
    return { ok: true, account };
  });

  ipcMain.handle('accounts:addMicrosoft', async () => {
    try {
      const profile = await loginMicrosoft();
      return { ok: true, profile };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  });

  ipcMain.handle('accounts:getPremiumLink', async (_event, noctraAccountId) => {
    const data = readAccounts();
    const noctraAccount = data.accounts.find((account) => account.id === noctraAccountId && account.type === 'noctra');
    if (!noctraAccount) return { ok: false, error: 'Noctra account not found.' };
    return noctraAccountFetch(noctraAccount, '/v1/account/minecraft');
  });

  ipcMain.handle('accounts:linkPremium', async (_event, payload = {}) => {
    const data = readAccounts();
    const noctraAccount = data.accounts.find(
      (account) => account.id === payload.noctraAccountId && account.type === 'noctra'
    );
    if (!noctraAccount) return { ok: false, error: 'Noctra account not found.' };

    let microsoftAccountId = payload.microsoftAccountId;
    if (!microsoftAccountId) {
      try {
        const profile = await loginMicrosoft();
        microsoftAccountId = profile.id;
        const updated = readAccounts();
        updated.activeId = noctraAccount.id;
        saveAccounts(updated);
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    }

    const microsoftAccount = readAccounts().accounts.find(
      (account) => account.id === microsoftAccountId && account.type === 'microsoft'
    );
    if (!microsoftAccount) return { ok: false, error: 'Microsoft account not found.' };

    const minecraftAccessToken = await getMinecraftAccessToken(microsoftAccount.id, { forceRefresh: true });
    if (!minecraftAccessToken) {
      return { ok: false, error: 'Microsoft sign-in expired. Sign in again to prove Minecraft ownership.' };
    }
    return noctraAccountFetch(noctraAccount, '/v1/account/minecraft', {
      method: 'POST',
      body: { minecraftAccessToken }
    });
  });

  ipcMain.handle('accounts:unlinkPremium', async (_event, noctraAccountId) => {
    const data = readAccounts();
    const noctraAccount = data.accounts.find((account) => account.id === noctraAccountId && account.type === 'noctra');
    if (!noctraAccount) return { ok: false, error: 'Noctra account not found.' };
    return noctraAccountFetch(noctraAccount, '/v1/account/minecraft', { method: 'DELETE' });
  });

  ipcMain.handle('accounts:premiumStatus', async (_event, microsoftAccountId) => {
    const account = readAccounts().accounts.find((a) => a.id === microsoftAccountId && a.type === 'microsoft');
    return { ok: Boolean(account), link: publicLink(account) };
  });
  ipcMain.handle('accounts:ensureNoctra', async (_event, microsoftAccountId, options = {}) =>
    ensurePremiumLink(microsoftAccountId, { force: Boolean(options?.force) }));
  ipcMain.handle('accounts:connectNoctra', async (_event, payload = {}) => connectNoctra(payload));
  ipcMain.handle('accounts:disconnectNoctra', async (_event, microsoftAccountId) => disconnectNoctra(microsoftAccountId));

  ipcMain.handle('accounts:getAvatar', async (_event, uuid) => {
    const avatarUuid = uuid || 'MHF_Steve';
    const avatarsDir = path.join(deps.app.getPath('userData'), 'avatars');
    const targetPath = path.join(avatarsDir, `${avatarUuid}.png`);

    if (!fs.existsSync(targetPath)) {
      try {
        fs.mkdirSync(avatarsDir, { recursive: true });
        const url = `https://mc-heads.net/avatar/${avatarUuid}/100`;
        const res = await fetch(url);
        if (res.ok) {
          const buffer = Buffer.from(await res.arrayBuffer());
          fs.writeFileSync(targetPath, buffer);
        } else {
          return `https://mc-heads.net/avatar/${avatarUuid}/100`;
        }
      } catch (err) {
        return `https://mc-heads.net/avatar/${avatarUuid}/100`;
      }
    }

    try {
      const data = fs.readFileSync(targetPath);
      return `data:image/png;base64,${data.toString('base64')}`;
    } catch {
      return `https://mc-heads.net/avatar/${avatarUuid}/100`;
    }
  });

  ipcMain.handle('accounts:setActive', (_event, id) => {
    const data = readAccounts();
    if (!data.accounts.find(a => a.id === id)) return false;
    data.activeId = id;
    saveAccounts(data);
    return true;
  });

  ipcMain.handle('accounts:remove', (_event, id) => {
    const data = readAccounts();
    delete mcSessions[id];
    data.accounts = data.accounts.filter(a => a.id !== id);
    if (data.activeId === id) data.activeId = data.accounts[0]?.id ?? null;
    saveAccounts(data);
    return true;
  });
}

module.exports = {
  readAccounts,
  linkedIdentity,
  publicLink,
  ensurePremiumLink,
  connectNoctra,
  disconnectNoctra,
  premiumSignIn,
  init,
  getMclcAuth,
  getLaunchAuth,
  offlineAuthorization,
  generateOfflinePlayerUuid,
  getMinecraftAccessToken,
  getMinecraftProfile
};
