/**
 * Native billing: Tebex Checkout (merchant of record) for capes, bundles and Native+, plus redeem codes.
 *
 *   GET  /v1/billing/config                 public: is billing on, Tebex public token, Native+ prices
 *   POST /v1/billing/checkout               { kind: 'cape', itemId } | { kind: 'bundle', bundleId } | { kind: 'bundle', itemIds } | { kind: 'plus', plan: 'monthly'|'yearly' }
 *                                           -> { transactionId (basket ident), url (playnative.fun/checkout), payUrl (pay.tebex.io) }
 *                                           (a bundle is several custom packages in one Tebex basket; a store bundle is sold at its
 *                                           bundle price, split over the pieces still to buy)
 *   GET  /v1/billing/me                     Native+ status and purchases of the signed-in account
 *   POST /v1/billing/portal                 link to the website billing page (Tebex payment portal: receipts, cancel Native+)
 *   POST /v1/billing/tebex/webhook          Tebex webhooks (X-Signature checked, validation.webhook answered)
 *   POST /v1/store/redeem                   { code } event / gift codes
 *   GET  /v1/admin/billing/overview         sales, refunds, members
 *   GET|POST /v1/admin/billing/codes        list / create redeem codes
 *   DELETE   /v1/admin/billing/codes/:code  delete a redeem code
 *   GET|POST /v1/admin/billing/settings     Tebex keys (secrets are write-only)
 *   POST /v1/admin/billing/setup            checks the keys by opening a throwaway basket
 *   POST /v1/admin/billing/activate         { mode: 'off' | 'test' | 'live' } (test = only admins can check out)
 *   GET|POST /v1/admin/billing/plus         list / give Native+ to a player { username, days (0 = forever), note }
 *   DELETE   /v1/admin/billing/plus/:userId take a given Native+ away again
 *
 * How things are owned (all in store_owned):
 *   source 'purchase'  bought once, kept forever (removed again on refund / chargeback)
 *   source 'plus'      added while a Native+ member; removed when the membership ends
 *   source 'code'      redeemed with an event code
 *   source 'admin'     given by an admin
 *
 * Native+ comes from a Tebex recurring payment or from an admin (plus_grants, optionally until a date).
 *
 * Keys: saved from the admin page (billing_settings) or, as a fallback, the env vars TEBEX_PROJECT_ID,
 * TEBEX_PRIVATE_KEY, TEBEX_PUBLIC_TOKEN, TEBEX_WEBHOOK_SECRET and TEBEX_MODE (off | test | live).
 * Tebex docs: https://docs.tebex.io/developers/checkout-api/overview
 */
const crypto = require('crypto');
const db = require('./db');
const events = require('./social-events');

const PLUS_ACTIVE = new Set(['active', 'overdue', 'pending_downgrade']);
const PLANS = {
  monthly: { amount: 2.99, period: 'month' },
  yearly: { amount: 24.99, period: 'year' }
};
const CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,31}$/;
const MODES = ['off', 'test', 'live'];
const API = 'https://checkout.tebex.io/api';
/** Tebex sends webhooks only from these addresses (checked when TEBEX_CHECK_IP=1 and the real IP is known). */
const TEBEX_IPS = new Set(['18.209.80.3', '54.87.231.232']);

const site = () => require('./site-routes');
const env = (name) => String(process.env[name] || '').trim();
const SITE_URL = () => (env('NATIVE_SITE_URL') || env('PUBLIC_SITE_URL') || 'https://playnative.fun').replace(/\/$/, '');
const WEBHOOK_URL = () => env('TEBEX_WEBHOOK_URL') || `${(env('PUBLIC_API_URL') || 'https://api.playnative.fun').replace(/\/$/, '')}/v1/billing/tebex/webhook`;
const FIELDS = { projectId: 'TEBEX_PROJECT_ID', privateKey: 'TEBEX_PRIVATE_KEY', publicToken: 'TEBEX_PUBLIC_TOKEN', webhookSecret: 'TEBEX_WEBHOOK_SECRET' };

