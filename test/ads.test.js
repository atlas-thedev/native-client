'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('ads: banners download once, then load from disk (also offline)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-'));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(60, 1)]);
  const feed = { ok: true, ads: [{ id: 'discord01', title: 'Join', image: 'https://api.example/b1.png', url: 'https://discord.gg/playnative', player: true }, { id: 'bad', image: 'http://x/y.png', url: 'https://x' }] };
  let imageHits = 0;
  let online = true;
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (!online) throw new Error('offline');
    if (String(url).endsWith('/v1/site/ads')) return { ok: true, json: async () => feed };
    imageHits += 1;
    return { ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => png };
  };
  try {
    delete require.cache[require.resolve('../electron/ads.js')];
    const ads = require('../electron/ads.js');
    ads.init({ app: { getPath: () => dir } }, { handle() {} });
    const first = await ads.list({ force: true });
    assert.equal(first.ads.length, 1);
    assert.equal(first.ads[0].player, true);
    assert.match(first.ads[0].image, /^data:image\/png;base64,/);
    await ads.list({ force: true });
    assert.equal(imageHits, 1, 'second load must reuse the downloaded banner');
    online = false;
    const offline = await ads.list({ force: true });
    assert.equal(offline.ads.length, 1);
    assert.equal(offline.offline, true);
    assert.equal(imageHits, 1);
  } finally {
    global.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
