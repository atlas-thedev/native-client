const { ipcMain } = require('electron');
const { getActiveNoctraAccount, API_ROOTS, isOnline } = require('./social');

/**
 * IPC bridge for the Relay group + reply API.
 *
 * Mirrors social.js: the hosted API, plus a self-hosted one only when
 * NOCTRA_LOCAL_API is set explicitly.
 */

const ROOTS = API_ROOTS;

async function relayFetch(pathname, { method = 'GET', body = null, timeout = 15_000 } = {}) {
  const account = getActiveNoctraAccount();
  const token = account?.token || account?.sessionToken;
  if (!token) return { ok: false, error: 'Sign in to a Noctra account to use Relay.' };
  if (!isOnline()) return { ok: false, offline: true, error: 'You are offline.' };

  let lastError = 'Relay is unreachable.';

  for (const root of ROOTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`${root}/v1/social/relay${pathname}`, {
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
        lastError = payload.error || `Relay request failed (${response.status}).`;
        // Auth and validation failures are final; only transport errors retry.
        if (response.status < 500) return { ok: false, error: lastError };
        continue;
      }
      return payload;
    } catch (error) {
      lastError = error?.name === 'AbortError' ? 'Relay request timed out.' : (error?.message || lastError);
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, error: lastError };
}

const q = (params = {}) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
};

function init() {
  const handle = (channel, fn) => {
    ipcMain.removeHandler?.(channel);
    ipcMain.handle(channel, (_event, ...args) => fn(...args));
  };

  handle('relay:getGroups', () => relayFetch('/groups'));
  handle('relay:getGroup', (groupId) => relayFetch(`/groups/${encodeURIComponent(groupId)}`));
  handle('relay:createGroup', (payload) => relayFetch('/groups', { method: 'POST', body: payload || {} }));
  handle('relay:updateGroup', (groupId, payload) =>
    relayFetch(`/groups/${encodeURIComponent(groupId)}/update`, { method: 'POST', body: payload || {} }));
  handle('relay:deleteGroup', (groupId) =>
    relayFetch(`/groups/${encodeURIComponent(groupId)}/delete`, { method: 'POST', body: {} }));
  handle('relay:leaveGroup', (groupId) =>
    relayFetch(`/groups/${encodeURIComponent(groupId)}/leave`, { method: 'POST', body: {} }));
  handle('relay:addMembers', (groupId, userIds) =>
    relayFetch(`/groups/${encodeURIComponent(groupId)}/members`, { method: 'POST', body: { userIds } }));
  handle('relay:removeMember', (groupId, userId) =>
    relayFetch(`/groups/${encodeURIComponent(groupId)}/members/remove`, { method: 'POST', body: { userId } }));
  handle('relay:setMemberRole', (groupId, userId, role) =>
    relayFetch(`/groups/${encodeURIComponent(groupId)}/members/role`, { method: 'POST', body: { userId, role } }));
  handle('relay:setGroupPrefs', (groupId, prefs) =>
    relayFetch(`/groups/${encodeURIComponent(groupId)}/prefs`, { method: 'POST', body: prefs || {} }));
  handle('relay:markGroupRead', (groupId) =>
    relayFetch(`/groups/${encodeURIComponent(groupId)}/read`, { method: 'POST', body: {} }));
  handle('relay:setGroupTyping', (groupId, isTyping) =>
    relayFetch(`/groups/${encodeURIComponent(groupId)}/typing`, { method: 'POST', body: { isTyping } }));
  handle('relay:getGroupMessages', (groupId, options = {}) =>
    relayFetch(`/groups/${encodeURIComponent(groupId)}/messages${q(options)}`));
  handle('relay:sendGroupMessage', (groupId, payload) =>
    relayFetch(`/groups/${encodeURIComponent(groupId)}/messages`, { method: 'POST', body: payload || {} }));

  handle('relay:reactToGroupMessage', (messageId, reaction) =>
    relayFetch(`/messages/${encodeURIComponent(messageId)}/react`, { method: 'POST', body: { reaction } }));
  handle('relay:editGroupMessage', (messageId, content) =>
    relayFetch(`/messages/${encodeURIComponent(messageId)}/edit`, { method: 'POST', body: { content } }));
  handle('relay:deleteGroupMessage', (messageId) =>
    relayFetch(`/messages/${encodeURIComponent(messageId)}/delete`, { method: 'POST', body: {} }));

  handle('relay:getDirectMessages', (friendId, options = {}) =>
    relayFetch(`/dm/${encodeURIComponent(friendId)}/messages${q(options)}`));
  handle('relay:sendDirectMessage', (friendId, payload) =>
    relayFetch(`/dm/${encodeURIComponent(friendId)}/messages`, { method: 'POST', body: payload || {} }));
  handle('relay:editDirectMessage', (messageId, content) =>
    relayFetch(`/dm-messages/${encodeURIComponent(messageId)}/edit`, { method: 'POST', body: { content } }));
  handle('relay:deleteDirectMessage', (messageId) =>
    relayFetch(`/dm-messages/${encodeURIComponent(messageId)}/delete`, { method: 'POST', body: {} }));
}

module.exports = { init, relayFetch };
