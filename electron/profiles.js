/**
 * Player profiles (Discord-style profile card): GET /v1/profiles/:name plus
 * the signed-in player's own bio/links and launcher playtime totals.
 */
const { socialFetch, API_ROOTS, isOnline } = require('./social');

const NAME_RE = /^[A-Za-z0-9_.\- ]{1,32}$/;

/** Public read: works with or without a Native session. */
async function publicGet(endpoint) {
  if (!isOnline()) return { ok: false, offline: true, error: 'You are offline.' };
  let last = { ok: false, error: 'Could not reach Native.' };
  for (const root of API_ROOTS) {
    try {
      const res = await fetch(`${root}${endpoint}`, { signal: AbortSignal.timeout(12_000) });
      const data = await res.json().catch(() => null);
      if (data && typeof data === 'object') {
        if (res.status < 500) return res.ok ? data : { ok: false, status: res.status, ...data };
        last = { ok: false, error: data.error || `Native returned HTTP ${res.status}.` };
      }
    } catch (err) {
      last = { ok: false, error: err?.name === 'TimeoutError' ? 'Native took too long to respond.' : 'Could not reach Native.' };
    }
  }
  return last;
}

function init(ipcMain) {
  ipcMain.handle('profiles:get', async (_event, name) => {
    const clean = String(name || '').trim();
    if (!NAME_RE.test(clean)) return { ok: false, error: 'Unknown player.' };
    return publicGet(`/v1/profiles/${encodeURIComponent(clean)}`);
  });

  ipcMain.handle('profiles:view', async (_event, name) => {
    const clean = String(name || '').trim();
    if (!NAME_RE.test(clean)) return { ok: false };
    return socialFetch(`/v1/profiles/${encodeURIComponent(clean)}/view`, { method: 'POST', body: {} });
  });

  ipcMain.handle('profiles:saveAbout', async (_event, about = {}) => {
    const links = Array.isArray(about.links) ? about.links.slice(0, 8) : [];
    return socialFetch('/v1/profiles/me/about', { method: 'POST', body: { bio: String(about.bio || '').slice(0, 280), links } });
  });

  ipcMain.handle('profiles:reportStats', async (_event, stats = {}) => {
    const body = {
      playtimeSecs: Math.max(0, Math.round(Number(stats.playtimeSecs) || 0)),
      sessions: Math.max(0, Math.round(Number(stats.sessions) || 0)),
      lastPlayed: Math.max(0, Math.round(Number(stats.lastPlayed) || 0))
    };
    return socialFetch('/v1/profiles/me/stats', { method: 'POST', body });
  });
}

module.exports = { init };
