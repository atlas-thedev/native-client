require('./electron-stub');
const test = require('node:test');
const assert = require('node:assert/strict');

test('launcher follows the main website chosen on the backend', async () => {
  const realFetch = global.fetch;
  let answer = { ok: false };
  global.fetch = async () => ({ ok: true, json: async () => answer });
  const site = require('../electron/siteUrl');
  assert.equal(site.siteUrl(), 'https://playnative.net');
  assert.ok(!site.isSiteHost('newnative.gg'));
  await site.refresh(true);
  answer = { ok: true, site: 'https://newnative.gg', sites: ['newnative.gg', 'bad host!'] };
  await site.refresh(true);
  assert.equal(site.siteUrl(), 'https://newnative.gg');
  assert.ok(site.isSiteHost('www.newnative.gg'));
  assert.ok(site.isSiteHost('playnative.net'));
  assert.ok(!site.isSiteHost('evil.com'));
  answer = { ok: true, site: 'http://insecure.example' };
  await site.refresh(true);
  global.fetch = realFetch;
  assert.equal(site.siteUrl(), 'https://newnative.gg');
});

test('obsolete disk cache cannot override the migrated default', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../electron/siteUrl'), 'utf8');
  const sandbox = {
    module: { exports: {} }, URL, Date, AbortSignal,
    fetch: async () => { throw new Error('offline'); },
    require: (name) => {
      if (name === 'node:fs') return { readFileSync: () => JSON.stringify({ site: 'https://obsolete.example', sites: ['obsolete.example'], at: Date.now() }) };
      if (name === 'electron') return { app: { getPath: () => '/fake' } };
      if (name === './social') return { API_ROOTS: [] };
      return require(name);
    },
  };
  vm.runInNewContext(source, sandbox);
  assert.equal(sandbox.module.exports.siteUrl(), 'https://playnative.net');
  assert.equal(sandbox.module.exports.isSiteHost('obsolete.example'), false);
});