function savedSettings() {
  try { return Object.fromEntries(sql().prepare('SELECT key, value FROM billing_settings').all().map((row) => [row.key, row.value])); } catch { return {}; }
}
function saveSetting(key, value) {
  if (value == null || value === '') sql().prepare('DELETE FROM billing_settings WHERE key = ?').run(key);
  else sql().prepare('INSERT INTO billing_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, String(value), Date.now());
}
/** off | test (admins only) | live. */
function mode() {
  const saved = savedSettings()['tebex.mode'];
  if (MODES.includes(saved)) return saved;
  return MODES.includes(env('TEBEX_MODE')) ? env('TEBEX_MODE') : 'off';
}
/** The Tebex setup; saved values win over env vars. */
function config() {
  const saved = savedSettings();
  const pick = (field) => saved[`tebex.${field}`] || env(FIELDS[field]);
  return { projectId: pick('projectId'), privateKey: pick('privateKey'), publicToken: pick('publicToken'), webhookSecret: pick('webhookSecret'), mode: mode() };
}
const readyIn = (c) => Boolean(c.projectId && c.privateKey && c.webhookSecret);
/** Checkouts are open to everyone. */
const enabled = () => { const c = config(); return readyIn(c) && c.mode === 'live'; };
/** Checkouts are open to this user (admins can test before going live). */
const openFor = (user) => { const c = config(); return readyIn(c) && (c.mode === 'live' || (c.mode === 'test' && Boolean(user?.is_admin))); };

/* ── database ──────────────────────────────────────────────────────── */

let ready = null;
function sql() {
  const handle = db.getDb();
  if (ready !== handle) {
    handle.exec(`
      CREATE TABLE IF NOT EXISTS store_owned (
        user_id TEXT NOT NULL, item_id TEXT NOT NULL, acquired_at INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'free', PRIMARY KEY (user_id, item_id)
      );
      CREATE TABLE IF NOT EXISTS billing_customers (
        user_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS billing_bundle_lines (
        transaction_id TEXT NOT NULL, line_id TEXT NOT NULL, item_id TEXT NOT NULL, PRIMARY KEY (transaction_id, line_id)
      );
      CREATE TABLE IF NOT EXISTS billing_checkouts (
        transaction_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,
        item_id TEXT, plan TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS billing_purchases (
        transaction_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, item_id TEXT, plan TEXT,
        amount_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD',
        status TEXT NOT NULL DEFAULT 'paid', subscription_id TEXT, customer_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_billing_purchases_user ON billing_purchases(user_id);
      CREATE TABLE IF NOT EXISTS billing_subscriptions (
        subscription_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL, plan TEXT,
        current_period_end INTEGER, cancel_at INTEGER, customer_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_user ON billing_subscriptions(user_id);
      CREATE TABLE IF NOT EXISTS billing_events (
        event_id TEXT PRIMARY KEY, type TEXT NOT NULL, received_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS redeem_codes (
        code TEXT PRIMARY KEY, item_id TEXT NOT NULL, max_uses INTEGER NOT NULL DEFAULT 1,
        uses INTEGER NOT NULL DEFAULT 0, expires_at INTEGER, note TEXT, created_by TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS billing_settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS billing_customer_ids (
        user_id TEXT NOT NULL, environment TEXT NOT NULL, customer_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, environment)
      );
      CREATE INDEX IF NOT EXISTS idx_billing_customer_ids_customer ON billing_customer_ids(customer_id);
      CREATE TABLE IF NOT EXISTS plus_grants (
        user_id TEXT PRIMARY KEY, expires_at INTEGER, note TEXT, granted_by TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS redeem_uses (
        code TEXT NOT NULL, user_id TEXT NOT NULL, used_at INTEGER NOT NULL, PRIMARY KEY (code, user_id)
      );
    `);
    for (const table of ['billing_purchases', 'billing_subscriptions']) {
      try { handle.exec(`ALTER TABLE ${table} ADD COLUMN environment TEXT`); } catch { /* already there */ }
    }
    for (const table of ['billing_purchases', 'billing_checkouts']) {
      try { handle.exec(`ALTER TABLE ${table} ADD COLUMN bundle_id TEXT`); } catch { /* already there */ }
    }
    // Customers saved before environments existed belong to the env-var environment.
    handle.prepare('INSERT OR IGNORE INTO billing_customer_ids (user_id, environment, customer_id, created_at) SELECT user_id, ?, customer_id, created_at FROM billing_customers').run('live');
    ready = handle;
  }
  return handle;
}

const toMs = (value) => {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
};

/* ── entitlements ──────────────────────────────────────────────────── */

/** An admin-given Native+ that hasn't run out yet. */
function giftFor(userId) {
  const row = sql().prepare('SELECT * FROM plus_grants WHERE user_id = ?').get(String(userId));
  return row && (!row.expires_at || row.expires_at > Date.now()) ? row : null;
}

function plusFor(userId) {
  const rows = sql().prepare("SELECT * FROM billing_subscriptions WHERE user_id = ? AND COALESCE(environment, 'live') != 'sandbox' ORDER BY updated_at DESC").all(String(userId));
  const live = rows.find((row) => PLUS_ACTIVE.has(row.status)) || null;
  const latest = live || rows[0] || null;
  const gift = live ? null : giftFor(userId);
  if (gift) {
    return { active: true, status: 'active', plan: 'gift', gifted: true, renewsAt: null, endsAt: gift.expires_at || null, subscriptionId: null };
  }
  return {
    active: Boolean(live),
    status: latest?.status || null,
    plan: latest?.plan || null,
    renewsAt: live && !live.cancel_at ? live.current_period_end : null,
    endsAt: live?.cancel_at || null,
    subscriptionId: latest?.subscription_id || null
  };
}
const hasPlus = (userId) => plusFor(userId).active;

/** A cape you pay for (or get with Native+). Event capes are never sold. */
const isPaid = (item) => Boolean(item) && !item.exclusive && Number(item.price) > 0;

function ownedSource(userId, itemId) {
  return sql().prepare('SELECT source FROM store_owned WHERE user_id = ? AND item_id = ?').get(String(userId), String(itemId))?.source || null;
}

function grantItem(userId, itemId, source) {
  sql().prepare(`INSERT INTO store_owned (user_id, item_id, acquired_at, source) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, item_id) DO UPDATE SET source = CASE
      WHEN excluded.source = 'purchase' THEN 'purchase'
      WHEN store_owned.source = 'plus' AND excluded.source IN ('code', 'admin') THEN excluded.source
      ELSE store_owned.source END`).run(String(userId), String(itemId), Date.now(), source);
}

/* hooks set by the server (profile storage lives there) */
let hooks = { readProfile: null, saveProfile: null, findItem: null, allItems: null, findBundle: null, quoteBundle: null, bundleOnSale: null };
function setHooks(next) { hooks = { ...hooks, ...next }; }

function takeOffIfWearing(user, itemIds) {
  if (!hooks.readProfile || !hooks.saveProfile || !user) return;
  const profile = hooks.readProfile(user.username);
  if (!profile) return;
  let next = profile;
  if (next.capeStore && itemIds.includes(next.capeStore)) next = { ...next, cape: null, capeAnim: null, capeStore: null };
  // 3D cosmetics (hats, wings, ...) come off too when the item is taken back
  const worn = next.cosmetics && typeof next.cosmetics === 'object' ? next.cosmetics : null;
  if (worn && Object.values(worn).some((id) => itemIds.includes(id))) {
    const cosmetics = {};
    for (const [slot, id] of Object.entries(worn)) if (!itemIds.includes(id)) cosmetics[slot] = id;
    const sides = { ...(next.cosmeticSides || {}) };
    for (const slot of Object.keys(sides)) if (!cosmetics[slot]) delete sides[slot];
    next = { ...next, cosmetics, cosmeticSides: sides };
  }
  if (next !== profile) hooks.saveProfile({ ...next, updatedAt: new Date().toISOString() }, null, user);
}

function setPlusBadge(userId, on) {
  try { db.setUserBadge(userId, 'plus', on); } catch { /* badge list may be older */ }
}

/** Brings a member's locker and badge in line with their Native+ status. */
function syncPlus(userId) {
  const user = db.getUserById(userId);
  if (!user) return;
  const active = hasPlus(userId);
  setPlusBadge(userId, active);
  if (active && hooks.allItems) {
    for (const item of hooks.allItems()) {
      if (!item.hidden && isPaid(item) && !ownedSource(userId, item.id)) grantItem(userId, item.id, 'plus');
    }
  }
  if (!active) {
    const rows = sql().prepare("SELECT item_id FROM store_owned WHERE user_id = ? AND source = 'plus'").all(String(userId));
    if (rows.length) {
      const ids = rows.map((row) => row.item_id);
      sql().prepare("DELETE FROM store_owned WHERE user_id = ? AND source = 'plus'").run(String(userId));
      takeOffIfWearing(user, ids);
    }
  }
  notify(user);
}

/** Ends gifts that ran out (checked every few minutes and on start). */
let sweepTimer = null;
function sweepGifts() {
  try {
    const expired = sql().prepare('SELECT user_id FROM plus_grants WHERE expires_at IS NOT NULL AND expires_at <= ?').all(Date.now());
    for (const row of expired) {
      sql().prepare('DELETE FROM plus_grants WHERE user_id = ?').run(row.user_id);
      syncPlus(row.user_id);
    }
  } catch (error) { console.warn('[Native Billing] Gift sweep failed:', error.message); }
}
function startGiftSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepGifts, 5 * 60_000);
  sweepTimer.unref?.();
  setImmediate(sweepGifts);
}

