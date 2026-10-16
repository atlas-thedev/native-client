'use strict';
/**
 * Native Voice: an SFU-style relay for in-game voice.
 *
 * HTTP (game ticket auth) hands out a voice session: { sid, key, host, port }. The mod then talks UDP:
 *   [0x4E][type][sid u32][seq u32][AES-128-GCM(payload) + tag]     nonce = sid | seq | dir (0 up, 1 down)
 *   sid is always the receiver's own session; forwarded audio carries [from sid][flags][seq][opus].
 * Audio from one session is re-encrypted for every other session in the same room. Rooms:
 *   dm:<a>:<b>   a direct call between two friends
 *   g:<id>       a group call (members only)
 *   srv:<addr>   everyone with Native on the same Minecraft server (proximity, mixed by distance in the mod)
 * Rosters go out on the existing mod event stream as `voice:state`.
 */
const dgram = require('dgram');
const crypto = require('crypto');
const db = require('./db');
const events = require('./social-events');

const PORT = Number(process.env.NATIVE_VOICE_PORT || 24470);
const PUBLIC_HOST = process.env.NATIVE_VOICE_HOST || '';
const MAGIC = 0x4e;
const T_AUDIO = 1, T_PING = 2, T_BYE = 3;
const HEADER = 10, TAG = 16;
const IDLE_MS = 20_000;
const MAX_ROOM = 64;
const MAX_PACKET = 1400;

const sessions = new Map(); // sid -> session
const rooms = new Map(); // room -> Set<sid>
let socket = null;

function userForTicket(ticket) {
  return require('./mod-routes').userForTicket(ticket);
}

const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

function normalizeServer(address) {
  let a = str(address, 120).toLowerCase().replace(/\.$/, '');
  if (a.endsWith(':25565')) a = a.slice(0, -6);
  return a;
}

/** Resolves a conversation key from the mod to a room, or throws when the player may not join it. */
function resolveRoom(user, key) {
  const k = str(key, 160);
  const me = String(user.id);
  if (k.startsWith('dm:')) {
    const other = k.slice(3);
    if (!other || other === me || !db.areFriends(user.id, other)) throw Object.assign(new Error('You can only call friends.'), { status: 403 });
    const pair = [me, String(other)].sort();
    return { room: `dm:${pair[0]}:${pair[1]}`, kind: 'call', notify: pair };
  }
  if (k.startsWith('g:')) {
    const groupId = k.slice(2);
    const members = (db.groupMemberIds(groupId) || []).map(String);
    if (!members.includes(me)) throw Object.assign(new Error('You are not in this group.'), { status: 403 });
    return { room: `g:${groupId}`, kind: 'call', notify: members };
  }
  if (k.startsWith('srv:')) {
    const addr = normalizeServer(k.slice(4));
    if (!addr || addr === 'singleplayer') throw Object.assign(new Error('Proximity voice needs a multiplayer server.'), { status: 400 });
    return { room: `srv:${addr}`, kind: 'srv', notify: null };
  }
  throw Object.assign(new Error('Unknown voice room.'), { status: 400 });
}

function roster(room) {
  const out = [];
  for (const sid of rooms.get(room) || []) {
    const s = sessions.get(sid);
    if (!s) continue;
    out.push({ sid: s.sid, userId: s.userId, name: s.name, ign: s.ign, skin: s.skin, muted: s.muted, deafened: s.deafened, connected: Boolean(s.addr) });
  }
  return out;
}

function notifyTargets(room, notify) {
  const ids = new Set(notify || []);
  for (const sid of rooms.get(room) || []) {
    const s = sessions.get(sid);
    if (s) ids.add(String(s.userId));
  }
  return [...ids];
}

function broadcast(room, notify, extra = {}) {
  try {
    events.publish(notifyTargets(room, notify), 'voice:state', { room, members: roster(room), ...extra });
  } catch { /* best effort */ }
}

function newSid() {
  for (;;) {
    const sid = crypto.randomBytes(4).readUInt32BE(0);
    if (sid !== 0 && !sessions.has(sid)) return sid;
  }
}

function removeSession(sid, reason) {
  const s = sessions.get(sid);
  if (!s) return;
  sessions.delete(sid);
  const set = rooms.get(s.room);
  if (set) {
    set.delete(sid);
    if (set.size === 0) rooms.delete(s.room);
  }
  broadcast(s.room, s.notify, { left: { userId: s.userId, reason } });
}

