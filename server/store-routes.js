'use strict';
/**
 * The Native cape store.
 *
 * Public
 *   GET  /v1/store/catalog         visible items (newest/featured first) with texture URLs + owner counts
 *   GET  /v1/store/items/:id       one item (hidden items too, so retired capes still have a page)
 *   GET  /v1/store/users?q=        find players by name (no q = top collectors)
 *   GET  /v1/store/users/:name     a player's public profile: worn items, locker, wishlist
 * Signed in (Bearer or X-Native-Token)
 *   GET  /v1/store/me              { equipped, wearing: { slot: itemId }, owned: [{ id, acquiredAt }] }
 *   POST /v1/store/claim           { itemId }  add a store item to your locker (everything is free today)
 *   POST /v1/store/unclaim         { itemId }  remove it from your locker (takes it off if worn)
 *   POST /v1/store/equip           { itemId }  wear an item from your locker (null = take the cape off).
 *                                   Free items are added to the locker automatically. A cosmetic
 *                                   (hat, glasses, back item, shoes) goes into its slot;
 *                                   { slot, itemId: null } takes that slot off.
 *   GET  /v1/store/wishlist        { wishlist: [{ id, addedAt }], prefs }
 *   POST /v1/store/wishlist        { itemId, on? }  add/remove (toggles when `on` is omitted)
 *   POST /v1/store/prefs           { hideLocker?, hideWishlist? }  what other players see on your profile
 *   GET  /v1/store/stream          SSE: wardrobe:changed for the signed-in account
 * Admin (session with is_admin)
 *   GET    /v1/admin/store/items           every item, hidden ones included
 *   POST   /v1/admin/store/items           create (animated strip + still, or a static PNG)
 *   PATCH  /v1/admin/store/items/:id       edit metadata and/or replace textures
 *   DELETE /v1/admin/store/items/:id       remove from the store (owners keep nothing)
 *   GET    /v1/admin/store/items/:id/owners   who has this item
 *   POST   /v1/admin/store/items/:id/grant    { username }  give an item (the only way to get exclusive ones)
 *   POST   /v1/admin/store/items/:id/revoke   { username }  take it back (and off, if worn)
 *   GET    /v1/admin/store/users/:id       one account: profile facts, owned capes, worn cape
 *   POST   /v1/admin/store/users/:id/capes { itemId, action: grant|revoke|equip|unequip }
 *
 * Exclusive items (`exclusive: true`, e.g. Beta Tester) are listed in the store but can't be
 * claimed or equipped by just anyone: an admin grants them.
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
const billing = require('./billing');
const cosmetics = require('./cosmetics');
const site = () => require('./site-routes');

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
    // sections added in later deploys (hats, glasses, ...) appear after the saved ones
    for (const section of bundled.sections) {
      if (!catalog.sections.some((x) => x.id === section.id)) { catalog.sections = [...catalog.sections, section]; added = true; }
    }
    // the 3D cosmetics that used to ship with the server are gone: drop them (and their locker rows)
    const retired = catalog.items.filter((item) => item.bundled && cosmetics.isCosmetic(item));
    if (retired.length) {
      catalog.items = catalog.items.filter((item) => !retired.includes(item));
      for (const item of retired) {
        try { sql().prepare('DELETE FROM store_owned WHERE item_id = ?').run(item.id); } catch {}
      }
      console.log(`[Native Store] Removed ${retired.length} built-in cosmetics: ${retired.map((item) => item.id).join(', ')}`);
      added = true;
    }
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
    try { persist(); } catch (error) { console.warn('[Native Store] Could not save the catalogue:', error.message); }
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
    handle.exec(`CREATE TABLE IF NOT EXISTS store_wishlist (
      user_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, item_id)
    )`);
    handle.exec(`CREATE TABLE IF NOT EXISTS store_prefs (
      user_id TEXT PRIMARY KEY,
      hide_locker INTEGER NOT NULL DEFAULT 0,
      hide_wishlist INTEGER NOT NULL DEFAULT 0
    )`);
    tableReady = true;
  }
  return handle;
}

function ownedBy(userId) {
  return sql().prepare('SELECT item_id, acquired_at, source FROM store_owned WHERE user_id = ? ORDER BY acquired_at DESC').all(String(userId))
    .map((row) => ({ id: row.item_id, acquiredAt: Number(row.acquired_at), source: row.source }));
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


/* ── wishlist + public profile ─────────────────────────────────────── */

