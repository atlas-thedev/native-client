const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const media = require('./media');
const events = require('./social-events');

/**
 * Native client-mod API.
 *
 *   GET  /v1/skins/directory   every published skin/cape, incremental via ?epoch=&since=
 *   GET  /v1/skins/stream      Server-Sent Events: a `skin` event the moment a wardrobe changes
 *   POST /v1/auth/game-ticket  swap a launcher session for a short-lived, game-only ticket
 *   GET  /v1/mod/me            who a game ticket belongs to + account status
 *   GET  /v1/mod/friends       friends (with live presence) and pending requests
 *   GET  /v1/mod/stream        Server-Sent Events: presence / friends / account changes, live
 *                              (?relay=1 adds the Relay chat events for the in-game chat)
 *   POST /v1/mod/presence      what the player is doing in game ("Playing Minecraft 1.21.1")
 *   POST /v1/mod/presence-icon a server/world icon for Discord Rich Presence (PNG, hosted by hash)
 *   GET  /v1/presence-icons/<sha256>.png
 *
 * The mod never sees the account's real session token: the launcher hands it a
 * ticket that only works on /v1/mod/* and expires on its own.
 */

const profilesDir = path.join(media.DATA_DIR, 'profiles');
const iconsDir = path.join(media.DATA_DIR, 'presence-icons');
const ICON_MAX_BYTES = 256 * 1024;
const ICON_LIMIT = 20_000;
const EPOCH = Date.now();
const TICKET_TTL_MS = 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 5000;
const STREAM_PER_IP = 4;
const STREAM_TOTAL = 3000;
const HEARTBEAT_MS = 25_000;

/* ── Skin directory ───────────────────────────────────────────────────── */

const index = new Map(); // lowercase name -> entry
const history = []; // recent changes, newest last
let rev = 0;
let loaded = false;

const cleanUuid = (value) => String(value || '').replace(/-/g, '').toLowerCase();
const HASH = /^[a-f0-9]{64}$/;

function entryFor(profile) {
  if (!profile || typeof profile.username !== 'string') return null;
  let user = null;
  try { user = db.getUserByUsername(profile.username); } catch { /* the database may be unavailable in tests */ }
  // Premium and merged accounts are named after their Minecraft profile, so the
  // entry is pinned to that UUID. They keep their Mojang skin and only wear the
  // Native cloak; offline players never reach the directory.
  const mcUuid = user?.minecraft_uuid ? cleanUuid(user.minecraft_uuid) : null;
  const premiumUser = Boolean(mcUuid && (user.auth_type === 'premium' || user.auth_type === 'merged'));
  // Only Native store cloaks animate (see store-routes.animationFor).
  let allowed = null;
  let capeOk = true;
  let k = [];
  try {
    const store = require('./store-routes');
    allowed = store.animationFor(profile);
    capeOk = store.capeAllowed(profile.cape, profile);
    k = require('./cosmetics').directoryRefs(profile, store.findItem, store.dyedTexture).filter((ref) => HASH.test(ref.m) && HASH.test(ref.x));
  } catch {}
  const cape = HASH.test(profile.cape || '') && capeOk ? profile.cape : null;
  const anim = allowed && cape
    ? { h: allowed.strip, f: Number(allowed.frames) || 0, p: Number(allowed.fps) || 0 }
    : null;
  const a = anim && anim.f >= 2 && anim.p > 0 ? anim : null;
  return {
    n: profile.username,
    m: profile.model === 'slim' ? 'slim' : 'default',
    s: !premiumUser && HASH.test(profile.skin || '') ? profile.skin : null,
    // For an animated cloak `c` is its first frame: the game loads it as an ordinary cape.
    c: cape,
    // Animation: strip hash, frame count, frames per second.
    a,
    u: mcUuid,
    // Premium players: cloak only, the Mojang skin stays (mods up to 1.4 read `p`).
    ...(premiumUser ? { p: { c: cape, a } } : {}),
    // 3D cosmetics (mod 1.5+): item id, NCM model hash, texture hash
    ...(k.length ? { k } : {}),
    t: Date.parse(profile.updatedAt) || 0
  };
}

