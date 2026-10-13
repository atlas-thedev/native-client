const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('admin bridge distinguishes validation failures from revoked access and restricts routes', async () => {
  const handlers = new Map();
  let status = 400, calls = 0;
  const sandbox = {
    module: { exports: {} }, AbortController, setTimeout, clearTimeout, URLSearchParams,
    fetch: async () => { calls++; return { ok: status === 200, status, text: async () => JSON.stringify(status === 200 ? { ok: true } : { error: 'Title required.' }) }; },
    require: name => {
      if (name === 'electron') return { ipcMain: { handle: (key, handler) => handlers.set(key, handler), removeHandler() {} } };
      if (name === './social') return { getActiveNativeAccount: () => ({ token: 'test-token' }), API_ROOTS: ['https://test.invalid'] };
      throw new Error(`Unexpected dependency: ${name}`);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/admin.js'), 'utf8'), sandbox);
  const { adminFetch, init } = sandbox.module.exports;
  let result = await adminFetch('/site', { method: 'POST', body: {} });
  assert.equal(result.status, 400);
  assert.equal(result.isAdmin, undefined);
  for (status of [401, 403]) {
    result = await adminFetch('/site');
    assert.equal(result.status, status);
    assert.equal(result.isAdmin, false);
  }
  status = 200;
  assert.equal((await adminFetch('/site')).ok, true);
  init();
  const request = handlers.get('admin:request');
  const before = calls;
  assert.equal((await request(null, 'POST', '/site/../users', {})).ok, false);
  assert.equal((await request(null, 'POST', '/unrelated', {})).ok, false);
  assert.equal((await request(null, 'PUT', '/site', {})).ok, false);
  assert.equal(calls, before);
  assert.equal((await request(null, 'POST', '/site', { theme: { halloween: true } })).ok, true);
});
