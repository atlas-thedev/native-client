require('./electron-stub');
const test = require('node:test');
const assert = require('node:assert/strict');

test('launcher follows the main website chosen on the backend', async () => {
  const realFetch = global.fetch;
  let answer = { ok: false };
  global.fetch = async () => ({ ok: true, json: async () => answer });
  const site = require('../electron/siteUrl');
  assert.equal(site.siteUrl(), 'https://playnative.fun');
  assert.ok(!site.isSiteHost('newnative.gg'));
  await site.refresh(true);
  answer = { ok: true, site: 'https://newnative.gg', sites: ['newnative.gg', 'bad host!'] };
  await site.refresh(true);
  assert.equal(site.siteUrl(), 'https://newnative.gg');
  assert.ok(site.isSiteHost('www.newnative.gg'));
  assert.ok(site.isSiteHost('playnative.fun'));
  assert.ok(!site.isSiteHost('evil.com'));
  answer = { ok: true, site: 'http://insecure.example' };
  await site.refresh(true);
  global.fetch = realFetch;
  assert.equal(site.siteUrl(), 'https://newnative.gg');
});