function wishlistOf(userId) {
  return sql().prepare('SELECT item_id, added_at FROM store_wishlist WHERE user_id = ? ORDER BY added_at DESC').all(String(userId))
    .map((row) => ({ id: row.item_id, addedAt: Number(row.added_at) })).filter((entry) => findItem(entry.id));
}
function setWish(userId, itemId, on) {
  if (on) sql().prepare('INSERT OR IGNORE INTO store_wishlist (user_id, item_id, added_at) VALUES (?, ?, ?)').run(String(userId), String(itemId), Date.now());
  else sql().prepare('DELETE FROM store_wishlist WHERE user_id = ? AND item_id = ?').run(String(userId), String(itemId));
}
function prefsOf(userId) {
  const row = sql().prepare('SELECT hide_locker, hide_wishlist FROM store_prefs WHERE user_id = ?').get(String(userId));
  return { hideLocker: Boolean(row?.hide_locker), hideWishlist: Boolean(row?.hide_wishlist) };
}
function setPrefs(userId, next) {
  const now = { ...prefsOf(userId), ...next };
  sql().prepare('INSERT INTO store_prefs (user_id, hide_locker, hide_wishlist) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET hide_locker = excluded.hide_locker, hide_wishlist = excluded.hide_wishlist')
    .run(String(userId), now.hideLocker ? 1 : 0, now.hideWishlist ? 1 : 0);
  return now;
}
function parseBadges(value) { try { const list = JSON.parse(value || '[]'); return Array.isArray(list) ? list.map(String).slice(0, 12) : []; } catch { return []; } }
function userCard(row) {
  return { name: row.username, uuid: row.uuid, model: row.model === 'slim' ? 'slim' : 'default', joinedAt: Number(row.created_at) || 0 };
}
const USER_NAME_RE = /^[A-Za-z0-9_.\- ]{1,32}$/;
/** Everyone's lockers are public by default; owners can hide the locker and/or wishlist. */
function publicProfile(row, profile) {
  const prefs = prefsOf(row.id);
  const owned = ownedBy(row.id).filter((entry) => findItem(entry.id));
  const wish = wishlistOf(row.id).filter((entry) => !owned.some((o) => o.id === entry.id));
  const worn = profile?.capeStore ? findItem(profile.capeStore) : null;
  return {
    ...userCard(row),
    badges: parseBadges(row.badges),
    admin: Boolean(row.is_admin),
    plus: (() => { try { return Boolean(billing.hasPlus(row.id)); } catch { return false; } })(),
    equipped: worn ? worn.id : null,
    wearing: wearingOf(profile), sides: (profile && profile.cosmeticSides) || {},
    counts: { owned: owned.length, wishlist: wish.length },
    hidden: { locker: prefs.hideLocker, wishlist: prefs.hideWishlist },
    owned: prefs.hideLocker ? [] : owned.map(({ id, acquiredAt }) => ({ id, acquiredAt })),
    wishlist: prefs.hideWishlist ? [] : wish
  };
}
function searchUsers(query) {
  const h = sql();
  const q = String(query || '').trim().slice(0, 32).replace(/[%_\\]/g, '');
  if (!q) {
    return h.prepare(`SELECT u.username, u.uuid, u.model, u.created_at, COUNT(o.item_id) AS n
      FROM users u JOIN store_owned o ON o.user_id = u.id
      LEFT JOIN store_prefs p ON p.user_id = u.id
      WHERE COALESCE(p.hide_locker, 0) = 0
      GROUP BY u.id ORDER BY n DESC, u.created_at ASC LIMIT 12`).all().map((row) => ({ ...userCard(row), owned: Number(row.n) }));
  }
  return h.prepare(`SELECT u.username, u.uuid, u.model, u.created_at,
      (SELECT COUNT(*) FROM store_owned o WHERE o.user_id = u.id) AS n
    FROM users u WHERE u.username LIKE ? ORDER BY (lower(u.username) = lower(?)) DESC, length(u.username) ASC LIMIT 12`)
    .all(`${q}%`, q).map((row) => ({ ...userCard(row), owned: Number(row.n) }));
}

/* ── animation policy (used by server.js and mod-routes.js) ───────── */

const current = () => catalog || (storeTexture ? ensureCatalog() : { items: [] });
const findItem = (id) => current().items.find((item) => item.id === id) || null;
const allItems = () => current().items.slice();

/** Native+ members get every paid cape in their locker automatically (source 'plus'). */
function grantPlusCapes(userId) {
  if (!userId || !billing.hasPlus(userId)) return 0;
  let added = 0;
  for (const item of current().items) {
    if (item.hidden || !billing.isPaid(item) || owns(userId, item.id)) continue;
    billing.grantItem(userId, item.id, 'plus');
    added += 1;
  }
  return added;
}
/**
 * Capes players may wear: the bundled classic capes (sha256 of the PNG, the same files ship with the
 * launcher and the website) and Native Store capes. Players cannot upload capes of their own.
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
/**
 * Players can't upload capes: only the classic presets and Native Store capes are worn/served.
 * Exclusive capes (e.g. Beta Tester) only count for a profile that wears them through the store
 * (`capeStore`), which only an owner can do; their PNG alone never unlocks them.
 */
