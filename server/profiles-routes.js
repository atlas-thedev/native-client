/**
 * Public player profiles, skin library and global search (laby.net-style).
 *
 * Purely additive: own tables (pf_*), own routes. Nothing here changes an
 * existing endpoint, so the launcher and the mod keep working unchanged.
 *
 *   GET  /v1/profiles/:name            Native player (or any Minecraft Java player) with
 *                                      name history, skin history, views, likes, bio, links
 *   POST /v1/profiles/:name/view       count a profile view (one per visitor per day)
 *   GET  /v1/profiles/me/about         your bio + links            (signed in)
 *   POST /v1/profiles/me/about         { bio, links: [{ type, url }] } (signed in)
 *   GET  /v1/library/skins?sort=trending|new|popular&q=&page=   skin library
 *   GET  /v1/library/skins/:hash               one skin, who wore it, likes
 *   POST /v1/library/skins/:hash/like          { like: true|false }        (signed in)
 *   GET  /v1/search?q=                 players, skins and store items in one go (Ctrl+K)
 */
const crypto = require('crypto');
const db = require('./db');

const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const NATIVE_NAME_RE = /^[A-Za-z0-9_.\- ]{1,32}$/;
const HASH_RE = /^[a-f0-9]{32,64}$/;
const LINK_TYPES = ['youtube', 'twitch', 'tiktok', 'x', 'instagram', 'discord', 'github', 'website'];
const PAGE = 36;

let hooks = { readProfile: () => null, mojangSkin: async () => null, allItems: () => [], originOf: () => '' };
let ready = false;

function sql() {
  const h = db.getDb();
  if (!ready) {
    h.exec(`
      CREATE TABLE IF NOT EXISTS pf_skins (
        hash TEXT PRIMARY KEY,
        source TEXT NOT NULL,            -- native | mojang
        url TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT 'default',
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pf_skin_history (
        subject TEXT NOT NULL,           -- n:<userId> | m:<minecraft uuid>
        hash TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT 'default',
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        PRIMARY KEY (subject, hash)
      );
      CREATE INDEX IF NOT EXISTS pf_skin_history_hash ON pf_skin_history(hash);
      CREATE TABLE IF NOT EXISTS pf_name_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT NOT NULL,
        name TEXT NOT NULL,
        seen_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pf_name_history_subject ON pf_name_history(subject, id);
      CREATE INDEX IF NOT EXISTS pf_name_history_name ON pf_name_history(lower(name));
      CREATE TABLE IF NOT EXISTS pf_skin_likes (
        user_id TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, hash)
      );
      CREATE INDEX IF NOT EXISTS pf_skin_likes_hash ON pf_skin_likes(hash, created_at);
      CREATE TABLE IF NOT EXISTS pf_views (
        subject TEXT NOT NULL,
        viewer TEXT NOT NULL,
        day TEXT NOT NULL,
        PRIMARY KEY (subject, viewer, day)
      );
      CREATE TABLE IF NOT EXISTS pf_about (
        user_id TEXT PRIMARY KEY,
        bio TEXT NOT NULL DEFAULT '',
        links TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pf_mojang (
        uuid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cape TEXT,
        checked_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pf_mojang_name ON pf_mojang(lower(name));
    `);
    ready = true;
  }
  return h;
}

const now = () => Date.now();
const nativeSubject = (user) => `n:${user.id}`;
const mcSubject = (uuid) => `m:${String(uuid).replace(/-/g, '').toLowerCase()}`;
const dashed = (id) => String(id).replace(/-/g, '').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const premiumOf = (user) => user && (user.auth_type === 'premium' || user.auth_type === 'merged');
const mcUuidOf = (user) => {
  if (!user) return null;
  if (user.minecraft_uuid) return String(user.minecraft_uuid).replace(/-/g, '').toLowerCase();
  if (premiumOf(user) && user.uuid) return String(user.uuid).replace(/-/g, '').toLowerCase();
  try { const link = db.getMinecraftLink(user.id); if (link && link.uuid) return String(link.uuid).replace(/-/g, '').toLowerCase(); } catch {}
  return null;
};

/* ── recording ─────────────────────────────────────────────────────── */

