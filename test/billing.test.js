const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'noctra-billing-test-'));
process.env.NOCTRA_DATA_DIR = DATA_DIR;
process.env.NOCTRA_ADMIN_EMAILS = 'boss@test.local';
const SECRET = 'pdl_ntfset_test_secret';
Object.assign(process.env, {
  PADDLE_ENV: 'sandbox', PADDLE_API_KEY: 'test-key', PADDLE_CLIENT_TOKEN: 'test_token', PADDLE_WEBHOOK_SECRET: SECRET,
  PADDLE_CAPE_PRODUCT: 'pro_cape', PADDLE_PLUS_MONTHLY_PRICE: 'pri_month', PADDLE_PLUS_YEARLY_PRICE: 'pri_year'
});

const db = require('../server/db');
const { listen } = require('../server/server');

const sign = (body, ts = Math.floor(Date.now() / 1000)) => `ts=${ts};h1=${crypto.createHmac('sha256', SECRET).update(`${ts}:${body}`).digest('hex')}`;

test('Paddle webhooks sell capes, run Noctra+, refund, and redeem codes', async () => {
  const buyer = db.createUser({ email: 'buyer@test.local', username: 'Buyer', password: 'password123' });
  const boss = db.createUser({ email: 'boss@test.local', username: 'Boss', password: 'password123' });
  const buyerSession = db.createSession(buyer.id);
  const bossSession = db.createSession(boss.id);
  const server = await listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, pathname, body, token) => fetch(`${base}${pathname}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
  });
  const hook = (event) => {
    const raw = JSON.stringify(event);
    return fetch(`${base}/v1/billing/paddle/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sign(raw) }, body: raw });
  };
  const owned = async () => (await (await call('GET', '/v1/store/me', null, buyerSession.token)).json()).owned;

  try {
    const config = await (await call('GET', '/v1/billing/config')).json();
    assert.equal(config.enabled, true);
    assert.equal(config.clientToken, 'test_token');

    // Make one cape paid.
    const { items } = await (await call('GET', '/v1/admin/store/items', null, bossSession.token)).json();
    const paid = items.find((item) => !item.exclusive);
    const patched = await (await call('PATCH', `/v1/admin/store/items/${paid.id}`, { price: 1.49 }, bossSession.token)).json();
    assert.equal(patched.item.price, 1.49);
    assert.equal(patched.item.paid, true);

    // Paid capes can't be claimed or worn for free.
    const claim = await call('POST', '/v1/store/claim', { itemId: paid.id }, buyerSession.token);
    assert.equal(claim.status, 402);
    assert.equal((await claim.json()).needsPurchase, true);
    assert.equal((await call('POST', '/v1/store/equip', { itemId: paid.id }, buyerSession.token)).status, 402);

    // Forged webhooks are rejected.
    const forged = await fetch(`${base}/v1/billing/paddle/webhook`, { method: 'POST', headers: { 'Paddle-Signature': 'ts=1;h1=00' }, body: '{}' });
    assert.equal(forged.status, 401);

    // Buying a cape.
    const sale = { event_id: 'evt_1', event_type: 'transaction.completed', data: {
      id: 'txn_1', status: 'completed', customer_id: 'ctm_1', currency_code: 'USD', custom_data: { userId: buyer.id, kind: 'cape', itemId: paid.id },
      details: { totals: { grand_total: '149' } }, items: [{ price: { id: 'pri_x' } }]
    } };
    assert.equal((await hook(sale)).status, 200);
    assert.equal((await (await hook(sale)).json()).duplicate, true, 'events are processed once');
    assert.ok((await owned()).some((entry) => entry.id === paid.id && entry.source === 'purchase'));
    const unclaim = await call('POST', '/v1/store/unclaim', { itemId: paid.id }, buyerSession.token);
    assert.equal(unclaim.status, 403, 'bought capes stay in the locker');

    // Refund takes it back.
    await hook({ event_id: 'evt_2', event_type: 'adjustment.updated', data: { id: 'adj_1', action: 'refund', status: 'approved', transaction_id: 'txn_1' } });
    assert.ok(!(await owned()).some((entry) => entry.id === paid.id));

    // Noctra+ unlocks paid capes while active.
    await hook({ event_id: 'evt_3', event_type: 'subscription.created', data: {
      id: 'sub_1', status: 'active', customer_id: 'ctm_1', custom_data: { userId: buyer.id, kind: 'plus', plan: 'monthly' },
      items: [{ price: { id: 'pri_month' } }], current_billing_period: { ends_at: new Date(Date.now() + 864e5 * 30).toISOString() }
    } });
    const me = await (await call('GET', '/v1/billing/me', null, buyerSession.token)).json();
    assert.equal(me.plus.active, true);
    assert.equal(me.plus.plan, 'monthly');
    assert.ok(db.getUserById(buyer.id).badges.includes('plus'), 'members get the Noctra+ badge');
    const wear = await (await call('POST', '/v1/store/equip', { itemId: paid.id }, buyerSession.token)).json();
    assert.equal(wear.equipped, paid.id);
    assert.ok((await owned()).some((entry) => entry.id === paid.id && entry.source === 'plus'));

    // Ending Noctra+ takes plus capes back off.
    await hook({ event_id: 'evt_4', event_type: 'subscription.canceled', data: { id: 'sub_1', status: 'canceled', customer_id: 'ctm_1', items: [{ price: { id: 'pri_month' } }] } });
    assert.ok(!(await owned()).some((entry) => entry.id === paid.id));
    assert.equal((await (await call('GET', '/v1/store/me', null, buyerSession.token)).json()).equipped, null);
    assert.ok(!db.getUserById(buyer.id).badges.includes('plus'));

    // Redeem codes for event capes.
    const event = items.find((item) => item.exclusive) || items[0];
    const made = await (await call('POST', '/v1/admin/billing/codes', { itemId: event.id, code: 'summer-26', maxUses: 1, expiresInDays: 7 }, bossSession.token)).json();
    assert.equal(made.code, 'SUMMER-26');
    assert.equal((await call('POST', '/v1/admin/billing/codes', { itemId: event.id }, buyerSession.token)).status, 403);
    const redeemed = await (await call('POST', '/v1/store/redeem', { code: ' summer-26 ' }, buyerSession.token)).json();
    assert.equal(redeemed.item.id, event.id);
    assert.equal((await call('POST', '/v1/store/redeem', { code: 'SUMMER-26' }, buyerSession.token)).status, 409);
    assert.ok((await owned()).some((entry) => entry.id === event.id && entry.source === 'code'));

    const overview = await (await call('GET', '/v1/admin/billing/overview', null, bossSession.token)).json();
    assert.equal(overview.refunds.count, 1);
    assert.equal(overview.recent[0].username, 'Buyer');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.closeDb();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
});

