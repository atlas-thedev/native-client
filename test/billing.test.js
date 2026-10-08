const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'native-billing-test-'));
process.env.NATIVE_DATA_DIR = DATA_DIR;
process.env.NATIVE_ADMIN_EMAILS = 'boss@test.local';
const SECRET = 'tebex_webhook_test_secret';
Object.assign(process.env, {
  TEBEX_PROJECT_ID: '1234567', TEBEX_PRIVATE_KEY: 'privatekeyprivatekey123', TEBEX_PUBLIC_TOKEN: 'abcd-0123456789abcdef', TEBEX_WEBHOOK_SECRET: SECRET, TEBEX_MODE: 'live'
});

const db = require('../server/db');
const { listen } = require('../server/server');

const sign = (body, secret = SECRET) => crypto.createHmac('sha256', secret).update(crypto.createHash('sha256').update(body).digest('hex')).digest('hex');
let eventNo = 0;
const ev = (type, subject) => ({ id: `evt_${++eventNo}`, type, date: new Date().toISOString(), subject });

test('Tebex webhooks sell capes, run Native+, refund, and redeem codes', async () => {
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
    return fetch(`${base}/v1/billing/tebex/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': sign(raw) }, body: raw });
  };
  const owned = async () => (await (await call('GET', '/v1/store/me', null, buyerSession.token)).json()).owned;

  try {
    const config = await (await call('GET', '/v1/billing/config')).json();
    assert.equal(config.enabled, true);
    assert.equal(config.provider, 'tebex');
    assert.equal(config.publicToken, 'abcd-0123456789abcdef');

    // Tebex validates a new endpoint by expecting its id back.
    const validation = await (await hook({ id: 'val-1', type: 'validation.webhook', date: new Date().toISOString(), subject: {} })).json();
    assert.deepEqual(validation, { id: 'val-1' });

    // Make one cape paid.
    const { items } = await (await call('GET', '/v1/admin/store/items', null, bossSession.token)).json();
    const paid = items.find((item) => !item.exclusive);
    const patched = await (await call('PATCH', `/v1/admin/store/items/${paid.id}`, { price: 2.49 }, bossSession.token)).json();
    assert.equal(patched.item.price, 2.49);
    assert.equal(patched.item.paid, true);

    // Paid capes can't be claimed or worn for free.
    const claim = await call('POST', '/v1/store/claim', { itemId: paid.id }, buyerSession.token);
    assert.equal(claim.status, 402);
    assert.equal((await claim.json()).needsPurchase, true);
    assert.equal((await call('POST', '/v1/store/equip', { itemId: paid.id }, buyerSession.token)).status, 402);

    // Forged webhooks are rejected.
    const forged = await fetch(`${base}/v1/billing/tebex/webhook`, { method: 'POST', headers: { 'X-Signature': sign('{}', 'wrong-secret') }, body: '{}' });
    assert.equal(forged.status, 401);

    // Buying a cape.
    const sale = ev('payment.completed', {
      transaction_id: 'tbx-1', status: { id: 1, description: 'Complete' }, price: { amount: 2.49, currency: 'USD' }, price_paid: { amount: 2.49, currency: 'USD' },
      payment_method: { name: 'PayPal', refundable: true }, customer: { email: 'buyer@test.local' }, custom: { userId: buyer.id, kind: 'cape', itemId: paid.id },
      products: [{ id: null, name: paid.name, quantity: 1, custom: { userId: buyer.id, kind: 'cape', itemId: paid.id } }], recurring_payment_reference: null
    });
    assert.equal((await hook(sale)).status, 200);
    assert.equal((await (await hook(sale)).json()).duplicate, true, 'events are processed once');
    assert.ok((await owned()).some((entry) => entry.id === paid.id && entry.source === 'purchase'));
    const unclaim = await call('POST', '/v1/store/unclaim', { itemId: paid.id }, buyerSession.token);
    assert.equal(unclaim.status, 403, 'bought capes stay in the locker');

    // Refund takes it back.
    await hook(ev('payment.refunded', { transaction_id: 'tbx-1', status: { id: 2, description: 'Refund' } }));
    assert.ok(!(await owned()).some((entry) => entry.id === paid.id));

    // Native+ unlocks paid capes while active.
    const firstPayment = {
      transaction_id: 'tbx-2', status: { id: 1 }, price: { amount: 2.99, currency: 'USD' }, price_paid: { amount: 2.99, currency: 'USD' },
      payment_method: { name: 'Card' }, custom: { userId: buyer.id, kind: 'plus', plan: 'monthly' }, products: [{ name: 'Native+ (monthly)', custom: { plan: 'monthly' } }],
      recurring_payment_reference: 'tbx-r-1'
    };
    await hook(ev('payment.completed', firstPayment));
    const renewsAt = new Date(Date.now() + 864e5 * 30).toISOString();
    await hook(ev('recurring-payment.started', { reference: 'tbx-r-1', next_payment_at: renewsAt, status: { id: 2, description: 'Active' }, initial_payment: firstPayment, price: { amount: 2.99, currency: 'USD' } }));
    const me = await (await call('GET', '/v1/billing/me', null, buyerSession.token)).json();
    assert.equal(me.plus.active, true);
    assert.equal(me.plus.plan, 'monthly');
    assert.ok(db.getUserById(buyer.id).badges.includes('plus'), 'members get the Native+ badge');
    const wear = await (await call('POST', '/v1/store/equip', { itemId: paid.id }, buyerSession.token)).json();
    assert.equal(wear.equipped, paid.id);
    assert.ok((await owned()).some((entry) => entry.id === paid.id && entry.source === 'plus'));

    assert.equal(me.plus.renewsAt, Date.parse(renewsAt));

    // Asking to cancel keeps Native+ until the paid period ends.
    await hook(ev('recurring-payment.cancellation.requested', { reference: 'tbx-r-1', next_payment_at: renewsAt, status: { id: 2 }, initial_payment: firstPayment }));
    const cancelling = (await (await call('GET', '/v1/billing/me', null, buyerSession.token)).json()).plus;
    assert.equal(cancelling.active, true);
    assert.equal(cancelling.endsAt, Date.parse(renewsAt));
    assert.equal(cancelling.renewsAt, null);

    // Ending Native+ takes plus capes back off.
    await hook(ev('recurring-payment.ended', { reference: 'tbx-r-1', status: { id: 5, description: 'Cancelled' }, initial_payment: firstPayment, cancelled_at: new Date().toISOString() }));
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

    // Admins can give Native+ without a payment, for a while or forever, and take it back.
    const friend = db.createUser({ email: 'friend@test.local', username: 'Friendo', password: 'password123' });
    const friendSession = db.createSession(friend.id);
    const plusOf = async () => (await (await call('GET', '/v1/billing/me', null, friendSession.token)).json()).plus;
    assert.equal((await plusOf()).active, false);
    assert.equal((await call('POST', '/v1/admin/billing/plus', { username: 'Friendo', days: 30 }, buyerSession.token)).status, 403, 'only admins give Native+');
    assert.equal((await call('POST', '/v1/admin/billing/plus', { username: 'NobodyHere', days: 30 }, bossSession.token)).status, 404);
    const given = await (await call('POST', '/v1/admin/billing/plus', { username: 'friendo', days: 30, note: 'giveaway' }, bossSession.token)).json();
    assert.equal(given.ok, true);
    assert.ok(given.expiresAt > Date.now() + 29 * 864e5 && given.expiresAt < Date.now() + 31 * 864e5);
    const gifted = await plusOf();
    assert.equal(gifted.active, true);
    assert.equal(gifted.gifted, true);
    assert.ok(db.getUserById(friend.id).badges.includes('plus'), 'gift adds the Native+ badge');
    const friendClaim = await call('POST', '/v1/store/claim', { itemId: paid.id }, friendSession.token);
    assert.equal(friendClaim.status, 200, 'a gifted member gets paid capes');
    const more = await (await call('POST', '/v1/admin/billing/plus', { username: 'Friendo', days: 30 }, bossSession.token)).json();
    assert.ok(more.expiresAt > given.expiresAt + 29 * 864e5, 'more time adds to what is left');
    const list = await (await call('GET', '/v1/admin/billing/plus', null, bossSession.token)).json();
    assert.equal(list.gifts.length, 1);
    assert.equal(list.gifts[0].username, 'Friendo');
    const withGift = await (await call('GET', '/v1/admin/billing/overview', null, bossSession.token)).json();
    assert.equal(withGift.plus.gifted, 1);
    const removed = await (await call('DELETE', `/v1/admin/billing/plus/${friend.id}`, null, bossSession.token)).json();
    assert.equal(removed.gifts.length, 0);
    assert.equal((await plusOf()).active, false);
    assert.ok(!(await (await call('GET', '/v1/store/me', null, friendSession.token)).json()).owned.some((entry) => entry.id === paid.id), 'paid capes go back when the gift ends');
    const forever = await (await call('POST', '/v1/admin/billing/plus', { username: 'Friendo', days: 0 }, bossSession.token)).json();
    assert.equal(forever.expiresAt, null);
    assert.equal((await plusOf()).endsAt, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.closeDb();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
});

test('admin Tebex settings: secrets are write-only, modes, test mode is admins only', async () => {
  const boss = db.getUserByUsername('Boss') || db.createUser({ email: 'boss@test.local', username: 'Boss', password: 'password123' });
  const shopper = db.createUser({ email: 'shopper@test.local', username: 'Shopper', password: 'password123' });
  const token = db.createSession(boss.id).token;
  const shopperToken = db.createSession(shopper.id).token;
  const server = await listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, pathname, body, as = token) => fetch(`${base}${pathname}`, { method, headers: { Authorization: `Bearer ${as}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    let r = await call('POST', '/v1/admin/billing/settings', { projectId: 'not-a-number' });
    assert.equal(r.status, 400);
    r = await call('POST', '/v1/admin/billing/settings', { projectId: '7654321', privateKey: 'liveprivatekey0123456789SECRET' });
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(JSON.stringify(body).includes('SECRET'), false);
    assert.equal(body.settings.privateKey, '…CRET');
    assert.equal(body.settings.projectId, '7654321');
    assert.equal((await call('POST', '/v1/admin/billing/settings', { privateKey: 'x' }, shopperToken)).status, 403);

    // test mode: only admins can check out
    r = await call('POST', '/v1/admin/billing/activate', { mode: 'test' });
    assert.equal(r.status, 200);
    assert.equal((await (await fetch(`${base}/v1/billing/config`)).json()).testMode, true);
    r = await call('POST', '/v1/billing/checkout', { kind: 'plus', plan: 'monthly' }, shopperToken);
    assert.equal(r.status, 503);
    assert.equal((await (await call('GET', '/v1/billing/me', null, shopperToken)).json()).enabled, false);
    assert.equal((await (await call('GET', '/v1/billing/me')).json()).enabled, true);

    // off
    await call('POST', '/v1/admin/billing/activate', { mode: 'off' });
    assert.equal((await (await fetch(`${base}/v1/billing/config`)).json()).enabled, false);
    assert.equal((await call('POST', '/v1/admin/billing/activate', { mode: 'nope' })).status, 400);

    // the portal points at the website billing page
    const portal = await (await call('POST', '/v1/billing/portal', {}, shopperToken)).json();
    assert.match(portal.url, /\/billing$/);
    await call('POST', '/v1/admin/billing/activate', { mode: 'live' });
  } finally {
    server.close();
  }
});
