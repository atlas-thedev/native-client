'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'native-bundles-test-'));
process.env.NATIVE_DATA_DIR = DATA_DIR;
process.env.NATIVE_SKIN_DATA = DATA_DIR;
process.env.NATIVE_ADMIN_EMAILS = 'boss@bundles.local';
const SECRET = 'pdl_ntfset_bundle_secret';
Object.assign(process.env, {
  PADDLE_ENV: 'sandbox', PADDLE_API_KEY: 'test-key', PADDLE_CLIENT_TOKEN: 'test_token', PADDLE_WEBHOOK_SECRET: SECRET,
  PADDLE_CAPE_PRODUCT: 'pro_cape', PADDLE_PLUS_MONTHLY_PRICE: 'pri_month', PADDLE_PLUS_YEARLY_PRICE: 'pri_year'
});

const db = require('../server/db');
const { listen } = require('../server/server');
const bundles = require('../server/bundles');

const sign = (body, ts = Math.floor(Date.now() / 1000)) => `ts=${ts};h1=${crypto.createHmac('sha256', SECRET).update(`${ts}:${body}`).digest('hex')}`;

/** A plain RGBA PNG (cape sized) in one colour. */
function png(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: width }, () => Buffer.from([r, g, b, 255])))]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('bundle prices: discount, fixed price, owned pieces left out, shares add up', () => {
  const items = { a: { id: 'a', price: 2 }, b: { id: 'b', price: 3 }, c: { id: 'c', price: 0 }, e: { id: 'e', price: 5, exclusive: true } };
  const env = { findItem: (id) => items[id], priceOf: (item) => item.price };
  const q = bundles.quote({ itemIds: ['a', 'b', 'c', 'e'], discount: 20 }, env);
  assert.equal(q.items.length, 3, 'event items never count');
  assert.equal(q.fullCents, 500);
  assert.equal(q.priceCents, 400);
  assert.equal(q.discountPercent, 20);
  const fixed = bundles.quote({ itemIds: ['a', 'b'], price: 4.49, discount: 50 }, env);
  assert.equal(fixed.priceCents, 449, 'a fixed price wins over the discount');
  const mine = bundles.quote({ itemIds: ['a', 'b', 'c'], discount: 20 }, { ...env, ownedSource: (id) => (id === 'a' ? 'purchase' : id === 'b' ? 'plus' : null) });
  assert.deepEqual(mine.lines.map((line) => line.item.id), ['b'], 'Native+ pieces are still sold, bought ones are not');
  assert.equal(mine.dueCents, 240);
  assert.equal(mine.lines.reduce((sum, line) => sum + line.cents, 0), mine.dueCents);
  assert.deepEqual(bundles.split(101, [1, 1, 1]).reduce((a, b) => a + b, 0), 101);
  assert.throws(() => bundles.cleanBundle({ name: 'Pack', itemIds: ['a'] }, null, env), /at least 2/);
  assert.throws(() => bundles.cleanBundle({ name: 'Pack', itemIds: ['a', 'e'] }, null, env), /event item/);
});