function join(user, body) {
  const { room, kind, notify } = resolveRoom(user, body.room);
  // one call and one proximity room per player at a time
  for (const s of [...sessions.values()]) {
    if (String(s.userId) === String(user.id) && s.kind === kind) removeSession(s.sid, 'switched');
  }
  const set = rooms.get(room) || new Set();
  if (set.size >= MAX_ROOM) throw Object.assign(new Error('This voice room is full.'), { status: 409 });
  const wasEmpty = set.size === 0;
  const sid = newSid();
  const s = {
    sid, kind, room, notify,
    userId: String(user.id),
    name: user.username,
    ign: str(body.ign, 32) || user.username,
    skin: /^([a-f0-9]{64}|mj:[a-f0-9]{32})$/.test(String(body.skin || '')) ? body.skin : null,
    key: crypto.randomBytes(16),
    muted: Boolean(body.muted),
    deafened: Boolean(body.deafened),
    addr: null, port: 0,
    lastSeen: Date.now(),
    maxSeq: -1, window: new Set(),
    outSeq: 0,
    bucket: 0, bucketAt: Date.now()
  };
  sessions.set(sid, s);
  set.add(sid);
  rooms.set(room, set);
  broadcast(room, notify, wasEmpty && kind === 'call' ? { started: { userId: s.userId, name: s.name } } : { joined: { userId: s.userId } });
  return s;
}

function ownSession(user, sid) {
  const s = sessions.get(Number(sid) >>> 0);
  return s && s.userId === String(user.id) ? s : null;
}

/** Calls that are live in conversations the player belongs to (so a relaunch can show "join"). */
function liveCalls(user) {
  const me = String(user.id);
  const out = [];
  for (const [room] of rooms) {
    if (room.startsWith('dm:')) {
      const [, a, b] = room.split(':');
      if (a === me || b === me) out.push({ room, members: roster(room) });
    } else if (room.startsWith('g:')) {
      try {
        if ((db.groupMemberIds(room.slice(2)) || []).map(String).includes(me)) out.push({ room, members: roster(room) });
      } catch { /* group gone */ }
    }
  }
  return out;
}

// ── UDP ──────────────────────────────────────────────────────────────────

function nonce(sid, seq, dir) {
  const n = Buffer.alloc(12);
  n.writeUInt32BE(sid >>> 0, 0);
  n.writeUInt32BE(seq >>> 0, 4);
  n.writeUInt32BE(dir, 8);
  return n;
}

function open(s, msg) {
  if (msg.length < HEADER + TAG) return null;
  const seq = msg.readUInt32BE(6);
  try {
    const d = crypto.createDecipheriv('aes-128-gcm', s.key, nonce(s.sid, seq, 0));
    d.setAAD(msg.subarray(0, HEADER));
    d.setAuthTag(msg.subarray(msg.length - TAG));
    const plain = Buffer.concat([d.update(msg.subarray(HEADER, msg.length - TAG)), d.final()]);
    return { seq, plain };
  } catch {
    return null;
  }
}

function seal(s, type, plain) {
  const seq = s.outSeq = (s.outSeq + 1) >>> 0;
  const head = Buffer.alloc(HEADER);
  head[0] = MAGIC;
  head[1] = type;
  head.writeUInt32BE(s.sid >>> 0, 2);
  head.writeUInt32BE(seq, 6);
  const c = crypto.createCipheriv('aes-128-gcm', s.key, nonce(s.sid, seq, 1));
  c.setAAD(head);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([head, body, c.getAuthTag()]);
}

/** Replay window: accept each sequence number once, tolerate a little reordering. */
function fresh(s, seq) {
  if (seq > s.maxSeq) {
    s.maxSeq = seq;
    s.window.add(seq);
    if (s.window.size > 256) for (const v of s.window) { if (v < seq - 256) s.window.delete(v); }
    return true;
  }
  if (s.maxSeq - seq > 256 || s.window.has(seq)) return false;
  s.window.add(seq);
  return true;
}

function allow(s) {
  const now = Date.now();
  if (now - s.bucketAt >= 1000) { s.bucket = 0; s.bucketAt = now; }
  return ++s.bucket <= 120;
}

