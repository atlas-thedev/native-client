'use strict';
/**
 * The Noctra cape store.
 *
 * Public
 *   GET  /v1/store/catalog         visible items (newest/featured first) with texture URLs + owner counts
 *   GET  /v1/store/items/:id       one item (hidden items too, so retired capes still have a page)
 * Signed in (Bearer or X-Noctra-Token)
 *   GET  /v1/store/me              { equipped, owned: [{ id, acquiredAt }] }
 *   POST /v1/store/claim           { itemId }  add a store item to your locker (everything is free today)
 *   POST /v1/store/unclaim         { itemId }  remove it from your locker (takes it off if worn)
 *   POST /v1/store/equip           { itemId }  wear an item from your locker (null = take the cape off).
 *                                   Free items are added to the locker automatically.
 *   GET  /v1/store/stream          SSE: wardrobe:changed for the signed-in account
 * Admin (session with is_admin)
 *   GET    /v1/admin/store/items           every item, hidden ones included
 *   POST   /v1/admin/store/items           create (animated strip + still, or a static PNG)
 *   PATCH  /v1/admin/store/items/:id       edit metadata and/or replace textures
 *   DELETE /v1/admin/store/items/:id       remove from the store (owners keep nothing)
 *
 * Animated capes are ONLY store items: the wardrobe accepts an animation when its strip is
 * a store item the account owns (see `authorizeAnimation`). Anything else is shown as its
 * still first frame everywhere (`animationFor`).
 *
 * The catalogue lives in DATA_DIR/store/catalog.json. On first run it is seeded from the
 * bundled server/store/catalog.json; bundled items added in later deploys appear automatically
 * unless an admin deleted them.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const capes = require('./capes');
const events = require('./social-events');

const ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const NEW_FOR_MS = 21 * 24 * 60 * 60 * 1000;

let catalog = null; // { rev, sections, items, deleted }
let storeTexture = null;
let tableReady = false;

const catalogFile = () => path.join(db.DATA_DIR || path.join(__dirname, '..', 'data'), 'store', 'catalog.json');

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function persist() {
  catalog.rev += 1;
  atomicWrite(catalogFile(), JSON.stringify({ version: 2, rev: catalog.rev, sections: catalog.sections, deleted: catalog.deleted, items: catalog.items }, null, 2));
}

function ensureCatalog(textureFn) {
  if (textureFn) storeTexture = textureFn;
  if (catalog) return catalog;
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(catalogFile(), 'utf8')); } catch {}
  const bundled = capes.loadCatalog(storeTexture);
  const now = Date.now();
  if (saved && Array.isArray(saved.items)) {
    catalog = { rev: Number(saved.rev) || 1, sections: saved.sections || bundled.sections, deleted: Array.isArray(saved.deleted) ? saved.deleted : [], items: saved.items };
    let added = false;
    bundled.items.forEach((item, index) => {
      if (catalog.items.some((x) => x.id === item.id) || catalog.deleted.includes(item.id)) return;
      catalog.items.push({ ...item, hidden: false, order: catalog.items.length + index, createdAt: now, updatedAt: now });
      added = true;
    });
    if (added) persist();
  } else {
    catalog = {
      rev: 1,
      sections: bundled.sections,
      deleted: [],
      items: bundled.items.map((item, index) => ({ ...item, hidden: false, order: index, createdAt: now - index * 1000, updatedAt: now }))
    };
    try { persist(); } catch (error) { console.warn('[Noctra Store] Could not save the catalogue:', error.message); }
  }
  return catalog;
}

/* ── ownership ─────────────────────────────────────────────────────── */

function sql() {
  const handle = db.getDb();
  if (!tableReady) {
    handle.exec(`CREATE TABLE IF NOT EXISTS store_owned (
      user_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'free',
      PRIMARY KEY (user_id, item_id)
    )`);
    handle.exec('CREATE INDEX IF NOT EXISTS idx_store_owned_item ON store_owned(item_id)');
    tableReady = true;
  }
  return handle;
}

