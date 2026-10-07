'use strict';
/**
 * Native Store bundles: a named set of store items (cloaks and 3D cosmetics) sold together at a discount.
 *
 * Bundles live next to the items in the store catalogue (`catalog.bundles`):
 *   { id, name, description, itemIds: [...], discount: 0-90 (percent off the items' prices),
 *     price: 0 | USD (a fixed bundle price, overrides the discount), featured, hidden, order, createdAt, updatedAt }
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

/**
 * Validates an admin bundle edit. Throws a readable error.
 * @param body     request body (partial when `previous` is given)
 * @param previous the bundle being edited, or null for a new one
 * @param env      { findItem, bundles }  (bundles: the current list, for id clashes)
 */
function cleanBundle(body, previous, { findItem, bundles = [] }) {
  const out = previous ? { ...previous } : { featured: false, hidden: false, discount: 20, price: 0, description: '' };
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
function publicBundle(bundle, q, { isNew = false, mine = null } = {}) {
  return {
    id: bundle.id,
    kind: 'bundle',
    name: bundle.name,
    description: bundle.description || '',
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

/** Bundles a store visitor can see: not hidden, with at least two items still on sale. */
const listable = (bundle, q) => !bundle.hidden && q.items.length >= MIN_ITEMS;

const sorted = (bundles) => [...bundles].sort((a, b) =>
  Number(Boolean(b.featured)) - Number(Boolean(a.featured))
  || (Number(a.order) || 0) - (Number(b.order) || 0)
  || (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));

module.exports = { MIN_ITEMS, MAX_ITEMS, MAX_BUNDLES, KEPT, cleanBundle, quote, publicBundle, mineOf, listable, sorted, split };
