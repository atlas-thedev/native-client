'use strict';
/**
 * Native Store bundles: a full look (a cloak plus 3D cosmetics) sold together at a discount, shown in the
 * launcher like an in-game shop bundle: big art, a rarity, a countdown and the whole set worn on your skin.
 *
 * Bundles live next to the items in the store catalogue (`catalog.bundles`):
 *   { id, name, tagline, description, itemIds: [...], discount: 0-90 (percent off the items' prices),
 *     price: 0 | USD (a fixed bundle price, overrides the discount), rarity: rare|epic|legendary|mythic,
 *     accent: '#rrggbb' | null (overrides the rarity colour), art: texture hash | null (a wide banner),
 *     startsAt / endsAt: ms | null (a limited-time bundle), featured, hidden, order, createdAt, updatedAt }
 *
 * A bundle is listed while it is visible and live (started, not ended). Ended bundles stay in the catalogue
 * marked `ended` so players who own the pieces still see the set in their locker, but they can't be bought.
 *
 * Price rules (all in cents, so every client shows the same numbers):
 *  - full   = what the paid pieces cost one by one right now (live offers included)
 *  - price  = the fixed price, or full minus the discount (never above full, at least $0.50 when anything is paid)
 *  - for a signed-in player, pieces they already own for good (bought, redeemed, founder, admin, event) are
 *    left out and the price shrinks in proportion ("complete the set"). Pieces held through Native+ are
 *    still sold, so they stay after the membership ends.
 * Free pieces in a bundle are simply added to the locker with it. Event (exclusive) items can't be bundled.
 */

const ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
const MIN_ITEMS = 2;
const MAX_ITEMS = 12;
const MAX_BUNDLES = 60;
const MIN_CENTS = 50;
/** Sources that mean "yours for good": these pieces are never charged again. */
const KEPT = (source) => Boolean(source) && source !== 'plus';

const cleanText = (value, max) => String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const slug = (value) => String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
const isPaid = (item) => Boolean(item) && !item.exclusive && Number(item.price) > 0;
const cents = (usd) => Math.max(0, Math.round((Number(usd) || 0) * 100));
const RARITIES = ['rare', 'epic', 'legendary', 'mythic'];
const HEX_RE = /^#[0-9a-f]{6}$/;
const MAX_ART_BYTES = 4 * 1024 * 1024;
/** 'png' | 'jpeg' | 'webp' | null, from the file's first bytes. */
function imageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}
/** The banner image from a data URL or plain base64 (PNG, JPEG or WebP, up to 4 MB). Throws a readable error. */
function artFrom(value) {
  const text = String(value || '').replace(/^data:[^;,]+;base64,/i, '').trim();
  const buffer = Buffer.from(text, 'base64');
  if (!buffer.length) throw new Error('The bundle art is empty.');
  if (buffer.length > MAX_ART_BYTES) throw new Error('The bundle art must be under 4 MB.');
  if (!imageType(buffer)) throw new Error('The bundle art must be a PNG, JPEG or WebP image.');
  return buffer;
}
/** ms since 1970 from a number, an ISO string or empty (null). Throws on garbage. */
function timeOf(value, label) {
  if (value === null || value === undefined || value === '' || value === 0) return null;
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(ms) || ms < Date.UTC(2020, 0, 1) || ms > Date.UTC(2100, 0, 1)) throw new Error(`${label} isn’t a valid date.`);
  return Math.round(ms);
}
/** 'upcoming' | 'live' | 'ended' right now. */
function phaseOf(bundle, now = Date.now()) {
  if (Number(bundle.startsAt) > now) return 'upcoming';
  if (Number(bundle.endsAt) > 0 && Number(bundle.endsAt) <= now) return 'ended';
  return 'live';
}

/**
 * Validates an admin bundle edit. Throws a readable error.
 * @param body     request body (partial when `previous` is given)
 * @param previous the bundle being edited, or null for a new one
 * @param env      { findItem, bundles }  (bundles: the current list, for id clashes)
 */
