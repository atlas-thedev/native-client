// Shared in-memory caches so Home and the locker never wait twice for the same thing.
// `${itemId}|${hex}` -> dyed texture (data URL)
export const dyeTextures = new Map();
// itemId -> cosmetic asset from store.cosmetic()
export const cosmeticAssets = new Map();
