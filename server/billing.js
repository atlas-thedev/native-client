/**
 * Noctra billing: Paddle Billing checkout, webhooks, Noctra+ and redeem codes.
 *
 *   GET  /v1/billing/config                 public: is billing on, Paddle client token, prices
 *   POST /v1/billing/checkout               { kind: 'cape', itemId } | { kind: 'plus', plan: 'monthly'|'yearly' } -> { url }
 *   GET  /v1/billing/me                     Noctra+ status and purchases of the signed-in account
 *   POST /v1/billing/portal                 Paddle customer portal link (receipts, cancel Noctra+)
 *   POST /v1/billing/paddle/webhook         Paddle notifications (signature checked)
 *   POST /v1/store/redeem                   { code } event / gift codes
 *   GET  /v1/admin/billing/overview         sales, refunds, members
 *   GET|POST /v1/admin/billing/codes        list / create redeem codes
 *   DELETE   /v1/admin/billing/codes/:code  delete a redeem code
 *
 * How things are owned (all in store_owned):
 *   source 'purchase'  bought once, kept forever (removed again on refund / chargeback)
 *   source 'plus'      added while a Noctra+ member; removed when the membership ends
 *   source 'code'      redeemed with an event code
 *   source 'admin'     given by an admin
 *
 * Environment: PADDLE_ENV (sandbox|production), PADDLE_API_KEY, PADDLE_CLIENT_TOKEN,
 * PADDLE_WEBHOOK_SECRET, PADDLE_CAPE_PRODUCT, PADDLE_PLUS_MONTHLY_PRICE, PADDLE_PLUS_YEARLY_PRICE.
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

const env = (name) => String(process.env[name] || '').trim();
const config = () => ({
  environment: env('PADDLE_ENV') === 'production' ? 'production' : 'sandbox',
  apiKey: env('PADDLE_API_KEY'),
  clientToken: env('PADDLE_CLIENT_TOKEN'),
  webhookSecret: env('PADDLE_WEBHOOK_SECRET'),
  capeProduct: env('PADDLE_CAPE_PRODUCT'),
  prices: { monthly: env(PLANS.monthly.env), yearly: env(PLANS.yearly.env) }
});
const enabled = () => {
  const c = config();
  return Boolean(c.apiKey && c.clientToken && c.webhookSecret && c.capeProduct);
};
const apiBase = () => (config().environment === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com');

/* ── database ──────────────────────────────────────────────────────── */

let ready = false;
function sql() {
  const handle = db.getDb();
  if (!ready) {
    handle.exec(`
      CREATE TABLE IF NOT EXISTS store_owned (
        user_id TEXT NOT NULL, item_id TEXT NOT NULL, acquired_at INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'free', PRIMARY KEY (user_id, item_id)
      );
      CREATE TABLE IF NOT EXISTS billing_customers (
        user_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
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
      CREATE TABLE IF NOT EXISTS redeem_uses (
        code TEXT NOT NULL, user_id TEXT NOT NULL, used_at INTEGER NOT NULL, PRIMARY KEY (code, user_id)
      );
    `);
    ready = true;
  }
  return handle;
}

const toMs = (value) => {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
};

/* ── entitlements ──────────────────────────────────────────────────── */