function notify(user) {
  if (!user) return;
  const profile = hooks.readProfile ? hooks.readProfile(user.username) : null;
  events.publish(user.id, 'wardrobe:changed', { userId: user.id, name: user.username, capeStore: profile?.capeStore || null, owned: true });
  events.publish(user.id, 'billing:changed', { userId: user.id });
}

/* ── Tebex API ─────────────────────────────────────────────────────── */

async function tebex(method, pathname, body, c = config()) {
  if (!c.projectId || !c.privateKey) throw Object.assign(new Error('No Tebex project ID / private key saved.'), { status: 400 });
  const response = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${c.projectId}:${c.privateKey}`).toString('base64')}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000)
  });
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(payload?.detail || payload?.message || payload?.error_message || payload?.title || `Tebex request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data : payload;
}

/** A public, routable IPv4/IPv6 address worth passing to Tebex for fraud checks. */
function publicIp(ip) {
  const value = String(ip || '').replace(/^::ffff:/, '');
  if (!value || value === '::1' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/.test(value) || /^(fc|fd|fe80)/i.test(value)) return null;
  return value;
}

/**
 * Opens a Tebex basket with custom packages. `lines` = [{ name, price, custom, subscription? }].
 * Returns the basket (ident + links.checkout).
 */
async function openBasket(user, lines, custom, ip) {
  const back = SITE_URL();
  const basket = await tebex('POST', '/baskets', {
    email: user.email || undefined,
    first_name: user.username,
    return_url: `${back}/store`,
    complete_url: `${back}/checkout?done=1`,
    complete_auto_redirect: true,
    custom,
    ...(publicIp(ip) ? { ip: publicIp(ip) } : {})
  });
  if (!basket?.ident) throw new Error('Tebex didn’t return a basket.');
  let latest = basket;
  for (const line of lines) {
    const type = line.subscription ? 'subscription' : 'single';
    latest = await tebex('POST', `/baskets/${encodeURIComponent(basket.ident)}/packages`, {
      package: {
        name: line.name,
        price: Math.round(Number(line.price) * 100) / 100,
        type,
        ...(line.subscription ? { expiry_period: line.subscription, expiry_length: 1 } : {}),
        custom: { ...custom, ...line.custom }
      },
      qty: 1,
      type
    });
  }
  return { ...basket, ...(latest && latest.ident ? latest : {}), ident: basket.ident };
}

/* ── webhooks ──────────────────────────────────────────────────────── */

