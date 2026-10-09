'use strict';
/**
 * Super Beta Tester program: players apply on the website, admins review.
 * Accepted testers get the Super Beta Tester badge, the Super Beta Tester cape and Native+ forever.
 *
 * Signed in
 *   GET    /v1/beta/me          { open, application|null, perks }
 *   POST   /v1/beta/apply       send (or edit while pending) your application
 *   DELETE /v1/beta/apply       withdraw a pending application
 * Admin
 *   GET    /v1/admin/beta       ?status=pending|approved|waitlist|rejected|all &q=  { applications, counts, open }
 *   PATCH  /v1/admin/beta/:id   { status?, note? }  approve (grants rewards) / waitlist / reject (revokes rewards)
 *   DELETE /v1/admin/beta/:id   delete an application (revokes rewards)
 *   Opening/closing applications: POST /v1/admin/site { beta: { open, closesAt, maxTesters } }
 *
 * Beta updates (launcher pre-release channel)
 *   GET    /v1/beta/channel              ?version=&platform=  { channel: 'beta'|'stable', tester }  (no sign-in → stable)
 *   GET    /v1/admin/beta/testers        ?q=  { config, releases, testers, stats }
 *   POST   /v1/admin/beta/testers        { username, note? }  add someone to beta updates
 *   PATCH  /v1/admin/beta/testers/:user  { enabled: true|false|null, note? }  null = follow application
 *   DELETE /v1/admin/beta/testers/:user  remove the override / manual tester
 *   POST   /v1/admin/beta/updates        { enabled?, includeAccepted? }  channel switches
 */
const crypto = require('crypto');
const db = require('./db');

const BADGE = 'super_beta_tester';
const CAPE = 'super-beta-tester';
const SOURCE = 'beta';
const PLUS_NOTE = 'Super Beta Tester';
const STATUSES = ['pending', 'approved', 'waitlist', 'rejected'];
const PLATFORMS = ['windows', 'macos', 'linux'];
const REAPPLY_MS = 7 * 86_400_000;

let ready = false;
let hooks = { settings: null, findItem: () => null, publish: null };
function setHooks(next) { hooks = { ...hooks, ...next }; }
const billing = () => require('./billing');