function cleanBundle(body, previous, { findItem, bundles = [], storeArt = null }) {
  const out = previous ? { ...previous } : { featured: false, hidden: false, discount: 20, price: 0, description: '', tagline: '', rarity: 'epic', accent: null, art: null, startsAt: null, endsAt: null };
  if (!previous || body.name !== undefined) {
    const name = cleanText(body.name, 60);
    if (!name) throw new Error('Give the bundle a name.');
    out.name = name;
  }
  if (!previous) {
    const id = slug(body.id || body.name);
    if (!ID_RE.test(id)) throw new Error('Use a name with letters or numbers.');
    if (bundles.some((bundle) => bundle.id === id)) throw new Error('A bundle with that name already exists.');
    if (bundles.length >= MAX_BUNDLES) throw new Error(`Up to ${MAX_BUNDLES} bundles.`);
    out.id = id;
  }
  if (body.description !== undefined) out.description = cleanText(body.description, 400);
  if (body.tagline !== undefined) out.tagline = cleanText(body.tagline, 80);
  if (body.rarity !== undefined) {
    const rarity = String(body.rarity || '').toLowerCase();
    if (!RARITIES.includes(rarity)) throw new Error(`The rarity must be one of ${RARITIES.join(', ')}.`);
    out.rarity = rarity;
  }
  if (body.accent !== undefined) {
    const accent = body.accent ? String(body.accent).trim().toLowerCase() : null;
    if (accent && !HEX_RE.test(accent)) throw new Error('The accent colour must look like #ff8800.');
    out.accent = accent || null;
  }
  if (body.art !== undefined) {
    if (!body.art) out.art = null;
    else {
      if (!storeArt) throw new Error('Art uploads aren’t available.');
      out.art = storeArt(artFrom(body.art));
    }
  }
  if (body.startsAt !== undefined) out.startsAt = timeOf(body.startsAt, 'The start');
  if (body.endsAt !== undefined) out.endsAt = timeOf(body.endsAt, 'The end');
  if (out.startsAt && out.endsAt && out.endsAt <= out.startsAt) throw new Error('The bundle must end after it starts.');
  if (!previous || body.itemIds !== undefined) {
    const raw = Array.isArray(body.itemIds) ? body.itemIds : String(body.itemIds || '').split(',');
    const ids = [...new Set(raw.map((id) => String(id || '').trim()).filter(Boolean))];
    if (ids.length < MIN_ITEMS) throw new Error(`A bundle needs at least ${MIN_ITEMS} items.`);
    if (ids.length > MAX_ITEMS) throw new Error(`A bundle can hold up to ${MAX_ITEMS} items.`);
    for (const id of ids) {
      const item = findItem(id);
      if (!item) throw new Error(`Unknown item "${id}".`);
      if (item.exclusive) throw new Error(`${item.name} is an event item and can't be sold in a bundle.`);
    }
    out.itemIds = ids;
  }
  if (body.discount !== undefined) {
    const discount = Math.round(Number(body.discount));
    if (!Number.isFinite(discount) || discount < 0 || discount > 90) throw new Error('The discount must be 0-90%.');
    out.discount = discount;
  }
  if (body.price !== undefined) {
    const price = body.price === null || body.price === '' ? 0 : Number(body.price);
    if (!Number.isFinite(price) || price < 0 || (price > 0 && price < 0.5) || price > 999.99) throw new Error('A fixed price must be $0.50-$999.99 (or empty to use the discount).');
    out.price = Math.round(price * 100) / 100;
  }
  if (body.featured !== undefined) out.featured = Boolean(body.featured);
  if (body.hidden !== undefined) out.hidden = Boolean(body.hidden);
  if (body.order !== undefined && Number.isFinite(Number(body.order))) out.order = Math.trunc(Number(body.order));
  const now = Date.now();
  if (!previous) out.createdAt = now;
  out.updatedAt = now;
  return out;
}

/** Splits `total` cents over `weights` in proportion; every share is at least 1 cent and the shares add up to `total`. */
function split(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!weights.length) return [];
  if (!sum) return weights.map((_, i) => (i === weights.length - 1 ? total - Math.floor(total / weights.length) * (weights.length - 1) : Math.floor(total / weights.length)));
  const shares = weights.map((w) => Math.max(1, Math.floor((total * w) / sum)));
  let diff = total - shares.reduce((a, b) => a + b, 0);
  for (let i = shares.length - 1; diff !== 0 && i >= 0; i -= 1) {
    const step = diff > 0 ? diff : Math.max(diff, 1 - shares[i]);
    shares[i] += step;
    diff -= step;
  }
  return shares;
}

/**
 * Prices a bundle, for everyone or for one player.
 * @param env { findItem, priceOf(item) -> USD now, ownedSource(itemId) -> source|null (optional) }
 * @returns { items, paid, free, fullCents, priceCents, discountPercent, owned, missing, dueFullCents, dueCents, lines }
 *          lines: [{ item, cents }] for the paid pieces still to buy.
 */