/** X-Signature = HMAC-SHA256(key = webhook secret, data = hex SHA256 of the raw body). */
function verifySignature(raw, header, secret) {
  if (!header || !secret) return false;
  const bodyHash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
  const expected = crypto.createHmac('sha256', secret).update(bodyHash).digest('hex');
  const given = String(header).trim().toLowerCase();
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** Everything we put in `custom` (basket and packages), merged. */
function customOf(payment) {
  const out = {};
  for (const product of payment?.products || []) if (product?.custom && typeof product.custom === 'object') Object.assign(out, product.custom);
  if (payment?.custom && typeof payment.custom === 'object') Object.assign(out, payment.custom);
  return out;
}

function userForPayment(payment) {
  const custom = customOf(payment);
  if (custom.userId && db.getUserById(String(custom.userId))) return db.getUserById(String(custom.userId));
  if (custom.ident) {
    const row = sql().prepare('SELECT user_id FROM billing_checkouts WHERE transaction_id = ?').get(String(custom.ident));
    if (row) return db.getUserById(row.user_id);
  }
  if (payment?.recurring_payment_reference) {
    const row = sql().prepare('SELECT user_id FROM billing_subscriptions WHERE subscription_id = ?').get(String(payment.recurring_payment_reference));
    if (row) return db.getUserById(row.user_id);
  }
  if (payment?.transaction_id) {
    const row = sql().prepare('SELECT user_id FROM billing_purchases WHERE transaction_id = ?').get(String(payment.transaction_id));
    if (row) return db.getUserById(row.user_id);
  }
  return null;
}

const cents = (price) => Math.round(Number(price?.amount || 0) * 100);
const isTestPayment = (payment) => /test/i.test(String(payment?.payment_method?.name || ''));
const planOf = (custom, amount) => {
  if (custom?.plan === 'monthly' || custom?.plan === 'yearly') return custom.plan;
  const value = Number(amount || 0);
  if (Math.abs(value - PLANS.yearly.amount) < 0.01) return 'yearly';
  if (Math.abs(value - PLANS.monthly.amount) < 0.01) return 'monthly';
  return null;
};

/** Item ids of a bundle (array or comma-separated), unique, at most 12. */
function bundleIds(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(list.map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 12);
}

function upsertSubscription({ reference, user, status, plan, periodEnd, cancelAt, keepCancel = false, environment = 'live' }) {
  const now = Date.now();
  sql().prepare(`INSERT INTO billing_subscriptions (subscription_id, user_id, status, plan, current_period_end, cancel_at, customer_id, created_at, updated_at, environment)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    ON CONFLICT(subscription_id) DO UPDATE SET status = excluded.status, plan = COALESCE(excluded.plan, billing_subscriptions.plan),
      current_period_end = COALESCE(excluded.current_period_end, billing_subscriptions.current_period_end),
      cancel_at = ${keepCancel ? 'billing_subscriptions.cancel_at' : 'excluded.cancel_at'}, updated_at = excluded.updated_at`).run(
    String(reference), String(user.id), String(status), plan || null, periodEnd || null, cancelAt || null, now, now, environment);
  syncPlus(user.id);
}

function onPaymentCompleted(payment) {
  const user = userForPayment(payment);
  if (!user) return { ignored: 'no matching user' };
  const txn = String(payment.transaction_id || '');
  if (!txn) return { ignored: 'no transaction id' };
  const custom = customOf(payment);
  const checkout = (custom.ident && sql().prepare('SELECT * FROM billing_checkouts WHERE transaction_id = ?').get(String(custom.ident))) || {};
  const reference = payment.recurring_payment_reference ? String(payment.recurring_payment_reference) : null;
  const kind = reference || custom.kind === 'plus' || checkout.kind === 'plus' ? 'plus' : (custom.kind || checkout.kind || 'cape');
  const productIds = (payment.products || []).map((product) => product?.custom?.itemId).filter(Boolean);
  const itemId = kind === 'cape' ? String(custom.itemId || productIds[0] || checkout.item_id || '') || null
    : kind === 'bundle' ? bundleIds(productIds.length ? productIds : (custom.itemIds || checkout.item_id)).join(',') || null
    : null;
  const bundleId = kind === 'bundle' ? (String(custom.bundleId || checkout.bundle_id || '') || null) : null;
  const plan = kind === 'plus' ? planOf({ plan: custom.plan || checkout.plan }, payment.price?.amount) : null;
  const environment = isTestPayment(payment) ? 'test' : 'live';
  const now = Date.now();
  sql().prepare(`INSERT OR IGNORE INTO billing_purchases
    (transaction_id, user_id, kind, item_id, plan, amount_cents, currency, status, subscription_id, customer_id, created_at, updated_at, environment, bundle_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?)`).run(
    txn, String(user.id), kind, itemId, plan, cents(payment.price_paid || payment.price), String(payment.price_paid?.currency || payment.price?.currency || 'USD'),
    reference, payment.customer?.email || null, toMs(payment.created_at) || now, now, environment, bundleId);

  if (kind === 'plus' && reference) {
    // A first payment or a renewal: the membership is active (the recurring-payment webhooks fill in dates).
    upsertSubscription({ reference, user, status: 'active', plan, keepCancel: true, environment });
    return { ok: true };
  }
  if (kind === 'cape' && itemId) {
    grantItem(user.id, itemId, 'purchase');
    notify(user);
  }
  if (kind === 'bundle' && itemId) {
    for (const id of bundleIds(itemId)) grantItem(user.id, id, 'purchase');
    // a store bundle's free pieces come with it
    const bundle = bundleId && hooks.findBundle ? hooks.findBundle(bundleId) : null;
    if (bundle && hooks.findItem) {
      for (const id of bundle.itemIds || []) {
        const item = hooks.findItem(id);
        if (item && !item.exclusive && !isPaid(item) && !ownedSource(user.id, id)) grantItem(user.id, id, 'free');
      }
    }
    notify(user);
  }
  return { ok: true };
}

/** Refund, chargeback or open dispute: take back what the payment bought. */
function onPaymentReversed(payment, status) {
  const purchase = sql().prepare('SELECT * FROM billing_purchases WHERE transaction_id = ?').get(String(payment.transaction_id || ''));
  if (!purchase) return { ignored: 'unknown transaction' };
  sql().prepare('UPDATE billing_purchases SET status = ?, updated_at = ? WHERE transaction_id = ?').run(status, Date.now(), purchase.transaction_id);
  if (purchase.kind === 'plus') {
    // A refunded / charged-back Native+ payment ends the membership.
    if (purchase.subscription_id) {
      sql().prepare('UPDATE billing_subscriptions SET status = ?, updated_at = ? WHERE subscription_id = ?').run(status, Date.now(), purchase.subscription_id);
    }
    syncPlus(purchase.user_id);
    return { ok: true };
  }
  let ids = purchase.item_id ? bundleIds(purchase.item_id) : [];
  ids = ids.filter((id) => ownedSource(purchase.user_id, id) === 'purchase');
  if (ids.length) {
    const plus = hasPlus(purchase.user_id);
    for (const id of ids) {
      sql().prepare('DELETE FROM store_owned WHERE user_id = ? AND item_id = ?').run(purchase.user_id, id);
      if (plus) grantItem(purchase.user_id, id, 'plus');
    }
    const user = db.getUserById(purchase.user_id);
    if (!plus) takeOffIfWearing(user, ids);
    notify(user);
  }
  return { ok: true };
}

/** A dispute we won: give the purchase back. */
function onDisputeWon(payment) {
  const purchase = sql().prepare('SELECT * FROM billing_purchases WHERE transaction_id = ?').get(String(payment.transaction_id || ''));
  if (!purchase) return { ignored: 'unknown transaction' };
  if (purchase.status === 'paid') return { ok: true };
  sql().prepare("UPDATE billing_purchases SET status = 'paid', updated_at = ? WHERE transaction_id = ?").run(Date.now(), purchase.transaction_id);
  if (purchase.kind === 'plus') {
    if (purchase.subscription_id) sql().prepare("UPDATE billing_subscriptions SET status = 'active', updated_at = ? WHERE subscription_id = ?").run(Date.now(), purchase.subscription_id);
    syncPlus(purchase.user_id);
    return { ok: true };
  }
  for (const id of purchase.item_id ? bundleIds(purchase.item_id) : []) grantItem(purchase.user_id, id, 'purchase');
  notify(db.getUserById(purchase.user_id));
  return { ok: true };
}

const RECURRING_STATUS = { 2: 'active', 3: 'overdue', 4: 'expired', 5: 'cancelled', 7: 'pending_downgrade' };

function onRecurring(type, sub) {
  const reference = String(sub?.reference || '');
  if (!reference) return { ignored: 'no reference' };
  const first = sub.initial_payment || sub.last_payment || {};
  let user = userForPayment({ ...first, recurring_payment_reference: reference });
  if (!user) {
    const row = sql().prepare('SELECT user_id FROM billing_subscriptions WHERE subscription_id = ?').get(reference);
    user = row ? db.getUserById(row.user_id) : null;
  }
  if (!user) return { ignored: 'no matching user' };
  let status = RECURRING_STATUS[sub.status?.id] || 'active';
  if (type === 'recurring-payment.ended' && PLUS_ACTIVE.has(status)) status = 'ended';
  const periodEnd = toMs(sub.next_payment_at);
  const plan = planOf(customOf(first), sub.price?.amount);
  const environment = isTestPayment(first) ? 'test' : 'live';
  if (type === 'recurring-payment.cancellation.requested') {
    upsertSubscription({ reference, user, status, plan, periodEnd, cancelAt: periodEnd || toMs(sub.cancelled_at) || Date.now(), environment });
  } else if (type === 'recurring-payment.cancellation.aborted' || type === 'recurring-payment.started' || type === 'recurring-payment.renewed') {
    upsertSubscription({ reference, user, status, plan, periodEnd, cancelAt: null, environment });
  } else {
    upsertSubscription({ reference, user, status, plan, periodEnd, cancelAt: toMs(sub.cancelled_at), environment });
  }
  return { ok: true };
}

function handleEvent(event) {
  const id = String(event?.id || '');
  const type = String(event?.type || '');
  if (id) {
    const seen = sql().prepare('INSERT OR IGNORE INTO billing_events (event_id, type, received_at) VALUES (?, ?, ?)').run(id, type, Date.now());
    if (!seen.changes) return { duplicate: true };
  }
  const subject = event?.subject || {};
  if (type === 'payment.completed') return onPaymentCompleted(subject);
  if (type === 'payment.refunded') return onPaymentReversed(subject, 'refunded');
  if (type === 'payment.dispute.opened') return onPaymentReversed(subject, 'disputed');
  if (type === 'payment.dispute.lost') return onPaymentReversed(subject, 'chargeback');
  if (type === 'payment.dispute.won') return onDisputeWon(subject);
  if (type.startsWith('recurring-payment.')) return onRecurring(type, subject);
  return { ignored: type };
}

/* ── redeem codes ──────────────────────────────────────────────────── */

const normalizeCode = (value) => String(value || '').trim().toUpperCase().replace(/\s+/g, '');

function redeem(user, rawCode) {
  const code = normalizeCode(rawCode);
  if (!CODE_RE.test(code)) return { status: 400, error: 'That code doesn’t look right.' };
  const row = sql().prepare('SELECT * FROM redeem_codes WHERE code = ?').get(code);
  if (!row) return { status: 404, error: 'That code doesn’t exist.' };
  if (row.expires_at && row.expires_at < Date.now()) return { status: 410, error: 'That code has expired.' };
  if (sql().prepare('SELECT 1 FROM redeem_uses WHERE code = ? AND user_id = ?').get(code, String(user.id))) return { status: 409, error: 'You already used this code.' };
  if (row.uses >= row.max_uses) return { status: 410, error: 'That code has been fully used.' };
  const item = hooks.findItem ? hooks.findItem(row.item_id) : null;
  if (!item) return { status: 410, error: 'The cloak for this code is gone.' };
  const take = sql().prepare('UPDATE redeem_codes SET uses = uses + 1 WHERE code = ? AND uses < max_uses').run(code);
  if (!take.changes) return { status: 410, error: 'That code has been fully used.' };
  sql().prepare('INSERT INTO redeem_uses (code, user_id, used_at) VALUES (?, ?, ?)').run(code, String(user.id), Date.now());
  grantItem(user.id, item.id, 'code');
  notify(user);
  return { status: 200, item: { id: item.id, name: item.name } };
}

/* ── http ──────────────────────────────────────────────────────────── */

const bearerOf = (req) => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  || String(req.headers['x-native-token'] || req.headers['x-noctra-token'] || '').trim();

async function readRaw(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function purchasesOf(userId) {
  return sql().prepare('SELECT * FROM billing_purchases WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(String(userId)).map((row) => ({
    transactionId: row.transaction_id, kind: row.kind, itemId: row.item_id, plan: row.plan, bundleId: row.bundle_id || null,
    bundleName: row.bundle_id && hooks.findBundle ? (hooks.findBundle(row.bundle_id)?.name || null) : null,
    amount: row.amount_cents / 100, currency: row.currency, status: row.status, createdAt: row.created_at
  }));
}