function ownedBy(userId) {
  return sql().prepare('SELECT item_id, acquired_at FROM store_owned WHERE user_id = ? ORDER BY acquired_at DESC').all(String(userId))
    .map((row) => ({ id: row.item_id, acquiredAt: Number(row.acquired_at) }));
}
function owns(userId, itemId) {
  return Boolean(sql().prepare('SELECT 1 FROM store_owned WHERE user_id = ? AND item_id = ?').get(String(userId), String(itemId)));
}
function grant(userId, itemId, source = 'free') {
  sql().prepare('INSERT OR IGNORE INTO store_owned (user_id, item_id, acquired_at, source) VALUES (?, ?, ?, ?)').run(String(userId), String(itemId), Date.now(), source);
}
function revoke(userId, itemId) {
  sql().prepare('DELETE FROM store_owned WHERE user_id = ? AND item_id = ?').run(String(userId), String(itemId));
}
function ownerCounts() {
  const counts = new Map();
  try {
    for (const row of sql().prepare('SELECT item_id, COUNT(*) AS n FROM store_owned GROUP BY item_id').all()) counts.set(row.item_id, Number(row.n));
  } catch {}
  return counts;
}

/* ── animation policy (used by server.js and mod-routes.js) ───────── */

const current = () => catalog || (storeTexture ? ensureCatalog() : { items: [] });
const findItem = (id) => current().items.find((item) => item.id === id) || null;
/**
 * Capes players may wear: the bundled classic capes (sha256 of the PNG, the same files ship with the
 * launcher and the website) and Noctra Store capes. Players cannot upload capes of their own.
 */
const PRESET_CAPE_HASHES = new Set([
  '0b4f4ee1bf094876a8454838b7cd07184dce86428b3cab4122b3bb7d67e530b6', // 15th Anniversary
  'be05a2d92dd043034c9ae6d7c8415e8bc990080ba4dc4c70e9ea92cf9a89705c', // Cherry Blossom
  '77065df71efe39771d3af4832ed62803c551772cc2f78e744d52822ae949f6c6', // Followers
  '99aba02ef05ec6aa4d42db8ee43796d6cd50e4b2954ab29f0caeb85f96bf52a1', // Founders
  '2340c0e03dd24a11b15a8b33c2a7e9e32abb2051b2481d0ba7defd635ca7a933', // Migrator
  '6836989ef37c72e84552410f178740a3d630ed4ecdce14029e6e9e155980d06c', // Purple Heart
  'f9a76537647989f9a0b6d001e320dac591c359e9e61a31f4ce11c88f207f0ad4' // Vanilla
]);
/** Players can't upload capes: only the classic presets and Noctra Store capes are worn/served. */
const capeAllowed = (hash) => !hash || PRESET_CAPE_HASHES.has(hash) || isStoreStill(hash);
const isStoreStill = (hash) => Boolean(hash) && current().items.some((item) => item.still === hash);
const findByStrip = (hash) => current().items.find((item) => item.animated && item.strip === hash) || null;

/**
 * The animation a profile may show: only a store cape that still exists, with the still frame
 * as its cape. Self-made animations (older launchers) are reduced to their first frame.
 */
function animationFor(profile) {
  if (!profile || !profile.capeAnim || !profile.capeStore || !HASH_RE.test(profile.capeAnim.strip || '')) return null;
  let item = null;
  try { item = findItem(profile.capeStore); } catch { return null; }
  if (!item || !item.animated || item.strip !== profile.capeAnim.strip || item.still !== profile.cape) return null;
  return { strip: item.strip, frames: item.frames, fps: item.fps };
}

/**
 * Decides whether a wardrobe upload may carry this animation strip.
 * @returns the store item id, or null when the animation must be dropped.
 */
function authorizeAnimation({ stripHash, user, existing }) {
  const item = findByStrip(stripHash);
  if (!item) return null;
  if (user && owns(user.id, item.id)) return item.id;
  if (existing && existing.capeStore === item.id) {
    if (user) grant(user.id, item.id, 'legacy');
    return item.id;
  }
  return null;
}

/* ── http ──────────────────────────────────────────────────────────── */

const bearerOf = (req) => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  || String(req.headers['x-noctra-token'] || '').trim();

function publicItem(item, textureBase, counts) {
  return {
    id: item.id,
    section: item.section,
    name: item.name,
    description: item.description,
    tags: item.tags,
    author: item.author,
    featured: Boolean(item.featured),
    hidden: Boolean(item.hidden),
    isNew: Date.now() - (Number(item.createdAt) || 0) < NEW_FOR_MS,
    price: 0,
    animated: Boolean(item.animated),
    frames: item.animated ? item.frames : 1,
    fps: item.animated ? item.fps : 0,
    width: item.width,
    frameHeight: item.frameHeight,
    stripUrl: item.animated ? `${textureBase}${item.strip}` : null,
    stillUrl: `${textureBase}${item.still}`,
    owners: counts ? (counts.get(item.id) || 0) : undefined,
    createdAt: Number(item.createdAt) || 0
  };
}