function plusFor(userId) {
  const rows = sql().prepare('SELECT * FROM billing_subscriptions WHERE user_id = ? ORDER BY updated_at DESC').all(String(userId));
  const live = rows.find((row) => PLUS_ACTIVE.has(row.status)) || null;
  const latest = live || rows[0] || null;
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

/** A cape you pay for (or get with Noctra+). Event capes are never sold. */
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
let hooks = { readProfile: null, saveProfile: null, findItem: null };
function setHooks(next) { hooks = { ...hooks, ...next }; }

function takeOffIfWearing(user, itemIds) {
  if (!hooks.readProfile || !hooks.saveProfile || !user) return;
  const profile = hooks.readProfile(user.username);
  if (profile && profile.capeStore && itemIds.includes(profile.capeStore)) {
    hooks.saveProfile({ ...profile, cape: null, capeAnim: null, capeStore: null, updatedAt: new Date().toISOString() }, null, user);
  }
}

function setPlusBadge(userId, on) {
  try { db.setUserBadge(userId, 'plus', on); } catch { /* badge list may be older */ }
}

/** Brings a member's locker and badge in line with their Noctra+ status. */
function syncPlus(userId) {
  const user = db.getUserById(userId);
  if (!user) return;
  const active = hasPlus(userId);
  setPlusBadge(userId, active);
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

function notify(user) {
  if (!user) return;
  const profile = hooks.readProfile ? hooks.readProfile(user.username) : null;
  events.publish(user.id, 'wardrobe:changed', { userId: user.id, name: user.username, capeStore: profile?.capeStore || null, owned: true });
  events.publish(user.id, 'billing:changed', { userId: user.id });
}

/* ── Paddle API ────────────────────────────────────────────────────── */

async function paddle(method, pathname, body) {
  const response = await fetch(`${apiBase()}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${config().apiKey}`, 'Content-Type': 'application/json' },
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

async function customerFor(user) {
  const row = sql().prepare('SELECT customer_id FROM billing_customers WHERE user_id = ?').get(String(user.id));
  if (row) return row.customer_id;
  let id = null;
  try {
    id = (await paddle('POST', '/customers', { email: user.email, name: user.username, custom_data: { noctraUserId: String(user.id) } })).id;
  } catch (error) {
    const match = error.code === 'customer_already_exists' && /ctm_[a-z0-9]+/i.exec(error.message);
    if (!match) throw error;
    id = match[0];
  }
  sql().prepare('INSERT OR REPLACE INTO billing_customers (user_id, customer_id, created_at) VALUES (?, ?, ?)').run(String(user.id), id, Date.now());
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
    const row = sql().prepare('SELECT user_id FROM billing_customers WHERE customer_id = ?').get(data.customer_id);
    if (row) return db.getUserById(row.user_id);
  }
  return null;
}

const planOf = (priceId) => {
  const { prices } = config();
  if (priceId && priceId === prices.monthly) return 'monthly';
  if (priceId && priceId === prices.yearly) return 'yearly';
  return null;
};

function onTransactionCompleted(data) {
  const user = userForPaddle(data);
  if (!user) return { ignored: 'no matching user' };
  const custom = data.custom_data || {};
  const checkout = sql().prepare('SELECT * FROM billing_checkouts WHERE transaction_id = ?').get(data.id) || {};
  const kind = data.subscription_id || custom.kind === 'plus' || checkout.kind === 'plus' ? 'plus' : (custom.kind || checkout.kind || 'cape');
  const itemId = kind === 'cape' ? String(custom.itemId || checkout.item_id || '') : null;
  const plan = kind === 'plus' ? (planOf(data.items?.[0]?.price?.id) || custom.plan || checkout.plan || null) : null;
  const totals = data.details?.totals || {};
  const now = Date.now();
  sql().prepare(`INSERT OR IGNORE INTO billing_purchases
    (transaction_id, user_id, kind, item_id, plan, amount_cents, currency, status, subscription_id, customer_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?, ?, ?)`).run(
    data.id, String(user.id), kind, itemId, plan, Number(totals.grand_total || totals.total || 0), String(data.currency_code || totals.currency_code || 'USD'),
    data.subscription_id || null, data.customer_id || null, toMs(data.billed_at) || now, now);
  if (data.customer_id) {
    sql().prepare('INSERT OR IGNORE INTO billing_customers (user_id, customer_id, created_at) VALUES (?, ?, ?)').run(String(user.id), data.customer_id, now);
  }
  if (kind === 'cape' && itemId) {
    grantItem(user.id, itemId, 'purchase');
    notify(user);
  }
  return { ok: true };
}

function onSubscription(data) {
  const user = userForPaddle(data);
  if (!user) return { ignored: 'no matching user' };
  const now = Date.now();
  const cancelAt = data.scheduled_change?.action === 'cancel' ? toMs(data.scheduled_change.effective_at) : null;
  sql().prepare(`INSERT INTO billing_subscriptions (subscription_id, user_id, status, plan, current_period_end, cancel_at, customer_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(subscription_id) DO UPDATE SET status = excluded.status, plan = COALESCE(excluded.plan, billing_subscriptions.plan),
      current_period_end = excluded.current_period_end, cancel_at = excluded.cancel_at, updated_at = excluded.updated_at`).run(
    data.id, String(user.id), String(data.status || 'active'), planOf(data.items?.[0]?.price?.id),
    toMs(data.current_billing_period?.ends_at), cancelAt, data.customer_id || null, toMs(data.created_at) || now, now);
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
  if (purchase.kind === 'cape' && purchase.item_id && ownedSource(purchase.user_id, purchase.item_id) === 'purchase') {
    sql().prepare('DELETE FROM store_owned WHERE user_id = ? AND item_id = ?').run(purchase.user_id, purchase.item_id);
    if (hasPlus(purchase.user_id)) grantItem(purchase.user_id, purchase.item_id, 'plus');
    const user = db.getUserById(purchase.user_id);
    if (!hasPlus(purchase.user_id)) takeOffIfWearing(user, [purchase.item_id]);
    notify(user);
  }
  return { ok: true };
}

function handleEvent(event) {
  const id = String(event?.event_id || '');
  const type = String(event?.event_type || '');
  if (id) {
    const seen = sql().prepare('INSERT OR IGNORE INTO billing_events (event_id, type, received_at) VALUES (?, ?, ?)').run(id, type, Date.now());
    if (!seen.changes) return { duplicate: true };
  }
  if (type === 'transaction.completed') return onTransactionCompleted(event.data || {});
  if (type.startsWith('subscription.')) return onSubscription(event.data || {});
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
  if (!item) return { status: 410, error: 'The cape for this code is gone.' };
  const take = sql().prepare('UPDATE redeem_codes SET uses = uses + 1 WHERE code = ? AND uses < max_uses').run(code);
  if (!take.changes) return { status: 410, error: 'That code has been fully used.' };
  sql().prepare('INSERT INTO redeem_uses (code, user_id, used_at) VALUES (?, ?, ?)').run(code, String(user.id), Date.now());
  grantItem(user.id, item.id, 'code');
  notify(user);
  return { status: 200, item: { id: item.id, name: item.name } };
}

/* ── http ──────────────────────────────────────────────────────────── */

const bearerOf = (req) => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  || String(req.headers['x-noctra-token'] || '').trim();

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
    transactionId: row.transaction_id, kind: row.kind, itemId: row.item_id, plan: row.plan,
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
  const { send, hit, tooMany, ip } = ctx;
  const noStore = { 'Cache-Control': 'no-store' };
  const c = config();

  if (req.method === 'POST' && url.pathname === '/v1/billing/paddle/webhook') {
    let raw = '';
    try { raw = await readRaw(req); } catch { send(res, 413, { ok: false }); return true; }
    if (!verifySignature(raw, req.headers['paddle-signature'], c.webhookSecret)) {
      send(res, 401, { ok: false, error: 'Bad signature.' });
      return true;
    }
    let event = null;
    try { event = JSON.parse(raw); } catch { send(res, 400, { ok: false, error: 'Bad JSON.' }); return true; }
    try {
      const result = handleEvent(event);
      send(res, 200, { ok: true, ...result });
    } catch (error) {
      console.error('[Noctra Billing] webhook failed:', error);
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

  if (!user) { send(res, 401, { ok: false, error: 'Sign in with your Noctra account first.' }); return true; }

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
    const body = await ctx.readJson(req);
    const kind = body.kind === 'plus' ? 'plus' : 'cape';
    let items;
    let custom;
    if (kind === 'cape') {
      const item = ctx.findItem(String(body.itemId || ''));
      if (!item || item.hidden) { send(res, 404, { ok: false, error: 'That cape isn’t for sale.' }); return true; }
      if (item.exclusive) { send(res, 403, { ok: false, error: `${item.name} is an event cape. It can’t be bought.` }); return true; }
      if (!isPaid(item)) { send(res, 400, { ok: false, error: `${item.name} is free. Add it to your locker instead.` }); return true; }
      if (ownedSource(user.id, item.id) && ownedSource(user.id, item.id) !== 'plus') { send(res, 409, { ok: false, error: `${item.name} is already yours.` }); return true; }
      items = [{
        quantity: 1,
        price: {
          name: item.name,
          description: `${item.name} cape for Noctra`,
          product_id: c.capeProduct,
          unit_price: { amount: String(Math.round(Number(item.price) * 100)), currency_code: 'USD' },
          custom_data: { itemId: item.id }
        }
      }];
      custom = { userId: String(user.id), kind, itemId: item.id };
    } else {
      const plan = body.plan === 'yearly' ? 'yearly' : 'monthly';
      if (!c.prices[plan]) { send(res, 503, { ok: false, error: 'Noctra+ isn’t available yet.' }); return true; }
      if (hasPlus(user.id)) { send(res, 409, { ok: false, error: 'You’re already a Noctra+ member.' }); return true; }
      items = [{ price_id: c.prices[plan], quantity: 1 }];
      custom = { userId: String(user.id), kind, plan };
    }
    try {
      const customerId = await customerFor(user);
      const txn = await paddle('POST', '/transactions', { items, customer_id: customerId, custom_data: custom, collection_mode: 'automatic' });
      sql().prepare('INSERT OR REPLACE INTO billing_checkouts (transaction_id, user_id, kind, item_id, plan, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(txn.id, String(user.id), kind, custom.itemId || null, custom.plan || null, Date.now());
      send(res, 200, { ok: true, transactionId: txn.id, url: txn.checkout?.url || null }, noStore);
    } catch (error) {
      console.error('[Noctra Billing] checkout failed:', error.message);
      send(res, 502, { ok: false, error: 'Couldn’t start the checkout. Try again in a moment.' });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/v1/billing/portal') {
    if (!hit('billing-portal', user.id, 20, 10 * 60_000)) { tooMany(res, 600); return true; }
    const row = sql().prepare('SELECT customer_id FROM billing_customers WHERE user_id = ?').get(String(user.id));
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
      console.error('[Noctra Billing] portal failed:', error.message);
      send(res, 502, { ok: false, error: 'Couldn’t open billing. Try again in a moment.' });
    }
    return true;
  }

  send(res, 404, { ok: false, error: 'Not found.' });
  return true;
}

async function handleAdmin(req, res, ctx, url, user) {
  const { send } = ctx;
  const noStore = { 'Cache-Control': 'no-store' };
  if (!user) { send(res, 401, { ok: false, error: 'Noctra account session required.' }); return true; }
  if (!user.is_admin) { send(res, 403, { ok: false, error: 'Administrator access required.' }); return true; }
  const nameOf = (id) => { try { return db.getUserById(id)?.username || null; } catch { return null; } };

  if (req.method === 'GET' && url.pathname === '/v1/admin/billing/overview') {
    const since = Date.now() - 30 * 86_400_000;
    const one = (query, ...args) => sql().prepare(query).get(...args) || {};
    const paid = one("SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM billing_purchases WHERE status = 'paid'");
    const recent30 = one("SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM billing_purchases WHERE status = 'paid' AND created_at >= ?", since);
    const refunds = one("SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM billing_purchases WHERE status != 'paid'");
    const members = sql().prepare("SELECT plan, COUNT(*) AS n FROM billing_subscriptions WHERE status IN ('active', 'trialing', 'past_due') GROUP BY plan").all();
    const recent = sql().prepare('SELECT * FROM billing_purchases ORDER BY created_at DESC LIMIT 25').all().map((row) => ({
      transactionId: row.transaction_id, userId: row.user_id, username: nameOf(row.user_id), kind: row.kind, itemId: row.item_id,
      itemName: row.item_id && ctx.findItem(row.item_id) ? ctx.findItem(row.item_id).name : null, plan: row.plan,
      amount: row.amount_cents / 100, currency: row.currency, status: row.status, createdAt: row.created_at
    }));
    send(res, 200, {
      ok: true,
      enabled: enabled(),
      environment: config().environment,
      sales: { count: paid.n || 0, total: (paid.cents || 0) / 100, last30Count: recent30.n || 0, last30: (recent30.cents || 0) / 100, currency: 'USD' },
      refunds: { count: refunds.n || 0, total: (refunds.cents || 0) / 100 },
      plus: {
        active: members.reduce((sum, row) => sum + row.n, 0),
        monthly: members.find((row) => row.plan === 'monthly')?.n || 0,
        yearly: members.find((row) => row.plan === 'yearly')?.n || 0
      },
      recent
    }, noStore);
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
      if (!item) { send(res, 404, { ok: false, error: 'Pick a cape for this code.' }); return true; }
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

  send(res, 404, { ok: false, error: 'Admin billing endpoint not found.' });
  return true;
}

module.exports = {
  handleBillingRoutes, setHooks, hasPlus, plusFor, isPaid, ownedSource, grantItem, syncPlus,
  verifySignature, handleEvent, redeem, enabled
};