function quote(bundle, { findItem, priceOf, ownedSource = null }) {
  const items = (bundle.itemIds || []).map((id) => findItem(id)).filter((item) => item && !item.hidden && !item.exclusive);
  const paid = items.filter(isPaid);
  const free = items.filter((item) => !isPaid(item));
  const now = new Map(paid.map((item) => [item.id, cents(priceOf(item))]));
  const fullCents = paid.reduce((sum, item) => sum + now.get(item.id), 0);
  let priceCents = 0;
  if (fullCents > 0) {
    priceCents = Number(bundle.price) > 0 ? Math.min(cents(bundle.price), fullCents) : Math.round((fullCents * (100 - (Number(bundle.discount) || 0))) / 100);
    priceCents = Math.min(fullCents, Math.max(MIN_CENTS, priceCents));
  }
  const kept = (item) => Boolean(ownedSource) && KEPT(ownedSource(item.id));
  const owned = items.filter((item) => (ownedSource ? Boolean(ownedSource(item.id)) : false));
  const toBuy = paid.filter((item) => !kept(item));
  const dueFullCents = toBuy.reduce((sum, item) => sum + now.get(item.id), 0);
  let dueCents = 0;
  if (dueFullCents > 0) {
    dueCents = dueFullCents === fullCents ? priceCents : Math.round((priceCents * dueFullCents) / fullCents);
    dueCents = Math.min(dueFullCents, Math.max(Math.min(MIN_CENTS, dueFullCents), dueCents));
  }
  const shares = split(dueCents, toBuy.map((item) => now.get(item.id)));
  return {
    items,
    paid,
    free,
    fullCents,
    priceCents,
    discountPercent: fullCents ? Math.max(0, Math.round(100 - (priceCents * 100) / fullCents)) : 0,
    owned: owned.length,
    missing: items.filter((item) => !(ownedSource && ownedSource(item.id))),
    dueFullCents,
    dueCents,
    lines: toBuy.map((item, i) => ({ item, cents: shares[i] }))
  };
}

/** What the store shows of a bundle. `mine` adds the signed-in player's view. */
function publicBundle(bundle, q, { isNew = false, mine = null, artUrl = null, now = Date.now() } = {}) {
  return {
    id: bundle.id,
    kind: 'bundle',
    name: bundle.name,
    tagline: bundle.tagline || '',
    description: bundle.description || '',
    rarity: RARITIES.includes(bundle.rarity) ? bundle.rarity : 'epic',
    accent: bundle.accent || null,
    artUrl: bundle.art ? artUrl : null,
    startsAt: Number(bundle.startsAt) || null,
    endsAt: Number(bundle.endsAt) || null,
    phase: phaseOf(bundle, now),
    itemIds: q.items.map((item) => item.id),
    featured: Boolean(bundle.featured),
    hidden: Boolean(bundle.hidden),
    isNew,
    paid: q.priceCents > 0,
    fullPrice: q.fullCents / 100,
    price: q.priceCents / 100,
    savePercent: q.discountPercent,
    discount: Number(bundle.discount) || 0,
    fixedPrice: Number(bundle.price) > 0 ? Number(bundle.price) : null,
    order: Number(bundle.order) || 0,
    createdAt: Number(bundle.createdAt) || 0,
    ...(mine ? { mine } : {})
  };
}

/** The signed-in player's view of a bundle quote. */
function mineOf(q) {
  return {
    owned: q.owned,
    total: q.items.length,
    complete: q.missing.length === 0,
    due: q.dueCents / 100,
    dueFull: q.dueFullCents / 100,
    toBuy: q.lines.map((line) => line.item.id)
  };
}

/** Bundles in the public catalogue: not hidden, started, with at least two items still on sale (ended ones too, marked). */
const listable = (bundle, q, now = Date.now()) => !bundle.hidden && q.items.length >= MIN_ITEMS && phaseOf(bundle, now) !== 'upcoming';
/** Bundles that can be bought or claimed right now. */
const onSale = (bundle, q, now = Date.now()) => listable(bundle, q, now) && phaseOf(bundle, now) === 'live';

const sorted = (bundles, now = Date.now()) => [...bundles].sort((a, b) =>
  Number(phaseOf(a, now) === 'ended') - Number(phaseOf(b, now) === 'ended')
  || Number(Boolean(b.featured)) - Number(Boolean(a.featured))
  || (Number(a.order) || 0) - (Number(b.order) || 0)
  || (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));

module.exports = { MIN_ITEMS, MAX_ITEMS, MAX_BUNDLES, RARITIES, KEPT, cleanBundle, quote, publicBundle, mineOf, listable, onSale, phaseOf, imageType, artFrom, sorted, split };
