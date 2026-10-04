'use strict';
/** Installs created before the Noctra -> Native rename keep working: env vars, database file, saved accounts. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('pre-rename NOCTRA_* variables fill in the NATIVE_* ones (without overriding them)', () => {
  const run = (script, file) => execFileSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(root, file))}); ${script}`], {
    env: { PATH: process.env.PATH, NOCTRA_DATA_DIR: '/old', NOCTRA_SITE_KEY: 'old-key', NATIVE_SITE_KEY: 'new-key' }
  }).toString();
  for (const file of ['server/env.js', 'electron/legacyEnv.js']) {
    assert.equal(run('process.stdout.write(process.env.NATIVE_DATA_DIR + "|" + process.env.NATIVE_SITE_KEY)', file), '/old|new-key');
  }
});

test('an existing noctra.db is reused, new installs get native.db', () => {
  const { resolveDbPath } = require('../server/env.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-dbpath-'));
  assert.equal(resolveDbPath(dir), path.join(dir, 'native.db'));
  fs.writeFileSync(path.join(dir, 'noctra.db'), '');
  assert.equal(resolveDbPath(dir), path.join(dir, 'noctra.db'));
  fs.writeFileSync(path.join(dir, 'native.db'), '');
  assert.equal(resolveDbPath(dir), path.join(dir, 'native.db'));
});

test('saved accounts using the old noctra* names are upgraded when read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-legacy-accounts-'));
  process.env.NATIVE_TEST_USER_DATA = dir;
  require('./electron-stub.js');
  const auth = require('../electron/auth.js');
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({
    activeId: 'noctra-1',
    accounts: [
      { id: 'noctra-1', name: 'Old', type: 'noctra', token: 't' },
      { id: 'ms-1', name: 'Premium', type: 'microsoft', noctraToken: 'link-token', noctraLink: { userId: 'u1', name: 'Old' }, noctraNotLinkedAt: 5 }
    ]
  }));
  const { accounts } = auth.readAccounts(dir);
  assert.equal(accounts[0].type, 'native');
  assert.equal(accounts[1].nativeToken, 'link-token');
  assert.deepEqual(accounts[1].nativeLink, { userId: 'u1', name: 'Old' });
  assert.equal(accounts[1].nativeNotLinkedAt, 5);
  for (const key of ['noctraToken', 'noctraLink', 'noctraNotLinkedAt']) assert.equal(key in accounts[1], false);
});