function noteSkin(subject, { hash, source, url, model }) {
  if (!hash || !HASH_RE.test(hash) || !url) return;
  const h = sql();
  const t = now();
  const m = model === 'slim' ? 'slim' : 'default';
  h.prepare(`INSERT INTO pf_skins (hash, source, url, model, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(hash) DO UPDATE SET last_seen = excluded.last_seen, url = excluded.url`).run(hash, source, url, m, t, t);
  h.prepare(`INSERT INTO pf_skin_history (subject, hash, model, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(subject, hash) DO UPDATE SET last_seen = excluded.last_seen, model = excluded.model`).run(subject, hash, m, t, t);
}

function noteName(subject, name, at = now()) {
  if (!name) return;
  const h = sql();
  const last = h.prepare('SELECT name FROM pf_name_history WHERE subject = ? ORDER BY id DESC LIMIT 1').get(subject);
  if (last && last.name === name) return;
  h.prepare('INSERT INTO pf_name_history (subject, name, seen_at) VALUES (?, ?, ?)').run(subject, name, at);
}

const urlOf = (r) => (r.source === 'native' ? `${hooks.originOf()}/csl/textures/${r.hash}` : r.url);
const mojangHash = (url) => { const m = String(url || '').match(/\/texture\/([a-f0-9]{32,64})$/i); return m ? m[1].toLowerCase() : null; };

const checked = new Map();
/** Records what a Native account looks like right now (skin + name). Never throws. */
async function syncUser(user, { mojang = true } = {}) {
  try {
    if (!user) return;
    const subject = nativeSubject(user);
    noteName(subject, user.username, sql().prepare('SELECT 1 FROM pf_name_history WHERE subject = ?').get(subject) ? now() : Number(user.created_at) || now());
    const profile = hooks.readProfile(user.username);
    if (profile && profile.skin) {
      noteSkin(subject, { hash: profile.skin, source: 'native', url: `${hooks.originOf()}/csl/textures/${profile.skin}`, model: profile.model });
    } else if (mojang) {
      // straight from Mojang (no long cache), at most once a minute per player
      const uuid = mcUuidOf(user);
      const last = checked.get(subject) || 0;
      if (uuid && now() - last > 60_000) {
        checked.set(subject, now());
        if (checked.size > 5000) checked.clear();
        const tex = await mojangTextures(uuid).catch(() => null);
        const hash = tex && mojangHash(tex.skin);
        if (hash) noteSkin(subject, { hash, source: 'mojang', url: tex.skin, model: tex.model });
      }
    }
  } catch (error) { console.warn('[Native Profiles] sync failed:', error.message); }
}

/** Called from saveProfile: a wardrobe change is a new skin-history entry at once. */
function noteProfile(profile) {
  try {
    const user = profile && db.getUserByUsername(profile.username);
    if (user) syncUser(user, { mojang: false });
  } catch {}
}

let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const users = sql().prepare('SELECT * FROM users').all();
    for (const user of users) await syncUser(user);
  } catch (error) { console.warn('[Native Profiles] sweep failed:', error.message); }
  sweeping = false;
}

/* ── Mojang lookups for players that are not on Native ─────────────── */

