const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { safeStorage } = require('electron');
const safeFile = require('./safeFile');

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
// A local/self-hosted API is only used when explicitly configured. Never send
// the session token to whatever happens to listen on localhost.
const LOCAL_ROOT = process.env.NOCTRA_LOCAL_API ? String(process.env.NOCTRA_LOCAL_API).replace(/\/+$/, '') : null;
const API_ROOTS = [...new Set([REMOTE_ROOT, LOCAL_ROOT].filter(Boolean))];
const REQUEST_TIMEOUT_MS = 15_000;
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
let wakeReconnect = null;
// Bumped by every stop/start, so a loop from a previous account exits instead
// of running alongside the new one (duplicate events after a switch).
let streamGeneration = 0;

const EMPTY_CACHE = () => ({ friends: [], requests: { received: [], sent: [] }, messages: {}, conversations: {} });

// One cache per account, so a failed fetch never shows the previous
// account's friends or DMs. The file is encrypted when the OS keychain is.
function cachePath(accountId) {
  const key = crypto.createHash('sha256').update(String(accountId)).digest('hex').slice(0, 16);
  return path.join(deps.app.getPath('userData'), 'social-cache', `${key}.json`);
}

function removeLegacyCache() {
  try { fs.rmSync(path.join(deps.app.getPath('userData'), 'social-cache.json'), { force: true }); } catch {}
}

function readCache() {
  const account = getActiveNoctraAccount();
  if (!account?.id) return EMPTY_CACHE();
  const stored = safeFile.readJson(cachePath(account.id), null);
  if (!stored) return EMPTY_CACHE();
  try {
    if (stored.enc === 'safe:v1') {
      return { ...EMPTY_CACHE(), ...JSON.parse(safeStorage.decryptString(Buffer.from(stored.data, 'base64'))) };
    }
    if (stored.enc === 'none') return { ...EMPTY_CACHE(), ...stored.data };
  } catch {}
  return EMPTY_CACHE();
}

function writeCache(updater) {
  try {
    const account = getActiveNoctraAccount();
    if (!account?.id) return;
    const current = readCache();
    const updated = typeof updater === 'function' ? updater(current) : { ...current, ...updater };
    let record;
    if (safeStorage?.isEncryptionAvailable?.()) {
      record = { enc: 'safe:v1', data: safeStorage.encryptString(JSON.stringify(updated)).toString('base64') };
    } else {
      record = { enc: 'none', data: updated };
    }
    safeFile.writeJsonAtomic(cachePath(account.id), record, { backup: false });
  } catch {}
}

function getActiveNoctraAccount() {
  try {
    // auth.js owns accounts.json (and decrypts the stored session token).
    const data = require('./auth').readAccounts(deps.app.getPath('userData'));
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

  let lastError = 'Could not connect to Noctra Social service.';
  for (const root of API_ROOTS) {
    try {
      const res = await fetch(`${root}${endpoint}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      const text = await res.text();
      let payload;
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = null; }
      if (payload && typeof payload === 'object') {
        if (!res.ok && payload.ok === undefined) payload.ok = false;
        // Only server/transport failures try the next root.
        if (res.status < 500) return payload;
        lastError = payload.error || `Noctra Social returned HTTP ${res.status}.`;
        continue;
      }
      lastError = `Noctra Social returned HTTP ${res.status}.`;
      if (res.status < 500) return { ok: false, error: lastError };
    } catch (err) {
      lastError = err?.name === 'TimeoutError' || err?.name === 'AbortError'
        ? 'Noctra Social took too long to respond.'
        : 'Could not connect to Noctra Social service.';
    }
  }
  return { ok: false, error: lastError };
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

async function connectStreamOnce(root, token, generation) {
  if (generation !== streamGeneration) return;
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
      if (generation !== streamGeneration) break;
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

async function streamLoop(generation) {
  const alive = () => generation === streamGeneration;

  while (alive()) {
    const account = getActiveNoctraAccount();
    const token = tokenOf(account);
    if (!token) {
      setStreamStatus('signed-out');
      break;
    }
    streamAccountId = account.id;

    let connected = false;
    for (const root of API_ROOTS) {
      if (!alive()) break;
      try {
        setStreamStatus(streamAttempt === 0 ? 'connecting' : 'reconnecting', root);
        await connectStreamOnce(root, token, generation);
        connected = true;
        break; // stream ended cleanly; reconnect through the outer loop
      } catch (err) {
        if (!alive() || err?.name === 'AbortError') break;
      }
    }

    if (!alive()) break;

    streamAttempt = connected ? 1 : streamAttempt + 1;
    setStreamStatus('disconnected');

    // Exponential backoff, capped at 15s, with jitter.
    const delay = Math.min(15_000, 700 * Math.pow(1.7, Math.min(streamAttempt, 8))) + Math.random() * 400;
    await new Promise((resolve) => {
      wakeReconnect = resolve;
      reconnectTimer = setTimeout(resolve, delay);
    });
    wakeReconnect = null;
  }

  if (alive()) streamRunning = false;
}

function startStream() {
  if (streamRunning) return;
  streamRunning = true;
  streamStopped = false;
  const generation = ++streamGeneration;
  streamLoop(generation).catch(() => {
    if (generation === streamGeneration) streamRunning = false;
  });
}

function stopStream() {
  streamStopped = true;
  streamGeneration += 1;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (wakeReconnect) { const wake = wakeReconnect; wakeReconnect = null; wake(); }
  try { streamController?.abort(); } catch {}
  streamController = null;
  streamRunning = false;
  streamAccountId = null;
  streamAttempt = 0;
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
  pushPresence();
}

// Presence updates fire in quick bursts (Starting… → In Menus → Singleplayer
// within a second). Sent in parallel they can land out of order and leave the
// server on a stale "Starting…". Send one at a time and always the latest.
let presenceInFlight = null;
let presenceDirty = false;
function pushPresence() {
  presenceDirty = true;
  if (presenceInFlight) return presenceInFlight;
  presenceInFlight = (async () => {
    try {
      while (presenceDirty) {
        presenceDirty = false;
        const token = tokenOf(getActiveNoctraAccount());
        if (!token) break;
        await socialFetch('/v1/social/presence', {
          method: 'POST',
          body: { ...currentPresence },
          token
        }).catch(() => {});
      }
    } finally {
      presenceInFlight = null;
    }
  })();
  return presenceInFlight;
}

function getPresence() {
  return currentPresence;
}

function init(dependencies, ipcMain) {
  deps = dependencies;
  removeLegacyCache();

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
    pushPresence();
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
  API_ROOTS,
  init,
  setPresence,
  getPresence,
  getActiveNoctraAccount,
  startStream,
  stopStream
};