const capeAllowed = (hash, profile = null) => !hash || PRESET_CAPE_HASHES.has(hash) || isStoreStill(hash, profile);
const isStoreStill = (hash, profile = null) => Boolean(hash) && current().items.some((item) =>
  !cosmetics.isCosmetic(item) && item.still === hash && (!item.exclusive || (profile && profile.capeStore === item.id)));
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
  || String(req.headers['x-native-token'] || req.headers['x-noctra-token'] || '').trim();

function saleOf(item) {
  try { const o = site().offerFor(item); return o ? site().priceOf(item) : null; } catch { return null; }
}
function offerOf(item) {
  try { const o = site().offerFor(item); return o ? site().publicOffer(o) : null; } catch { return null; }
}
const lockedFor = (user) => { try { return site().storeLocked() && !(user && user.is_admin); } catch { return false; } };
const LOCKED = 'The Native store opens at launch. Pre-launch accounts can pick one free founder cape.';

/** Bulk price change (admin). price 0 = free. Returns how many capes changed. */
function setPrices(price, itemIds = null) {
  const cat = current();
  const value = priceFrom(price);
  let changed = 0;
  cat.items = cat.items.map((item) => {
    if (item.exclusive) return item;
    if (itemIds && itemIds.length && !itemIds.includes(item.id)) return item;
    if (Number(item.price) === value) return item;
    changed += 1;
    return { ...item, price: value, updatedAt: Date.now() };
  });
  if (changed) persist();
  return changed;
}

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
    exclusive: Boolean(item.exclusive),
    isNew: Date.now() - (Number(item.createdAt) || 0) < NEW_FOR_MS,
    price: item.exclusive ? 0 : Math.max(0, Number(item.price) || 0),
    paid: billing.isPaid(item),
    salePrice: saleOf(item),
    offer: offerOf(item),
    animated: Boolean(item.animated),
    frames: item.animated ? item.frames : 1,
    fps: item.animated ? item.fps : 0,
    width: item.width,
    frameHeight: item.frameHeight,
    stripUrl: item.animated ? `${textureBase}${item.strip}` : null,
    stillUrl: `${textureBase}${item.still}`,
    ...(cosmetics.isCosmetic(item) ? {
      kind: 'cosmetic',
      slot: item.slot,
      motion: Boolean(item.motion),
      modelUrl: `${textureBase}${item.model}`,
      textureUrl: `${textureBase}${item.texture}`
    } : { kind: 'cape' }),
    owners: counts ? (counts.get(item.id) || 0) : undefined,
    createdAt: Number(item.createdAt) || 0
  };
}

/** The launcher's store hero rotates through at most this many featured capes. */
const MAX_FEATURED = 5;
/** Featured items are counted per section (capes, hats, glasses, ...). */
const featuredCount = (items, exceptId = null, section = 'capes') => items.filter((item) => item.featured && item.id !== exceptId && (item.section || 'capes') === section).length;
const tooManyFeatured = () => `Up to ${MAX_FEATURED} items per section can be featured. Unfeature one first.`;

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

/** 0 = free. Otherwise USD, 0.50-99.99, two decimals. */
function priceFrom(value) {
  const n = Math.round((Number(value) || 0) * 100) / 100;
  if (n <= 0) return 0;
  return Math.min(99.99, Math.max(0.5, n));
}

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

/** Validates an uploaded cosmetic (model JSON + texture PNG + thumbnail PNG). Returns item fields. */
function cosmeticFrom(body, previous = null) {
  const out = {};
  if (body.model !== undefined && body.model !== null && body.model !== '') {
    const text = typeof body.model === 'string' ? body.model : JSON.stringify(body.model);
    const info = cosmetics.validateModel(text);
    out.model = storeTexture(Buffer.from(text, 'utf8'));
    out.motion = info.animated;
  } else if (!previous) throw new Error('Choose the cosmetic model (.json).');
  if (body.texture) {
    const texture = capes.pngFromBase64(body.texture, cosmetics.MAX_TEXTURE_BYTES);
    if (!texture) throw new Error('Choose the cosmetic texture PNG.');
    capes.pngSize(texture);
    out.texture = storeTexture(texture);
  } else if (!previous) throw new Error('Choose the cosmetic texture PNG.');
  const thumbSource = body.thumb || body.still;
  if (thumbSource) {
    const thumb = capes.pngFromBase64(thumbSource, 5 * 1024 * 1024);
    if (!thumb) throw new Error('Choose a thumbnail PNG.');
    const { width, height } = capes.pngSize(thumb);
    Object.assign(out, { still: storeTexture(thumb), width, frameHeight: height });
  } else if (!previous) {
    // no thumbnail yet: the texture stands in until one is uploaded
    Object.assign(out, { still: out.texture, ...(() => { const t = capes.pngSize(capes.pngFromBase64(body.texture, cosmetics.MAX_TEXTURE_BYTES)); return { width: t.width, frameHeight: t.height }; })() });
  }
  return { ...out, animated: false, frames: 1, fps: 0, strip: null, bundled: false };
}

