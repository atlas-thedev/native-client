const { ipcMain } = require('electron');
const { getActiveNativeAccount, API_ROOTS } = require('./social');

const ROOTS = API_ROOTS;
const ADMIN_REQUEST_PATH = /^\/(site|polls|beta|store|billing|users|overview|domains)(\/[A-Za-z0-9_\-.%]+)*(\?[^#\s]*)?$/;

async function adminFetch(pathname, { method = 'GET', body = null, timeout = 15_000 } = {}) {
  const account = getActiveNativeAccount();
  const token = account?.token || account?.sessionToken;
  if (!token) return { ok: false, isAdmin: false, error: 'Sign in to a Native account.' };

  let lastError = 'Admin service is unreachable.';
  for (const root of ROOTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`${root}/v1/admin${pathname}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
      const text = await response.text();
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = { ok: false, error: text }; }
      if (!response.ok) {
        lastError = payload.error || `Admin request failed (${response.status}).`;
        if (response.status < 500) return { ok: false, isAdmin: false, error: lastError };
        continue;
      }
      return payload;
    } catch (error) {
      lastError = error?.name === 'AbortError' ? 'Admin request timed out.' : (error?.message || lastError);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, isAdmin: false, error: lastError };
}

function init() {
  const handle = (channel, fn) => {
    ipcMain.removeHandler?.(channel);
    ipcMain.handle(channel, (_event, ...args) => fn(...args));
  };

  handle('admin:status', () => adminFetch('/status'));
  handle('admin:overview', () => adminFetch('/overview'));
  handle('admin:listUsers', (options = {}) => {
    const query = new URLSearchParams({
      query: String(options.query || ''),
      page: String(options.page || 1),
      pageSize: String(options.pageSize || 50)
    });
    return adminFetch(`/users?${query.toString()}`);
  });
  handle('admin:storeItems', () => adminFetch('/store/items'));
  handle('admin:storeCreate', (item = {}) => adminFetch('/store/items', { method: 'POST', body: item, timeout: 60_000 }));
  handle('admin:storeUpdate', (id, patch = {}) => adminFetch(`/store/items/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch, timeout: 60_000 }));
  handle('admin:storeDelete', (id) => adminFetch(`/store/items/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  handle('admin:storeOwners', (id) => adminFetch(`/store/items/${encodeURIComponent(id)}/owners`));
  handle('admin:storeGrant', (id, username) => adminFetch(`/store/items/${encodeURIComponent(id)}/grant`, { method: 'POST', body: { username: String(username || '') } }));
  handle('admin:storeRevoke', (id, username) => adminFetch(`/store/items/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: { username: String(username || '') } }));
  handle('admin:getUser', (userId) => adminFetch(`/store/users/${encodeURIComponent(userId)}`));
  handle('admin:userCape', (userId, itemId, action = 'grant') =>
    adminFetch(`/store/users/${encodeURIComponent(userId)}/capes`, {
      method: 'POST',
      body: { itemId: itemId == null ? null : String(itemId), action: String(action || 'grant') }
    }));
  handle('admin:setAdmin', (userId, isAdmin) =>
    adminFetch(`/users/${encodeURIComponent(userId)}/admin`, { method: 'POST', body: { isAdmin: Boolean(isAdmin) } }));
  handle('admin:revokeSessions', (userId) =>
    adminFetch(`/users/${encodeURIComponent(userId)}/sessions/revoke`, { method: 'POST', body: {} }));
  handle('admin:billingOverview', () => adminFetch('/billing/overview'));
  handle('admin:billingCodes', () => adminFetch('/billing/codes'));
  handle('admin:billingCreateCode', (payload = {}) => adminFetch('/billing/codes', { method: 'POST', body: payload }));
  handle('admin:billingDeleteCode', (code) => adminFetch(`/billing/codes/${encodeURIComponent(code)}`, { method: 'DELETE' }));
  handle('admin:plusGifts', () => adminFetch('/billing/plus'));
  handle('admin:givePlus', (payload = {}) => adminFetch('/billing/plus', {
    method: 'POST',
    body: { username: String(payload.username || ''), days: Number(payload.days) || 0, note: String(payload.note || '') }
  }));
  handle('admin:removePlus', (userId) => adminFetch(`/billing/plus/${encodeURIComponent(String(userId || ''))}`, { method: 'DELETE' }));
  handle('admin:billingSettings', () => adminFetch('/billing/settings'));
  handle('admin:billingSaveSettings', (payload = {}) => adminFetch('/billing/settings', { method: 'POST', body: payload }));
  handle('admin:billingSetup', () => adminFetch('/billing/setup', { method: 'POST', body: {} }));
  handle('admin:billingActivate', (mode) => adminFetch('/billing/activate', { method: 'POST', body: { mode: String(mode || '') } }));
  // beta updates channel
  handle('admin:betaTesters', (q = '') => adminFetch(`/beta/testers?q=${encodeURIComponent(String(q || ''))}`));
  handle('admin:betaAddTester', (username, note = '') => adminFetch('/beta/testers', { method: 'POST', body: { username: String(username || ''), note: String(note || '') } }));
  handle('admin:betaSetTester', (userId, enabled) => adminFetch(`/beta/testers/${encodeURIComponent(String(userId || ''))}`, { method: 'PATCH', body: { enabled: enabled === true ? true : enabled === false ? false : null } }));
  handle('admin:betaRemoveTester', (userId) => adminFetch(`/beta/testers/${encodeURIComponent(String(userId || ''))}`, { method: 'DELETE' }));
  handle('admin:betaUpdates', (patch = {}) => adminFetch('/beta/updates', { method: 'POST', body: { ...(patch.enabled !== undefined ? { enabled: Boolean(patch.enabled) } : {}), ...(patch.includeAccepted !== undefined ? { includeAccepted: Boolean(patch.includeAccepted) } : {}) } }));
  // Website settings, offers, votes and beta applications (everything the old website admin did).
  handle('admin:request', (method = 'GET', pathname = '', body = null) => {
    const verb = String(method || 'GET').toUpperCase();
    const target = String(pathname || '');
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(verb)) return { ok: false, error: 'Unsupported method.' };
    if (!ADMIN_REQUEST_PATH.test(target) || target.includes('..')) return { ok: false, error: 'Not found.' };
    return adminFetch(target, { method: verb, body: verb === 'GET' ? null : (body || {}), timeout: 60_000 });
  });
  handle('admin:setBadge', (userId, badge, granted) =>
    adminFetch(`/users/${encodeURIComponent(userId)}/badges`, {
      method: 'POST',
      body: { badge, granted: Boolean(granted) }
    }));
}

module.exports = { init, adminFetch };
