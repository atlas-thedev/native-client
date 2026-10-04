const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const textureCache = require('../electron/textureCache');

test('texture cache stores by sha256 and serves cached bytes without fetching', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-tc-'));
  textureCache.init(dir);
  const bytes = Buffer.from('a cape texture that is long enough to cache');
  const hash = textureCache.write(bytes);
  assert.equal(hash, textureCache.sha(bytes));
  assert.ok(fs.existsSync(path.join(dir, 'cache', 'textures', `${hash}.png`)));
  let fetched = 0;
  const got = await textureCache.fetchCached(`https://api.example/csl/textures/${hash}`, { fetchImpl: async () => { fetched += 1; throw new Error('no'); } });
  assert.deepEqual(got, bytes);
  assert.equal(fetched, 0);
});

test('texture cache downloads once, then reuses; rejects tampered files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-tc-'));
  textureCache.init(dir);
  const bytes = Buffer.from('another texture body for the download test');
  const hash = textureCache.sha(bytes);
  let fetched = 0;
  const fetchImpl = async () => { fetched += 1; return { ok: true, arrayBuffer: async () => bytes }; };
  const url = `https://api.example/csl/textures/${hash}`;
  assert.deepEqual(await textureCache.fetchCached(url, { fetchImpl }), bytes);
  assert.deepEqual(await textureCache.fetchCached(url, { fetchImpl }), bytes);
  assert.equal(fetched, 1);
  fs.writeFileSync(path.join(dir, 'cache', 'textures', `${hash}.png`), Buffer.from('tampered contents that do not match hash'));
  assert.equal(textureCache.read(hash), null);
  assert.equal(textureCache.hashFromUrl('https://x/y/not-a-hash'), null);
});
