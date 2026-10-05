'use strict';
/**
 * Website + launch controls: pre-launch countdown, store/download locks, the founder free cape,
 * maintenance mode, the announcement bar, offers (sales) and community votes.
 *
 * Public
 *   GET  /v1/site/config                 launch state, maintenance, announcement, live offers
 *   GET  /v1/polls                       community votes (Bearer optional: adds your vote)
 * Signed in
 *   GET  /v1/site/founder                { eligible, picked, capes }
 *   POST /v1/site/founder                { itemId }  pick the one free founder cape
 *   POST /v1/polls/:id/vote              { optionId }  vote (you may change it while the vote is open)
 * Admin (session with is_admin)
 *   GET  /v1/admin/site                  settings + overview numbers
 *   POST /v1/admin/site                  { launch?, maintenance?, announcement? } partial update
 *   POST /v1/admin/site/offers           create an offer        PATCH/DELETE /v1/admin/site/offers/:id
 *   POST /v1/admin/site/prices           { price, itemIds? }  set the price of many capes at once
 *   GET  /v1/admin/polls                 every vote with full results
 *   POST /v1/admin/polls                 create                 PATCH/DELETE /v1/admin/polls/:id
 */
const crypto = require('crypto');
const db = require('./db');
const capes = require('./capes');

const DEFAULT_LAUNCH_AT = Date.parse(process.env.NATIVE_LAUNCH_AT || '2026-11-01T18:00:00Z');
const DEFAULT_FOUNDER_CAPES = ['toon-blaze', 'slime-pop', 'comet-night'];

/** Tests (which run on a temp NATIVE_DATA_DIR) start launched unless they opt in. */
const PRELAUNCH_DEFAULT = process.env.NATIVE_PRELAUNCH != null
  ? !/^(0|false|no)$/i.test(process.env.NATIVE_PRELAUNCH)
  : !(process.env.NODE_ENV === 'test' || process.env.NATIVE_DATA_DIR);

const DEFAULTS = () => ({
  launch: {
    at: DEFAULT_LAUNCH_AT,
    prelaunch: PRELAUNCH_DEFAULT,
    lockStore: true,
    lockDownloads: true,
    founderPick: true,
    founderCapes: DEFAULT_FOUNDER_CAPES.slice(),
    headline: 'Native is almost here.',
    subline: 'Create your free account before launch and pick one exclusive cape on us.'
  },
  maintenance: { enabled: false, message: 'We’re upgrading Native. Back very soon.', until: null },
  announcement: { enabled: false, text: '', href: '', cta: '' },
  offers: []
});

let ready = false;
let cache = null;
let hooks = { findItem: () => null, allItems: () => [], storeTexture: null, grant: null, owns: null };
function setHooks(next) { hooks = { ...hooks, ...next }; }

function sql() {
  const h = db.getDb();
  if (!ready) {
    h.exec(`CREATE TABLE IF NOT EXISTS site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS founder_picks (user_id TEXT PRIMARY KEY, item_id TEXT NOT NULL, picked_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS polls (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'cape',
        status TEXT NOT NULL DEFAULT 'open', results TEXT NOT NULL DEFAULT 'after_vote', ends_at INTEGER,
        created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS poll_options (
        id TEXT PRIMARY KEY, poll_id TEXT NOT NULL, label TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        image TEXT, position INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options(poll_id);
      CREATE TABLE IF NOT EXISTS poll_votes (
        poll_id TEXT NOT NULL, user_id TEXT NOT NULL, option_id TEXT NOT NULL, voted_at INTEGER NOT NULL,
        PRIMARY KEY (poll_id, user_id));
      CREATE INDEX IF NOT EXISTS idx_poll_votes_option ON poll_votes(option_id);`);
    ready = true;
  }
  return h;
}

/* ── settings ──────────────────────────────────────────────────────── */

