const path = require('path');
const fs = require('fs');

/**
 * Noctra Social & Friends System (Main Process).
 *
 * Provides:
 * - A persistent Server-Sent-Events connection to the Relay backend, so
 *   messages, reactions, typing, presence, requests and read receipts arrive
 *   in real time instead of being polled.
 * - Friends list, request handling, direct messaging, blocking and unblocking
 * - Bulk conversation preloading (every thread, not just the open one)
 * - Local fallback caching for instant frame-1 rendering
 * - Strict authentication against Noctra accounts only
 */

const REMOTE_ROOT = String(process.env.NATIVE_WARDROBE_API || 'https://api.nativelaunch.xyz').replace(/\/+$/, '');
const LOCAL_ROOT = 'http://127.0.0.1:3418';
const STREAM_SILENCE_MS = Number(process.env.NOCTRA_STREAM_SILENCE_MS) || 70_000;

let deps = null;
let heartbeatInterval = null;
let currentPresence = {
  status: 'in-launcher',
  activity: 'In Launcher',
  serverAddress: null
};

// Realtime stream state
let streamController = null;
let streamRunning = false;
let streamStopped = false;
let streamAttempt = 0;
let streamAccountId = null;
let streamStatus = 'idle';
let reconnectTimer = null;

const cachePath = () => path.join(deps.app.getPath('userData'), 'social-cache.json');

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
  } catch {
    return { friends: [], requests: { received: [], sent: [] }, messages: {}, conversations: {} };
  }
}

function writeCache(updater) {
  try {
    const current = readCache();
    const updated = typeof updater === 'function' ? updater(current) : { ...current, ...updater };
    fs.writeFileSync(cachePath(), JSON.stringify(updated, null, 2));
  } catch {}
}

function getActiveNoctraAccount() {
  try {
    const accountsPath = path.join(deps.app.getPath('userData'), 'accounts.json');
    if (!fs.existsSync(accountsPath)) return null;
    const data = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
    const active = (data.accounts || []).find(a => a.id === data.activeId);
    if (active && active.type === 'noctra' && (active.token || active.sessionToken)) {
      return active;
    }
  } catch {}
  return null;
}

function tokenOf(account) {
  return account?.token || account?.sessionToken || null;
}