const sorted = (items) => [...items].sort((a, b) =>
  Number(Boolean(b.featured)) - Number(Boolean(a.featured))
  || (Number(a.order) || 0) - (Number(b.order) || 0)
  || (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));

function slug(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}
const cleanText = (value, max) => String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const cleanTags = (value) => (Array.isArray(value) ? value : String(value || '').split(','))
  .map((tag) => slug(tag).slice(0, 24)).filter(Boolean).filter((tag, i, all) => all.indexOf(tag) === i).slice(0, 8);

/** Validates uploaded textures. Returns texture fields for an item. */
function texturesFrom(body) {
  if (body.animated) {
    const strip = capes.pngFromBase64(body.strip);
    const still = capes.pngFromBase64(body.still, 5 * 1024 * 1024);
    if (!strip || !still) throw new Error('An animated cape needs its frame strip and its first frame.');
    const info = capes.validateAnimation({ strip, still, frames: body.frames, fps: body.fps });
    return { animated: true, frames: info.frames, fps: info.fps, width: info.width, frameHeight: info.frameHeight, strip: storeTexture(strip), still: storeTexture(still) };
  }
  const still = capes.pngFromBase64(body.still || body.strip, 5 * 1024 * 1024);
  if (!still) throw new Error('Choose a cape PNG.');
  const { width, height } = capes.pngSize(still);
  if (width < 16 || height < 8 || width > 4096 || height > 4096) throw new Error('That cape size is not supported.');
  return { animated: false, frames: 1, fps: 0, width, frameHeight: height, strip: null, still: storeTexture(still) };
}

/**
 * @param ctx { ip, send, hit, tooMany, readJson, readProfile, saveProfile, originOf, storeTexture, profileDocument }
 * @returns {Promise<boolean>} true when handled
 */