function onPacket(msg, rinfo) {
  if (msg.length > MAX_PACKET || msg.length < HEADER + TAG || msg[0] !== MAGIC) return;
  const s = sessions.get(msg.readUInt32BE(2));
  if (!s || !allow(s)) return;
  const opened = open(s, msg);
  if (!opened || !fresh(s, opened.seq)) return;
  const firstContact = !s.addr;
  s.addr = rinfo.address;
  s.port = rinfo.port;
  s.lastSeen = Date.now();
  if (firstContact) broadcast(s.room, s.notify, { connected: { userId: s.userId } });
  const type = msg[1];
  if (type === T_PING) {
    socket.send(seal(s, T_PING, opened.plain.subarray(0, 16)), s.port, s.addr);
    return;
  }
  if (type === T_BYE) {
    removeSession(s.sid, 'left');
    return;
  }
  if (type !== T_AUDIO || s.muted || opened.plain.length < 1) return;
  // forwarded payload: [sender sid u32][flags][sender seq u32][opus]
  const out = Buffer.alloc(opened.plain.length + 8);
  out.writeUInt32BE(s.sid >>> 0, 0);
  out[4] = opened.plain[0];
  out.writeUInt32BE(opened.seq, 5);
  opened.plain.copy(out, 9, 1);
  for (const sid of rooms.get(s.room) || []) {
    if (sid === s.sid) continue;
    const r = sessions.get(sid);
    if (!r || !r.addr || r.deafened) continue;
    socket.send(seal(r, T_AUDIO, out), r.port, r.addr);
  }
}

function sweep() {
  const now = Date.now();
  for (const s of [...sessions.values()]) {
    if (now - s.lastSeen > (s.addr ? IDLE_MS : IDLE_MS * 2)) removeSession(s.sid, 'timeout');
  }
}

function start() {
  if (socket) return socket;
  socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('message', (msg, rinfo) => { try { onPacket(msg, rinfo); } catch { /* bad packet */ } });
  socket.on('error', (e) => console.error('[Native Voice] UDP error:', e.message));
  socket.bind(PORT, '0.0.0.0', () => console.log(`[Native Voice] UDP relay on :${PORT}`));
  const t = setInterval(sweep, 5_000);
  if (t.unref) t.unref();
  return socket;
}

// ── HTTP ─────────────────────────────────────────────────────────────────

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

function hostFor(req) {
  if (PUBLIC_HOST) return PUBLIC_HOST;
  return String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
}

async function handleVoiceRoutes(req, res, ctx) {
  if (!req.url.startsWith('/v1/voice/')) return false;
  const { send, hit, tooMany } = ctx;
  const url = new URL(req.url, 'http://localhost');
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const user = userForTicket(bearer);
  if (!user) { send(res, 401, { ok: false, error: 'Game ticket is missing, invalid or expired.' }); return true; }
  try {
    if (req.method === 'POST' && url.pathname === '/v1/voice/join') {
      if (!hit('voice-join', user.id, 30, 60_000)) { tooMany(res, 60); return true; }
      const s = join(user, await readBody(req));
      send(res, 200, { ok: true, sid: s.sid, key: s.key.toString('base64'), host: hostFor(req), port: PORT, room: s.room, members: roster(s.room) });
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/v1/voice/leave') {
      const s = ownSession(user, (await readBody(req)).sid);
      if (s) removeSession(s.sid, 'left');
      send(res, 200, { ok: true });
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/v1/voice/state') {
      if (!hit('voice-state', user.id, 60, 60_000)) { tooMany(res, 60); return true; }
      const body = await readBody(req);
      const s = ownSession(user, body.sid);
      if (!s) { send(res, 404, { ok: false, error: 'Not in that voice room.' }); return true; }
      s.muted = Boolean(body.muted);
      s.deafened = Boolean(body.deafened);
      broadcast(s.room, s.notify);
      send(res, 200, { ok: true });
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/v1/voice/calls') {
      if (!hit('voice-calls', user.id, 30, 60_000)) { tooMany(res, 60); return true; }
      send(res, 200, { ok: true, calls: liveCalls(user) });
      return true;
    }
  } catch (e) {
    send(res, e.status || 500, { ok: false, error: e.status ? e.message : 'Voice request failed.' });
    return true;
  }
  send(res, 404, { ok: false, error: 'Not found.' });
  return true;
}

module.exports = { start, handleVoiceRoutes, _internals: { sessions, rooms, join, resolveRoom, onPacket, normalizeServer } };