function readProfileFile(name) {
  try { return JSON.parse(fs.readFileSync(path.join(profilesDir, `${String(name).toLowerCase()}.json`), 'utf8')); } catch { return null; }
}

function load() {
  if (loaded) return;
  loaded = true;
  let files = [];
  try { files = fs.readdirSync(profilesDir).filter((f) => f.endsWith('.json')); } catch { return; }
  for (const file of files) {
    try {
      const profile = JSON.parse(fs.readFileSync(path.join(profilesDir, file), 'utf8'));
      const entry = entryFor(profile);
      if (entry && (entry.s || entry.c || entry.k)) index.set(entry.n.toLowerCase(), { ...entry, r: 0 });
    } catch { /* skip unreadable profile */ }
  }
}

const subscribers = new Set(); // { res, ip }

function broadcast(entry) {
  const frame = `event: skin\nid: ${entry.r}\ndata: ${JSON.stringify(entry)}\n\n`;
  for (const sub of subscribers) {
    try { sub.res.write(frame); } catch { subscribers.delete(sub); }
  }
}

const animKey = (e) => (e && e.a ? `${e.a.h}:${e.a.f}:${e.a.p}` : '');
const cosmeticKey = (e) => (e && e.k ? e.k.map((ref) => `${ref.i}:${ref.m}:${ref.x}:${ref.h || ''}`).join(',') : '');

/** Store and broadcast one directory entry (an entry with no skin, cloak or cosmetic removes the player). */
function upsert(entry) {
  const key = entry.n.toLowerCase();
  const previous = index.get(key);
  const empty = !entry.s && !entry.c && !(entry.k && entry.k.length);
  if (!previous && empty) return;
  if (previous && previous.s === entry.s && previous.c === entry.c && previous.m === entry.m && previous.u === entry.u && animKey(previous) === animKey(entry) && cosmeticKey(previous) === cosmeticKey(entry) && Boolean(previous.p) === Boolean(entry.p)) return;
  rev += 1;
  const stored = { ...entry, r: rev };
  if (empty) index.delete(key); else index.set(key, stored);
  history.push(stored);
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
  broadcast(stored);
}

const emptyEntry = (name) => ({ n: name, m: 'default', s: null, c: null, a: null, u: null, t: Date.now() });

/** Call whenever a wardrobe changes. */
function noteProfile(profileOrName) {
  load();
  let profile = profileOrName;
  if (typeof profileOrName === 'string') {
    profile = readProfileFile(profileOrName);
    if (!profile) {
      const key = String(profileOrName).toLowerCase();
      if (index.has(key)) upsert(emptyEntry(index.get(key).n));
      return;
    }
  }
  const entry = entryFor(profile);
  if (entry) upsert(entry);
}

/**
 * Accounts changed names (a premium owner took a name back, a merge, a
 * minecraft.net rename): drop the old entries, then publish the new ones.
 */
function noteRename(changes) {
  load();
  for (const { from } of changes) upsert(emptyEntry(index.get(String(from).toLowerCase())?.n || from));
  for (const { to } of changes) {
    upsert(emptyEntry(index.get(String(to).toLowerCase())?.n || to));
    noteProfile(to);
  }
}

function snapshot({ epoch, since }) {
  load();
  const canDelta = Number(epoch) === EPOCH && since >= 0 && history.length && since >= history[0].r - 1 && since <= rev;
  if (canDelta || (Number(epoch) === EPOCH && since === rev)) {
    return { full: false, entries: history.filter((e) => e.r > since) };
  }
  return { full: true, entries: Array.from(index.values()) };
}

/* ── Game tickets (stateless, HMAC-signed) ────────────────────────────── */

