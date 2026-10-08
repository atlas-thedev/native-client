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

// Secrets at rest: Microsoft refresh data and Native session tokens are
// encrypted with the OS keychain (safeStorage) whenever it is available.
const SECRET_FIELDS = ['token', 'sessionToken', 'nativeToken'];

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

/** Accounts saved before the rename used `noctra*` names; they are upgraded in place when read. */
function upgradeLegacyAccount(account) {
  const next = { ...account };
  if (next.type === 'noctra') next.type = 'native';
  for (const [from, to] of [['noctraToken', 'nativeToken'], ['noctraLink', 'nativeLink'], ['noctraNotLinkedAt', 'nativeNotLinkedAt']]) {
    if (from in next) {
      if (next[to] === undefined) next[to] = next[from];
      delete next[from];
    }
  }
  return next;
}

function revealAccount(account) {
  if (!account || typeof account !== 'object') return account;
  const next = upgradeLegacyAccount(account);
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
  const now = Date.now();
  const protectedData = {
    ...data,
    accounts: (data.accounts || []).map((account) => {
      const next = { ...account, refresh: protectRefresh(account.refresh) };
      // the login screen shows when each saved account was last used
      if (account.id === data.activeId) next.lastUsedAt = now;
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
      title: 'Sign in to Microsoft — Native Client',
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
    // Re-signing into Microsoft keeps the connected Native account.
    ...(previous?.nativeToken ? { nativeToken: previous.nativeToken, nativeLink: previous.nativeLink } : {})
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
 *   - Offline and Native accounts: always a local session.
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

function apiRoots() {
  return require('./social').API_ROOTS;
}

// ── Premium accounts ──────────────────────────────────────────────────────
// Signing in with Microsoft is also the Native account: the server creates one
// named after the Minecraft profile the first time (no email or password). The
// Microsoft account carries that Native session (`nativeToken`, encrypted at
// rest); Relay, friends and the store use it. It can be merged once into an
// email Native account, which then takes the Minecraft name.

const cleanUuid = (value) => String(value || '').replace(/-/g, '').toLowerCase();

async function apiRequest(endpoint, { method = 'POST', body, token } = {}) {
  let last = { status: 0, data: { ok: false, error: 'Could not connect to Native. Check your connection and try again.' } };
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
      last = { status: response.status, data: data || { ok: false, error: `Native returned HTTP ${response.status}.` } };
      if (response.status < 500) return last;
    } catch { /* try the next configured root */ }
  }
  return last;
}

/** What the renderer may know about a connection (never the token). */
function publicLink(account) {
  if (!account || account.type !== 'microsoft' || !account.nativeToken || !account.nativeLink?.userId) return null;
  const { userId, name, email, uuid, model, linkedAt, type } = account.nativeLink;
  return { connected: true, userId, name, email: email || null, uuid: uuid || null, model: model || 'classic', linkedAt: linkedAt || null, type: type || (email ? 'merged' : 'premium') };
}

/** The Native identity a connected premium account acts as. */
function linkedIdentity(account) {
  const link = publicLink(account);
  if (!link) return null;
  return {
    id: link.userId,
    name: link.name,
    email: link.email,
    uuid: link.uuid,
    model: link.model,
    type: 'native',
    token: account.nativeToken,
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

function storeLink(microsoftId, nativeAccount, token) {
  const updated = updateMicrosoftAccount(microsoftId, {
    nativeToken: token,
    nativeLink: {
      userId: nativeAccount.id,
      name: nativeAccount.name,
      email: nativeAccount.email || null,
      uuid: nativeAccount.uuid || null,
      model: nativeAccount.model || 'classic',
      type: nativeAccount.authType === 'merged' || nativeAccount.type === 'merged' || nativeAccount.email ? 'merged' : 'premium',
      linkedAt: Date.now()
    },
    nativeNotLinkedAt: undefined
  });
  return publicLink(updated);
}

/** Token + Native user id for a saved account (Native, or premium connected to Native). */
function nativeSessionOf(account) {
  if (!account) return null;
  if (account.type === 'native') {
    const token = account.token || account.sessionToken;
    return token ? { token, userId: account.id } : null;
  }
  if (account.type === 'microsoft' && account.nativeToken && account.nativeLink?.userId) {
    return { token: account.nativeToken, userId: account.nativeLink.userId };
  }
  return null;
}

/** Writes a new Native name everywhere this launcher remembers it. */
function applyNativeName(userId, name) {
  if (!userId || !name) return false;
  const data = readAccounts();
  let changed = false;
  data.accounts = data.accounts.map((account) => {
    if (account.type === 'native' && account.id === userId && account.name !== name) {
      changed = true;
      return { ...account, name };
    }
    if (account.type === 'microsoft' && account.nativeLink?.userId === userId && account.nativeLink.name !== name) {
      changed = true;
      return { ...account, nativeLink: { ...account.nativeLink, name } };
    }
    return account;
  });
  if (changed) saveAccounts(data);
  return changed;
}

/** Picks up Native names changed elsewhere (e.g. a premium owner claimed one). */
async function refreshNativeNames() {
  const seen = new Set();
  let changed = false;
  for (const account of readAccounts().accounts) {
    const session = nativeSessionOf(account);
    if (!session || seen.has(session.userId)) continue;
    seen.add(session.userId);
    const { status, data } = await apiRequest('/v1/account/minecraft', { method: 'GET', token: session.token });
    if (status === 200 && data?.account?.id === session.userId && data.account.name) {
      if (applyNativeName(session.userId, data.account.name)) changed = true;
    }
  }
  return { ok: true, changed };
}

function clearLink(microsoftId) {
  updateMicrosoftAccount(microsoftId, { nativeToken: undefined, nativeLink: undefined, nativeNotLinkedAt: undefined });
}

/** Sign into (or create) the Native account of this premium account. */
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
    if (status === 401 && attempt === 0) {
      // A cached Minecraft token can expire early; refresh it once.
      minecraftAccessToken = null;
      continue;
    }
    return { ok: false, code: status === 0 ? 'offline' : 'error', error: data?.error || 'Could not connect to Native.' };
  }
  return { ok: false, code: 'error', error: 'Could not connect to Native.' };
}

/**
 * Makes sure a premium account is signed into its Native account: keeps a
 * working session and renews an expired or revoked one.
 */
async function ensurePremiumLink(microsoftId) {
  const account = readAccounts().accounts.find((a) => a.id === microsoftId);
  if (!account || account.type !== 'microsoft') return { ok: false, code: 'not_microsoft' };

  if (account.nativeToken) {
    const { status, data } = await apiRequest('/v1/account/minecraft', { method: 'GET', token: account.nativeToken });
    if (status === 0 || status >= 500) {
      // Offline: keep the saved session, it is checked again later.
      return { ok: true, link: publicLink(account), offline: true };
    }
    if (status === 200 && data?.ok && data.profile?.uuid && cleanUuid(data.profile.uuid) === cleanUuid(account.uuid)) {
      if (data.account?.name) applyNativeName(data.account.id, data.account.name);
      if (data.account?.type && account.nativeLink?.type !== data.account.type) {
        updateMicrosoftAccount(microsoftId, { nativeLink: { ...account.nativeLink, type: data.account.type } });
      }
      return { ok: true, link: publicLink(readAccounts().accounts.find((a) => a.id === microsoftId)) };
    }
    clearLink(microsoftId);
  }
  return premiumSignIn(microsoftId);
}

/** Ends a Native session on the server (best effort, never blocks signing out). */
function revokeNativeSession(token) {
  if (!token) return;
  apiRequest('/v1/auth/logout', { token }).catch(() => {});
}

/**
 * Merges a premium account into an email Native account (one-way). The email
 * account keeps its email and password, takes the Minecraft name, and gets
 * everything the premium account had.
 */
async function mergeNative({ microsoftAccountId, login, password } = {}) {
  const accounts = readAccounts().accounts;
  const microsoftAccount = accounts.find((a) => a.id === microsoftAccountId && a.type === 'microsoft');
  if (!microsoftAccount) return { ok: false, error: 'Choose a Microsoft account to merge.' };
  if (!String(login || '').trim() || !password) return { ok: false, error: 'Enter your Native email or username and password.' };
  let session = await ensurePremiumLink(microsoftAccountId);
  if (!session.ok) return { ok: false, error: session.error || 'Sign in with Microsoft again, then merge.' };
  const token = readAccounts().accounts.find((a) => a.id === microsoftAccountId)?.nativeToken;
  const { status, data } = await apiRequest('/v1/account/merge', { token, body: { login: String(login).trim(), password: String(password) } });
  if (!data?.ok || !data.token || !data.account) {
    return { ok: false, error: data?.error || (status === 0 ? 'Could not reach Native. Try again when you are online.' : 'Could not merge the accounts.') };
  }
  const link = storeLink(microsoftAccountId, { ...data.account, type: 'merged' }, data.token);
  // The email account now signs in through Microsoft: drop its separate saved copy.
  const next = readAccounts();
  const before = next.accounts.length;
  next.accounts = next.accounts.filter((a) => !(a.type === 'native' && a.id === data.account.id));
  if (next.accounts.length !== before) {
    if (!next.accounts.some((a) => a.id === next.activeId)) next.activeId = microsoftAccountId;
    saveAccounts(next);
  }
  return { ok: true, link };
}

/** Opens playnative.fun signed in as this account (one-time, 60-second link). */
async function openWebsite(accountId) {
  const { shell } = require('electron');
  const accounts = readAccounts().accounts;
  const account = accounts.find((a) => a.id === (accountId || readAccounts().activeId));
  if (account?.type === 'microsoft') await ensurePremiumLink(account.id).catch(() => null);
  const session = nativeSessionOf(readAccounts().accounts.find((a) => a.id === account?.id));
  const site = 'https://playnative.fun';
  if (!session) {
    await shell.openExternal(`${site}/login`);
    return { ok: true, signedIn: false };
  }
  const { data } = await apiRequest('/v1/auth/web-link', { token: session.token });
  if (!data?.ok || !data.code) {
    await shell.openExternal(`${site}/login`);
    return { ok: true, signedIn: false };
  }
  await shell.openExternal(`${site}/api/auth/link?code=${encodeURIComponent(data.code)}`);
  return { ok: true, signedIn: true };
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
      // Every premium account is a Native account: sign it in (or create it) right away.
      const link = await ensurePremiumLink(profile.id).catch(() => null);
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
      revokeNativeSession(nativeSessionOf(data.accounts.find((a) => a.id === id))?.token);
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
      accounts: accounts.map(({ refresh: _r, nativeToken: _n, nativeNotLinkedAt: _l, nativeLink: _k, ...rest }, index) => (
        rest.type === 'microsoft' ? { ...rest, nativeLink: publicLink(accounts[index]) } : rest
      ))
    };
  });


  const handleAddNativeAccount = (_event, payload) => {
    const rawName = typeof payload === 'string' ? payload : payload?.name;
    const name = String(rawName || '').trim();
    const model = payload?.model === 'slim' ? 'slim' : 'classic';
    if (!name) return { ok: false, error: 'Name is required' };
    const data = readAccounts();
    const id = `native-${crypto.randomBytes(4).toString('hex')}`;
    const uuid = generateOfflinePlayerUuid(name);
    const account = { id, name, uuid, type: 'native', model };
    data.accounts.push(account);
    data.activeId = id;
    saveAccounts(data);
    return { ok: true, account };
  };

  ipcMain.handle('accounts:addNative', handleAddNativeAccount);

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
        try { return JSON.parse(text); } catch { return { ok: false, error: `Native Auth returned HTTP ${res.status}.` }; }
      } catch { /* try the next configured root */ }
    }
    return { ok: false, error: 'Could not connect to Native Auth server.' };
  };

  ipcMain.handle('accounts:nativeSendCode', async (_event, payload) => {
    return authFetch('/v1/auth/register/send-code', payload);
  });

  ipcMain.handle('accounts:nativeResendCode', async (_event, payload) => {
    return authFetch('/v1/auth/resend-code', payload);
  });

  ipcMain.handle('accounts:nativeForgotPassword', async (_event, payload) => {
    return authFetch('/v1/auth/password/forgot', { email: String(payload?.email || '').trim() });
  });

  ipcMain.handle('accounts:nativeResetPassword', async (_event, payload) => {
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
      data.accounts = data.accounts.filter((a) => !(a.type === 'native' && String(a.email || '').toLowerCase() === email));
      if (data.accounts.length !== before) {
        if (!data.accounts.some((a) => a.id === data.activeId)) data.activeId = data.accounts[0]?.id ?? null;
        saveAccounts(data);
      }
    }
    return res;
  });

  ipcMain.handle('accounts:nativeVerifyRegister', async (_event, payload) => {
    const res = await authFetch('/v1/auth/register/verify', payload);
    if (res?.ok && res?.account) {
      const data = readAccounts();
      const account = {
        id: res.account.id,
        name: res.account.name,
        email: res.account.email,
        uuid: res.account.uuid,
        type: 'native',
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

  ipcMain.handle('accounts:nativeLogin', async (_event, payload) => {
    const res = await authFetch('/v1/auth/login', payload);
    if (res?.ok && res?.account) {
      const data = readAccounts();
      const account = {
        id: res.account.id,
        name: res.account.name,
        email: res.account.email,
        uuid: res.account.uuid,
        type: 'native',
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
      const link = await ensurePremiumLink(profile.id).catch(() => null);
      return { ok: true, profile, link: link?.ok ? link.link : null };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  });

  ipcMain.handle('accounts:premiumStatus', async (_event, microsoftAccountId) => {
    const account = readAccounts().accounts.find((a) => a.id === microsoftAccountId && a.type === 'microsoft');
    return { ok: Boolean(account), link: publicLink(account) };
  });
  ipcMain.handle('accounts:ensureNative', async (_event, microsoftAccountId) => ensurePremiumLink(microsoftAccountId));
  ipcMain.handle('accounts:merge', async (_event, payload = {}) => mergeNative(payload));
  ipcMain.handle('accounts:openWebsite', async (_event, accountId) => openWebsite(accountId).catch((error) => ({ ok: false, error: String(error?.message || error) })));
  ipcMain.handle('accounts:refreshNames', async () => refreshNativeNames().catch(() => ({ ok: false, changed: false })));

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
    revokeNativeSession(nativeSessionOf(data.accounts.find((a) => a.id === id))?.token);
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
  mergeNative,
  openWebsite,
  premiumSignIn,
  init,
  getMclcAuth,
  getLaunchAuth,
  offlineAuthorization,
  generateOfflinePlayerUuid,
  getMinecraftAccessToken,
  getMinecraftProfile
};