function settings() {
  if (cache) return cache;
  const base = DEFAULTS();
  try {
    for (const row of sql().prepare('SELECT key, value FROM site_settings').all()) {
      let v = null;
      try { v = JSON.parse(row.value); } catch {}
      if (v == null) continue;
      if (row.key === 'offers') base.offers = Array.isArray(v) ? v : [];
      else if (base[row.key] && typeof v === 'object') base[row.key] = { ...base[row.key], ...v };
    }
  } catch (error) { console.warn('[Native Site] settings:', error.message); }
  cache = base;
  return cache;
}
function save(key, value) {
  sql().prepare(`INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, JSON.stringify(value), Date.now());
  cache = null;
}

const isPrelaunch = (s = settings()) => Boolean(s.launch.prelaunch) && Date.now() < Number(s.launch.at || 0);
const storeLocked = () => { const s = settings(); return isPrelaunch(s) && Boolean(s.launch.lockStore); };
const maintenanceOn = () => Boolean(settings().maintenance.enabled);

/* ── offers ────────────────────────────────────────────────────────── */

const offerLive = (o, now = Date.now()) => o && o.enabled && (!o.startsAt || o.startsAt <= now) && (!o.endsAt || o.endsAt > now);
const offerFits = (o, item) => !Array.isArray(o.itemIds) || !o.itemIds.length || o.itemIds.includes(item.id);

/** The best live offer for an item, or null. */
function offerFor(item) {
  if (!item || item.exclusive || !(Number(item.price) > 0)) return null;
  let best = null;
  for (const o of settings().offers) if (offerLive(o) && offerFits(o, item) && (!best || o.percent > best.percent)) best = o;
  return best;
}
/** What a cape costs right now (USD), after the best live offer. */
function priceOf(item) {
  const base = Math.max(0, Number(item?.price) || 0);
  const o = offerFor(item);
  if (!o || !base) return base;
  return Math.max(0.5, Math.round(base * (100 - o.percent)) / 100);
}
const publicOffer = (o) => ({ id: o.id, title: o.title, description: o.description || '', percent: o.percent, itemIds: o.itemIds || [], startsAt: o.startsAt || null, endsAt: o.endsAt || null, banner: Boolean(o.banner) });

/* ── founder cape ──────────────────────────────────────────────────── */

function founderCapes() {
  const s = settings();
  const wanted = (s.launch.founderCapes || []).map((id) => hooks.findItem(id)).filter((it) => it && !it.hidden);
  const list = wanted.length ? wanted : hooks.allItems().filter((it) => !it.hidden && !it.exclusive).slice(0, 3);
  return list.slice(0, 6);
}
const pickOf = (userId) => sql().prepare('SELECT item_id, picked_at FROM founder_picks WHERE user_id = ?').get(String(userId)) || null;
/** Accounts made before launch get one free cape (they may pick it any time). */
function founderEligible(user) {
  const s = settings();
  if (!user || !s.launch.founderPick) return false;
  return Number(user.created_at || 0) < Number(s.launch.at || 0) || isPrelaunch(s);
}

/* ── beta tester badge ────────────────────────────────────────────── */
const BETA_BADGE = 'beta_tester';
let betaSweptAt = 0;
function addBadge(row) {
  let list = [];
  try { list = JSON.parse(row.badges || '[]'); } catch { list = []; }
  if (!Array.isArray(list)) list = [];
  if (list.includes(BETA_BADGE)) return false;
  list.push(BETA_BADGE);
  sql().prepare('UPDATE users SET badges = ? WHERE id = ?').run(JSON.stringify(list), row.id);
  return true;
}
/** Every account made before launch is a beta tester (granted while pre-launch). Never revoked. Returns ids that just got it. */
function sweepBetaBadges({ force = false } = {}) {
  if (!force && Date.now() - betaSweptAt < 5 * 60_000) return [];
  betaSweptAt = Date.now();
  // Only while pre-launch: after launch nobody new qualifies, and everyone who did already has it.
  if (!isPrelaunch(settings())) return [];
  const rows = sql().prepare("SELECT id, badges FROM users WHERE created_at <= ? AND (badges IS NULL OR badges NOT LIKE '%\"beta_tester\"%')").all(Date.now());
  return rows.filter(addBadge).map((r) => r.id);
}
/** Called right after sign-up: grants the beta tester badge while pre-launch. */
function onUserCreated(user) {
  if (!user?.id) return false;
  if (!isPrelaunch(settings())) return false;
  const row = sql().prepare('SELECT id, badges FROM users WHERE id = ?').get(String(user.id));
  return row ? addBadge(row) : false;
}

/* ── polls ─────────────────────────────────────────────────────────── */

const ID = () => crypto.randomBytes(6).toString('hex');
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const pollOpen = (p, now = Date.now()) => p.status === 'open' && (!p.ends_at || p.ends_at > now);

function pollDoc(p, textureBase, userId, admin = false) {
  const options = sql().prepare('SELECT * FROM poll_options WHERE poll_id = ? ORDER BY position, rowid').all(p.id);
  const counts = new Map(sql().prepare('SELECT option_id, COUNT(*) AS n FROM poll_votes WHERE poll_id = ? GROUP BY option_id').all(p.id).map((r) => [r.option_id, Number(r.n)]));
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const mine = userId ? sql().prepare('SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?').get(p.id, String(userId))?.option_id || null : null;
  const open = pollOpen(p);
  const show = admin || p.results === 'always' || (p.results === 'after_vote' && (mine || !open)) || (p.results === 'after_close' && !open);
  return {
    id: p.id, title: p.title, description: p.description, kind: p.kind, status: open ? 'open' : 'closed', rawStatus: p.status,
    results: p.results, endsAt: p.ends_at || null, createdAt: p.created_at, myVote: mine, total: show ? total : null, showResults: show,
    options: options.map((o) => ({
      id: o.id, label: o.label, description: o.description,
      image: o.image ? (/^[a-f0-9]{64}$/.test(o.image) ? `${textureBase}${o.image}` : o.image) : null,
      votes: show ? (counts.get(o.id) || 0) : null
    }))
  };
}

function optionImage(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && /^https:\/\//.test(value)) return value.slice(0, 500);
  if (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) return value;
  const png = capes.pngFromBase64(value, 5 * 1024 * 1024);
  if (!png || !hooks.storeTexture) throw new Error('Images must be PNG files under 5 MB.');
  return hooks.storeTexture(png);
}

/* ── validation ────────────────────────────────────────────────────── */

const timeOf = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(n) ? n : undefined;
};
const bool = (v, fallback) => (v === undefined ? fallback : Boolean(v));

function applyLaunch(prev, b) {
  const next = { ...prev };
  if (b.at !== undefined) {
    const t = timeOf(b.at);
    if (!t) throw new Error('Pick a valid launch date and time.');
    next.at = t;
  }
  for (const k of ['prelaunch', 'lockStore', 'lockDownloads', 'founderPick']) next[k] = bool(b[k], prev[k]);
  if (b.founderCapes !== undefined) {
    const ids = (Array.isArray(b.founderCapes) ? b.founderCapes : []).map(String).filter((id) => hooks.findItem(id));
    next.founderCapes = [...new Set(ids)].slice(0, 6);
  }
  if (b.headline !== undefined) next.headline = clean(b.headline, 80);
  if (b.subline !== undefined) next.subline = clean(b.subline, 200);
  return next;
}
function applyMaintenance(prev, b) {
  const next = { ...prev, enabled: bool(b.enabled, prev.enabled) };
  if (b.message !== undefined) next.message = clean(b.message, 280) || DEFAULTS().maintenance.message;
  if (b.until !== undefined) next.until = timeOf(b.until) || null;
  return next;
}
function applyAnnouncement(prev, b) {
  const next = { ...prev, enabled: bool(b.enabled, prev.enabled) };
  if (b.text !== undefined) next.text = clean(b.text, 160);
  if (b.cta !== undefined) next.cta = clean(b.cta, 30);
  if (b.href !== undefined) {
    const href = clean(b.href, 300);
    if (href && !/^(https:\/\/|\/)/.test(href)) throw new Error('Links must start with https:// or /.');
    next.href = href;
  }
  return next;
}
function offerFrom(b, prev = {}) {
  const o = { ...prev };
  if (b.title !== undefined || !prev.id) o.title = clean(b.title, 60);
  if (!o.title || o.title.length < 2) throw new Error('Give the offer a title.');
  if (b.description !== undefined) o.description = clean(b.description, 200);
  if (b.percent !== undefined || !prev.id) {
    const p = Math.round(Number(b.percent));
    if (!(p >= 1 && p <= 90)) throw new Error('The discount must be 1-90%.');
    o.percent = p;
  }
  if (b.itemIds !== undefined) o.itemIds = (Array.isArray(b.itemIds) ? b.itemIds : []).map(String).filter((id) => hooks.findItem(id)).slice(0, 100);
  if (b.startsAt !== undefined) { const t = timeOf(b.startsAt); if (t === undefined) throw new Error('Invalid start date.'); o.startsAt = t; }
  if (b.endsAt !== undefined) { const t = timeOf(b.endsAt); if (t === undefined) throw new Error('Invalid end date.'); o.endsAt = t; }
  if (o.startsAt && o.endsAt && o.endsAt <= o.startsAt) throw new Error('The offer must end after it starts.');
  o.enabled = bool(b.enabled, prev.id ? prev.enabled : true);
  o.banner = bool(b.banner, prev.id ? prev.banner : true);
  return o;
}

/* ── http ──────────────────────────────────────────────────────────── */

const bearerOf = (req) => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  || String(req.headers['x-native-token'] || '').trim();

function publicConfig() {
  const s = settings();
  const prelaunch = isPrelaunch(s);
  return {
    serverTime: Date.now(),
    launch: {
      at: s.launch.at, prelaunch, launched: !prelaunch,
      lockStore: prelaunch && s.launch.lockStore, lockDownloads: prelaunch && s.launch.lockDownloads,
      founderPick: Boolean(s.launch.founderPick), founderCapes: founderCapes().map((it) => it.id),
      headline: s.launch.headline, subline: s.launch.subline
    },
    maintenance: s.maintenance,
    announcement: s.announcement,
    offers: s.offers.filter((o) => offerLive(o)).map(publicOffer)
  };
}

function overview() {
  const one = (q, ...a) => Number(sql().prepare(q).get(...a)?.n || 0);
  const s = settings();
  return {
    users: one('SELECT COUNT(*) AS n FROM users'),
    preLaunchUsers: one('SELECT COUNT(*) AS n FROM users WHERE created_at < ?', s.launch.at),
    newToday: one('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', Date.now() - 86_400_000),
    newThisWeek: one('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', Date.now() - 7 * 86_400_000),
    founderPicks: one('SELECT COUNT(*) AS n FROM founder_picks'),
    founderByCape: sql().prepare('SELECT item_id AS id, COUNT(*) AS n FROM founder_picks GROUP BY item_id ORDER BY n DESC').all().map((r) => ({ id: r.id, name: hooks.findItem(r.id)?.name || r.id, count: Number(r.n) })),
    votes: one('SELECT COUNT(*) AS n FROM poll_votes'),
    openPolls: sql().prepare('SELECT * FROM polls').all().filter((p) => pollOpen(p)).length,
    signups: sql().prepare("SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY day ORDER BY day").all(Date.now() - 30 * 86_400_000).map((r) => ({ day: r.day, count: Number(r.n) }))
  };
}

async function handleSiteRoutes(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const isSite = p.startsWith('/v1/site/') || p === '/v1/polls' || p.startsWith('/v1/polls/');
  const isAdmin = p === '/v1/admin/site' || p.startsWith('/v1/admin/site/') || p === '/v1/admin/polls' || p.startsWith('/v1/admin/polls/');
  if (!isSite && !isAdmin) return false;
  const { send, hit, tooMany, ip } = ctx;
  const noStore = { 'Cache-Control': 'no-store' };
  const textureBase = `${ctx.originOf(req)}/csl/textures/`;
  const token = bearerOf(req);
  const user = token ? db.getUserBySession(token) : null;
  const fail = (status, error) => { send(res, status, { ok: false, error }); return true; };

  if (isAdmin) {
    if (!user) return fail(401, 'Native account session required.');
    if (!user.is_admin) return fail(403, 'Administrator access required.');
    let body = {};
    if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
      try { body = (await ctx.readJson(req)) || {}; } catch { return fail(400, 'Invalid JSON.'); }
    }
    const allPolls = () => sql().prepare('SELECT * FROM polls ORDER BY created_at DESC').all().map((row) => pollDoc(row, textureBase, null, true));
    const adminDoc = () => ({ ok: true, settings: settings(), config: publicConfig(), overview: overview() });
    try {
      if (p === '/v1/admin/site' && req.method === 'GET') { send(res, 200, adminDoc(), noStore); return true; }
      if (p === '/v1/admin/site' && req.method === 'POST') {
        const s = settings();
        if (body.launch) save('launch', applyLaunch(s.launch, body.launch));
        if (body.maintenance) save('maintenance', applyMaintenance(s.maintenance, body.maintenance));
        if (body.announcement) save('announcement', applyAnnouncement(s.announcement, body.announcement));
        send(res, 200, adminDoc(), noStore);
        return true;
      }
      if (p === '/v1/admin/site/offers' && req.method === 'POST') {
        const o = { id: ID(), createdAt: Date.now(), ...offerFrom(body) };
        save('offers', [o, ...settings().offers].slice(0, 100));
        send(res, 200, adminDoc(), noStore);
        return true;
      }
      const om = p.match(/^\/v1\/admin\/site\/offers\/([a-f0-9]{6,24})$/);
      if (om) {
        const list = settings().offers;
        const prev = list.find((o) => o.id === om[1]);
        if (!prev) return fail(404, 'That offer does not exist.');
        if (req.method === 'PATCH') save('offers', list.map((o) => (o.id === prev.id ? offerFrom(body, prev) : o)));
        else if (req.method === 'DELETE') save('offers', list.filter((o) => o.id !== prev.id));
        else return fail(405, 'Method not allowed.');
        send(res, 200, adminDoc(), noStore);
        return true;
      }
      if (p === '/v1/admin/site/prices' && req.method === 'POST') {
        if (!hooks.setPrices) return fail(503, 'Store is not ready.');
        const changed = hooks.setPrices(Number(body.price), Array.isArray(body.itemIds) ? body.itemIds.map(String) : null);
        send(res, 200, { ...adminDoc(), changed }, noStore);
        return true;
      }
      if (p === '/v1/admin/polls' && req.method === 'GET') { send(res, 200, { ok: true, polls: allPolls() }, noStore); return true; }
      if (p === '/v1/admin/polls' && req.method === 'POST') {
        const title = clean(body.title, 80);
        if (title.length < 3) return fail(400, 'Give the vote a title (3-80 characters).');
        const opts = Array.isArray(body.options) ? body.options : [];
        if (opts.length < 2 || opts.length > 8) return fail(400, 'A vote needs 2-8 options.');
        const prepared = opts.map((o, i) => {
          const label = clean(o?.label, 40);
          if (!label) throw new Error(`Option ${i + 1} needs a name.`);
          return { id: ID(), label, description: clean(o?.description, 200), image: optionImage(o?.image), position: i };
        });
        const endsAt = timeOf(body.endsAt);
        if (endsAt === undefined) return fail(400, 'Invalid end date.');
        const now = Date.now();
        const id = ID();
        const results = ['always', 'after_vote', 'after_close'].includes(body.results) ? body.results : 'after_vote';
        const status = body.status === 'draft' ? 'draft' : 'open';
        sql().prepare('INSERT INTO polls (id, title, description, kind, status, results, ends_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, title, clean(body.description, 500), clean(body.kind, 20) || 'cape', status, results, endsAt, String(user.id), now, now);
        const ins = sql().prepare('INSERT INTO poll_options (id, poll_id, label, description, image, position) VALUES (?, ?, ?, ?, ?, ?)');
        for (const o of prepared) ins.run(o.id, id, o.label, o.description, o.image, o.position);
        send(res, 200, { ok: true, polls: allPolls() }, noStore);
        return true;
      }
      const pm = p.match(/^\/v1\/admin\/polls\/([a-f0-9]{6,24})$/);
      if (pm) {
        const row = sql().prepare('SELECT * FROM polls WHERE id = ?').get(pm[1]);
        if (!row) return fail(404, 'That vote does not exist.');
        if (req.method === 'PATCH') {
          const next = { ...row };
          if (body.title !== undefined) { next.title = clean(body.title, 80); if (next.title.length < 3) return fail(400, 'Give the vote a title.'); }
          if (body.description !== undefined) next.description = clean(body.description, 500);
          if (body.status !== undefined) next.status = ['open', 'closed', 'draft'].includes(body.status) ? body.status : row.status;
          if (body.results !== undefined) next.results = ['always', 'after_vote', 'after_close'].includes(body.results) ? body.results : row.results;
          if (body.endsAt !== undefined) { const t = timeOf(body.endsAt); if (t === undefined) return fail(400, 'Invalid end date.'); next.ends_at = t; }
          sql().prepare('UPDATE polls SET title = ?, description = ?, status = ?, results = ?, ends_at = ?, updated_at = ? WHERE id = ?')
            .run(next.title, next.description, next.status, next.results, next.ends_at, Date.now(), row.id);
          if (body.resetVotes === true) sql().prepare('DELETE FROM poll_votes WHERE poll_id = ?').run(row.id);
          send(res, 200, { ok: true, polls: allPolls() }, noStore);
          return true;
        }
        if (req.method === 'DELETE') {
          sql().prepare('DELETE FROM poll_votes WHERE poll_id = ?').run(row.id);
          sql().prepare('DELETE FROM poll_options WHERE poll_id = ?').run(row.id);
          sql().prepare('DELETE FROM polls WHERE id = ?').run(row.id);
          send(res, 200, { ok: true, polls: allPolls() }, noStore);
          return true;
        }
      }
    } catch (error) {
      return fail(400, error.message || 'That didn’t work.');
    }
    return fail(404, 'Admin endpoint not found.');
  }

  if (req.method === 'GET' && p === '/v1/site/config') {
    if (!hit('site-config', ip, 240, 60_000)) { tooMany(res, 60); return true; }
    send(res, 200, { ok: true, ...publicConfig() }, { 'Cache-Control': 'public, max-age=10', 'Access-Control-Allow-Origin': '*' });
    return true;
  }

  if (p === '/v1/site/founder') {
    if (!user) return fail(401, 'Sign in to pick your founder cape.');
    const list = founderCapes();
    const doc = () => {
      const pick = pickOf(user.id);
      return { ok: true, eligible: founderEligible(user), picked: pick ? pick.item_id : null, pickedAt: pick ? Number(pick.picked_at) : null, capes: list.map((it) => it.id) };
    };
    if (req.method === 'GET') { send(res, 200, doc(), noStore); return true; }
    if (req.method === 'POST') {
      if (!hit('founder-pick', user.id, 10, 10 * 60_000)) { tooMany(res, 600); return true; }
      const body = await ctx.readJson(req).catch(() => ({}));
      if (!founderEligible(user)) return fail(403, 'The free founder cape is for accounts made before launch.');
      if (pickOf(user.id)) return fail(409, 'You already picked your free founder cape.');
      const item = list.find((it) => it.id === String(body.itemId || ''));
      if (!item) return fail(400, 'Pick one of the founder capes.');
      const take = sql().prepare('INSERT OR IGNORE INTO founder_picks (user_id, item_id, picked_at) VALUES (?, ?, ?)').run(String(user.id), item.id, Date.now());
      if (!take.changes) return fail(409, 'You already picked your free founder cape.');
      if (hooks.grant) hooks.grant(user.id, item.id, 'founder');
      if (hooks.onGrant) { try { hooks.onGrant(user, item); } catch {} }
      send(res, 200, doc(), noStore);
      return true;
    }
    return fail(405, 'Method not allowed.');
  }

  if (req.method === 'GET' && p === '/v1/polls') {
    if (!hit('polls', ip, 120, 60_000)) { tooMany(res, 60); return true; }
    const rows = sql().prepare("SELECT * FROM polls WHERE status != 'draft' ORDER BY created_at DESC LIMIT 50").all();
    const polls = rows.map((row) => pollDoc(row, textureBase, user?.id)).sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open'));
    send(res, 200, { ok: true, signedIn: Boolean(user), polls }, noStore);
    return true;
  }

  const vm = p.match(/^\/v1\/polls\/([a-f0-9]{6,24})\/vote$/);
  if (vm && req.method === 'POST') {
    if (!user) return fail(401, 'Sign in to vote.');
    if (!hit('poll-vote', user.id, 30, 10 * 60_000)) { tooMany(res, 600); return true; }
    const row = sql().prepare('SELECT * FROM polls WHERE id = ?').get(vm[1]);
    if (!row || row.status === 'draft') return fail(404, 'That vote does not exist.');
    if (!pollOpen(row)) return fail(410, 'This vote is closed.');
    const body = await ctx.readJson(req).catch(() => ({}));
    const opt = sql().prepare('SELECT id FROM poll_options WHERE id = ? AND poll_id = ?').get(String(body.optionId || ''), row.id);
    if (!opt) return fail(400, 'Pick an option.');
    sql().prepare(`INSERT INTO poll_votes (poll_id, user_id, option_id, voted_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(poll_id, user_id) DO UPDATE SET option_id = excluded.option_id, voted_at = excluded.voted_at`).run(row.id, String(user.id), opt.id, Date.now());
    send(res, 200, { ok: true, poll: pollDoc(row, textureBase, user.id) }, noStore);
    return true;
  }

  return fail(404, 'Not found.');
}

/** Test hook. */
function resetCache() { cache = null; ready = false; }

module.exports = { BETA_BADGE, sweepBetaBadges, onUserCreated, handleSiteRoutes, setHooks, settings, publicConfig, isPrelaunch, storeLocked, maintenanceOn, priceOf, offerFor, publicOffer, founderCapes, resetCache };