function publicPlus(plus) {
  const { subscriptionId, ...rest } = plus;
  return rest;
}

/**
 * @param ctx { ip, send, hit, tooMany, readJson, findItem }
 * @returns {Promise<boolean>} true when handled
 */
async function handleBillingRoutes(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost');
  const isBilling = url.pathname.startsWith('/v1/billing/');
  const isRedeem = url.pathname === '/v1/store/redeem';
  const isAdmin = url.pathname.startsWith('/v1/admin/billing/');
  if (!isBilling && !isRedeem && !isAdmin) return false;
  startGiftSweep();
  const { send, hit, tooMany, ip } = ctx;
  const noStore = { 'Cache-Control': 'no-store' };
  const c = config();

  if (req.method === 'POST' && url.pathname === '/v1/billing/tebex/webhook') {
    if (env('TEBEX_CHECK_IP') === '1' && ip && !TEBEX_IPS.has(String(ip).replace(/^::ffff:/, ''))) {
      send(res, 404, { ok: false, error: 'Not found.' });
      return true;
    }
    let raw = '';
    try { raw = await readRaw(req); } catch { send(res, 413, { ok: false }); return true; }
    if (!verifySignature(raw, req.headers['x-signature'], c.webhookSecret)) {
      send(res, 401, { ok: false, error: 'Bad signature.' });
      return true;
    }
    let event = null;
    try { event = JSON.parse(raw); } catch { send(res, 400, { ok: false, error: 'Bad JSON.' }); return true; }
    // Tebex validates a new endpoint by expecting its id echoed back.
    if (event?.type === 'validation.webhook') { send(res, 200, { id: event.id }); return true; }
    try {
      const result = handleEvent(event);
      send(res, 200, { ok: true, ...result });
    } catch (error) {
      console.error('[Native Billing] webhook failed:', error);
      send(res, 500, { ok: false, error: 'Webhook failed.' }); // Tebex retries
    }
    return true;
  }

  if (url.pathname === '/v1/billing/paddle/webhook') {
    send(res, 410, { ok: false, error: 'Paddle is no longer used.' });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/v1/billing/config') {
    const open = readyIn(c) && c.mode !== 'off';
    send(res, 200, {
      ok: true,
      provider: 'tebex',
      enabled: open,
      testMode: open && c.mode === 'test',
      publicToken: open ? (c.publicToken || null) : null,
      plus: {
        monthly: { amount: PLANS.monthly.amount, currency: 'USD', available: true },
        yearly: { amount: PLANS.yearly.amount, currency: 'USD', available: true }
      }
    }, { 'Cache-Control': 'public, max-age=60', 'Access-Control-Allow-Origin': '*' });
    return true;
  }

  const token = bearerOf(req);
  const user = token ? db.getUserBySession(token) : null;

  if (isAdmin) return handleAdmin(req, res, ctx, url, user);

  if (!user) { send(res, 401, { ok: false, error: 'Sign in with your Native account first.' }); return true; }

  if (req.method === 'POST' && isRedeem) {
    if (!hit('store-redeem', user.id, 10, 10 * 60_000)) { tooMany(res, 600); return true; }
    const body = await ctx.readJson(req);
    const result = redeem(user, body.code);
    if (result.error) { send(res, result.status, { ok: false, error: result.error }); return true; }
    send(res, 200, { ok: true, item: result.item }, noStore);
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/v1/billing/me') {
    send(res, 200, { ok: true, enabled: openFor(user), plus: publicPlus(plusFor(user.id)), purchases: purchasesOf(user.id) }, noStore);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/v1/billing/portal') {
    // Receipts and cancelling Native+ live in Tebex's payment portal, opened from the website.
    send(res, 200, { ok: true, url: `${SITE_URL()}/billing` }, noStore);
    return true;
  }

  if (!openFor(user)) {
    send(res, 503, { ok: false, error: readyIn(c) && c.mode === 'test' ? 'Payments are being tested and open soon.' : 'Payments aren’t switched on yet.' });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/v1/billing/checkout') {
    if (!hit('billing-checkout', user.id, 20, 10 * 60_000)) { tooMany(res, 600); return true; }
    if (site().storeLocked() && !user.is_admin) { send(res, 423, { ok: false, locked: true, error: 'The Native store opens at launch.' }); return true; }
    const body = await ctx.readJson(req);
    const kind = body.kind === 'plus' ? 'plus' : body.kind === 'bundle' ? 'bundle' : 'cape';
    let lines;
    let custom;
    const lineFor = (item) => ({ name: item.name, price: site().priceOf(item), custom: { itemId: item.id } });
    if (kind === 'bundle' && body.bundleId) {
      const bundle = hooks.findBundle ? hooks.findBundle(String(body.bundleId)) : null;
      const q = bundle && hooks.quoteBundle ? hooks.quoteBundle(bundle, user.id) : null;
      if (!bundle || bundle.hidden || !q || q.items.length < 2) { send(res, 404, { ok: false, error: 'That bundle isn’t for sale.' }); return true; }
      if (hooks.bundleOnSale && !hooks.bundleOnSale(bundle, q)) { send(res, 410, { ok: false, error: `${bundle.name} isn’t available any more.` }); return true; }
      if (!q.lines.length) { send(res, 400, { ok: false, error: q.missing.length ? 'Everything you’re missing in this bundle is free. Add it to your locker instead.' : 'You already own everything in this bundle.' }); return true; }
      lines = q.lines.map(({ item, cents: price }) => ({ name: `${item.name} (${bundle.name})`, price: price / 100, custom: { itemId: item.id, bundleId: bundle.id } }));
      custom = { userId: String(user.id), kind: 'bundle', bundleId: bundle.id, itemIds: q.lines.map(({ item }) => item.id).join(',') };
    } else if (kind === 'bundle') {
      const ids = bundleIds(body.itemIds);
      const list = [];
      for (const id of ids) {
        const item = ctx.findItem(id);
        if (!item || item.hidden || item.exclusive || !isPaid(item)) continue; // free / event pieces aren't sold
        const source = ownedSource(user.id, item.id);
        if (source && source !== 'plus') continue; // already yours
        list.push(item);
      }
      if (!list.length) { send(res, 400, { ok: false, error: 'Everything in this look is already yours or free.' }); return true; }
      lines = list.map(lineFor);
      custom = list.length === 1
        ? { userId: String(user.id), kind: 'cape', itemId: list[0].id }
        : { userId: String(user.id), kind: 'bundle', itemIds: list.map((item) => item.id).join(',') };
    } else if (kind === 'cape') {
      const item = ctx.findItem(String(body.itemId || ''));
      if (!item || item.hidden) { send(res, 404, { ok: false, error: 'That cloak isn’t for sale.' }); return true; }
      if (item.exclusive) { send(res, 403, { ok: false, error: `${item.name} is an event cloak. It can’t be bought.` }); return true; }
      if (!isPaid(item)) { send(res, 400, { ok: false, error: `${item.name} is free. Add it to your locker instead.` }); return true; }
      if (ownedSource(user.id, item.id) && ownedSource(user.id, item.id) !== 'plus') { send(res, 409, { ok: false, error: `${item.name} is already yours.` }); return true; }
      lines = [lineFor(item)];
      custom = { userId: String(user.id), kind, itemId: item.id };
    } else {
      const plan = body.plan === 'yearly' ? 'yearly' : 'monthly';
      if (hasPlus(user.id)) { send(res, 409, { ok: false, error: 'You’re already a Native+ member.' }); return true; }
      lines = [{ name: `Native+ (${plan})`, price: PLANS[plan].amount, subscription: PLANS[plan].period, custom: { plan } }];
      custom = { userId: String(user.id), kind, plan };
    }
    try {
      const basket = await openBasket(user, lines, custom, ip);
      sql().prepare('INSERT OR REPLACE INTO billing_checkouts (transaction_id, user_id, kind, item_id, plan, created_at, bundle_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(basket.ident, String(user.id), custom.kind, custom.itemId || custom.itemIds || null, custom.plan || null, Date.now(), custom.bundleId || null);
      send(res, 200, {
        ok: true,
        transactionId: basket.ident,
        url: `${SITE_URL()}/checkout?ident=${encodeURIComponent(basket.ident)}`,
        payUrl: basket.links?.checkout || `https://pay.tebex.io/${encodeURIComponent(basket.ident)}`
      }, noStore);
    } catch (error) {
      console.error('[Native Billing] checkout failed:', error.message);
      send(res, 502, { ok: false, error: 'Couldn’t start the checkout. Try again in a moment.' });
    }
    return true;
  }

  send(res, 404, { ok: false, error: 'Not found.' });
  return true;
}

/* ── admin: Tebex settings ─────────────────────────────────────────── */

const hint = (value) => (value ? `…${value.slice(-4)}` : null);
function publicSettings() {
  const saved = savedSettings();
  const c = config();
  return {
    provider: 'tebex',
    mode: c.mode,
    webhookUrl: WEBHOOK_URL(),
    projectId: c.projectId || null, // not secret
    privateKey: hint(c.privateKey), // never the key itself
    publicToken: c.publicToken || null, // public by design (it ships in the page)
    webhookSecret: Boolean(c.webhookSecret),
    fromEnvFile: !saved['tebex.privateKey'] && Boolean(env('TEBEX_PRIVATE_KEY')),
    checkedAt: Number(saved['tebex.checkedAt']) || null,
    ready: readyIn(c)
  };
}

async function handleAdmin(req, res, ctx, url, user) {
  const { send } = ctx;
  const noStore = { 'Cache-Control': 'no-store' };
  if (!user) { send(res, 401, { ok: false, error: 'Native account session required.' }); return true; }
  if (!user.is_admin) { send(res, 403, { ok: false, error: 'Administrator access required.' }); return true; }
  const nameOf = (id) => { try { return db.getUserById(id)?.username || null; } catch { return null; } };

  if (req.method === 'GET' && url.pathname === '/v1/admin/billing/overview') {
    const since = Date.now() - 30 * 86_400_000;
    const inEnv = "COALESCE(environment, 'live') IN ('live', 'production')"; // test payments and old Paddle sandbox rows don't count
    const one = (query, ...args) => sql().prepare(query).get(...args) || {};
    const paid = one(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM billing_purchases WHERE status = 'paid' AND ${inEnv}`);
    const recent30 = one(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM billing_purchases WHERE status = 'paid' AND created_at >= ? AND ${inEnv}`, since);
    const refunds = one(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM billing_purchases WHERE status != 'paid' AND ${inEnv}`);
    const members = sql().prepare(`SELECT plan, COUNT(*) AS n FROM billing_subscriptions WHERE status IN ('active', 'overdue', 'pending_downgrade', 'trialing', 'past_due') AND ${inEnv} GROUP BY plan`).all();
    const gifted = one(`SELECT COUNT(*) AS n FROM plus_grants WHERE (expires_at IS NULL OR expires_at > ?) AND user_id NOT IN (SELECT user_id FROM billing_subscriptions WHERE status IN ('active', 'overdue', 'pending_downgrade', 'trialing', 'past_due') AND ${inEnv})`, Date.now()).n || 0;
    const recent = sql().prepare('SELECT * FROM billing_purchases ORDER BY created_at DESC LIMIT 25').all().map((row) => ({
      transactionId: row.transaction_id, userId: row.user_id, username: nameOf(row.user_id), kind: row.kind, itemId: row.item_id,
      itemName: row.kind === 'bundle' && row.bundle_id && hooks.findBundle?.(row.bundle_id) ? `${hooks.findBundle(row.bundle_id).name} bundle` : row.kind === 'bundle' ? bundleIds(row.item_id).map((id) => ctx.findItem(id)?.name || id).join(', ') : row.item_id && ctx.findItem(row.item_id) ? ctx.findItem(row.item_id).name : null, plan: row.plan,
      amount: row.amount_cents / 100, currency: row.currency, status: row.status, createdAt: row.created_at,
      environment: row.environment || 'live'
    }));
    send(res, 200, {
      ok: true,
      enabled: readyIn(config()) && config().mode !== 'off',
      mode: config().mode,
      environment: config().mode === 'live' ? 'production' : 'sandbox',
      sales: { count: paid.n || 0, total: (paid.cents || 0) / 100, last30Count: recent30.n || 0, last30: (recent30.cents || 0) / 100, currency: 'USD' },
      refunds: { count: refunds.n || 0, total: (refunds.cents || 0) / 100 },
      plus: {
        active: members.reduce((sum, row) => sum + row.n, 0) + gifted,
        gifted,
        monthly: members.find((row) => row.plan === 'monthly')?.n || 0,
        yearly: members.find((row) => row.plan === 'yearly')?.n || 0
      },
      recent
    }, noStore);
    return true;
  }

  const listGifts = () => sql().prepare('SELECT * FROM plus_grants WHERE expires_at IS NULL OR expires_at > ? ORDER BY created_at DESC LIMIT 500').all(Date.now()).map((row) => ({
    userId: row.user_id, username: nameOf(row.user_id), expiresAt: row.expires_at || null, note: row.note || '',
    grantedBy: nameOf(row.granted_by), createdAt: row.created_at, subscribed: plusFor(row.user_id).gifted !== true
  }));

  if (url.pathname === '/v1/admin/billing/plus') {
    if (req.method === 'GET') { send(res, 200, { ok: true, gifts: listGifts() }, noStore); return true; }
    if (req.method === 'POST') {
      const body = await ctx.readJson(req);
      const name = String(body.username || '').trim();
      const target = name ? db.getUserByUsername(name) : null;
      if (!target) { send(res, 404, { ok: false, error: name ? `No Native account called ${name}.` : 'Type a username.' }); return true; }
      const days = Number(body.days);
      const current = sql().prepare('SELECT expires_at FROM plus_grants WHERE user_id = ?').get(String(target.id));
      // Giving more time to someone who still has a gift adds to what's left.
      const from = current && current.expires_at && current.expires_at > Date.now() ? current.expires_at : Date.now();
      const expiresAt = Number.isFinite(days) && days > 0 ? from + Math.min(days, 3650) * 86_400_000 : null;
      sql().prepare(`INSERT INTO plus_grants (user_id, expires_at, note, granted_by, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET expires_at = excluded.expires_at, note = excluded.note, granted_by = excluded.granted_by`)
        .run(String(target.id), expiresAt, String(body.note || '').slice(0, 120), String(user.id), Date.now());
      syncPlus(target.id);
      send(res, 200, { ok: true, username: target.username, expiresAt, gifts: listGifts() }, noStore);
      return true;
    }
  }
  const giftMatch = url.pathname.match(/^\/v1\/admin\/billing\/plus\/([^/]+)$/);
  if (giftMatch && req.method === 'DELETE') {
    const userId = decodeURIComponent(giftMatch[1]);
    sql().prepare('DELETE FROM plus_grants WHERE user_id = ?').run(userId);
    syncPlus(userId);
    send(res, 200, { ok: true, gifts: listGifts() }, noStore);
    return true;
  }

  const listCodes = () => sql().prepare('SELECT * FROM redeem_codes ORDER BY created_at DESC LIMIT 200').all().map((row) => ({
    code: row.code, itemId: row.item_id, itemName: ctx.findItem(row.item_id)?.name || null, maxUses: row.max_uses, uses: row.uses,
    expiresAt: row.expires_at, note: row.note || '', createdBy: nameOf(row.created_by), createdAt: row.created_at
  }));

  if (url.pathname === '/v1/admin/billing/codes') {
    if (req.method === 'GET') { send(res, 200, { ok: true, codes: listCodes() }, noStore); return true; }
    if (req.method === 'POST') {
      const body = await ctx.readJson(req);
      const item = ctx.findItem(String(body.itemId || ''));
      if (!item) { send(res, 404, { ok: false, error: 'Pick a cloak for this code.' }); return true; }
      const code = normalizeCode(body.code) || `${item.id.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10)}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      if (!CODE_RE.test(code)) { send(res, 400, { ok: false, error: 'Codes use A-Z, 0-9 and dashes (3-32 characters).' }); return true; }
      const maxUses = Math.max(1, Math.min(100000, Math.floor(Number(body.maxUses) || 1)));
      const days = Number(body.expiresInDays);
      const expiresAt = Number.isFinite(days) && days > 0 ? Date.now() + Math.min(days, 3650) * 86_400_000 : null;
      try {
        sql().prepare('INSERT INTO redeem_codes (code, item_id, max_uses, uses, expires_at, note, created_by, created_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)')
          .run(code, item.id, maxUses, expiresAt, String(body.note || '').slice(0, 120), String(user.id), Date.now());
      } catch {
        send(res, 409, { ok: false, error: `The code ${code} already exists.` });
        return true;
      }
      send(res, 200, { ok: true, code, codes: listCodes() }, noStore);
      return true;
    }
  }
  const codeMatch = url.pathname.match(/^\/v1\/admin\/billing\/codes\/([^/]+)$/);
  if (codeMatch && req.method === 'DELETE') {
    const code = normalizeCode(decodeURIComponent(codeMatch[1]));
    sql().prepare('DELETE FROM redeem_codes WHERE code = ?').run(code);
    send(res, 200, { ok: true, codes: listCodes() }, noStore);
    return true;
  }


  if (url.pathname === '/v1/admin/billing/settings') {
    if (req.method === 'POST') {
      const body = await ctx.readJson(req);
      const rules = {
        projectId: /^\d{1,12}$/,
        privateKey: /^[A-Za-z0-9_-]{16,200}$/,
        publicToken: /^[A-Za-z0-9_-]{4,200}$/,
        webhookSecret: /^[A-Za-z0-9_-]{8,200}$/
      };
      const labels = { projectId: 'project ID', privateKey: 'private key', publicToken: 'public token', webhookSecret: 'webhook secret' };
      for (const field of Object.keys(rules)) {
        const text = String(body[field] ?? '').trim();
        if (!text) continue;
        if (!rules[field].test(text)) { send(res, 400, { ok: false, error: `That ${labels[field]} doesn’t look like a Tebex ${labels[field]}.` }); return true; }
        saveSetting(`tebex.${field}`, text);
      }
      for (const field of Array.isArray(body.clear) ? body.clear : []) {
        if (FIELDS[field]) saveSetting(`tebex.${field}`, null);
      }
      console.log(`[Native Billing] ${user.username} updated the Tebex settings`);
    }
    send(res, 200, { ok: true, settings: publicSettings() }, noStore);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/v1/admin/billing/setup') {
    const c = config();
    if (!c.projectId || !c.privateKey) { send(res, 400, { ok: false, error: 'Save the project ID and private key first.' }); return true; }
    const steps = [];
    try {
      // A throwaway basket proves the keys work (it simply expires unpaid).
      const basket = await tebex('POST', '/baskets', { first_name: 'Native', custom: { check: true } }, c);
      steps.push(`Keys work (test basket ${String(basket.ident || '').slice(0, 10)}…)`);
      saveSetting('tebex.checkedAt', Date.now());
    } catch (error) {
      console.error('[Native Billing] Tebex check failed:', error.message);
      const denied = error.status === 401 || error.status === 403;
      send(res, denied ? 400 : 502, { ok: false, error: denied ? 'Tebex rejected those keys. Check the project ID and private key, and that Checkout API access is approved for the project.' : `Tebex check failed: ${error.message}` });
      return true;
    }
    steps.push(c.webhookSecret ? 'Webhook secret saved' : `Add a webhook endpoint in Tebex (${WEBHOOK_URL()}) and paste its secret`);
    if (!c.publicToken) steps.push('Add the public token so the website can open the payment portal');
    send(res, 200, { ok: true, steps, settings: publicSettings() }, noStore);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/v1/admin/billing/activate') {
    const body = await ctx.readJson(req);
    const next = MODES.includes(body.mode) ? body.mode : body.environment === 'production' ? 'live' : body.environment === 'sandbox' ? 'test' : null;
    if (!next) { send(res, 400, { ok: false, error: 'Pick off, test or live.' }); return true; }
    if (next !== 'off' && !readyIn(config())) { send(res, 400, { ok: false, error: 'Finish the Tebex setup first (project ID, private key and webhook secret).' }); return true; }
    saveSetting('tebex.mode', next);
    console.log(`[Native Billing] ${user.username} switched payments to ${next}`);
    send(res, 200, { ok: true, settings: publicSettings() }, noStore);
    return true;
  }
  send(res, 404, { ok: false, error: 'Admin billing endpoint not found.' });
  return true;
}

/** Give Native+ (days 0/null = forever). Keeps a longer existing gift. */
function givePlus(userId, { days = 0, note = '', by = null } = {}) {
  const current = sql().prepare('SELECT expires_at FROM plus_grants WHERE user_id = ?').get(String(userId));
  const expiresAt = Number(days) > 0 ? Date.now() + Math.min(Number(days), 3650) * 86_400_000 : null;
  const keep = current && current.expires_at == null; // already forever
  if (!keep) {
    sql().prepare(`INSERT INTO plus_grants (user_id, expires_at, note, granted_by, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET expires_at = excluded.expires_at, note = excluded.note, granted_by = excluded.granted_by`)
      .run(String(userId), expiresAt, String(note).slice(0, 120), by ? String(by) : null, Date.now());
  }
  syncPlus(userId);
}
/** Take back a Native+ gift — only the one with this note, so other gifts stay. */
function takePlus(userId, note) {
  sql().prepare('DELETE FROM plus_grants WHERE user_id = ? AND note = ?').run(String(userId), String(note));
  syncPlus(userId);
}
/** Remove an item that came from one source (e.g. 'beta'), taking it off if worn. */
function takeItem(userId, itemId, source) {
  const r = sql().prepare('DELETE FROM store_owned WHERE user_id = ? AND item_id = ? AND source = ?').run(String(userId), String(itemId), String(source));
  if (r.changes) takeOffIfWearing(db.getUserById(userId), [String(itemId)]);
  return r.changes > 0;
}

module.exports = {
  handleBillingRoutes, setHooks, hasPlus, plusFor, isPaid, ownedSource, grantItem, syncPlus, givePlus, takePlus, takeItem,
  verifySignature, handleEvent, redeem, enabled, openFor, config, mode, publicSettings, saveSetting
};
