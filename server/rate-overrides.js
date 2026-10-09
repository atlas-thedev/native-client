// Per-route rate limit overrides for the store routes.
// Equipping/unequipping cosmetics in the Locker and Store fires many requests, so 40 per 10 minutes
// locked people out (429) for 10 minutes. This raises the limit without touching store-routes.js.
const storeRoutes = require('./store-routes');

const LIMITS = { 'store-equip': 300 };

if (!storeRoutes.__nativeRateOverrides) {
  const original = storeRoutes.handleStoreRoutes;
  storeRoutes.handleStoreRoutes = function handleStoreRoutes(req, res, ctx) {
    if (!ctx || typeof ctx.hit !== 'function') return original(req, res, ctx);
    const baseHit = ctx.hit;
    const hit = (name, key, limit, windowMs) => baseHit(name, key, LIMITS[name] ? Math.max(limit, LIMITS[name]) : limit, windowMs);
    return original(req, res, { ...ctx, hit });
  };
  storeRoutes.__nativeRateOverrides = true;
}

module.exports = { LIMITS };