test('store bundles: admin CRUD, catalogue, checkout split, webhook grant, refund; paid capes need ownership', async () => {
  const buyer = db.createUser({ email: 'buyer@bundles.local', username: 'BundleBuyer', password: 'password123' });
  const thief = db.createUser({ email: 'thief@bundles.local', username: 'CapeThief', password: 'password123' });
  const boss = db.createUser({ email: 'boss@bundles.local', username: 'BundleBoss', password: 'password123' });
  const buyerToken = db.createSession(buyer.id).token;
  const thiefToken = db.createSession(thief.id).token;
  const bossToken = db.createSession(boss.id).token;
  const server = await listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  const paddleCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (!href.includes('paddle.com')) return realFetch(url, init);
    const body = init.body ? JSON.parse(init.body) : null;
    paddleCalls.push({ href, body });
    const reply = href.endsWith('/customers') ? { data: { id: 'ctm_bundle' } } : { data: { id: `txn_${paddleCalls.length}`, checkout: { url: 'https://pay.example/checkout' } } };
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const call = (method, pathname, body, token) => realFetch(`${base}${pathname}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
  });
  const json = async (...args) => (await call(...args)).json();
  const hook = (event) => { const raw = JSON.stringify(event); return realFetch(`${base}/v1/billing/paddle/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sign(raw) }, body: raw }); };

  try {
    // A static paid cape, plus two of the bundled capes (one paid, one free).
    const stillPng = png(64, 32, [200, 40, 40]);
    const created = await json('POST', '/v1/admin/store/items', { name: 'Red Static', still: stillPng.toString('base64') }, bossToken);
    assert.equal(created.ok, true, created.error);
    const red = created.item.id;
    await json('PATCH', `/v1/admin/store/items/${red}`, { price: 2 }, bossToken);
    await json('PATCH', '/v1/admin/store/items/aurora', { price: 3 }, bossToken);

    // Bug fix: wearing a paid static cape by uploading its PNG doesn't work without owning it.
    const sneaky = await json('POST', '/v1/wardrobe', { cape: stillPng.toString('base64') }, thiefToken);
    assert.equal(sneaky.ok, true);
    assert.deepEqual(sneaky.capes, [], 'a paid cape PNG is not worn for free');

    // Admin bundles: validation, create, edit.
    const bad = await call('POST', '/v1/admin/store/bundles', { name: 'Solo', itemIds: [red] }, bossToken);
    assert.equal(bad.status, 400);
    assert.equal((await call('POST', '/v1/admin/store/bundles', { name: 'Nope', itemIds: [red, 'aurora'] }, buyerToken)).status, 403);
    const made = await json('POST', '/v1/admin/store/bundles', { name: 'Starter Pack', description: 'Three cloaks', itemIds: [red, 'aurora', 'ember'], discount: 20, featured: true }, bossToken);
    assert.equal(made.ok, true, made.error);
    assert.equal(made.bundle.id, 'starter-pack');
    assert.equal(made.bundle.fullPrice, 5);
    assert.equal(made.bundle.price, 4);
    assert.equal(made.bundle.savePercent, 20);

    const catalog = await json('GET', '/v1/store/catalog');
    assert.equal(catalog.bundles.length, 1);
    assert.deepEqual(catalog.bundles[0].itemIds, [red, 'aurora', 'ember']);
    const one = await json('GET', '/v1/store/bundles/starter-pack');
    assert.equal(one.items.length, 3);

    // A paid bundle can't be claimed for free.
    assert.equal((await call('POST', '/v1/store/bundles/starter-pack/claim', {}, buyerToken)).status, 402);

    // Checkout: one line per paid piece, adding up to the bundle price.
    const checkout = await json('POST', '/v1/billing/checkout', { kind: 'bundle', bundleId: 'starter-pack' }, buyerToken);
    assert.equal(checkout.ok, true, checkout.error);
    const txn = paddleCalls.find((entry) => entry.href.endsWith('/transactions')).body;
    assert.equal(txn.items.length, 2);
    assert.equal(txn.items.reduce((sum, line) => sum + Number(line.price.unit_price.amount), 0), 400);
    assert.equal(txn.custom_data.bundleId, 'starter-pack');

    // The webhook grants every piece (the free one too) and remembers the bundle.
    const sale = { event_id: 'evt_b1', event_type: 'transaction.completed', data: {
      id: checkout.transactionId, status: 'completed', customer_id: 'ctm_bundle', currency_code: 'USD', custom_data: txn.custom_data,
      details: { totals: { grand_total: '400' }, line_items: [] }, items: []
    } };
    assert.equal((await hook(sale)).status, 200);
    const me = await json('GET', '/v1/store/me', null, buyerToken);
    for (const id of [red, 'aurora', 'ember']) assert.ok(me.owned.some((entry) => entry.id === id), `${id} owned`);
    assert.equal(me.bundles['starter-pack'].complete, true);
    const bill = await json('GET', '/v1/billing/me', null, buyerToken);
    assert.equal(bill.purchases[0].bundleId, 'starter-pack');
    assert.equal(bill.purchases[0].bundleName, 'Starter Pack');

    // Owners can wear the static cape (also as a PNG from an older launcher).
    const worn = await json('POST', '/v1/wardrobe', { cape: stillPng.toString('base64') }, buyerToken);
    assert.equal(worn.capes.length, 1, 'owners can wear it');
    assert.equal((await json('GET', '/v1/store/me', null, buyerToken)).equipped, red, 'a PNG upload of a store cape counts as wearing it');
    const equipped = await json('POST', '/v1/store/equip', { itemId: red }, buyerToken);
    assert.equal(equipped.equipped, red);
    assert.equal((await json('GET', '/v1/store/me', null, buyerToken)).premiumEquipped, red);

    // Buying again is refused; a full refund takes everything back and off.
    assert.equal((await call('POST', '/v1/billing/checkout', { kind: 'bundle', bundleId: 'starter-pack' }, buyerToken)).status, 400);
    await hook({ event_id: 'evt_b2', event_type: 'adjustment.updated', data: { id: 'adj_b', action: 'refund', status: 'approved', transaction_id: checkout.transactionId } });
    const after = await json('GET', '/v1/store/me', null, buyerToken);
    assert.ok(!after.owned.some((entry) => entry.id === red || entry.id === 'aurora'));
    assert.equal(after.equipped, null, 'a refunded cape comes off');

    // Admin edits and deletes.
    const edited = await json('PATCH', '/v1/admin/store/bundles/starter-pack', { price: 4.5, hidden: true }, bossToken);
    assert.equal(edited.bundle.price, 4.5);
    assert.equal((await json('GET', '/v1/store/catalog')).bundles.length, 0, 'hidden bundles are not listed');
    const removed = await json('DELETE', '/v1/admin/store/bundles/starter-pack', null, bossToken);
    assert.equal(removed.bundles.length, 0);
  } finally {
    globalThis.fetch = realFetch;
    server.closeAllConnections?.();
    server.close();
    try { db.closeDb(); } catch {}
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    setTimeout(() => process.exit(0), 50).unref();
  }
});