const lookups = new Map();
async function fetchJson(url, ms = 5000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'native-server' } });
  if (r.status === 204 || r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function mojangByName(name) {
  const key = name.toLowerCase();
  const hit = lookups.get(key);
  if (hit && now() - hit.at < 10 * 60_000) return hit.value;
  let value = null;
  try {
    const j = await fetchJson(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`);
    if (j && j.id) value = { uuid: j.id, name: j.name };
  } catch {
    try {
      const j = await fetchJson(`https://api.minetools.eu/uuid/${encodeURIComponent(name)}`);
      if (j && j.id && j.status !== 'ERR') value = { uuid: j.id, name: j.name };
    } catch {}
  }
  lookups.set(key, { at: now(), value });
  if (lookups.size > 5000) lookups.clear();
  return value;
}
async function mojangTextures(uuid) {
  const decode = (props) => { const v = (props || []).find((p) => p.name === 'textures'); return v ? JSON.parse(Buffer.from(v.value, 'base64').toString('utf8')).textures || {} : {}; };
  let tex = null;
  try { const j = await fetchJson(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`); tex = j ? decode(j.properties) : {}; }
  catch { try { const j = await fetchJson(`https://api.minetools.eu/profile/${uuid}`); tex = j && j.decoded ? j.decoded.textures || {} : null; } catch {} }
  if (!tex) return null;
  const https = (u) => (u ? String(u).replace(/^http:\/\//, 'https://') : null);
  return { skin: https(tex.SKIN && tex.SKIN.url), model: tex.SKIN && tex.SKIN.metadata && tex.SKIN.metadata.model === 'slim' ? 'slim' : 'default', cape: https(tex.CAPE && tex.CAPE.url) };
}

/* ── reading ───────────────────────────────────────────────────────── */

function likesOf(hash) { return Number(sql().prepare('SELECT COUNT(*) AS n FROM pf_skin_likes WHERE hash = ?').get(hash).n) || 0; }
function viewsOf(subject) { return Number(sql().prepare('SELECT COUNT(*) AS n FROM pf_views WHERE subject = ?').get(subject).n) || 0; }

function historyOf(subject) {
  const h = sql();
  const names = h.prepare('SELECT name, seen_at FROM pf_name_history WHERE subject = ? ORDER BY id DESC LIMIT 50').all(subject)
    .map((r) => ({ name: r.name, at: Number(r.seen_at) }));
  const skins = h.prepare(`SELECT s.hash, s.url, s.source, x.model, x.first_seen, x.last_seen,
      (SELECT COUNT(*) FROM pf_skin_likes l WHERE l.hash = s.hash) AS likes
    FROM pf_skin_history x JOIN pf_skins s ON s.hash = x.hash WHERE x.subject = ? ORDER BY x.last_seen DESC LIMIT 60`).all(subject)
    .map((r) => ({ hash: r.hash, url: urlOf(r), source: r.source, model: r.model, firstSeen: Number(r.first_seen), lastSeen: Number(r.last_seen), likes: Number(r.likes) }));
  return { names, skins };
}

function aboutOf(userId) {
  const row = sql().prepare('SELECT bio, links FROM pf_about WHERE user_id = ?').get(String(userId));
  let links = [];
  try { links = JSON.parse(row ? row.links : '[]'); } catch {}
  return { bio: row ? row.bio : '', links: Array.isArray(links) ? links : [] };
}

function cleanAbout(body) {
  const bio = String(body.bio ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, 280);
  const links = (Array.isArray(body.links) ? body.links : []).slice(0, 8).map((l) => {
    const type = LINK_TYPES.includes(String(l && l.type)) ? String(l.type) : null;
    let url = String((l && l.url) || '').trim().slice(0, 200);
    if (!type || !url) return null;
    if (type === 'discord' && !/^https?:/i.test(url)) return { type, url: url.slice(0, 40) }; // a Discord handle
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try { const u = new URL(url); if (u.protocol !== 'https:' && u.protocol !== 'http:') return null; return { type, url: u.toString() }; } catch { return null; }
  }).filter(Boolean);
  return { bio, links };
}

function friendsOf(user) {
  try { return db.getFriendIds(user.id).length; } catch { return 0; }
}

async function nativeProfile(user) {
  await syncUser(user);
  const subject = nativeSubject(user);
  const uuid = mcUuidOf(user);
  const profile = hooks.readProfile(user.username);
  let current = null;
  let mojangCape = null;
  if (profile && profile.skin) current = { url: `${hooks.originOf()}/csl/textures/${profile.skin}`, hash: profile.skin, model: profile.model === 'slim' ? 'slim' : 'default' };
  if (uuid) {
    const tex = await mojangTextures(uuid).catch(() => null);
    if (tex) {
      mojangCape = tex.cape;
      if (!current && tex.skin) {
        current = { url: tex.skin, hash: mojangHash(tex.skin), model: tex.model };
        // the skin shown is always in the history too, the moment it changes
        if (current.hash) noteSkin(subject, { hash: current.hash, source: 'mojang', url: tex.skin, model: tex.model });
      }
    }
  }
  const { names, skins } = historyOf(subject);
  return {
    native: true,
    name: user.username,
    uuid: uuid ? dashed(uuid) : dashed(user.uuid),
    premium: Boolean(premiumOf(user) || uuid),
    joinedAt: Number(user.created_at) || 0,
    ...aboutOf(user.id),
    views: viewsOf(subject),
    friends: friendsOf(user),
    names,
    skins,
    current,
    mojangCape
  };
}

async function mojangProfile(name) {
  const hit = await mojangByName(name);
  if (!hit) return null;
  const subject = mcSubject(hit.uuid);
  noteName(subject, hit.name);
  sql().prepare(`INSERT INTO pf_mojang (uuid, name, checked_at) VALUES (?, ?, ?) ON CONFLICT(uuid) DO UPDATE SET name = excluded.name, checked_at = excluded.checked_at`).run(hit.uuid, hit.name, now());
  const tex = await mojangTextures(hit.uuid).catch(() => null);
  const hash = tex && mojangHash(tex.skin);
  if (hash) noteSkin(subject, { hash, source: 'mojang', url: tex.skin, model: tex.model });
  if (tex) sql().prepare('UPDATE pf_mojang SET cape = ? WHERE uuid = ?').run(tex.cape, hit.uuid);
  const { names, skins } = historyOf(subject);
  return {
    native: false,
    name: hit.name,
    uuid: dashed(hit.uuid),
    premium: true,
    joinedAt: 0,
    bio: '',
    links: [],
    views: viewsOf(subject),
    friends: 0,
    names,
    skins,
    current: tex && tex.skin ? { url: tex.skin, hash, model: tex.model } : null,
    mojangCape: tex ? tex.cape : null
  };
}

function subjectFor(name) {
  const user = NATIVE_NAME_RE.test(name) ? db.getUserByUsername(name) : null;
  if (user) return nativeSubject(user);
  const row = sql().prepare('SELECT uuid FROM pf_mojang WHERE lower(name) = lower(?)').get(name);
  return row ? mcSubject(row.uuid) : null;
}

function listSkins({ sort, q, page }) {
  const h = sql();
  const offset = Math.max(0, Math.min(50, Number(page) || 0)) * PAGE;
  const week = now() - 7 * 86_400_000;
  const where = [];
  const args = [];
  const query = String(q || '').trim().slice(0, 32).replace(/[%_\\]/g, '');
  if (query) {
    where.push(`s.hash IN (SELECT x.hash FROM pf_skin_history x JOIN pf_name_history n ON n.subject = x.subject WHERE lower(n.name) LIKE lower(?))`);
    args.push(`${query}%`);
  }
  const order = sort === 'new' ? 's.first_seen DESC'
    : sort === 'popular' ? 'likes DESC, wearers DESC, s.first_seen DESC'
    : 'recent_likes DESC, wearers DESC, s.last_seen DESC';
  const rows = h.prepare(`SELECT s.hash, s.url, s.source, s.model, s.first_seen, s.last_seen,
      (SELECT COUNT(*) FROM pf_skin_likes l WHERE l.hash = s.hash) AS likes,
      (SELECT COUNT(*) FROM pf_skin_likes l WHERE l.hash = s.hash AND l.created_at > ${week}) AS recent_likes,
      (SELECT COUNT(DISTINCT subject) FROM pf_skin_history x WHERE x.hash = s.hash) AS wearers
    FROM pf_skins s ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${order} LIMIT ${PAGE + 1} OFFSET ${offset}`).all(...args);
  const total = Number(h.prepare('SELECT COUNT(*) AS n FROM pf_skins').get().n) || 0;
  return {
    total,
    more: rows.length > PAGE,
    skins: rows.slice(0, PAGE).map((r) => ({ hash: r.hash, url: urlOf(r), source: r.source, model: r.model, firstSeen: Number(r.first_seen), lastSeen: Number(r.last_seen), likes: Number(r.likes), wearers: Number(r.wearers) }))
  };
}

function wearersOf(hash) {
  const h = sql();
  return h.prepare(`SELECT x.subject, x.first_seen, x.last_seen,
      (SELECT name FROM pf_name_history n WHERE n.subject = x.subject ORDER BY id DESC LIMIT 1) AS name
    FROM pf_skin_history x WHERE x.hash = ? ORDER BY x.last_seen DESC LIMIT 60`).all(hash)
    .filter((r) => r.name)
    .map((r) => ({ name: r.name, native: r.subject.startsWith('n:'), firstSeen: Number(r.first_seen), lastSeen: Number(r.last_seen) }));
}

function search(q) {
  const query = String(q || '').trim().slice(0, 32);
  if (!query) return { players: [], items: [] };
  const like = `${query.replace(/[%_\\]/g, '')}%`;
  const h = sql();
  const latest = h.prepare(`SELECT s.hash, s.url, s.source, x.model FROM pf_skin_history x JOIN pf_skins s ON s.hash = x.hash WHERE x.subject = ? ORDER BY x.last_seen DESC LIMIT 1`);
  const look = (subject) => { const r = latest.get(subject); return r ? { skin: urlOf(r), model: r.model === 'slim' ? 'slim' : 'default' } : { skin: null, model: 'default' }; };
  const native = h.prepare(`SELECT id, username, uuid, model, created_at FROM users WHERE username LIKE ? ORDER BY (lower(username) = lower(?)) DESC, length(username) ASC LIMIT 8`).all(like, query)
    .map((r) => ({ name: r.username, uuid: r.uuid, native: true, ...look(`n:${r.id}`) }));
  const known = h.prepare(`SELECT uuid, name FROM pf_mojang WHERE name LIKE ? ORDER BY length(name) ASC LIMIT 6`).all(like)
    .filter((r) => !native.some((n) => n.name.toLowerCase() === r.name.toLowerCase()))
    .map((r) => ({ name: r.name, uuid: dashed(r.uuid), native: false, ...look(mcSubject(r.uuid)) }));
  const lower = query.toLowerCase();
  let items = [];
  try {
    items = hooks.allItems().filter((it) => it && !it.hidden && String(it.name || '').toLowerCase().includes(lower)).slice(0, 8)
      .map((it) => ({ id: it.id, name: it.name, kind: it.kind === 'cosmetic' ? 'cosmetic' : 'cape', slot: it.slot || null }));
  } catch {}
  return { players: [...native, ...known].slice(0, 10), items };
}

/* ── routes ────────────────────────────────────────────────────────── */

function setHooks(next) { hooks = { ...hooks, ...next }; }

async function handleProfileRoutes(req, res, { ip, send, hit, tooMany, readJson }) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (!p.startsWith('/v1/profiles/') && !p.startsWith('/v1/library/') && p !== '/v1/search') return false;
  const cors = { 'Access-Control-Allow-Origin': '*' };
  const noStore = { 'Cache-Control': 'no-store' };
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const signedIn = () => (bearer ? db.getUserBySession(bearer) : null);

  if (p === '/v1/profiles/me/about') {
    const user = signedIn();
    if (!user) { send(res, 401, { ok: false, error: 'Sign in first.' }); return true; }
    if (req.method === 'GET') { send(res, 200, { ok: true, ...aboutOf(user.id) }, noStore); return true; }
    if (req.method === 'POST') {
      if (!hit('pf-about', user.id, 20, 10 * 60_000)) { tooMany(res, 600); return true; }
      const about = cleanAbout(await readJson(req));
      sql().prepare(`INSERT INTO pf_about (user_id, bio, links, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET bio = excluded.bio, links = excluded.links, updated_at = excluded.updated_at`).run(user.id, about.bio, JSON.stringify(about.links), now());
      send(res, 200, { ok: true, ...about }, noStore);
      return true;
    }
  }

  const viewMatch = p.match(/^\/v1\/profiles\/([^/]+)\/view$/);
  if (req.method === 'POST' && viewMatch) {
    if (!hit('pf-view', ip, 120, 60_000)) { tooMany(res, 60); return true; }
    const subject = subjectFor(decodeURIComponent(viewMatch[1]).trim());
    if (!subject) { send(res, 404, { ok: false }); return true; }
    const viewer = crypto.createHash('sha256').update(`${ip}|${subject}`).digest('hex').slice(0, 24);
    sql().prepare('INSERT OR IGNORE INTO pf_views (subject, viewer, day) VALUES (?, ?, ?)').run(subject, viewer, new Date().toISOString().slice(0, 10));
    send(res, 200, { ok: true, views: viewsOf(subject) }, noStore);
    return true;
  }

  const profileMatch = p.match(/^\/v1\/profiles\/([^/]+)$/);
  if (req.method === 'GET' && profileMatch) {
    if (!hit('pf-profile', ip, 90, 60_000)) { tooMany(res, 60); return true; }
    const name = decodeURIComponent(profileMatch[1]).trim();
    const user = NATIVE_NAME_RE.test(name) ? db.getUserByUsername(name) : null;
    const profile = user ? await nativeProfile(user) : NAME_RE.test(name) ? await mojangProfile(name) : null;
    if (!profile) { send(res, 404, { ok: false, error: 'No player with that name.' }); return true; }
    send(res, 200, { ok: true, profile }, { 'Cache-Control': 'public, max-age=15', ...cors });
    return true;
  }

  if (req.method === 'GET' && p === '/v1/library/skins') {
    if (!hit('pf-skins', ip, 120, 60_000)) { tooMany(res, 60); return true; }
    const sort = ['trending', 'new', 'popular'].includes(url.searchParams.get('sort')) ? url.searchParams.get('sort') : 'trending';
    send(res, 200, { ok: true, sort, ...listSkins({ sort, q: url.searchParams.get('q'), page: url.searchParams.get('page') }) }, { 'Cache-Control': 'public, max-age=30', ...cors });
    return true;
  }

  const likeMatch = p.match(/^\/v1\/library\/skins\/([a-f0-9]{32,64})\/like$/);
  if (likeMatch && (req.method === 'POST' || req.method === 'GET')) {
    const user = signedIn();
    const hash = likeMatch[1];
    if (req.method === 'GET') {
      const liked = user ? Boolean(sql().prepare('SELECT 1 FROM pf_skin_likes WHERE user_id = ? AND hash = ?').get(user.id, hash)) : false;
      send(res, 200, { ok: true, liked, likes: likesOf(hash) }, noStore);
      return true;
    }
    if (!user) { send(res, 401, { ok: false, error: 'Sign in to like skins.' }); return true; }
    if (!hit('pf-like', user.id, 120, 10 * 60_000)) { tooMany(res, 600); return true; }
    if (!sql().prepare('SELECT 1 FROM pf_skins WHERE hash = ?').get(hash)) { send(res, 404, { ok: false, error: 'Unknown skin.' }); return true; }
    const body = await readJson(req);
    if (body.like === false) sql().prepare('DELETE FROM pf_skin_likes WHERE user_id = ? AND hash = ?').run(user.id, hash);
    else sql().prepare('INSERT OR IGNORE INTO pf_skin_likes (user_id, hash, created_at) VALUES (?, ?, ?)').run(user.id, hash, now());
    send(res, 200, { ok: true, liked: body.like !== false, likes: likesOf(hash) }, noStore);
    return true;
  }

  const skinMatch = p.match(/^\/v1\/library\/skins\/([a-f0-9]{32,64})$/);
  if (req.method === 'GET' && skinMatch) {
    if (!hit('pf-skins', ip, 120, 60_000)) { tooMany(res, 60); return true; }
    const row = sql().prepare('SELECT * FROM pf_skins WHERE hash = ?').get(skinMatch[1]);
    if (!row) { send(res, 404, { ok: false, error: 'Unknown skin.' }); return true; }
    send(res, 200, { ok: true, skin: { hash: row.hash, url: urlOf(row), source: row.source, model: row.model, firstSeen: Number(row.first_seen), lastSeen: Number(row.last_seen), likes: likesOf(row.hash), wearers: wearersOf(row.hash) } }, { 'Cache-Control': 'public, max-age=30', ...cors });
    return true;
  }

  if (req.method === 'GET' && p === '/v1/search') {
    if (!hit('pf-search', ip, 120, 60_000)) { tooMany(res, 60); return true; }
    send(res, 200, { ok: true, ...search(url.searchParams.get('q')) }, { 'Cache-Control': 'public, max-age=15', ...cors });
    return true;
  }
  return false;
}

function start() {
  setTimeout(() => { sweep(); }, 5_000).unref();
  setInterval(() => { sweep(); }, 15 * 60_000).unref();
}

module.exports = { setHooks, handleProfileRoutes, noteProfile, sweep, start, _internals: { cleanAbout, listSkins, search } };