async function handleStoreRoutes(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost');
  const isStore = url.pathname.startsWith('/v1/store/');
  const isAdmin = url.pathname === '/v1/admin/store/items' || url.pathname.startsWith('/v1/admin/store/');
  if (!isStore && !isAdmin) return false;
  const { send, hit, tooMany, ip } = ctx;
  const cat = ensureCatalog(ctx.storeTexture);
  const origin = ctx.originOf(req);
  const textureBase = `${origin}/csl/textures/`;
  const noStore = { 'Cache-Control': 'no-store' };
  const signedIn = () => {
    const token = bearerOf(req);
    return token ? db.getUserBySession(token) : null;
  };

  if (isAdmin) return handleAdmin(req, res, ctx, url, cat, textureBase);

  if (req.method === 'GET' && url.pathname === '/v1/store/catalog') {
    if (!hit('store-catalog', ip, 120, 60_000)) { tooMany(res, 60); return true; }
    const counts = ownerCounts();
    send(res, 200, {
      ok: true,
      rev: cat.rev,
      textureBase,
      sections: cat.sections,
      items: sorted(cat.items.filter((item) => !item.hidden)).map((item) => publicItem(item, textureBase, counts))
    }, { 'Cache-Control': 'public, max-age=30', 'Access-Control-Allow-Origin': '*' });
    return true;
  }

  const itemMatch = url.pathname.match(/^\/v1\/store\/items\/([^/]+)$/);
  if (req.method === 'GET' && itemMatch) {
    if (!hit('store-catalog', ip, 120, 60_000)) { tooMany(res, 60); return true; }
    const item = findItem(decodeURIComponent(itemMatch[1]));
    if (!item) { send(res, 404, { ok: false, error: 'That cape does not exist.' }); return true; }
    send(res, 200, { ok: true, textureBase, item: publicItem(item, textureBase, ownerCounts()) }, { 'Cache-Control': 'public, max-age=30', 'Access-Control-Allow-Origin': '*' });
    return true;
  }

  // Live refresh for the website: pushes `wardrobe:changed` whenever this account's locker changes.
  if (req.method === 'GET' && url.pathname === '/v1/store/stream') {
    const token = bearerOf(req) || String(url.searchParams.get('token') || '').trim();
    const user = token ? db.getUserBySession(token) : null;
    if (!user) { send(res, 401, { ok: false, error: 'Sign in first.' }); return true; }
    if (!hit('store-stream', ip, 30, 60_000)) { tooMany(res, 60); return true; }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    if (res.flushHeaders) res.flushHeaders();
    if (req.socket && req.socket.setNoDelay) req.socket.setNoDelay(true);
    if (req.socket && req.socket.setTimeout) req.socket.setTimeout(0);
    const unsubscribe = events.subscribeWatch(user.id, res);
    req.on('close', unsubscribe);
    req.on('error', unsubscribe);
    return true;
  }

  const user = signedIn();

  if (req.method === 'GET' && url.pathname === '/v1/store/me') {
    if (!user) { send(res, 401, { ok: false, error: 'Sign in to see your capes.' }); return true; }
    const profile = ctx.readProfile(user.username);
    const worn = profile?.capeStore ? findItem(profile.capeStore) : null;
    const equipped = worn && (worn.animated ? animationFor(profile) : profile.cape === worn.still) ? worn.id : null;
    if (equipped && !owns(user.id, equipped)) grant(user.id, equipped, 'legacy');
    send(res, 200, { ok: true, equipped, owned: ownedBy(user.id).filter((entry) => findItem(entry.id)) }, noStore);
    return true;
  }

  if (req.method === 'POST' && (url.pathname === '/v1/store/claim' || url.pathname === '/v1/store/unclaim')) {
    if (!user) { send(res, 401, { ok: false, error: 'Sign in to add capes to your locker.' }); return true; }
    if (!hit('store-claim', user.id, 60, 10 * 60_000)) { tooMany(res, 600); return true; }
    const body = await ctx.readJson(req);
    const item = findItem(String(body.itemId || ''));
    if (!item) { send(res, 404, { ok: false, error: 'That cape does not exist.' }); return true; }
    let profile = null;
    if (url.pathname === '/v1/store/claim') {
      if (item.hidden && !owns(user.id, item.id)) { send(res, 410, { ok: false, error: 'That cape is no longer available.' }); return true; }
      grant(user.id, item.id, 'free');
    } else {
      revoke(user.id, item.id);
      const existing = ctx.readProfile(user.username);
      if (existing && existing.capeStore === item.id) {
        profile = ctx.saveProfile({ ...existing, cape: null, capeAnim: null, capeStore: null, updatedAt: new Date().toISOString() }, req, user);
      }
    }
    const current = ctx.readProfile(user.username);
    events.publish(user.id, 'wardrobe:changed', { userId: user.id, name: user.username, capeStore: current?.capeStore || null, owned: true });
    send(res, 200, { ok: true, owned: ownedBy(user.id).filter((entry) => findItem(entry.id)), equipped: current?.capeStore || null, ...(profile ? { profile: ctx.profileDocument(profile, req) } : {}) }, noStore);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/v1/store/equip') {
    if (!user) { send(res, 401, { ok: false, error: 'Sign in to equip store items.' }); return true; }
    if (!hit('store-equip', user.id, 40, 10 * 60_000)) { tooMany(res, 600); return true; }
    const body = await ctx.readJson(req);
    const existing = ctx.readProfile(user.username) || {
      username: user.username,
      model: user.model === 'slim' ? 'slim' : 'default',
      skin: null,
      cape: null,
      authHash: null
    };
    let next;
    if (body.itemId == null || body.itemId === '') {
      next = { ...existing, cape: null, capeAnim: null, capeStore: null };
    } else {
      const item = findItem(String(body.itemId));
      if (!item) { send(res, 404, { ok: false, error: 'That store item does not exist.' }); return true; }
      if (!owns(user.id, item.id)) {
        if (item.hidden) { send(res, 403, { ok: false, error: 'Add this cape to your locker first.' }); return true; }
        grant(user.id, item.id, 'free'); // everything is free today
      }
      next = {
        ...existing,
        cape: item.still,
        capeAnim: item.animated ? { strip: item.strip, frames: item.frames, fps: item.fps } : null,
        capeStore: item.id
      };
    }
    next.updatedAt = new Date().toISOString();
    const saved = ctx.saveProfile(next, req, user);
    send(res, 200, { ok: true, equipped: saved.capeStore || null, owned: ownedBy(user.id).filter((entry) => findItem(entry.id)), profile: ctx.profileDocument(saved, req) }, noStore);
    return true;
  }

  send(res, 404, { ok: false, error: 'Not found.' });
  return true;
}

