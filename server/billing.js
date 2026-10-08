/**
 * Native billing: Paddle Billing checkout, webhooks, Native+ and redeem codes.
 *
 *   GET  /v1/billing/config                 public: is billing on, Paddle client token, prices
 *   POST /v1/billing/checkout               { kind: 'cape', itemId } | { kind: 'bundle', bundleId } | { kind: 'bundle', itemIds } | { kind: 'plus', plan: 'monthly'|'yearly' } -> { url }
 *                                           (a bundle is several paid items in one Paddle transaction; item_id holds them comma-separated;
 *                                           a store bundle is sold at its bundle price, split over the pieces still to buy)
 *   GET  /v1/billing/me                     Native+ status and purchases of the signed-in account
 *   POST /v1/billing/portal                 Paddle customer portal link (receipts, cancel Native+)
 *   POST /v1/billing/paddle/webhook         Paddle notifications (signature checked)
 *   POST /v1/store/redeem                   { code } event / gift codes
 *   GET  /v1/admin/billing/overview         sales, refunds, members
 *   GET|POST /v1/admin/billing/codes        list / create redeem codes
 *   DELETE   /v1/admin/billing/codes/:code  delete a redeem code
 *   GET|POST /v1/admin/billing/settings     Paddle keys per environment (secrets are write-only)
 *   POST /v1/admin/billing/setup            { environment } create/find products, prices and the webhook in Paddle
 *   POST /v1/admin/billing/activate         { environment } switch checkouts between sandbox and live
 *   GET|POST /v1/admin/billing/plus         list / give Native+ to a player { username, days (0 = forever), note }
 *   DELETE   /v1/admin/billing/plus/:userId take a given Native+ away again
 *
 * How things are owned (all in store_owned):
 *   source 'purchase'  bought once, kept forever (removed again on refund / chargeback)
 *   source 'plus'      added while a Native+ member; removed when the membership ends
 *   source 'code'      redeemed with an event code
 *   source 'admin'     given by an admin
 *
 * Native+ comes from a Paddle subscription or from an admin (plus_grants, optionally until a date).
 *
 * Keys: saved from the admin page (billing_settings, per environment) or, as a fallback for the
 * environment named by PADDLE_ENV, the env vars PADDLE_API_KEY, PADDLE_CLIENT_TOKEN, PADDLE_WEBHOOK_SECRET,
 * PADDLE_CAPE_PRODUCT, PADDLE_PLUS_PRODUCT, PADDLE_PLUS_MONTHLY_PRICE, PADDLE_PLUS_YEARLY_PRICE.
 */
const crypto = require('crypto');
const db = require('./db');
const events = require('./social-events');

const PLUS_ACTIVE = new Set(['active', 'trialing', 'past_due']);
const PLANS = {
  monthly: { amount: 2.99, interval: 'month', env: 'PADDLE_PLUS_MONTHLY_PRICE' },
  yearly: { amount: 24.99, interval: 'year', env: 'PADDLE_PLUS_YEARLY_PRICE' }
};
const CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,31}$/;

const site = () => require('./site-routes');
const env = (name) => String(process.env[name] || '').trim();
const ENVS = ['sandbox', 'production'];
const envDefault = () => (env('PADDLE_ENV') === 'production' ? 'production' : 'sandbox');
const WEBHOOK_URL = () => env('PADDLE_WEBHOOK_URL') || `${(env('PUBLIC_API_URL') || 'https://api.nativelaunch.xyz').replace(/\/$/, '')}/v1/billing/paddle/webhook`;
const WEBHOOK_EVENTS = ['transaction.completed', 'subscription.created', 'subscription.updated', 'subscription.canceled', 'subscription.past_due', 'adjustment.created', 'adjustment.updated'];
const FIELDS = { apiKey: 'PADDLE_API_KEY', clientToken: 'PADDLE_CLIENT_TOKEN', webhookSecret: 'PADDLE_WEBHOOK_SECRET', capeProduct: 'PADDLE_CAPE_PRODUCT', plusProduct: 'PADDLE_PLUS_PRODUCT', monthlyPrice: 'PADDLE_PLUS_MONTHLY_PRICE', yearlyPrice: 'PADDLE_PLUS_YEARLY_PRICE', notificationId: 'PADDLE_NOTIFICATION_ID' };

