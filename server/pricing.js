'use strict';
/**
 * Store prices and slots, worked out automatically so a new upload is ready to sell with no setup.
 *
 * Items are sold at an automatic price unless an admin marks them free (`item.free`: anyone can claim
 * them at no cost) or exclusive (event items: granted, never sold). Automatic prices start at
 * $1.99 and go up with how much there is to look at: animation, size and detail.
 *   cloaks     static 1.99 · animated 2.49 · long smooth animations 2.99
 *   cosmetics  1.99 base, + moving parts, + big pieces (back, hand), + lots of detail
 */
const MIN_PRICE = 1.99;
const MAX_AUTO = 4.99;
const BIG_SLOTS = new Set(['back', 'hand']);
const ATTACH_SLOT = { head: 'hats', body: 'back', back: 'back', torso: 'back', rightarm: 'hand', leftarm: 'hand', rightleg: 'shoes', rightfoot: 'shoes', leftleg: 'shoes', leftfoot: 'shoes' };

/** Snaps to the nearest x.49 / x.99 price point. */
const snap = (value) => {
  const steps = [1.99, 2.49, 2.99, 3.49, 3.99, 4.49, 4.99];
  return steps.reduce((best, p) => (Math.abs(p - value) < Math.abs(best - value) ? p : best), steps[0]);
};

function modelStats(modelText) {
  const out = { cubes: 0, parts: 0, animated: false, attach: new Map(), names: '' };
  let root;
  try { root = typeof modelText === 'string' ? JSON.parse(modelText) : modelText; } catch { return out; }
  const walk = (list, inherited) => {
    for (const part of Array.isArray(list) ? list : []) {
      if (!part || typeof part !== 'object') continue;
      out.parts += 1;
      const at = String(part.attach || inherited || 'head').toLowerCase().replace(/_/g, '');
      const n = Array.isArray(part.cubes) ? part.cubes.length : 0;
      out.cubes += n;
      out.attach.set(at, (out.attach.get(at) || 0) + Math.max(1, n));
      out.names += ` ${part.id || ''}`;
      if (Array.isArray(part.anim) && part.anim.length) out.animated = true;
      if (Array.isArray(part.children)) walk(part.children, at);
    }
  };
  walk(root && root.parts, null);
  return out;
}

/** Which slot a model belongs in, from where its parts attach (and a few name hints). */
function guessSlot(modelText, name = '') {
  const stats = modelStats(modelText);
  const text = `${name} ${stats.names}`.toLowerCase();
  if (/glass|shade|goggle|visor|monocle|spectacle/.test(text) && !/helmet/.test(text)) return 'glasses';
  if (/sword|blade|staff|wand|axe|bow|shield|hammer|scythe/.test(text) && !/back/.test(text)) {
    if ([...stats.attach.keys()].some((a) => a.includes('arm'))) return 'hand';
  }
  let best = 'head', most = -1;
  for (const [at, weight] of stats.attach) if (weight > most) { best = at; most = weight; }
  return ATTACH_SLOT[best] || 'hats';
}

/** The automatic price of an item (cloak or cosmetic). Free and exclusive items: 0. */
function suggestPrice(item, modelText = null) {
  if (!item || item.exclusive || item.free) return 0;
  if (!item.kind && !item.slot) {
    if (!item.animated) return MIN_PRICE;
    return (item.frames || 0) >= 32 ? 2.99 : 2.49;
  }
  const stats = modelText ? modelStats(modelText) : { cubes: 0, animated: Boolean(item.motion) };
  let price = MIN_PRICE;
  if (stats.animated || item.motion) price += 0.5;
  if (BIG_SLOTS.has(item.slot)) price += 1;
  if (stats.cubes >= 40) price += 0.5;
  if (stats.cubes >= 120) price += 0.5;
  return Math.min(MAX_AUTO, snap(price));
}

/**
 * The price to store. Free items (`item.free`) cost 0; exclusive items keep what was asked (normally 0).
 * Otherwise a missing/zero price becomes the automatic one, so older admin clients that send 0 for
 * "automatic" never make an item free by accident.
 */
function finalPrice(requested, item, modelText = null) {
  if (item && item.free && !item.exclusive) return 0;
  if (item && item.exclusive) return Math.max(0, Number(requested) || 0);
  const n = Math.round((Number(requested) || 0) * 100) / 100;
  if (n <= 0) return suggestPrice(item, modelText) || MIN_PRICE;
  return Math.min(99.99, Math.max(MIN_PRICE, n));
}

module.exports = { MIN_PRICE, suggestPrice, finalPrice, guessSlot, modelStats };