async function handleAdmin(req, res, ctx, url, cat, textureBase) {
  const { send } = ctx;
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const user = token ? db.getUserBySession(token) : null;
  if (!user) { send(res, 401, { ok: false, error: 'Noctra account session required.' }); return true; }
  if (!user.is_admin) { send(res, 403, { ok: false, error: 'Administrator access required.' }); return true; }
  const noStore = { 'Cache-Control': 'no-store' };
  const list = () => sorted(cat.items).map((item) => ({ ...publicItem(item, textureBase, ownerCounts()), order: Number(item.order) || 0 }));

  if (req.method === 'GET' && url.pathname === '/v1/admin/store/items') {
    send(res, 200, { ok: true, items: list(), sections: cat.sections }, noStore);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/v1/admin/store/items') {
    const body = await ctx.readJson(req);
    const name = cleanText(body.name, 40);
    if (name.length < 2) { send(res, 400, { ok: false, error: 'Give the cape a name (2-40 characters).' }); return true; }
    const id = slug(body.id || name);
    if (!ID_RE.test(id)) { send(res, 400, { ok: false, error: 'The id may only use a-z, 0-9 and dashes.' }); return true; }
    if (findItem(id)) { send(res, 409, { ok: false, error: `A cape with the id "${id}" already exists.` }); return true; }
    let textures;
    try { textures = texturesFrom(body); } catch (error) { send(res, 400, { ok: false, error: error.message }); return true; }
    const now = Date.now();
    const item = {
      id,
      section: 'capes',
      name,
      description: cleanText(body.description, 200),
      tags: cleanTags(body.tags),
      author: cleanText(body.author, 40) || 'Noctra',
      featured: Boolean(body.featured),
      hidden: Boolean(body.hidden),
      price: 0,
      order: Number.isFinite(Number(body.order)) ? Number(body.order) : -1,
      ...textures,
      createdAt: now,
      updatedAt: now
    };
    cat.items.push(item);
    cat.deleted = cat.deleted.filter((entry) => entry !== id);
    persist();
    send(res, 200, { ok: true, item: publicItem(item, textureBase), items: list() }, noStore);
    return true;
  }

  const match = url.pathname.match(/^\/v1\/admin\/store\/items\/([^/]+)$/);
  if (match) {
    const item = findItem(decodeURIComponent(match[1]));
    if (!item) { send(res, 404, { ok: false, error: 'That cape does not exist.' }); return true; }
    if (req.method === 'PATCH') {
      const body = await ctx.readJson(req);
      const next = { ...item };
      if (body.name !== undefined) {
        next.name = cleanText(body.name, 40);
        if (next.name.length < 2) { send(res, 400, { ok: false, error: 'Give the cape a name (2-40 characters).' }); return true; }
      }
      if (body.description !== undefined) next.description = cleanText(body.description, 200);
      if (body.tags !== undefined) next.tags = cleanTags(body.tags);
      if (body.author !== undefined) next.author = cleanText(body.author, 40) || 'Noctra';
      if (body.featured !== undefined) next.featured = Boolean(body.featured);
      if (body.hidden !== undefined) next.hidden = Boolean(body.hidden);
      if (body.order !== undefined && Number.isFinite(Number(body.order))) next.order = Number(body.order);
      if (body.strip || body.still) {
        try { Object.assign(next, texturesFrom({ ...body, animated: body.animated !== undefined ? body.animated : item.animated })); } catch (error) { send(res, 400, { ok: false, error: error.message }); return true; }
      } else if (item.animated && body.fps !== undefined) {
        const fps = Number(body.fps);
        if (!Number.isFinite(fps) || fps < capes.LIMITS.minFps || fps > capes.LIMITS.maxFps) { send(res, 400, { ok: false, error: 'Speed must be 1-30 fps.' }); return true; }
        next.fps = Math.round(fps * 100) / 100;
      }
      next.updatedAt = Date.now();
      cat.items[cat.items.indexOf(item)] = next;
      persist();
      send(res, 200, { ok: true, item: publicItem(next, textureBase), items: list() }, noStore);
      return true;
    }
    if (req.method === 'DELETE') {
      cat.items = cat.items.filter((entry) => entry !== item);
      if (!cat.deleted.includes(item.id)) cat.deleted.push(item.id);
      try { sql().prepare('DELETE FROM store_owned WHERE item_id = ?').run(item.id); } catch {}
      persist();
      send(res, 200, { ok: true, items: list() }, noStore);
      return true;
    }
  }

  send(res, 404, { ok: false, error: 'Admin store endpoint not found.' });
  return true;
}

/** Test hook: forget the in-memory catalogue (it is re-read from disk). */
function resetCatalog() { catalog = null; }

module.exports = { handleStoreRoutes, ensureCatalog, animationFor, authorizeAnimation, findItem, isStoreStill, capeAllowed, owns, grant, resetCatalog };