test('admin Paddle settings: secrets are write-only, live needs setup, sandbox events are ignored while live', async () => {
  const boss = db.getUserByUsername('Boss') || db.createUser({ email: 'boss@test.local', username: 'Boss', password: 'password123' });
  const token = db.createSession(boss.id).token;
  const server = await listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, pathname, body) => fetch(`${base}${pathname}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    let r = await call('POST', '/v1/admin/billing/settings', { environment: 'production', apiKey: 'pdl_sdbx_apikey_wrongwrongwrongwrongwrong' });
    assert.equal(r.status, 400);
    r = await call('POST', '/v1/admin/billing/settings', { environment: 'production', apiKey: 'pdl_live_apikey_01abcdefghijklmnopqrstuvwxyz_SECRET', clientToken: 'live_0123456789abcdef0123456789' });
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(JSON.stringify(body).includes('SECRET'), false);
    assert.equal(body.settings.environments.production.apiKey, '…CRET');
    assert.equal(body.settings.environments.production.ready, false);
    r = await call('POST', '/v1/admin/billing/activate', { environment: 'production' });
    assert.equal(r.status, 400);

    // pretend setup ran, then go live
    const billing = require('../server/billing');
    for (const [k, v] of Object.entries({ webhookSecret: 'pdl_ntfset_live_secret', capeProduct: 'pro_live' })) billing.saveSetting(`production.${k}`, v);
    r = await call('POST', '/v1/admin/billing/activate', { environment: 'production' });
    assert.equal(r.status, 200);
    assert.equal((await (await fetch(`${base}/v1/billing/config`)).json()).environment, 'production');
    const raw = JSON.stringify({ event_id: 'evt_sbx_after_live', event_type: 'transaction.completed', data: { id: 'txn_x', custom_data: { userId: boss.id, kind: 'cape', itemId: 'aurora' } } });
    r = await fetch(`${base}/v1/billing/paddle/webhook`, { method: 'POST', headers: { 'Paddle-Signature': sign(raw) }, body: raw });
    assert.equal((await r.json()).ignored, 'sandbox event while live');
    await call('POST', '/v1/admin/billing/activate', { environment: 'sandbox' });
  } finally {
    server.close();
  }
});
