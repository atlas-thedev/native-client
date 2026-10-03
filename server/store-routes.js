'use strict';
/**
 *   GET  /v1/store/catalog   public: sections + every item with texture URLs
 *   GET  /v1/store/me        the signed-in account's equipped store item
 *   GET  /v1/store/stream    SSE: wardrobe:changed for the signed-in account (website live refresh)
 *   POST /v1/store/equip     { itemId } equip a store cape (itemId null = take it off)
 *
 * Store items are free today; the item model already carries `price`.
 */
const db = require('./db');
const capes = require('./capes');
const events = require('./social-events');

let catalog = null;
let revision = 1;

function ensureCatalog(storeTexture) {
  if (!catalog) catalog = capes.loadCatalog(storeTexture);
  return catalog;
}

const bearerOf = (req) => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  || String(req.headers['x-noctra-token'] || '').trim();

function publicItem(item, textureBase) {
  return {
    id: item.id,
    section: item.section,
    name: item.name,
    description: item.description,
    tags: item.tags,
    author: item.author,
    featured: item.featured,
    price: item.price,
    animated: item.animated,
    frames: item.frames,
    fps: item.fps,
    width: item.width,
    frameHeight: item.frameHeight,
    stripUrl: `${textureBase}${item.strip}`,
    stillUrl: `${textureBase}${item.still}`
  };
}

/**
 * @param ctx { ip, send, hit, tooMany, readJson, readProfile, saveProfile, originOf, storeTexture }
 * @returns {Promise<boolean>} true when handled
 */
async function handleStoreRoutes(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/v1/store/')) return false;
  const { send, hit, tooMany, ip } = ctx;
  const cat = ensureCatalog(ctx.storeTexture);
  const origin = ctx.originOf(req);
  const textureBase = `${origin}/csl/textures/`;

  if (req.method === 'GET' && url.pathname === '/v1/store/catalog') {
    if (!hit('store-catalog', ip, 90, 60_000)) { tooMany(res, 60); return true; }
    send(res, 200, {
      ok: true,
      rev: revision,
      textureBase,
      sections: cat.sections,
      items: cat.items.map((item) => publicItem(item, textureBase))
    }, { 'Cache-Control': 'public, max-age=60', 'Access-Control-Allow-Origin': '*' });
    return true;
  }

  // Live refresh for the website: pushes `wardrobe:changed` whenever this account's locker changes
  // (launcher, website, another device). Does not affect presence.
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

  if (req.method === 'GET' && url.pathname === '/v1/store/me') {
    const user = bearerOf(req) ? db.getUserBySession(bearerOf(req)) : null;
    if (!user) { send(res, 401, { ok: false, error: 'Sign in to see your store items.' }); return true; }
    const profile = ctx.readProfile(user.username);
    send(res, 200, { ok: true, equipped: profile?.capeStore || null });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/v1/store/equip') {
    const token = bearerOf(req);
    const user = token ? db.getUserBySession(token) : null;
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
      const item = cat.items.find((candidate) => candidate.id === String(body.itemId));
      if (!item) { send(res, 404, { ok: false, error: 'That store item does not exist.' }); return true; }
      next = {
        ...existing,
        cape: item.still,
        capeAnim: { strip: item.strip, frames: item.frames, fps: item.fps },
        capeStore: item.id
      };
    }
    next.updatedAt = new Date().toISOString();
    const saved = ctx.saveProfile(next, req, user);
    send(res, 200, { ok: true, equipped: saved.capeStore || null, profile: ctx.profileDocument(saved, req) });
    return true;
  }

  send(res, 404, { ok: false, error: 'Not found.' });
  return true;
}

module.exports = { handleStoreRoutes, ensureCatalog };