/** What a profile wears in the cosmetic slots: { hats: 'propeller-cap', ... }. */
const wearingOf = (profile) => cosmetics.wearing(profile, findItem);

/** Takes `item` off a profile (cape or cosmetic). Returns the next profile, or null when it wasn't worn. */
function takenOff(profile, item) {
  if (!profile || !item) return null;
  if (cosmetics.isCosmetic(item)) return cosmetics.withoutItem(profile, item.id);
  if (profile.capeStore === item.id) return { ...profile, cape: null, capeAnim: null, capeStore: null };
  return null;
}

/** Re-publishes the mod directory entries of everyone wearing `itemId` (its model/texture changed or it was deleted). */
function refreshWearers(ctx, itemId, userIds) {
  for (const userId of userIds) {
    try {
      const account = db.getUserById(userId);
      const profile = account ? ctx.readProfile(account.username) : null;
      if (profile && profile.cosmetics && Object.values(profile.cosmetics).includes(itemId)) require('./mod-routes').noteProfile(profile);
    } catch {}
  }
}
const ownerIds = (itemId) => { try { return sql().prepare('SELECT user_id FROM store_owned WHERE item_id = ?').all(itemId).map((row) => row.user_id); } catch { return []; } };

/** Puts `item` on a profile (cape or cosmetic). */
function putOn(profile, item) {
  if (cosmetics.isCosmetic(item)) return cosmetics.withItem(profile, item);
  return { ...profile, cape: item.still, capeAnim: item.animated ? { strip: item.strip, frames: item.frames, fps: item.fps } : null, capeStore: item.id };
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
    if (!item) { send(res, 404, { ok: false, error: 'That cloak does not exist.' }); return true; }
    send(res, 200, { ok: true, textureBase, item: publicItem(item, textureBase, ownerCounts()) }, { 'Cache-Control': 'public, max-age=30', 'Access-Control-Allow-Origin': '*' });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/v1/store/users') {
    if (!hit('store-users', ip, 60, 60_000)) { tooMany(res, 60); return true; }
    send(res, 200, { ok: true, users: searchUsers(url.searchParams.get('q')) }, { 'Cache-Control': 'public, max-age=20', 'Access-Control-Allow-Origin': '*' });
    return true;
  }

  const userMatch = url.pathname.match(/^\/v1\/store\/users\/([^/]+)$/);
  if (req.method === 'GET' && userMatch) {
    if (!hit('store-users', ip, 60, 60_000)) { tooMany(res, 60); return true; }
    const name = decodeURIComponent(userMatch[1]).trim();
    const row = USER_NAME_RE.test(name) ? db.getUserByUsername(name) : null;
    if (!row) { send(res, 404, { ok: false, error: 'No Native player with that name.' }); return true; }
    send(res, 200, { ok: true, textureBase, profile: publicProfile(row, ctx.readProfile(row.username)) }, { 'Cache-Control': 'public, max-age=15', 'Access-Control-Allow-Origin': '*' });
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
    if (!user) { send(res, 401, { ok: false, error: 'Sign in to see your cloaks.' }); return true; }
    const profile = ctx.readProfile(user.username);
    const worn = profile?.capeStore ? findItem(profile.capeStore) : null;
    const equipped = worn && (worn.animated ? animationFor(profile) : profile.cape === worn.still) ? worn.id : null;
    if (equipped && !owns(user.id, equipped)) grant(user.id, equipped, 'legacy');
    try { grantPlusCapes(user.id); } catch (error) { console.warn('[Native Store] Plus capes:', error.message); }
    send(res, 200, { ok: true, equipped, wearing: wearingOf(profile), sides: (profile && profile.cosmeticSides) || {}, owned: ownedBy(user.id).filter((entry) => findItem(entry.id)), wishlist: wishlistOf(user.id), prefs: prefsOf(user.id) }, noStore);
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/v1/store/wishlist') {
    if (!user) { send(res, 401, { ok: false, error: 'Sign in to see your wishlist.' }); return true; }
    send(res, 200, { ok: true, wishlist: wishlistOf(user.id), prefs: prefsOf(user.id) }, noStore);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/v1/store/wishlist') {
    if (!user) { send(res, 401, { ok: false, error: 'Sign in to save items to your wishlist.' }); return true; }
    if (!hit('store-wish', user.id, 120, 10 * 60_000)) { tooMany(res, 600); return true; }
    const body = await ctx.readJson(req);
    const item = findItem(String(body.itemId || ''));
    if (!item || item.hidden) { send(res, 404, { ok: false, error: 'That item does not exist.' }); return true; }
    const on = body.on === undefined ? !wishlistOf(user.id).some((entry) => entry.id === item.id) : Boolean(body.on);
    if (on && wishlistOf(user.id).length >= 200) { send(res, 409, { ok: false, error: 'Your wishlist is full (200 items).' }); return true; }
    setWish(user.id, item.id, on);
    events.publish(user.id, 'wardrobe:changed', { userId: user.id, name: user.username, wishlist: true });
    send(res, 200, { ok: true, wishlist: wishlistOf(user.id) }, noStore);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/v1/store/prefs') {
    if (!user) { send(res, 401, { ok: false, error: 'Sign in first.' }); return true; }
    if (!hit('store-prefs', user.id, 30, 10 * 60_000)) { tooMany(res, 600); return true; }
    const body = await ctx.readJson(req);
    const next = {};
    if (body.hideLocker !== undefined) next.hideLocker = Boolean(body.hideLocker);
    if (body.hideWishlist !== undefined) next.hideWishlist = Boolean(body.hideWishlist);
    send(res, 200, { ok: true, prefs: setPrefs(user.id, next) }, noStore);
    return true;
  }

  if (req.method === 'POST' && (url.pathname === '/v1/store/claim' || url.pathname === '/v1/store/unclaim')) {
    if (!user) { send(res, 401, { ok: false, error: 'Sign in to add cloaks to your locker.' }); return true; }
    if (!hit('store-claim', user.id, 60, 10 * 60_000)) { tooMany(res, 600); return true; }
    const body = await ctx.readJson(req);
    const item = findItem(String(body.itemId || ''));
    if (!item) { send(res, 404, { ok: false, error: 'That cloak does not exist.' }); return true; }
    let profile = null;
    if (url.pathname === '/v1/store/claim') {
      if (item.hidden && !owns(user.id, item.id)) { send(res, 410, { ok: false, error: 'That cloak is no longer available.' }); return true; }
      if (item.exclusive && !owns(user.id, item.id)) { send(res, 403, { ok: false, error: `${item.name} can't be claimed. The Native team gives it out.` }); return true; }
      if (!owns(user.id, item.id)) {
        if (lockedFor(user)) { send(res, 423, { ok: false, locked: true, error: LOCKED }); return true; }
        if (billing.isPaid(item)) {
          if (!billing.hasPlus(user.id)) { send(res, 402, { ok: false, needsPurchase: true, error: `${item.name} costs $${site().priceOf(item).toFixed(2)}. Buy it or join Native+.` }); return true; }
          grant(user.id, item.id, 'plus');
        } else {
          grant(user.id, item.id, 'free');
        }
      }
    } else {
      if (item.exclusive) { send(res, 403, { ok: false, error: `${item.name} stays in your locker. You can take it off any time.` }); return true; }
      if (['purchase', 'code', 'founder'].includes(billing.ownedSource(user.id, item.id))) { send(res, 403, { ok: false, error: `${item.name} is yours to keep. You can take it off any time.` }); return true; }
      revoke(user.id, item.id);
      const existing = ctx.readProfile(user.username);
      const off = takenOff(existing, item);
      if (off) profile = ctx.saveProfile({ ...off, updatedAt: new Date().toISOString() }, req, user);
    }
    const current = ctx.readProfile(user.username);
    events.publish(user.id, 'wardrobe:changed', { userId: user.id, name: user.username, capeStore: current?.capeStore || null, wearing: wearingOf(current), owned: true });
    send(res, 200, { ok: true, owned: ownedBy(user.id).filter((entry) => findItem(entry.id)), equipped: current?.capeStore || null, wearing: wearingOf(current), ...(profile ? { profile: ctx.profileDocument(profile, req) } : {}) }, noStore);
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
    if ((body.itemId == null || body.itemId === '') && body.side !== undefined && cosmetics.SIDED.includes(body.slot)) {
      // just switching hands for a worn hand item / balloon
      if (!cosmetics.isSide(body.side)) { send(res, 400, { ok: false, error: 'Pick left or right.' }); return true; }
      next = cosmetics.withSide(existing, body.slot, body.side);
    } else if ((body.itemId == null || body.itemId === '') && body.slot !== undefined && body.slot !== 'capes') {
      if (!cosmetics.isSlot(body.slot)) { send(res, 400, { ok: false, error: 'Unknown cosmetic slot.' }); return true; }
      next = cosmetics.withoutSlot(existing, body.slot);
    } else if (body.itemId == null || body.itemId === '') {
      next = { ...existing, cape: null, capeAnim: null, capeStore: null };
    } else {
      const item = findItem(String(body.itemId));
      if (!item) { send(res, 404, { ok: false, error: 'That store item does not exist.' }); return true; }
      if (!owns(user.id, item.id)) {
        if (item.exclusive) { send(res, 403, { ok: false, error: `${item.name} can't be claimed. The Native team gives it out.` }); return true; }
        if (item.hidden) { send(res, 403, { ok: false, error: 'Add this cloak to your locker first.' }); return true; }
        if (lockedFor(user)) { send(res, 423, { ok: false, locked: true, error: LOCKED }); return true; }
        if (billing.isPaid(item)) {
          if (!billing.hasPlus(user.id)) { send(res, 402, { ok: false, needsPurchase: true, error: `${item.name} costs $${site().priceOf(item).toFixed(2)}. Buy it or join Native+.` }); return true; }
          grant(user.id, item.id, 'plus');
        } else {
          grant(user.id, item.id, 'free');
        }
      }
      next = putOn(existing, item);
      if (cosmetics.isCosmetic(item) && body.side !== undefined) next = cosmetics.withSide(next, item.slot, body.side);
    }
    next.updatedAt = new Date().toISOString();
    const saved = ctx.saveProfile(next, req, user);
    send(res, 200, { ok: true, equipped: saved.capeStore || null, wearing: wearingOf(saved), sides: (saved && saved.cosmeticSides) || {}, owned: ownedBy(user.id).filter((entry) => findItem(entry.id)), profile: ctx.profileDocument(saved, req) }, noStore);
    return true;
  }

  send(res, 404, { ok: false, error: 'Not found.' });
  return true;
}

