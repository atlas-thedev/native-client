const { ipcMain } = require('electron');
const { getActiveNoctraAccount, API_ROOTS } = require('./social');

const ROOTS = API_ROOTS;

async function adminFetch(pathname, { method = 'GET', body = null, timeout = 15_000 } = {}) {
  const account = getActiveNoctraAccount();
  const token = account?.token || account?.sessionToken;
  if (!token) return { ok: false, isAdmin: false, error: 'Sign in to a Noctra account.' };

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
  handle('admin:setBadge', (userId, badge, granted) =>
    adminFetch(`/users/${encodeURIComponent(userId)}/badges`, {
      method: 'POST',
      body: { badge, granted: Boolean(granted) }
    }));
}

module.exports = { init, adminFetch };
