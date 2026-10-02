const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const media = require('./media');

/**
 * Noctra client-mod API.
 *
 *   GET  /v1/skins/directory   every published skin/cape, incremental via ?epoch=&since=
 *   GET  /v1/skins/stream      Server-Sent Events: a `skin` event the moment a wardrobe changes
 *   POST /v1/auth/game-ticket  swap a launcher session for a short-lived, game-only ticket
 *   GET  /v1/mod/me            who a game ticket belongs to
 *
 * The mod never sees the account's real session token: the launcher hands it a
 * ticket that only works on /v1/mod/* and expires on its own.
 */

const profilesDir = path.join(media.DATA_DIR, 'profiles');
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
  let mcUuid = null;
  try {
    const user = db.getUserByUsername(profile.username);
    mcUuid = user?.minecraft_uuid ? cleanUuid(user.minecraft_uuid) : null;
  } catch { /* the database may be unavailable in tests */ }
  return {
    n: profile.username,
    m: profile.model === 'slim' ? 'slim' : 'default',
    s: HASH.test(profile.skin || '') ? profile.skin : null,
    c: HASH.test(profile.cape || '') ? profile.cape : null,
    u: mcUuid,
    t: Date.parse(profile.updatedAt) || 0
  };
}

function load() {
  if (loaded) return;
  loaded = true;
  let files = [];
  try { files = fs.readdirSync(profilesDir).filter((f) => f.endsWith('.json')); } catch { return; }
  for (const file of files) {
    try {
      const entry = entryFor(JSON.parse(fs.readFileSync(path.join(profilesDir, file), 'utf8')));
      if (entry && (entry.s || entry.c)) index.set(entry.n.toLowerCase(), { ...entry, r: 0 });
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

/** Call whenever a wardrobe (or its premium link) changes. */
function noteProfile(profileOrName) {
  load();
  let profile = profileOrName;
  if (typeof profileOrName === 'string') {
    try { profile = JSON.parse(fs.readFileSync(path.join(profilesDir, `${profileOrName.toLowerCase()}.json`), 'utf8')); } catch { return; }
  }
  const entry = entryFor(profile);
  if (!entry) return;
  const key = entry.n.toLowerCase();
  const previous = index.get(key);
  if (previous && previous.s === entry.s && previous.c === entry.c && previous.m === entry.m && previous.u === entry.u) return;
  rev += 1;
  const stored = { ...entry, r: rev };
  if (stored.s || stored.c) index.set(key, stored); else index.delete(key);
  history.push(stored);
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
  broadcast(stored);
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
  const fromEnv = String(process.env.NOCTRA_TICKET_SECRET || '').trim();
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
  return {
    id: user.id,
    name: user.username,
    uuid: user.uuid,
    model: user.model || 'classic',
    minecraftUuid: link?.uuid || null
  };
}

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
    if (!user) { send(res, 401, { ok: false, error: 'Noctra account session required.' }); return true; }
    if (!hit('game-ticket', user.id, 30, 10 * 60_000)) { tooMany(res, 600); return true; }
    const { ticket, expiresAt } = signTicket(user.id);
    send(res, 200, { ok: true, ticket, expiresAt, account: accountPayload(user) });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/v1/mod/me') {
    if (!hit('mod-me', ip, 60, 60_000)) { tooMany(res, 60); return true; }
    const user = userForTicket(bearer);
    if (!user) { send(res, 401, { ok: false, error: 'Game ticket is missing, invalid or expired. Relaunch from the Noctra Client.' }); return true; }
    send(res, 200, { ok: true, account: accountPayload(user), serverTime: Date.now() });
    return true;
  }

  return false;
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
  noteProfile,
  signTicket,
  verifyTicket,
  stopStreams,
  _internals: { EPOCH, index, snapshot, entryFor }
};