async function socialFetch(endpoint, { method = 'GET', body = null, token = null } = {}) {
  const account = getActiveNoctraAccount();
  const authToken = token || tokenOf(account);
  if (!authToken) {
    return { ok: false, error: 'No active Noctra account session found.' };
  }

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${authToken}`
  };

  const reqOptions = {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  };

  try {
    const res = await fetch(`${REMOTE_ROOT}${endpoint}`, reqOptions);
    return await res.json();
  } catch (remoteErr) {
    try {
      const localRes = await fetch(`${LOCAL_ROOT}${endpoint}`, reqOptions);
      return await localRes.json();
    } catch {
      return { ok: false, error: 'Could not connect to Noctra Social service.' };
    }
  }
}

function sendToWindow(channel, payload) {
  const win = deps?.getWin?.();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function setStreamStatus(status, detail = null) {
  if (streamStatus === status && !detail) return;
  streamStatus = status;
  sendToWindow('social:streamStatus', { status, detail, at: Date.now() });
}

// ── Realtime event stream ──────────────────────────────────────────────────

function handleStreamFrame(block) {
  const lines = block.split('\n');
  let dataLines = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue; // heartbeat comment
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return;
  try {
    const payload = JSON.parse(dataLines.join('\n'));
    if (payload && payload.type && payload.type !== 'hello') {
      sendToWindow('social:event', payload);
    }
  } catch {}
}

async function connectStreamOnce(root, token) {
  const controller = new AbortController();
  streamController = controller;

  const res = await fetch(`${root}/v1/social/stream`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'text/event-stream'
    },
    signal: controller.signal
  });

  if (!res.ok || !res.body) {
    throw new Error(`Stream refused (${res.status})`);
  }

  streamAttempt = 0;
  setStreamStatus('connected', root);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // The server pings every 15s. Silence for longer means the socket died
  // quietly (sleep/resume, NAT timeout), so drop it and reconnect.
  let watchdog = null;
  const arm = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => { try { controller.abort(); } catch {} }, STREAM_SILENCE_MS);
  };
  arm();

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      arm();
      buffer += decoder.decode(value, { stream: true });

      let split = buffer.indexOf('\n\n');
      while (split !== -1) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        handleStreamFrame(block);
        split = buffer.indexOf('\n\n');
      }
    }
  } finally {
    clearTimeout(watchdog);
  }
}

async function streamLoop() {
  if (streamRunning) return;
  streamRunning = true;
  streamStopped = false;

  while (!streamStopped) {
    const account = getActiveNoctraAccount();
    const token = tokenOf(account);
    if (!token) {
      setStreamStatus('signed-out');
      break;
    }
    streamAccountId = account.id;

    let connected = false;
    for (const root of [REMOTE_ROOT, LOCAL_ROOT]) {
      if (streamStopped) break;
      try {
        setStreamStatus(streamAttempt === 0 ? 'connecting' : 'reconnecting', root);
        await connectStreamOnce(root, token);
        connected = true;
        break; // stream ended cleanly; reconnect through the outer loop
      } catch (err) {
        if (streamStopped || err?.name === 'AbortError') break;
      }
    }

    if (streamStopped) break;

    streamAttempt = connected ? 1 : streamAttempt + 1;
    setStreamStatus('disconnected');

    // Exponential backoff, capped at 15s, with jitter.
    const delay = Math.min(15_000, 700 * Math.pow(1.7, Math.min(streamAttempt, 8))) + Math.random() * 400;
    await new Promise((resolve) => {
      reconnectTimer = setTimeout(resolve, delay);
    });
  }

  streamRunning = false;
}

function startStream() {
  if (streamRunning) return;
  streamLoop().catch(() => { streamRunning = false; });
}

function stopStream() {
  streamStopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  try { streamController?.abort(); } catch {}
  streamController = null;
  streamRunning = false;
  setStreamStatus('idle');
}

/** Reconnect when the active account changes (sign in / account switch). */
function syncStreamWithAccount() {
  const account = getActiveNoctraAccount();
  const id = account?.id || null;
  if (id === streamAccountId && streamRunning) return;
  stopStream();
  if (id) startStream();
}

// ── Presence ───────────────────────────────────────────────────────────────

function setPresence({ status, activity, serverAddress = null }) {
  currentPresence = {
    status: status || currentPresence.status,
    activity: activity || currentPresence.activity,
    serverAddress: serverAddress !== undefined ? serverAddress : currentPresence.serverAddress
  };

  sendToWindow('social:presenceUpdated', currentPresence);

  const token = tokenOf(getActiveNoctraAccount());
  if (token) {
    socialFetch('/v1/social/presence', {
      method: 'POST',
      body: currentPresence,
      token
    }).catch(() => {});
  }
}

function getPresence() {
  return currentPresence;
}

function init(dependencies, ipcMain) {
  deps = dependencies;

  // Send initial presence immediately
  const initialToken = tokenOf(getActiveNoctraAccount());
  if (initialToken) {
    socialFetch('/v1/social/presence', {
      method: 'POST',
      body: currentPresence,
      token: initialToken
    }).catch(() => {});
  }

  startStream();

  // Presence heartbeat doubles as the account-change watcher.
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    syncStreamWithAccount();
    const token = tokenOf(getActiveNoctraAccount());
    if (token) {
      socialFetch('/v1/social/presence', {
        method: 'POST',
        body: currentPresence,
        token
      }).catch(() => {});
    }
  }, 10_000);

  ipcMain.handle('social:getFriends', async () => {
    const cache = readCache();
    const res = await socialFetch('/v1/social/friends');
    if (res?.ok && Array.isArray(res.friends)) {
      writeCache(c => ({ ...c, friends: res.friends }));
      return { ok: true, friends: res.friends };
    }
    return { ok: false, friends: cache.friends || [], error: res?.error };
  });

  ipcMain.handle('social:getStats', async () => {
    return await socialFetch('/v1/social/stats');
  });

  ipcMain.handle('social:getRequests', async () => {
    const cache = readCache();
    const res = await socialFetch('/v1/social/requests');
    if (res?.ok && res.requests) {
      writeCache(c => ({ ...c, requests: res.requests }));
      return { ok: true, requests: res.requests };
    }
    return { ok: false, requests: cache.requests || { received: [], sent: [] }, error: res?.error };
  });

  // Every conversation at once so all threads render instantly.
  ipcMain.handle('social:getConversations', async (_event, payload = {}) => {
    const perFriend = Number(payload?.perFriend) || 40;
    const cache = readCache();
    const res = await socialFetch(`/v1/social/conversations?perFriend=${perFriend}`);
    if (res?.ok && res.conversations) {
      writeCache(c => ({ ...c, conversations: res.conversations }));
      return { ok: true, conversations: res.conversations, serverTime: res.serverTime };
    }
    return { ok: false, conversations: cache.conversations || {}, error: res?.error };
  });

  ipcMain.handle('social:getUpdates', async (_event, payload = {}) => {
    const since = Number(payload?.since) || 0;
    return await socialFetch(`/v1/social/updates?since=${since}`);
  });

  ipcMain.handle('social:sendRequest', async (_event, targetUsername) => {
    return await socialFetch('/v1/social/requests/send', {
      method: 'POST',
      body: { username: targetUsername }
    });
  });

  ipcMain.handle('social:respondRequest', async (_event, { requestId, action }) => {
    return await socialFetch('/v1/social/requests/respond', {
      method: 'POST',
      body: { requestId, action }
    });
  });

  ipcMain.handle('social:getMessages', async (_event, { friendId, limit = 50, before = null, markRead = true }) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set('before', String(before));
    if (!markRead) params.set('markRead', '0');
    return await socialFetch(`/v1/social/messages/${encodeURIComponent(friendId)}?${params.toString()}`);
  });

  ipcMain.handle('social:sendMessage', async (_event, { friendId, content, mediaUrl, mediaName, mediaKind, isMedia, replyTo }) => {
    return await socialFetch(`/v1/social/messages/${encodeURIComponent(friendId)}`, {
      method: 'POST',
      body: { content, mediaUrl, mediaName, mediaKind, isMedia, replyTo: replyTo || null }
    });
  });

  ipcMain.handle('social:uploadMedia', async (_event, { dataUrl, filename }) => {
    return await socialFetch('/v1/social/upload', {
      method: 'POST',
      body: { dataUrl, filename, name: filename }
    });
  });

  ipcMain.handle('social:setMessageReaction', async (_event, { messageId, reaction }) => {
    return await socialFetch(`/v1/social/messages/${encodeURIComponent(messageId)}/react`, {
      method: 'POST',
      body: { reaction }
    });
  });

  ipcMain.handle('social:markRead', async (_event, friendId) => {
    return await socialFetch('/v1/social/read', {
      method: 'POST',
      body: { friendId }
    });
  });

  ipcMain.handle('social:setTyping', async (_event, { friendId, isTyping }) => {
    return await socialFetch('/v1/social/typing', {
      method: 'POST',
      body: { friendId, isTyping: Boolean(isTyping) }
    });
  });

  ipcMain.handle('social:updateFriend', async (_event, { friendId, isBestFriend, nickname, pinned, muted }) => {
    return await socialFetch('/v1/social/friends/update', {
      method: 'POST',
      body: { friendId, isBestFriend, nickname, pinned, muted }
    });
  });

  ipcMain.handle('social:unfriend', async (_event, friendId) => {
    return await socialFetch(`/v1/social/friends/${encodeURIComponent(friendId)}`, {
      method: 'DELETE'
    });
  });

  ipcMain.handle('social:block', async (_event, targetId) => {
    return await socialFetch('/v1/social/block', {
      method: 'POST',
      body: { targetId }
    });
  });

  ipcMain.handle('social:unblock', async (_event, targetId) => {
    return await socialFetch('/v1/social/unblock', {
      method: 'POST',
      body: { targetId }
    });
  });

  ipcMain.handle('social:getBlocked', async () => {
    return await socialFetch('/v1/social/blocked');
  });

  ipcMain.handle('social:searchUsers', async (_event, query) => {
    return await socialFetch(`/v1/social/search?q=${encodeURIComponent(query)}`);
  });

  ipcMain.handle('social:getPresence', () => currentPresence);

  ipcMain.handle('social:setPresence', (_event, payload) => {
    setPresence(payload);
    return currentPresence;
  });

  ipcMain.handle('social:getStreamStatus', () => ({ status: streamStatus }));

  ipcMain.handle('social:reconnectStream', () => {
    stopStream();
    startStream();
    return { ok: true };
  });
}

module.exports = {
  init,
  setPresence,
  getPresence,
  getActiveNoctraAccount,
  startStream,
  stopStream
};
