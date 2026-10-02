/**
 * Noctra Relay — realtime event bus.
 *
 * Keeps one in-process registry of Server-Sent-Event subscribers per user so
 * every social mutation (message, reaction, request, presence, typing, read
 * receipt) is pushed to the other party the moment it happens. HTTP polling
 * still works as a fallback, but it is no longer the primary transport.
 */

const clients = new Map(); // userId -> Set<ServerResponse>
// The Noctra game mod listens separately: it must not count as "the launcher is open",
// and it only receives the event types a game overlay can use (never message text).
const modClients = new Map(); // userId -> Set<ServerResponse>
const MOD_EVENTS = new Set(['presence', 'friends:changed', 'request:changed', 'skin:updated', 'wardrobe:changed', 'account:changed']);
const typingState = new Map(); // `${fromId}:${toId}` -> expiresAt

const TYPING_TTL = 6_000;

function frame(type, payload) {
  const data = JSON.stringify({ type, at: Date.now(), ...payload });
  return `event: ${type}\ndata: ${data}\n\n`;
}

/** Register an SSE response for a user. Returns an unsubscribe function. */
function subscribe(userId, res) {
  if (!userId || !res) return () => {};
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);

  try {
    res.write(frame('hello', { userId }));
  } catch {}

  return () => {
    const bucket = clients.get(userId);
    if (!bucket) return;
    bucket.delete(res);
    if (bucket.size === 0) clients.delete(userId);
  };
}

/** Register an SSE response for a user's game mod. Returns an unsubscribe function. */
function subscribeMod(userId, res) {
  if (!userId || !res) return () => {};
  if (!modClients.has(userId)) modClients.set(userId, new Set());
  modClients.get(userId).add(res);
  try {
    res.write(frame('hello', { userId }));
  } catch {}
  return () => {
    const bucket = modClients.get(userId);
    if (!bucket) return;
    bucket.delete(res);
    if (bucket.size === 0) modClients.delete(userId);
  };
}

const isModConnected = (userId) => modClients.has(userId);
const modConnectionCount = (userId) => (modClients.get(userId) ? modClients.get(userId).size : 0);

function writeTo(map, userId, body) {
  const bucket = map.get(userId);
  if (!bucket) return;
  for (const res of bucket) {
    try {
      res.write(body);
    } catch {
      bucket.delete(res);
    }
  }
}

/** Push an event to one or many users. Silently ignores offline users. */
function publish(userIds, type, payload = {}) {
  const targets = Array.isArray(userIds) ? userIds : [userIds];
  const body = frame(type, payload);
  const forMod = MOD_EVENTS.has(type);
  for (const userId of targets) {
    if (!userId) continue;
    writeTo(clients, userId, body);
    if (forMod) writeTo(modClients, userId, body);
  }
}

/** Heartbeat comment so proxies never idle-close a stream. */
function heartbeat() {
  for (const map of [clients, modClients]) {
    for (const bucket of map.values()) {
      for (const res of bucket) {
        try {
          res.write(': ping\n\n');
        } catch {
          bucket.delete(res);
        }
      }
    }
  }
}

function setTyping(fromId, toId, isTyping) {
  const key = `${fromId}:${toId}`;
  if (isTyping) typingState.set(key, Date.now() + TYPING_TTL);
  else typingState.delete(key);
  publish(toId, 'typing', { userId: fromId, isTyping: Boolean(isTyping) });
}

function isTyping(fromId, toId) {
  const expires = typingState.get(`${fromId}:${toId}`);
  if (!expires) return false;
  if (expires < Date.now()) {
    typingState.delete(`${fromId}:${toId}`);
    return false;
  }
  return true;
}

function isConnected(userId) {
  return clients.has(userId);
}

function connectionCount() {
  let total = 0;
  for (const bucket of clients.values()) total += bucket.size;
  return total;
}

/** Number of distinct signed-in Noctra users with a live event stream. */
function connectedUserCount() {
  return clients.size;
}

const heartbeatTimer = setInterval(heartbeat, 15_000);
if (heartbeatTimer.unref) heartbeatTimer.unref();

module.exports = {
  subscribe,
  subscribeMod,
  isModConnected,
  modConnectionCount,
  publish,
  heartbeat,
  setTyping,
  isTyping,
  isConnected,
  connectionCount,
  connectedUserCount
};