function sql() {
  const h = db.getDb();
  if (!ready) {
    h.exec(`CREATE TABLE IF NOT EXISTS beta_applications (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, username TEXT NOT NULL, email TEXT,
      answers TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', note TEXT,
      reviewed_by TEXT, reviewed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    h.exec('CREATE INDEX IF NOT EXISTS idx_beta_status ON beta_applications(status, created_at)');
    // enabled: 1 = always on beta, 0 = never, NULL = follow the application (accepted → on)
    h.exec(`CREATE TABLE IF NOT EXISTS beta_testers (
      user_id TEXT PRIMARY KEY, enabled INTEGER, note TEXT, added_by TEXT, added_at INTEGER,
      last_version TEXT, last_platform TEXT, last_seen_at INTEGER)`);
    h.exec('CREATE TABLE IF NOT EXISTS beta_update_config (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)');
    ready = true;
  }
  return h;
}

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, max);
const betaSettings = () => {
  const b = hooks.settings ? hooks.settings().beta : null;
  return { open: true, closesAt: null, maxTesters: 0, ...(b || {}) };
};
const approvedCount = () => Number(sql().prepare("SELECT COUNT(*) AS n FROM beta_applications WHERE status = 'approved'").get().n || 0);
function isOpen() {
  const b = betaSettings();
  if (!b.open) return false;
  if (b.closesAt && Date.now() >= Number(b.closesAt)) return false;
  if (Number(b.maxTesters) > 0 && approvedCount() >= Number(b.maxTesters)) return false;
  return true;
}

/** Validates the form. Throws a friendly message. */
function answersFrom(body) {
  const a = {
    discord: clean(body.discord, 40),
    platform: PLATFORMS.includes(body.platform) ? body.platform : '',
    specs: clean(body.specs, 300),
    versions: (Array.isArray(body.versions) ? body.versions : []).map((v) => clean(v, 20)).filter(Boolean).slice(0, 8),
    hours: Math.max(0, Math.min(80, Math.round(Number(body.hours) || 0))),
    playstyle: (Array.isArray(body.playstyle) ? body.playstyle : []).map((v) => clean(v, 24)).filter(Boolean).slice(0, 8),
    experience: clean(body.experience, 800),
    why: clean(body.why, 1200),
    timezone: clean(body.timezone, 60),
    age: ['under13', '13-17', '18-24', '25+'].includes(body.age) ? body.age : '',
    agree: body.agree === true
  };
  if (!a.discord || a.discord.length < 2) throw new Error('Add your Discord username so we can reach you.');
  if (!a.platform) throw new Error('Pick the computer you play on.');
  if (!a.age) throw new Error('Pick your age range.');
  if (a.age === 'under13') throw new Error('Sorry — beta testers need to be 13 or older.');
  if (a.why.length < 40) throw new Error('Tell us a bit more about why you want in (40+ characters).');
  if (!a.agree) throw new Error('Please agree to report bugs and keep unreleased things private.');
  return a;
}

function doc(row, admin = false) {
  if (!row) return null;
  let answers = {};
  try { answers = JSON.parse(row.answers || '{}'); } catch {}
  const out = {
    id: row.id, status: row.status, answers, createdAt: row.created_at, updatedAt: row.updated_at,
    reviewedAt: row.reviewed_at || null, note: row.status === 'pending' ? null : row.note || null,
    canReapply: row.status === 'rejected' && Date.now() - Number(row.reviewed_at || row.updated_at) >= REAPPLY_MS,
    reapplyAt: row.status === 'rejected' ? Number(row.reviewed_at || row.updated_at) + REAPPLY_MS : null
  };
  if (admin) {
    const u = db.getUserById(row.user_id);
    Object.assign(out, {
      userId: row.user_id, username: u?.username || row.username, email: row.email,
      accountCreatedAt: u?.created_at || null, badges: (() => { try { return JSON.parse(u?.badges || '[]'); } catch { return []; } })(),
      reviewedBy: row.reviewed_by ? (db.getUserById(row.reviewed_by)?.username || null) : null, note: row.note || null
    });
  }
  return out;
}

function perks() {
  const cape = hooks.findItem ? hooks.findItem(CAPE) : null;
  return { badge: BADGE, capeId: cape ? CAPE : null, plus: 'lifetime' };
}

/* ── rewards ───────────────────────────────────────────────────────── */
function grantRewards(userId, by) {
  try { db.setUserBadge(userId, BADGE, true); } catch (e) { console.warn('[Native Beta] badge', e.message); }
  if (hooks.findItem && hooks.findItem(CAPE)) billing().grantItem(userId, CAPE, SOURCE);
  billing().givePlus(userId, { note: PLUS_NOTE, by });
  notify(userId);
}
function revokeRewards(userId) {
  try { db.setUserBadge(userId, BADGE, false); } catch {}
  billing().takeItem(userId, CAPE, SOURCE);
  billing().takePlus(userId, PLUS_NOTE);
  notify(userId);
}
function notify(userId) {
  if (!hooks.publish) return;
  try { hooks.publish(userId); } catch {}
}


/* ── beta updates channel ──────────────────────────────────────────── */
const UPDATE_DEFAULTS = { enabled: true, includeAccepted: true };
function updateConfig() {
  const row = sql().prepare('SELECT value FROM beta_update_config WHERE id = 1').get();
  let v = {};
  try { v = JSON.parse(row?.value || '{}'); } catch {}
  return { ...UPDATE_DEFAULTS, ...v };
}
function saveUpdateConfig(patch) {
  const next = { ...updateConfig() };
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  if (patch.includeAccepted !== undefined) next.includeAccepted = Boolean(patch.includeAccepted);
  sql().prepare('INSERT INTO beta_update_config (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value').run(JSON.stringify(next));
  return next;
}
const testerRow = (userId) => sql().prepare('SELECT * FROM beta_testers WHERE user_id = ?').get(String(userId));
const isAccepted = (userId) => Boolean(sql().prepare("SELECT 1 FROM beta_applications WHERE user_id = ? AND status = 'approved'").get(String(userId)));
/** Whether this account gets launcher pre-releases. */
function isTester(userId, cfg = updateConfig()) {
  if (!cfg.enabled || !userId) return false;
  const row = testerRow(userId);
  if (row && row.enabled === 1) return true;
  if (row && row.enabled === 0) return false;
  return cfg.includeAccepted && isAccepted(userId);
}
function seen(userId, version, platform) {
  const v = clean(version, 40).replace(/[^0-9A-Za-z.+-]/g, '');
  const pf = ['win32', 'darwin', 'linux', 'windows', 'macos'].includes(platform) ? platform : '';
  sql().prepare(`INSERT INTO beta_testers (user_id, last_version, last_platform, last_seen_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET last_version = COALESCE(NULLIF(excluded.last_version, ''), last_version),
      last_platform = COALESCE(NULLIF(excluded.last_platform, ''), last_platform), last_seen_at = excluded.last_seen_at`)
    .run(String(userId), v, pf, Date.now());
}

let releaseCache = { at: 0, value: null };
async function releases() {
  if (releaseCache.value && Date.now() - releaseCache.at < 5 * 60_000) return releaseCache.value;
  try {
    const r = await fetch('https://api.github.com/repos/atlas-thedev/native-client-releases/releases?per_page=30', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'native-server' },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error('GitHub ' + r.status);
    const list = (await r.json()).filter((x) => !x.draft);
    const pick = (x) => x && {
      version: String(x.tag_name || '').replace(/^v/, ''), name: x.name || x.tag_name, url: x.html_url,
      publishedAt: Date.parse(x.published_at) || null,
      downloads: (x.assets || []).filter((a) => /\.(exe|dmg|AppImage|deb)$/i.test(a.name)).reduce((n, a) => n + (a.download_count || 0), 0)
    };
    const value = { stable: pick(list.find((x) => !x.prerelease)), beta: pick(list.find((x) => x.prerelease)) };
    releaseCache = { at: Date.now(), value };
    return value;
  } catch {
    return releaseCache.value || { stable: null, beta: null };
  }
}

function testerDocs(q) {
  const cfg = updateConfig();
  const ids = new Set([
    ...sql().prepare('SELECT user_id FROM beta_testers').all().map((r) => r.user_id),
    ...sql().prepare("SELECT user_id FROM beta_applications WHERE status = 'approved'").all().map((r) => r.user_id)
  ]);
  const out = [];
  for (const id of ids) {
    const u = db.getUserById(id);
    if (!u) continue;
    const row = testerRow(id);
    const accepted = isAccepted(id);
    if (!accepted && !(row && row.enabled === 1) && !(row && row.enabled === 0)) continue;
    if (q && !String(u.username).toLowerCase().includes(q)) continue;
    out.push({
      userId: id, username: u.username, accepted,
      mode: row?.enabled === 1 ? 'on' : row?.enabled === 0 ? 'off' : 'auto',
      active: isTester(id, cfg),
      note: row?.note || null, addedAt: row?.added_at || null,
      addedBy: row?.added_by ? (db.getUserById(row.added_by)?.username || null) : null,
      lastVersion: row?.last_version || null, lastPlatform: row?.last_platform || null, lastSeenAt: row?.last_seen_at || null
    });
  }
  out.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastSeenAt || 0) - (a.lastSeenAt || 0) || a.username.localeCompare(b.username));
  return out;
}

async function handleBetaRoutes(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const isPublic = p === '/v1/beta/me' || p === '/v1/beta/apply' || p === '/v1/beta/channel';
  const adminMatch = p === '/v1/admin/beta' || p.startsWith('/v1/admin/beta/');
  if (!isPublic && !adminMatch) return false;
  const { send } = ctx;
  const noStore = { 'Cache-Control': 'no-store' };
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const user = token ? db.getUserBySession(token) : null;
  const fail = (status, error) => { send(res, status, { ok: false, error }, noStore); return true; };
  if (p === '/v1/beta/channel' && req.method === 'GET') {
    // Signed-out launchers always stay on stable.
    if (!user) { send(res, 200, { ok: true, channel: 'stable', tester: false }, noStore); return true; }
    const tester = isTester(user.id);
    if (tester || testerRow(user.id) || isAccepted(user.id)) {
      try { seen(user.id, url.searchParams.get('version'), url.searchParams.get('platform')); } catch {}
    }
    send(res, 200, { ok: true, channel: tester ? 'beta' : 'stable', tester }, noStore);
    return true;
  }
  if (!user) return fail(401, 'Sign in to your Native account first.');
  let body = {};
  if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
    try { body = (await ctx.readJson(req)) || {}; } catch { return fail(400, 'Invalid JSON.'); }
  }
  const mine = () => sql().prepare('SELECT * FROM beta_applications WHERE user_id = ?').get(String(user.id));

  if (isPublic) {
    if (p === '/v1/beta/me' && req.method === 'GET') {
      send(res, 200, { ok: true, open: isOpen(), settings: betaSettings(), application: doc(mine()), perks: perks() }, noStore);
      return true;
    }
    if (p === '/v1/beta/apply' && req.method === 'POST') {
      if (ctx.hit && !ctx.hit('beta-apply', user.id, 12, 60 * 60_000)) return fail(429, 'Too many tries. Try again later.');
      const prev = mine();
      if (prev && prev.status === 'approved') return fail(409, 'You’re already a Super Beta Tester.');
      if (prev && prev.status === 'waitlist') return fail(409, 'You’re on the waitlist — we’ll reach out.');
      if (prev && prev.status === 'rejected' && !doc(prev).canReapply) return fail(409, 'You can apply again a week after your last review.');
      if (!prev && !isOpen()) return fail(423, 'Beta applications are closed right now.');
      let answers;
      try { answers = answersFrom(body); } catch (e) { return fail(400, e.message); }
      const now = Date.now();
      if (prev) {
        sql().prepare("UPDATE beta_applications SET answers = ?, status = 'pending', note = NULL, reviewed_by = NULL, reviewed_at = NULL, username = ?, email = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(answers), user.username, user.email, now, prev.id);
      } else {
        sql().prepare('INSERT INTO beta_applications (id, user_id, username, email, answers, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, \'pending\', ?, ?)')
          .run(crypto.randomBytes(6).toString('hex'), String(user.id), user.username, user.email, JSON.stringify(answers), now, now);
      }
      send(res, 200, { ok: true, application: doc(mine()) }, noStore);
      return true;
    }
    if (p === '/v1/beta/apply' && req.method === 'DELETE') {
      const prev = mine();
      if (!prev || prev.status !== 'pending') return fail(409, 'Only a pending application can be withdrawn.');
      sql().prepare('DELETE FROM beta_applications WHERE id = ?').run(prev.id);
      send(res, 200, { ok: true, application: null }, noStore);
      return true;
    }
    return fail(405, 'Method not allowed.');
  }

  // admin
  if (!user.is_admin) return fail(403, 'Administrator access required.');
  const counts = () => {
    const out = { pending: 0, approved: 0, waitlist: 0, rejected: 0, all: 0 };
    for (const r of sql().prepare('SELECT status, COUNT(*) AS n FROM beta_applications GROUP BY status').all()) { out[r.status] = Number(r.n); out.all += Number(r.n); }
    return out;
  };
  if (p === '/v1/admin/beta' && req.method === 'GET') {
    const status = url.searchParams.get('status') || 'pending';
    const q = clean(url.searchParams.get('q'), 60).toLowerCase();
    const rows = (STATUSES.includes(status)
      ? sql().prepare('SELECT * FROM beta_applications WHERE status = ? ORDER BY created_at ASC LIMIT 500').all(status)
      : sql().prepare('SELECT * FROM beta_applications ORDER BY created_at DESC LIMIT 500').all())
      .filter((r) => !q || r.username.toLowerCase().includes(q) || String(r.email || '').toLowerCase().includes(q) || String(r.answers).toLowerCase().includes(q));
    send(res, 200, { ok: true, open: isOpen(), settings: betaSettings(), counts: counts(), applications: rows.map((r) => doc(r, true)), perks: perks() }, noStore);
    return true;
  }
  if (p === '/v1/admin/beta/updates' && req.method === 'POST') {
    const config = saveUpdateConfig(body);
    send(res, 200, { ok: true, config }, noStore);
    return true;
  }
  if (p === '/v1/admin/beta/testers') {
    if (req.method === 'GET') {
      const q = clean(url.searchParams.get('q'), 60).toLowerCase();
      const testers = testerDocs(q);
      const week = Date.now() - 7 * 86_400_000;
      const rel = await releases();
      send(res, 200, {
        ok: true, config: updateConfig(), releases: rel, testers,
        stats: {
          active: testers.filter((t) => t.active).length,
          seen7d: testers.filter((t) => t.active && t.lastSeenAt && t.lastSeenAt >= week).length,
          onBeta: rel.beta ? testers.filter((t) => t.active && t.lastVersion === rel.beta.version).length : 0
        }
      }, noStore);
      return true;
    }
    if (req.method === 'POST') {
      const name = clean(body.username, 40).replace(/^@/, '');
      const target = name ? db.getUserByUsername(name) : null;
      if (!target) return fail(404, `No Native account called “${name}”.`);
      const note = body.note !== undefined ? clean(body.note, 200) : null;
      sql().prepare(`INSERT INTO beta_testers (user_id, enabled, note, added_by, added_at) VALUES (?, 1, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET enabled = 1, note = COALESCE(excluded.note, note), added_by = excluded.added_by, added_at = excluded.added_at`)
        .run(String(target.id), note, String(user.id), Date.now());
      send(res, 200, { ok: true, testers: testerDocs('') }, noStore);
      return true;
    }
    return fail(405, 'Method not allowed.');
  }
  const tm = p.match(/^\/v1\/admin\/beta\/testers\/([A-Za-z0-9_-]{1,64})$/);
  if (tm) {
    const target = db.getUserById(tm[1]);
    if (!target) return fail(404, 'Account not found.');
    if (req.method === 'PATCH') {
      const enabled = body.enabled === true ? 1 : body.enabled === false ? 0 : null;
      const note = body.note !== undefined ? clean(body.note, 200) : undefined;
      sql().prepare(`INSERT INTO beta_testers (user_id, enabled, note, added_by, added_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, note = COALESCE(excluded.note, note), added_by = excluded.added_by, added_at = excluded.added_at`)
        .run(String(target.id), enabled, note ?? null, String(user.id), Date.now());
      send(res, 200, { ok: true, testers: testerDocs('') }, noStore);
      return true;
    }
    if (req.method === 'DELETE') {
      // keep the last-seen info, drop the override
      sql().prepare('UPDATE beta_testers SET enabled = NULL, note = NULL WHERE user_id = ?').run(String(target.id));
      send(res, 200, { ok: true, testers: testerDocs('') }, noStore);
      return true;
    }
    return fail(405, 'Method not allowed.');
  }
  const m = p.match(/^\/v1\/admin\/beta\/([a-f0-9]{6,32})$/);
  if (!m) return fail(404, 'Not found.');
  const row = sql().prepare('SELECT * FROM beta_applications WHERE id = ?').get(m[1]);
  if (!row) return fail(404, 'Application not found.');
  if (req.method === 'PATCH') {
    const status = body.status !== undefined ? String(body.status) : row.status;
    if (!STATUSES.includes(status)) return fail(400, 'Unknown status.');
    const note = body.note !== undefined ? clean(body.note, 400) : row.note;
    sql().prepare('UPDATE beta_applications SET status = ?, note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?')
      .run(status, note || null, status === row.status && body.status === undefined ? row.reviewed_by : String(user.id), status === 'pending' ? null : Date.now(), Date.now(), row.id);
    if (status === 'approved' && row.status !== 'approved') grantRewards(row.user_id, user.id);
    if (status !== 'approved' && row.status === 'approved') revokeRewards(row.user_id);
    const next = sql().prepare('SELECT * FROM beta_applications WHERE id = ?').get(row.id);
    send(res, 200, { ok: true, application: doc(next, true), counts: counts() }, noStore);
    return true;
  }
  if (req.method === 'DELETE') {
    if (row.status === 'approved') revokeRewards(row.user_id);
    sql().prepare('DELETE FROM beta_applications WHERE id = ?').run(row.id);
    send(res, 200, { ok: true, counts: counts() }, noStore);
    return true;
  }
  return fail(405, 'Method not allowed.');
}

module.exports = { BADGE, CAPE, handleBetaRoutes, setHooks, grantRewards, revokeRewards, isOpen, isTester, updateConfig };