async function handleAdmin(req, res, ctx, url, cat, textureBase) {
  const { send } = ctx;
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const user = token ? db.getUserBySession(token) : null;
  if (!user) { send(res, 401, { ok: false, error: 'Native account session required.' }); return true; }
  if (!user.is_admin) { send(res, 403, { ok: false, error: 'Administrator access required.' }); return true; }
  const noStore = { 'Cache-Control': 'no-store' };
  const list = () => sorted(cat.items).map((item) => ({ ...publicItem(item, textureBase, ownerCounts()), order: Number(item.order) || 0 }));

  if (req.method === 'GET' && url.pathname === '/v1/admin/store/items') {
    send(res, 200, { ok: true, items: list(), sections: cat.sections, maxFeatured: MAX_FEATURED }, noStore);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/v1/admin/store/items') {
    const body = await ctx.readJson(req);
    const name = cleanText(body.name, 40);
    if (name.length < 2) { send(res, 400, { ok: false, error: 'Give the cloak a name (2-40 characters).' }); return true; }
    const id = slug(body.id || name);
    if (!ID_RE.test(id)) { send(res, 400, { ok: false, error: 'The id may only use a-z, 0-9 and dashes.' }); return true; }
    if (findItem(id)) { send(res, 409, { ok: false, error: `A cloak with the id "${id}" already exists.` }); return true; }
    const slot = body.kind === 'cosmetic' || cosmetics.isSlot(body.slot) || cosmetics.isSlot(body.section) ? String(body.slot || body.section || '') : null;
    if (slot !== null && !cosmetics.isSlot(slot)) { send(res, 400, { ok: false, error: `Pick a slot: ${cosmetics.SLOTS.join(', ')}.` }); return true; }
    if (body.featured && featuredCount(cat.items, null, slot || 'capes') >= MAX_FEATURED) { send(res, 409, { ok: false, error: tooManyFeatured() }); return true; }
    let textures;
    try { textures = slot ? cosmeticFrom(body) : texturesFrom(body); } catch (error) { send(res, 400, { ok: false, error: error.message }); return true; }
    const now = Date.now();
    const item = {
      id,
      section: slot || 'capes',
      ...(slot ? { kind: 'cosmetic', slot } : {}),
      name,
      description: cleanText(body.description, 200),
      tags: cleanTags(body.tags),
      author: cleanText(body.author, 40) || 'Native',
      featured: Boolean(body.featured),
      hidden: Boolean(body.hidden),
      exclusive: Boolean(body.exclusive),
      price: priceFrom(body.price),
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

  const userMatch = url.pathname.match(/^\/v1\/admin\/store\/users\/([^/]+)(\/capes)?$/);
  if (userMatch) {
    let target = null;
    try { target = db.getUserById(decodeURIComponent(userMatch[1])); } catch {}
    if (!target) { send(res, 404, { ok: false, error: 'User not found.' }); return true; }
    const detail = () => {
      let facts = null;
      try { facts = db.getAdminUserDetail ? db.getAdminUserDetail(target.id) : null; } catch {}
      const profile = ctx.readProfile(target.username);
      return {
        ...(facts || { id: target.id, username: target.username, email: target.email, isAdmin: Boolean(target.is_admin), createdAt: target.created_at }),
        owned: ownedBy(target.id).filter((entry) => findItem(entry.id)),
        equipped: profile?.capeStore || null,
        wearing: wearingOf(profile),
        hasCustomCape: Boolean(profile?.cape && !profile?.capeStore)
      };
    };
    if (req.method === 'GET' && !userMatch[2]) {
      send(res, 200, { ok: true, user: detail() }, noStore);
      return true;
    }
    if (req.method === 'POST' && userMatch[2]) {
      const body = await ctx.readJson(req);
      const action = String(body.action || 'grant');
      if (!['grant', 'revoke', 'equip', 'unequip'].includes(action)) { send(res, 400, { ok: false, error: 'Unknown cloak action.' }); return true; }
      const existing = ctx.readProfile(target.username) || {
        username: target.username,
        model: target.model === 'slim' ? 'slim' : 'default',
        skin: null,
        cape: null,
        authHash: null
      };
      const stamp = () => new Date().toISOString();
      if (action === 'unequip') {
        const item = body.itemId ? findItem(String(body.itemId)) : null;
        if (item) {
          const off = takenOff(existing, item);
          if (off) ctx.saveProfile({ ...off, updatedAt: stamp() }, req, target);
        } else if (cosmetics.isSlot(body.slot)) {
          ctx.saveProfile({ ...cosmetics.withoutSlot(existing, body.slot), updatedAt: stamp() }, req, target);
        } else if (existing.capeStore) ctx.saveProfile({ ...existing, cape: null, capeAnim: null, capeStore: null, updatedAt: stamp() }, req, target);
      } else {
        const item = findItem(String(body.itemId || ''));
        if (!item) { send(res, 404, { ok: false, error: 'That cloak does not exist.' }); return true; }
        if (action === 'grant') billing.grantItem(target.id, item.id, 'admin');
        if (action === 'revoke') {
          revoke(target.id, item.id);
          const off = takenOff(existing, item);
          if (off) ctx.saveProfile({ ...off, updatedAt: stamp() }, req, target);
        }
        if (action === 'equip') {
          if (!owns(target.id, item.id)) billing.grantItem(target.id, item.id, 'admin');
          ctx.saveProfile({ ...putOn(existing, item), updatedAt: stamp() }, req, target);
        }
      }
      const user = detail();
      events.publish(target.id, 'wardrobe:changed', { userId: target.id, name: target.username, capeStore: user.equipped, wearing: user.wearing, owned: true });
      send(res, 200, { ok: true, user, items: list() }, noStore);
      return true;
    }
  }

  const ownersMatch = url.pathname.match(/^\/v1\/admin\/store\/items\/([^/]+)\/(owners|grant|revoke)$/);
  if (ownersMatch) {
    const item = findItem(decodeURIComponent(ownersMatch[1]));
    if (!item) { send(res, 404, { ok: false, error: 'That cloak does not exist.' }); return true; }
    const owners = () => sql().prepare('SELECT user_id, acquired_at, source FROM store_owned WHERE item_id = ? ORDER BY acquired_at DESC LIMIT 500').all(item.id)
      .map((row) => {
        let account = null;
        try { account = db.getUserById ? db.getUserById(row.user_id) : null; } catch {}
        return { userId: row.user_id, username: account?.username || null, acquiredAt: Number(row.acquired_at), source: row.source };
      });
    if (req.method === 'GET' && ownersMatch[2] === 'owners') {
      send(res, 200, { ok: true, owners: owners() }, noStore);
      return true;
    }
    if (req.method === 'POST') {
      const body = await ctx.readJson(req);
      const name = cleanText(body.username, 32);
      let target = null;
      try { target = name ? db.getUserByUsername(name) : null; } catch {}
      if (!target) { send(res, 404, { ok: false, error: `No Native account called "${name || '?'}".` }); return true; }
      if (ownersMatch[2] === 'grant') {
        billing.grantItem(target.id, item.id, 'admin');
      } else {
        revoke(target.id, item.id);
        const off = takenOff(ctx.readProfile(target.username), item);
        if (off) ctx.saveProfile({ ...off, updatedAt: new Date().toISOString() }, req, target);
      }
      const profile = ctx.readProfile(target.username);
      events.publish(target.id, 'wardrobe:changed', { userId: target.id, name: target.username, capeStore: profile?.capeStore || null, wearing: wearingOf(profile), owned: true });
      send(res, 200, { ok: true, owners: owners(), items: list() }, noStore);
      return true;
    }
  }

  const match = url.pathname.match(/^\/v1\/admin\/store\/items\/([^/]+)$/);
  if (match) {
    const item = findItem(decodeURIComponent(match[1]));
    if (!item) { send(res, 404, { ok: false, error: 'That cloak does not exist.' }); return true; }
    if (req.method === 'PATCH') {
      const body = await ctx.readJson(req);
      const next = { ...item };
      if (body.name !== undefined) {
        next.name = cleanText(body.name, 40);
        if (next.name.length < 2) { send(res, 400, { ok: false, error: 'Give the cloak a name (2-40 characters).' }); return true; }
      }
      if (body.description !== undefined) next.description = cleanText(body.description, 200);
      if (body.tags !== undefined) next.tags = cleanTags(body.tags);
      if (body.author !== undefined) next.author = cleanText(body.author, 40) || 'Native';
      if (body.featured !== undefined) {
        next.featured = Boolean(body.featured);
        if (next.featured && !item.featured && featuredCount(cat.items, item.id, item.section || 'capes') >= MAX_FEATURED) { send(res, 409, { ok: false, error: tooManyFeatured() }); return true; }
      }
      if (body.hidden !== undefined) next.hidden = Boolean(body.hidden);
      if (body.exclusive !== undefined) next.exclusive = Boolean(body.exclusive);
      if (body.price !== undefined) next.price = priceFrom(body.price);
      if (body.order !== undefined && Number.isFinite(Number(body.order))) next.order = Number(body.order);
      if (cosmetics.isCosmetic(item)) {
        if (body.model || body.texture || body.thumb || body.still) {
          try { Object.assign(next, cosmeticFrom(body, item)); } catch (error) { send(res, 400, { ok: false, error: error.message }); return true; }
        }
      } else if (body.strip || body.still) {
        try { Object.assign(next, texturesFrom({ ...body, animated: body.animated !== undefined ? body.animated : item.animated })); } catch (error) { send(res, 400, { ok: false, error: error.message }); return true; }
      } else if (item.animated && body.fps !== undefined) {
        const fps = Number(body.fps);
        if (!Number.isFinite(fps) || fps < capes.LIMITS.minFps || fps > capes.LIMITS.maxFps) { send(res, 400, { ok: false, error: 'Speed must be 1-30 fps.' }); return true; }
        next.fps = Math.round(fps * 100) / 100;
      }
      next.updatedAt = Date.now();
      cat.items[cat.items.indexOf(item)] = next;
      persist();
      if (cosmetics.isCosmetic(item) && (next.model !== item.model || next.texture !== item.texture)) refreshWearers(ctx, item.id, ownerIds(item.id));
      send(res, 200, { ok: true, item: publicItem(next, textureBase), items: list() }, noStore);
      return true;
    }
    if (req.method === 'DELETE') {
      const wearers = cosmetics.isCosmetic(item) ? ownerIds(item.id) : [];
      cat.items = cat.items.filter((entry) => entry !== item);
      if (!cat.deleted.includes(item.id)) cat.deleted.push(item.id);
      try { sql().prepare('DELETE FROM store_owned WHERE item_id = ?').run(item.id); } catch {}
      persist();
      refreshWearers(ctx, item.id, wearers);
      send(res, 200, { ok: true, items: list() }, noStore);
      return true;
    }
  }

  send(res, 404, { ok: false, error: 'Admin store endpoint not found.' });
  return true;
}

/** Test hook: forget the in-memory catalogue (it is re-read from disk). */
function resetCatalog() { catalog = null; }

module.exports = { wearingOf, setPrices, MAX_FEATURED, handleStoreRoutes, ensureCatalog, animationFor, authorizeAnimation, findItem, allItems, grantPlusCapes, isStoreStill, capeAllowed, owns, grant, resetCatalog };