let secretCache = null;
function ticketSecret() {
  if (secretCache) return secretCache;
  const fromEnv = String(process.env.NATIVE_TICKET_SECRET || '').trim();
  if (fromEnv.length >= 32) return (secretCache = Buffer.from(fromEnv));
  const file = path.join(media.DATA_DIR, 'ticket.secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return (secretCache = Buffer.from(existing));
  } catch { /* create below */ }
  const created = crypto.randomBytes(48).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, created, { mode: 0o600 });
  return (secretCache = Buffer.from(created));
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function signTicket(userId, now = Date.now()) {
  const payload = b64u(JSON.stringify({ u: userId, e: now + TICKET_TTL_MS, s: 'game' }));
  const sig = b64u(crypto.createHmac('sha256', ticketSecret()).update(payload).digest());
  return { ticket: `nmt1.${payload}.${sig}`, expiresAt: now + TICKET_TTL_MS };
}

function verifyTicket(ticket, now = Date.now()) {
  const parts = String(ticket || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'nmt1') return null;
  const expected = crypto.createHmac('sha256', ticketSecret()).update(parts[1]).digest();
  let given;
  try { given = Buffer.from(parts[2], 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  if (payload?.s !== 'game' || typeof payload.u !== 'string' || !(payload.e > now)) return null;
  return payload;
}

function accountPayload(user) {
  let link = null;
  try { link = db.getMinecraftLink(user.id); } catch { /* optional */ }
  let badges = [];
  try { badges = JSON.parse(user.badges || '[]'); } catch { /* none */ }
  return {
    id: user.id,
    name: user.username,
    uuid: user.uuid,
    model: user.model || 'classic',
    minecraftUuid: link?.uuid || null,
    premium: link ? { linked: true, name: link.name || null, uuid: link.uuid || null } : { linked: false, name: null, uuid: null },
    type: user.auth_type || 'native',
    badges,
    memberSince: user.created_at || null,
    // Own skin texture hash, so the in-game chat can draw the player's face next to their messages.
    skin: (() => { const p = readProfileFile(user.username); return p && HASH.test(p.skin || '') ? p.skin : null; })()
  };
}


/** Friends + request counts shaped for a small in-game panel. */
function friendsPayload(user) {
  const friends = db.getFriends(user.id).map((f) => ({
    id: f.id,
    name: f.name,
    nickname: f.nickname || null,
    uuid: f.uuid || null,
    status: f.status || 'offline',
    online: f.status !== 'offline',
    activity: f.activity || null,
    serverAddress: f.serverAddress || null,
    best: Boolean(f.isBestFriend),
    pinned: Boolean(f.pinned),
    lastSeen: f.lastSeen || null,
    unread: Number(f.unreadCount || 0),
    // Skin texture hash (under /csl/textures/) so the in-game chat can draw the friend's face.
    skin: (() => { const p = readProfileFile(f.name); return p && HASH.test(p.skin || '') ? p.skin : null; })(),
    // Linked Minecraft (Mojang) account: the mod falls back to that skin when there is no Native skin.
    mcUuid: (() => { try { const l = db.getMinecraftLink(f.id); return l && l.uuid ? String(l.uuid) : null; } catch { return null; } })()
  }));
  let received = [];
  let sent = 0;
  try {
    const requests = db.getFriendRequests(user.id);
    received = (requests.received || []).map((r) => ({ id: r.id, name: r.name || r.username || '' }));
    sent = (requests.sent || []).length;
  } catch { /* optional */ }
  return {
    friends,
    online: friends.filter((f) => f.online).length,
    total: friends.length,
    requests: { received, sent }
  };
}

const MOD_STREAMS_PER_USER = 3;

function announce(user, activity, status) {
  try {
    db.updatePresence(user.id, { status, activity, serverAddress: null });
    events.publish(db.getFriendIds(user.id), 'presence', { userId: user.id, status, activity, serverAddress: null });
  } catch { /* presence is best-effort */ }
}

const cleanActivity = (value) => String(value || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60);

function userForTicket(ticket) {
  const payload = verifyTicket(ticket);
  if (!payload) return null;
  try {
    // Session lookups are by token; resolve the user by id through the username index.
    return db.getUserById ? db.getUserById(payload.u) : null;
  } catch { return null; }
}

/* ── Routes ───────────────────────────────────────────────────────────── */

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{ ip: string, send: Function, hit: Function, tooMany: Function }} ctx
 * @returns {Promise<boolean>} true when handled here
 */
async function handleModRoutes(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost');
  const { send, ip, hit, tooMany } = ctx;
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

  if (req.method === 'GET' && url.pathname === '/v1/skins/directory') {
    if (!hit('skins-dir', ip, 60, 60_000)) { tooMany(res, 60); return true; }
    const since = Number.parseInt(url.searchParams.get('since') || '-1', 10);
    const epoch = url.searchParams.get('epoch');
    const { full, entries } = snapshot({ epoch, since: Number.isFinite(since) ? since : -1 });
    send(res, 200, {
      ok: true,
      epoch: EPOCH,
      rev,
      full,
      textureBase: `${media.originOf(req)}/csl/textures/`,
      entries
    }, { 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/v1/skins/stream') {
    let fromIp = 0;
    for (const sub of subscribers) if (sub.ip === ip) fromIp += 1;
    if (fromIp >= STREAM_PER_IP || subscribers.size >= STREAM_TOTAL) { tooMany(res, 30, 'Too many live connections.'); return true; }
    load();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*'
    });
    if (res.flushHeaders) res.flushHeaders();
    if (req.socket?.setNoDelay) req.socket.setNoDelay(true);
    if (req.socket?.setTimeout) req.socket.setTimeout(0);

    const since = Number.parseInt(url.searchParams.get('since') || '-1', 10);
    const sameEpoch = Number(url.searchParams.get('epoch')) === EPOCH;
    res.write(`event: hello\ndata: ${JSON.stringify({ epoch: EPOCH, rev, resync: !(sameEpoch && since >= 0 && since <= rev) })}\n\n`);
    if (sameEpoch && since >= 0 && since < rev) {
      for (const entry of history) if (entry.r > since) res.write(`event: skin\nid: ${entry.r}\ndata: ${JSON.stringify(entry)}\n\n`);
    }

    const sub = { res, ip };
    subscribers.add(sub);
    const close = () => subscribers.delete(sub);
    req.on('close', close);
    req.on('error', close);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/v1/auth/game-ticket') {
    const user = bearer ? db.getUserBySession(bearer) : null;
    if (!user) { send(res, 401, { ok: false, error: 'Native account session required.' }); return true; }
    if (!hit('game-ticket', user.id, 30, 10 * 60_000)) { tooMany(res, 600); return true; }
    const { ticket, expiresAt } = signTicket(user.id);
    send(res, 200, { ok: true, ticket, expiresAt, account: accountPayload(user) });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/v1/mod/me') {
    if (!hit('mod-me', ip, 60, 60_000)) { tooMany(res, 60); return true; }
    const user = userForTicket(bearer);
    if (!user) { send(res, 401, { ok: false, error: 'Game ticket is missing, invalid or expired. Relaunch from the Native Client.' }); return true; }
    send(res, 200, { ok: true, account: accountPayload(user), serverTime: Date.now() });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/v1/mod/friends') {
    const user = userForTicket(bearer);
    if (!user) { send(res, 401, { ok: false, error: 'Game ticket is missing, invalid or expired.' }); return true; }
    if (!hit('mod-friends', user.id, 40, 60_000)) { tooMany(res, 60); return true; }
    send(res, 200, { ok: true, account: accountPayload(user), ...friendsPayload(user), serverTime: Date.now() }, { 'Cache-Control': 'no-store' });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/v1/mod/presence') {
    const user = userForTicket(bearer);
    if (!user) { send(res, 401, { ok: false, error: 'Game ticket is missing, invalid or expired.' }); return true; }
    if (!hit('mod-presence', user.id, 30, 60_000)) { tooMany(res, 60); return true; }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 4096) break; chunks.push(chunk); }
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* ignore */ }
    const activity = cleanActivity(body.activity);
    if (activity) announce(user, activity, 'online');
    send(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/v1/mod/presence-icon') {
    const user = userForTicket(bearer);
    if (!user) { send(res, 401, { ok: false, error: 'Game ticket is missing, invalid or expired.' }); return true; }
    if (!hit('mod-presence-icon', user.id, 30, 10 * 60_000)) { tooMany(res, 600); return true; }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > ICON_MAX_BYTES) { send(res, 413, { ok: false, error: 'Icon too large.' }); return true; }
      chunks.push(chunk);
    }
    const png = Buffer.concat(chunks);
    if (!isSmallPng(png)) { send(res, 400, { ok: false, error: 'Icons must be PNG images up to 512x512.' }); return true; }
    const hash = crypto.createHash('sha256').update(png).digest('hex');
    try {
      fs.mkdirSync(iconsDir, { recursive: true });
      const file = path.join(iconsDir, `${hash}.png`);
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, png);
        pruneIcons();
      } else {
        const now = new Date();
        fs.utimesSync(file, now, now);
      }
    } catch {
      send(res, 500, { ok: false, error: 'Could not store the icon.' });
      return true;
    }
    send(res, 200, { ok: true, url: `${media.originOf(req)}/v1/presence-icons/${hash}.png` });
    return true;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/v1/presence-icons/')) {
    const match = url.pathname.match(/^\/v1\/presence-icons\/([a-f0-9]{64})\.png$/);
    const file = match ? path.join(iconsDir, `${match[1]}.png`) : null;
    if (!file || !fs.existsSync(file)) { send(res, 404, { ok: false, error: 'Not found.' }); return true; }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(fs.readFileSync(file));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/v1/mod/stream') {
    const user = userForTicket(bearer);
    if (!user) { send(res, 401, { ok: false, error: 'Game ticket is missing, invalid or expired.' }); return true; }
    if (events.modConnectionCount(user.id) >= MOD_STREAMS_PER_USER) { tooMany(res, 30, 'Too many live connections.'); return true; }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*'
    });
    if (res.flushHeaders) res.flushHeaders();
    if (req.socket?.setNoDelay) req.socket.setNoDelay(true);
    if (req.socket?.setTimeout) req.socket.setTimeout(0);
    const unsubscribe = events.subscribeMod(user.id, res, { relay: url.searchParams.get('relay') === '1' });
    const activity = cleanActivity(url.searchParams.get('activity')) || 'Playing Minecraft';
    announce(user, activity, 'online');
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (events.isModConnected(user.id)) return;
      if (events.isConnected(user.id)) announce(user, 'In Launcher', 'online');
      else announce(user, null, 'offline');
    };
    req.on('close', close);
    req.on('error', close);
    return true;
  }

  return false;
}

