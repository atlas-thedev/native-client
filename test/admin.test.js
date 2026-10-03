const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'noctra-admin-test-'));
process.env.NOCTRA_DATA_DIR = DATA_DIR;
process.env.NOCTRA_ADMIN_EMAILS = 'owner@test.local';

const db = require('../server/db');
const { listen } = require('../server/server');

const authHeaders = (token, json = false) => ({
  Authorization: `Bearer ${token}`,
  ...(json ? { 'Content-Type': 'application/json' } : {})
});

test('admin API is role-protected and lets the configured admin manage sanitized user badges', async () => {
  const regular = db.createUser({ email: 'player@test.local', username: 'RegularPlayer', password: 'password123' });
  const owner = db.createUser({ email: 'owner@test.local', username: 'OhLlama', password: 'password123' });
  assert.equal(Boolean(db.getUserByUsername('OhLlama').is_admin), true, 'NOCTRA_ADMIN_EMAILS grants admin at sign-up');
  db.getDb().prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(owner.id);
  db.closeDb();
  db.getDb();
  assert.equal(Boolean(db.getUserByUsername('OhLlama').is_admin), true, 'schema migration restores the configured admin role');
  // A username alone never grants admin.
  const squatter = db.createUser({ email: 'someone@test.local', username: 'Ohllama_', password: 'password123' });
  assert.equal(Boolean(db.getUserByUsername(squatter.username).is_admin), false);
  db.getDb().prepare('DELETE FROM users WHERE id = ?').run(squatter.id);
  const regularSession = db.createSession(regular.id);
  const ownerSession = db.createSession(owner.id);
  const server = await listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const anonymous = await fetch(`${base}/v1/admin/status`);
    assert.equal(anonymous.status, 401);

    const regularStatus = await fetch(`${base}/v1/admin/status`, { headers: authHeaders(regularSession.token) });
    assert.deepEqual(await regularStatus.json(), { ok: true, isAdmin: false });

    const forbidden = await fetch(`${base}/v1/admin/overview`, { headers: authHeaders(regularSession.token) });
    assert.equal(forbidden.status, 403);

    const ownerStatus = await fetch(`${base}/v1/admin/status`, { headers: authHeaders(ownerSession.token) });
    assert.deepEqual(await ownerStatus.json(), { ok: true, isAdmin: true });
    assert.equal(Boolean(db.getUserBySession(ownerSession.token).is_admin), true);

    const overviewResponse = await fetch(`${base}/v1/admin/overview`, { headers: authHeaders(ownerSession.token) });
    assert.equal(overviewResponse.status, 200);
    const overview = await overviewResponse.json();
    assert.equal(overview.ok, true);
    assert.equal(overview.overview.users, 2);
    assert.ok(overview.overview.database.tables.some((table) => table.name === 'users' && table.rows === 2));

    const usersResponse = await fetch(`${base}/v1/admin/users?page=1&pageSize=50`, { headers: authHeaders(ownerSession.token) });
    const users = await usersResponse.json();
    assert.equal(users.ok, true);
    assert.equal(users.total, 2);
    assert.ok(users.users.some((user) => user.username === 'OhLlama' && user.isAdmin));
    const serialized = JSON.stringify(users);
    assert.doesNotMatch(serialized, /password_hash|salt|session|token|verification/i);

    const badgeResponse = await fetch(`${base}/v1/admin/users/${regular.id}/badges`, {
      method: 'POST',
      headers: authHeaders(ownerSession.token, true),
      body: JSON.stringify({ badge: 'bug_hunter', granted: true })
    });
    assert.equal(badgeResponse.status, 200);
    const badgeResult = await badgeResponse.json();
    assert.deepEqual(badgeResult.user.badges, ['bug_hunter']);
    assert.equal(JSON.parse(db.getUserByUsername('RegularPlayer').badges).includes('bug_hunter'), true);

    const invalidBadge = await fetch(`${base}/v1/admin/users/${regular.id}/badges`, {
      method: 'POST',
      headers: authHeaders(ownerSession.token, true),
      body: JSON.stringify({ badge: 'owner_of_everything', granted: true })
    });
    assert.equal(invalidBadge.status, 400);

    const post = (pathname, body, token = ownerSession.token) => fetch(`${base}${pathname}`, {
      method: 'POST', headers: authHeaders(token, true), body: JSON.stringify(body)
    });

    // Admin role management: promote, demote, never demote yourself.
    const selfDemote = await post(`/v1/admin/users/${owner.id}/admin`, { isAdmin: false });
    assert.equal(selfDemote.status, 400);
    const promote = await post(`/v1/admin/users/${regular.id}/admin`, { isAdmin: true });
    assert.equal((await promote.json()).user.isAdmin, true);
    const demote = await post(`/v1/admin/users/${regular.id}/admin`, { isAdmin: false });
    assert.equal((await demote.json()).user.isAdmin, false);
    const regularPromote = await post(`/v1/admin/users/${regular.id}/admin`, { isAdmin: true }, regularSession.token);
    assert.equal(regularPromote.status, 403);

    // Per-user cape management from the user panel.
    const itemsResponse = await fetch(`${base}/v1/admin/store/items`, { headers: authHeaders(ownerSession.token) });
    const { items } = await itemsResponse.json();
    const detailResponse = await fetch(`${base}/v1/admin/store/users/${regular.id}`, { headers: authHeaders(ownerSession.token) });
    const detail = await detailResponse.json();
    assert.equal(detail.user.username, 'RegularPlayer');
    assert.equal(typeof detail.user.sessionCount, 'number');
    assert.equal(detail.user.passwordHash, undefined);
    assert.deepEqual(detail.user.owned, []);
    if (items.length) {
      const capeId = items[0].id;
      const equip = await (await post(`/v1/admin/store/users/${regular.id}/capes`, { itemId: capeId, action: 'equip' })).json();
      assert.equal(equip.user.equipped, capeId);
      assert.ok(equip.user.owned.some((entry) => entry.id === capeId), 'equipping attaches the cape first');
      const off = await (await post(`/v1/admin/store/users/${regular.id}/capes`, { action: 'unequip' })).json();
      assert.equal(off.user.equipped, null);
      const revoked = await (await post(`/v1/admin/store/users/${regular.id}/capes`, { itemId: capeId, action: 'revoke' })).json();
      assert.ok(!revoked.user.owned.some((entry) => entry.id === capeId));
    }
    const badAction = await post(`/v1/admin/store/users/${regular.id}/capes`, { itemId: 'x', action: 'steal' });
    assert.equal(badAction.status, 400);

    // Signing a user out everywhere kills their sessions.
    const selfRevoke = await post(`/v1/admin/users/${owner.id}/sessions/revoke`, {});
    assert.equal(selfRevoke.status, 400);
    const revokeSessions = await (await post(`/v1/admin/users/${regular.id}/sessions/revoke`, {})).json();
    assert.ok(revokeSessions.revoked >= 1);
    const afterRevoke = await fetch(`${base}/v1/admin/status`, { headers: authHeaders(regularSession.token) });
    assert.equal(afterRevoke.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.closeDb();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
});