function savedSettings() {
  try { return Object.fromEntries(sql().prepare('SELECT key, value FROM billing_settings').all().map((row) => [row.key, row.value])); } catch { return {}; }
}
function saveSetting(key, value) {
  if (value == null || value === '') sql().prepare('DELETE FROM billing_settings WHERE key = ?').run(key);
  else sql().prepare('INSERT INTO billing_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, String(value), Date.now());
}
const activeEnv = () => {
  const saved = savedSettings().active;
  return ENVS.includes(saved) ? saved : envDefault();
};
/** One environment's Paddle setup; saved values win over env vars. */
function config(name = activeEnv()) {
  const saved = savedSettings();
  const pick = (field) => saved[`${name}.${field}`] || (name === envDefault() ? env(FIELDS[field]) : '');
  return {
    environment: name,
    apiKey: pick('apiKey'),
    clientToken: pick('clientToken'),
    webhookSecret: pick('webhookSecret'),
    capeProduct: pick('capeProduct'),
    plusProduct: pick('plusProduct'),
    notificationId: pick('notificationId'),
    prices: { monthly: pick('monthlyPrice'), yearly: pick('yearlyPrice') }
  };
}
const readyIn = (c) => Boolean(c.apiKey && c.clientToken && c.webhookSecret && c.capeProduct);
const enabled = () => readyIn(config());
const apiBase = (name = activeEnv()) => (name === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com');

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
    handle.prepare('INSERT OR IGNORE INTO billing_customer_ids (user_id, environment, customer_id, created_at) SELECT user_id, ?, customer_id, created_at FROM billing_customers').run(envDefault());
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
  const rows = sql().prepare("SELECT * FROM billing_subscriptions WHERE user_id = ? AND COALESCE(environment, ?) = ? ORDER BY updated_at DESC").all(String(userId), envDefault(), activeEnv());
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

/* ── Paddle API ────────────────────────────────────────────────────── */

async function paddle(method, pathname, body, name = activeEnv(), apiKey = null) {
  const key = apiKey || config(name).apiKey;
  if (!key) throw Object.assign(new Error('No Paddle API key saved for this environment.'), { status: 400 });
  const response = await fetch(`${apiBase(name)}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000)
  });
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(payload?.error?.detail || `Paddle request failed (${response.status}).`);
    error.code = payload?.error?.code;
    error.status = response.status;
    throw error;
  }
  return payload.data;
}

const customerRow = (userId, name = activeEnv()) => sql().prepare('SELECT customer_id FROM billing_customer_ids WHERE user_id = ? AND environment = ?').get(String(userId), name);

async function customerFor(user) {
  const name = activeEnv();
  const row = customerRow(user.id, name);
  if (row) return row.customer_id;
  let id = null;
  try {
    id = (await paddle('POST', '/customers', { email: user.email, name: user.username, custom_data: { nativeUserId: String(user.id) } })).id;
  } catch (error) {
    const match = error.code === 'customer_already_exists' && /ctm_[a-z0-9]+/i.exec(error.message);
    if (!match) throw error;
    id = match[0];
  }
  sql().prepare('INSERT OR REPLACE INTO billing_customer_ids (user_id, environment, customer_id, created_at) VALUES (?, ?, ?, ?)').run(String(user.id), name, id, Date.now());
  return id;
}

/* ── webhooks ──────────────────────────────────────────────────────── */

function verifySignature(raw, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(String(header).split(';').map((part) => part.split('=')).filter((pair) => pair.length === 2));
  const ts = Number(parts.ts);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.ts}:${raw}`).digest('hex');
  const given = String(header).split(';').filter((part) => part.startsWith('h1=')).map((part) => part.slice(3));
  return given.some((h1) => h1.length === expected.length && crypto.timingSafeEqual(Buffer.from(h1), Buffer.from(expected)));
}

function userForPaddle(data) {
  const custom = data?.custom_data || {};
  if (custom.userId && db.getUserById(String(custom.userId))) return db.getUserById(String(custom.userId));
  const txn = data?.transaction_id || (String(data?.id || '').startsWith('txn_') ? data.id : null);
  if (txn) {
    const row = sql().prepare('SELECT user_id FROM billing_checkouts WHERE transaction_id = ?').get(txn);
    if (row) return db.getUserById(row.user_id);
  }
  if (data?.subscription_id) {
    const row = sql().prepare('SELECT user_id FROM billing_subscriptions WHERE subscription_id = ?').get(data.subscription_id);
    if (row) return db.getUserById(row.user_id);
  }
  if (data?.customer_id) {
    const row = sql().prepare('SELECT user_id FROM billing_customer_ids WHERE customer_id = ?').get(data.customer_id);
    if (row) return db.getUserById(row.user_id);
  }
  return null;
}

const planOf = (priceId) => {
  for (const name of ENVS) {
    const { prices } = config(name);
    if (priceId && priceId === prices.monthly) return 'monthly';
    if (priceId && priceId === prices.yearly) return 'yearly';
  }
  return null;
};

function onTransactionCompleted(data, name) {
  const user = userForPaddle(data);
  if (!user) return { ignored: 'no matching user' };
  const custom = data.custom_data || {};
  const checkout = sql().prepare('SELECT * FROM billing_checkouts WHERE transaction_id = ?').get(data.id) || {};
  const kind = data.subscription_id || custom.kind === 'plus' || checkout.kind === 'plus' ? 'plus' : (custom.kind || checkout.kind || 'cape');
  const itemId = kind === 'cape' ? String(custom.itemId || checkout.item_id || '')
    : kind === 'bundle' ? bundleIds(custom.itemIds || checkout.item_id).join(',') || null
    : null;
  const bundleId = kind === 'bundle' ? (String(custom.bundleId || checkout.bundle_id || '') || null) : null;
  const plan = kind === 'plus' ? (planOf(data.items?.[0]?.price?.id) || custom.plan || checkout.plan || null) : null;
  const totals = data.details?.totals || {};
  const now = Date.now();
  sql().prepare(`INSERT OR IGNORE INTO billing_purchases
    (transaction_id, user_id, kind, item_id, plan, amount_cents, currency, status, subscription_id, customer_id, created_at, updated_at, environment, bundle_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?)`).run(
    data.id, String(user.id), kind, itemId, plan, Number(totals.grand_total || totals.total || 0), String(data.currency_code || totals.currency_code || 'USD'),
    data.subscription_id || null, data.customer_id || null, toMs(data.billed_at) || now, now, name, bundleId);
  if (data.customer_id) {
    sql().prepare('INSERT OR IGNORE INTO billing_customer_ids (user_id, environment, customer_id, created_at) VALUES (?, ?, ?, ?)').run(String(user.id), name, data.customer_id, now);
  }
  if (kind === 'cape' && itemId) {
    grantItem(user.id, itemId, 'purchase');
    notify(user);
  }
  if (kind === 'bundle' && itemId) {
    for (const id of bundleIds(itemId)) grantItem(user.id, id, 'purchase');
    // remember which line item is which piece, so a partial refund only takes back what was refunded
    const prices = new Map((data.items || []).map((line) => [line.price?.id, line.price?.custom_data?.itemId]));
    const insert = sql().prepare('INSERT OR IGNORE INTO billing_bundle_lines (transaction_id, line_id, item_id) VALUES (?, ?, ?)');
    for (const line of data.details?.line_items || []) {
      const id = prices.get(line.price_id);
      if (line.id && id) insert.run(data.id, line.id, String(id));
    }
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

/** Item ids of a bundle (array or comma-separated), unique, at most 12. */
function bundleIds(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(list.map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 12);
}

function onSubscription(data, name) {
  const user = userForPaddle(data);
  if (!user) return { ignored: 'no matching user' };
  const now = Date.now();
  const cancelAt = data.scheduled_change?.action === 'cancel' ? toMs(data.scheduled_change.effective_at) : null;
  sql().prepare(`INSERT INTO billing_subscriptions (subscription_id, user_id, status, plan, current_period_end, cancel_at, customer_id, created_at, updated_at, environment)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(subscription_id) DO UPDATE SET status = excluded.status, plan = COALESCE(excluded.plan, billing_subscriptions.plan),
      current_period_end = excluded.current_period_end, cancel_at = excluded.cancel_at, updated_at = excluded.updated_at`).run(
    data.id, String(user.id), String(data.status || 'active'), planOf(data.items?.[0]?.price?.id),
    toMs(data.current_billing_period?.ends_at), cancelAt, data.customer_id || null, toMs(data.created_at) || now, now, name);
  syncPlus(user.id);
  return { ok: true };
}

function onAdjustment(data) {
  if (!['refund', 'chargeback', 'chargeback_warning'].includes(data.action)) return { ignored: data.action };
  if (data.status !== 'approved') return { ignored: `status ${data.status}` };
  const purchase = sql().prepare('SELECT * FROM billing_purchases WHERE transaction_id = ?').get(data.transaction_id);
  if (!purchase) return { ignored: 'unknown transaction' };
  const status = data.action === 'refund' ? 'refunded' : 'chargeback';
  sql().prepare('UPDATE billing_purchases SET status = ?, updated_at = ? WHERE transaction_id = ?').run(status, Date.now(), purchase.transaction_id);
  let ids = [];
  if (purchase.kind === 'cape' && purchase.item_id) ids = [purchase.item_id];
  if (purchase.kind === 'bundle' && purchase.item_id) {
    // a partial refund lists the refunded line items; take back only those pieces
    const lines = (data.items || []).map((entry) => entry.item_id).filter(Boolean);
    const mapped = lines.map((line) => sql().prepare('SELECT item_id FROM billing_bundle_lines WHERE transaction_id = ? AND line_id = ?').get(purchase.transaction_id, line)?.item_id).filter(Boolean);
    ids = data.type === 'partial' && mapped.length ? mapped : bundleIds(purchase.item_id);
  }
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

function handleEvent(event, name = activeEnv()) {
  const id = String(event?.event_id || '');
  const type = String(event?.event_type || '');
  if (id) {
    const seen = sql().prepare('INSERT OR IGNORE INTO billing_events (event_id, type, received_at) VALUES (?, ?, ?)').run(id, type, Date.now());
    if (!seen.changes) return { duplicate: true };
  }
  if (type === 'transaction.completed') return onTransactionCompleted(event.data || {}, name);
  if (type.startsWith('subscription.')) return onSubscription(event.data || {}, name);
  if (type.startsWith('adjustment.')) return onAdjustment(event.data || {});
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

  if (req.method === 'POST' && url.pathname === '/v1/billing/paddle/webhook') {
    let raw = '';
    try { raw = await readRaw(req); } catch { send(res, 413, { ok: false }); return true; }
    // Sandbox and live both post here; the secret that matches tells us which one sent it.
    const from = ENVS.find((name) => verifySignature(raw, req.headers['paddle-signature'], config(name).webhookSecret));
    if (!from) {
      send(res, 401, { ok: false, error: 'Bad signature.' });
      return true;
    }
    if (from === 'sandbox' && activeEnv() === 'production') {
      send(res, 200, { ok: true, ignored: 'sandbox event while live' }); // never grant real things for test payments
      return true;
    }
    let event = null;
    try { event = JSON.parse(raw); } catch { send(res, 400, { ok: false, error: 'Bad JSON.' }); return true; }
    try {
      const result = handleEvent(event, from);
      send(res, 200, { ok: true, ...result });
    } catch (error) {
      console.error('[Native Billing] webhook failed:', error);
      send(res, 500, { ok: false, error: 'Webhook failed.' }); // Paddle retries
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/v1/billing/config') {
    send(res, 200, {
      ok: true,
      enabled: enabled(),
      environment: c.environment,
      clientToken: enabled() ? c.clientToken : null,
      plus: {
        monthly: { amount: PLANS.monthly.amount, currency: 'USD', available: Boolean(c.prices.monthly) },
        yearly: { amount: PLANS.yearly.amount, currency: 'USD', available: Boolean(c.prices.yearly) }
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
    send(res, 200, { ok: true, enabled: enabled(), plus: publicPlus(plusFor(user.id)), purchases: purchasesOf(user.id) }, noStore);
    return true;
  }

  if (!enabled()) { send(res, 503, { ok: false, error: 'Payments aren’t switched on yet.' }); return true; }

  if (req.method === 'POST' && url.pathname === '/v1/billing/checkout') {
    if (!hit('billing-checkout', user.id, 20, 10 * 60_000)) { tooMany(res, 600); return true; }
    if (site().storeLocked() && !user.is_admin) { send(res, 423, { ok: false, locked: true, error: 'The Native store opens at launch.' }); return true; }
    const body = await ctx.readJson(req);
    const kind = body.kind === 'plus' ? 'plus' : body.kind === 'bundle' ? 'bundle' : 'cape';
    let items;
    let custom;
    const lineFor = (item) => ({
      quantity: 1,
      price: {
        name: item.name,
        description: `${item.name} for Native`,
        product_id: c.capeProduct,
        unit_price: { amount: String(Math.round(site().priceOf(item) * 100)), currency_code: 'USD' },
        quantity: { minimum: 1, maximum: 1 },
        custom_data: { itemId: item.id }
      }
    });
    if (kind === 'bundle' && body.bundleId) {
      const bundle = hooks.findBundle ? hooks.findBundle(String(body.bundleId)) : null;
      const q = bundle && hooks.quoteBundle ? hooks.quoteBundle(bundle, user.id) : null;
      if (!bundle || bundle.hidden || !q || q.items.length < 2) { send(res, 404, { ok: false, error: 'That bundle isn’t for sale.' }); return true; }
      if (hooks.bundleOnSale && !hooks.bundleOnSale(bundle, q)) { send(res, 410, { ok: false, error: `${bundle.name} isn’t available any more.` }); return true; }
      if (!q.lines.length) { send(res, 400, { ok: false, error: q.missing.length ? 'Everything you’re missing in this bundle is free. Add it to your locker instead.' : 'You already own everything in this bundle.' }); return true; }
      items = q.lines.map(({ item, cents }) => ({
        quantity: 1,
        price: {
          name: `${item.name} (${bundle.name})`,
          description: `${item.name}, part of the ${bundle.name} bundle for Native`,
          product_id: c.capeProduct,
          unit_price: { amount: String(cents), currency_code: 'USD' },
          quantity: { minimum: 1, maximum: 1 },
          custom_data: { itemId: item.id, bundleId: bundle.id }
        }
      }));
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
      items = list.map(lineFor);
      custom = { userId: String(user.id), kind: list.length === 1 ? 'cape' : 'bundle', itemId: list.length === 1 ? list[0].id : undefined, itemIds: list.map((item) => item.id).join(',') };
      if (list.length === 1) delete custom.itemIds;
    } else if (kind === 'cape') {
      const item = ctx.findItem(String(body.itemId || ''));
      if (!item || item.hidden) { send(res, 404, { ok: false, error: 'That cloak isn’t for sale.' }); return true; }
      if (item.exclusive) { send(res, 403, { ok: false, error: `${item.name} is an event cloak. It can’t be bought.` }); return true; }
      if (!isPaid(item)) { send(res, 400, { ok: false, error: `${item.name} is free. Add it to your locker instead.` }); return true; }
      if (ownedSource(user.id, item.id) && ownedSource(user.id, item.id) !== 'plus') { send(res, 409, { ok: false, error: `${item.name} is already yours.` }); return true; }
      items = [{
        quantity: 1,
        price: {
          name: item.name,
          description: `${item.name} cape for Native`,
          product_id: c.capeProduct,
          unit_price: { amount: String(Math.round(site().priceOf(item) * 100)), currency_code: 'USD' },
          quantity: { minimum: 1, maximum: 1 },
          custom_data: { itemId: item.id }
        }
      }];
      custom = { userId: String(user.id), kind, itemId: item.id };
    } else {
      const plan = body.plan === 'yearly' ? 'yearly' : 'monthly';
      if (!c.prices[plan]) { send(res, 503, { ok: false, error: 'Native+ isn’t available yet.' }); return true; }
      if (hasPlus(user.id)) { send(res, 409, { ok: false, error: 'You’re already a Native+ member.' }); return true; }
      items = [{ price_id: c.prices[plan], quantity: 1 }];
      custom = { userId: String(user.id), kind, plan };
    }
    try {
      const customerId = await customerFor(user);
      const txn = await paddle('POST', '/transactions', { items, customer_id: customerId, custom_data: custom, collection_mode: 'automatic' });
      sql().prepare('INSERT OR REPLACE INTO billing_checkouts (transaction_id, user_id, kind, item_id, plan, created_at, bundle_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(txn.id, String(user.id), custom.kind, custom.itemId || custom.itemIds || null, custom.plan || null, Date.now(), custom.bundleId || null);
      send(res, 200, { ok: true, transactionId: txn.id, url: txn.checkout?.url || null }, noStore);
    } catch (error) {
      console.error('[Native Billing] checkout failed:', error.message);
      send(res, 502, { ok: false, error: 'Couldn’t start the checkout. Try again in a moment.' });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/v1/billing/portal') {
    if (!hit('billing-portal', user.id, 20, 10 * 60_000)) { tooMany(res, 600); return true; }
    const row = customerRow(user.id);
    if (!row) { send(res, 404, { ok: false, error: 'You haven’t bought anything yet.' }); return true; }
    try {
      const plus = plusFor(user.id);
      const session = await paddle('POST', `/customers/${row.customer_id}/portal-sessions`, plus.subscriptionId && plus.active ? { subscription_ids: [plus.subscriptionId] } : {});
      send(res, 200, {
        ok: true,
        url: session.urls?.general?.overview || null,
        cancelUrl: session.urls?.subscriptions?.[0]?.cancel_subscription || null
      }, noStore);
    } catch (error) {
      console.error('[Native Billing] portal failed:', error.message);
      send(res, 502, { ok: false, error: 'Couldn’t open billing. Try again in a moment.' });
    }
    return true;
  }

  send(res, 404, { ok: false, error: 'Not found.' });
  return true;
}

/* ── admin: Paddle settings + one-click setup ─────────────────────── */

const hint = (value) => (value ? `…${value.slice(-4)}` : null);
function publicSettings() {
  const saved = savedSettings();
  const envs = {};
  for (const name of ENVS) {
    const c = config(name);
    envs[name] = {
      apiKey: hint(c.apiKey), // never the key itself
      clientToken: c.clientToken || null, // public by design (it ships in the page)
      webhookSecret: Boolean(c.webhookSecret),
      capeProduct: c.capeProduct || null,
      plusProduct: c.plusProduct || null,
      monthlyPrice: c.prices.monthly || null,
      yearlyPrice: c.prices.yearly || null,
      notificationId: c.notificationId || null,
      fromEnvFile: name === envDefault() && !saved[`${name}.apiKey`] && Boolean(env('PADDLE_API_KEY')),
      ready: readyIn(c)
    };
  }
  return { active: activeEnv(), webhookUrl: WEBHOOK_URL(), environments: envs };
}

async function listAll(name, pathname) {
  const out = [];
  let next = `${pathname}${pathname.includes('?') ? '&' : '?'}per_page=200`;
  for (let page = 0; page < 10 && next; page += 1) {
    const response = await fetch(`${apiBase(name)}${next}`, { headers: { Authorization: `Bearer ${config(name).apiKey}` }, signal: AbortSignal.timeout(15_000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload?.error?.detail || `Paddle request failed (${response.status}).`), { status: response.status });
    out.push(...(payload.data || []));
    const nextUrl = payload.meta?.pagination?.has_more ? payload.meta.pagination.next : null;
    next = nextUrl ? nextUrl.replace(/^https:\/\/[^/]+/, '') : null;
  }
  return out;
}

/** Finds or creates everything Native needs in one Paddle environment and saves the ids. */
async function setupPaddle(name) {
  const steps = [];
  const c = config(name);
  const call = (method, pathname, body) => paddle(method, pathname, body, name);
  const products = await listAll(name, '/products?status=active');
  const product = async (field, tag, spec) => {
    let found = (c[field] && products.find((p) => p.id === c[field])) || products.find((p) => p.custom_data?.native === tag || p.custom_data?.noctra === tag) || products.find((p) => p.name === spec.name);
    if (!found) { found = await call('POST', '/products', { ...spec, custom_data: { native: tag } }); steps.push(`Created product ${spec.name}`); }
    else steps.push(`Found product ${found.name}`);
    saveSetting(`${name}.${field}`, found.id);
    return found.id;
  };
  await product('capeProduct', 'cape', { name: 'Native cape', description: 'A cosmetic cape for your Native account.', tax_category: 'standard' });
  const plusId = await product('plusProduct', 'plus', { name: 'Native+', description: 'Every paid Native cape and the Native+ badge while subscribed.', tax_category: 'standard' });

  const prices = await listAll(name, `/prices?product_id=${plusId}&status=active`);
  for (const plan of ['monthly', 'yearly']) {
    const field = plan === 'monthly' ? 'monthlyPrice' : 'yearlyPrice';
    const cents = String(Math.round(PLANS[plan].amount * 100));
    let found = (c.prices[plan] && prices.find((p) => p.id === c.prices[plan] && p.unit_price?.amount === cents))
      || prices.find((p) => p.billing_cycle?.interval === PLANS[plan].interval && p.billing_cycle?.frequency === 1 && p.unit_price?.amount === cents && p.unit_price?.currency_code === 'USD');
    if (!found) {
      found = await call('POST', '/prices', {
        product_id: plusId, name: `Native+ ${plan}`, description: `Native+ — billed ${plan}`,
        unit_price: { amount: cents, currency_code: 'USD' }, billing_cycle: { interval: PLANS[plan].interval, frequency: 1 },
        quantity: { minimum: 1, maximum: 1 }, custom_data: { native: `plus-${plan}` }
      });
      steps.push(`Created ${plan} price $${PLANS[plan].amount}`);
    } else {
      if (found.quantity?.maximum !== 1) await call('PATCH', `/prices/${found.id}`, { quantity: { minimum: 1, maximum: 1 } });
      steps.push(`Found ${plan} price $${PLANS[plan].amount}`);
    }
    saveSetting(`${name}.${field}`, found.id);
  }

  const destination = WEBHOOK_URL();
  const settings = await call('GET', '/notification-settings');
  let hook = (settings || []).find((n) => n.destination === destination && n.type === 'url');
  if (hook) {
    const have = new Set((hook.subscribed_events || []).map((e) => e.name || e));
    if (WEBHOOK_EVENTS.some((e) => !have.has(e)) || !hook.active) {
      hook = await call('PATCH', `/notification-settings/${hook.id}`, { active: true, subscribed_events: [...new Set([...have, ...WEBHOOK_EVENTS])] });
    }
    steps.push('Found webhook');
  } else {
    hook = await call('POST', '/notification-settings', { description: 'Native server', destination, type: 'url', subscribed_events: WEBHOOK_EVENTS, api_version: 1, include_sensitive_fields: false, traffic_source: 'platform' });
    steps.push('Created webhook');
  }
  saveSetting(`${name}.notificationId`, hook.id);
  if (hook.endpoint_secret_key) saveSetting(`${name}.webhookSecret`, hook.endpoint_secret_key);
  return steps;
}

async function handleAdmin(req, res, ctx, url, user) {
  const { send } = ctx;
  const noStore = { 'Cache-Control': 'no-store' };
  if (!user) { send(res, 401, { ok: false, error: 'Native account session required.' }); return true; }
  if (!user.is_admin) { send(res, 403, { ok: false, error: 'Administrator access required.' }); return true; }
  const nameOf = (id) => { try { return db.getUserById(id)?.username || null; } catch { return null; } };

  if (req.method === 'GET' && url.pathname === '/v1/admin/billing/overview') {
    const since = Date.now() - 30 * 86_400_000;
    const inEnv = `COALESCE(environment, '${envDefault()}') = '${activeEnv()}'`; // both values are from ENVS
    const one = (query, ...args) => sql().prepare(query).get(...args) || {};
    const paid = one(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM billing_purchases WHERE status = 'paid' AND ${inEnv}`);
    const recent30 = one(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM billing_purchases WHERE status = 'paid' AND created_at >= ? AND ${inEnv}`, since);
    const refunds = one(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM billing_purchases WHERE status != 'paid' AND ${inEnv}`);
    const members = sql().prepare(`SELECT plan, COUNT(*) AS n FROM billing_subscriptions WHERE status IN ('active', 'trialing', 'past_due') AND ${inEnv} GROUP BY plan`).all();
    const gifted = one(`SELECT COUNT(*) AS n FROM plus_grants WHERE (expires_at IS NULL OR expires_at > ?) AND user_id NOT IN (SELECT user_id FROM billing_subscriptions WHERE status IN ('active', 'trialing', 'past_due') AND ${inEnv})`, Date.now()).n || 0;
    const recent = sql().prepare('SELECT * FROM billing_purchases ORDER BY created_at DESC LIMIT 25').all().map((row) => ({
      transactionId: row.transaction_id, userId: row.user_id, username: nameOf(row.user_id), kind: row.kind, itemId: row.item_id,
      itemName: row.kind === 'bundle' && row.bundle_id && hooks.findBundle?.(row.bundle_id) ? `${hooks.findBundle(row.bundle_id).name} bundle` : row.kind === 'bundle' ? bundleIds(row.item_id).map((id) => ctx.findItem(id)?.name || id).join(', ') : row.item_id && ctx.findItem(row.item_id) ? ctx.findItem(row.item_id).name : null, plan: row.plan,
      amount: row.amount_cents / 100, currency: row.currency, status: row.status, createdAt: row.created_at,
      environment: row.environment || envDefault()
    }));
    send(res, 200, {
      ok: true,
      enabled: enabled(),
      environment: config().environment,
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
      const name = ENVS.includes(body.environment) ? body.environment : null;
      if (!name) { send(res, 400, { ok: false, error: 'Pick sandbox or live.' }); return true; }
      const clean = (value, re) => {
        const text = String(value ?? '').trim();
        if (!text) return null;
        if (!re.test(text)) throw new Error('bad');
        return text;
      };
      const live = name === 'production';
      const rules = {
        apiKey: live ? /^pdl_live_apikey_[A-Za-z0-9_]{20,200}$/ : /^pdl_sdbx_apikey_[A-Za-z0-9_]{20,200}$/,
        clientToken: live ? /^live_[a-f0-9]{20,64}$/ : /^test_[a-f0-9]{20,64}$/,
        webhookSecret: /^pdl_ntfset_[A-Za-z0-9_]{10,200}$/
      };
      const labels = { apiKey: 'API key', clientToken: 'client-side token', webhookSecret: 'webhook secret' };
      for (const field of Object.keys(rules)) {
        let value;
        try { value = clean(body[field], rules[field]); } catch {
          send(res, 400, { ok: false, error: `That ${labels[field]} doesn’t look like a ${live ? 'live' : 'sandbox'} Paddle ${labels[field]}.` });
          return true;
        }
        if (value) saveSetting(`${name}.${field}`, value);
      }
      for (const field of Array.isArray(body.clear) ? body.clear : []) {
        if (FIELDS[field]) saveSetting(`${name}.${field}`, null);
      }
      console.log(`[Native Billing] ${user.username} updated ${name} Paddle settings`);
    }
    send(res, 200, { ok: true, settings: publicSettings() }, noStore);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/v1/admin/billing/setup') {
    const body = await ctx.readJson(req);
    const name = ENVS.includes(body.environment) ? body.environment : null;
    if (!name) { send(res, 400, { ok: false, error: 'Pick sandbox or live.' }); return true; }
    if (!config(name).apiKey) { send(res, 400, { ok: false, error: 'Save an API key for this environment first.' }); return true; }
    try {
      const steps = await setupPaddle(name);
      console.log(`[Native Billing] ${user.username} ran Paddle setup for ${name}`);
      send(res, 200, { ok: true, steps, settings: publicSettings() }, noStore);
    } catch (error) {
      console.error('[Native Billing] setup failed:', error.message);
      send(res, error.status === 401 || error.status === 403 ? 400 : 502, { ok: false, error: error.status === 401 || error.status === 403 ? 'Paddle rejected that API key. Check it has read and write permissions for products, prices, customers, transactions, subscriptions and notification settings.' : `Paddle setup failed: ${error.message}` });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/v1/admin/billing/activate') {
    const body = await ctx.readJson(req);
    const name = ENVS.includes(body.environment) ? body.environment : null;
    if (!name) { send(res, 400, { ok: false, error: 'Pick sandbox or live.' }); return true; }
    if (!readyIn(config(name))) { send(res, 400, { ok: false, error: `Finish ${name === 'production' ? 'live' : 'sandbox'} setup first (keys + Set up Paddle).` }); return true; }
    saveSetting('active', name);
    console.log(`[Native Billing] ${user.username} switched checkouts to ${name}`);
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
  verifySignature, handleEvent, redeem, enabled, config, activeEnv, publicSettings, saveSetting
};