/** A real PNG (signature + IHDR) no bigger than 512x512: server favicons are 64x64, world icons 64x64. */
function isSmallPng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33) return false;
  if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return false;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return false;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width > 0 && height > 0 && width <= 512 && height <= 512;
}

/** Keeps the icon folder bounded: drops the least recently used icons past the limit. */
function pruneIcons() {
  let names;
  try { names = fs.readdirSync(iconsDir).filter((name) => name.endsWith('.png')); } catch { return; }
  if (names.length <= ICON_LIMIT) return;
  const byAge = names.map((name) => {
    try { return { name, at: fs.statSync(path.join(iconsDir, name)).mtimeMs }; } catch { return { name, at: 0 }; }
  }).sort((a, b) => a.at - b.at);
  for (const { name } of byAge.slice(0, names.length - ICON_LIMIT)) {
    try { fs.unlinkSync(path.join(iconsDir, name)); } catch { /* gone */ }
  }
}

function stopStreams() {
  for (const sub of subscribers) { try { sub.res.end(); } catch { /* closed */ } }
  subscribers.clear();
}

const heartbeat = setInterval(() => {
  for (const sub of subscribers) {
    try { sub.res.write(': ping\n\n'); } catch { subscribers.delete(sub); }
  }
}, HEARTBEAT_MS);
if (heartbeat.unref) heartbeat.unref();

module.exports = {
  handleModRoutes,
  isSmallPng,
  noteProfile,
  noteRename,
  signTicket,
  verifyTicket,
  userForTicket,
  stopStreams,
  _internals: { EPOCH, index, snapshot, entryFor }
};
