const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const load = () => import('../src/features/skins/presetTexture.js');

test('preset capes inlined as data: URLs are used directly (CSP blocks fetching them)', async () => {
  const { presetTextureDataUrl } = await load();
  const url = 'data:image/png;base64,iVBORw0KGgo=';
  const result = await presetTextureDataUrl({ name: 'Founder', textureUrl: url }, () => { throw new Error('must not fetch'); });
  assert.strictEqual(result, url);
});

test('preset capes served as files are fetched and encoded byte-for-byte', async () => {
  const { presetTextureDataUrl } = await load();
  const png = fs.readFileSync(path.join(__dirname, '..', 'src', 'assets', 'capes', 'founders.png'));
  const result = await presetTextureDataUrl({ name: 'Founder', textureUrl: '/assets/founders.png' }, async () => ({ ok: true, arrayBuffer: async () => png }));
  assert.strictEqual(result, `data:image/png;base64,${png.toString('base64')}`);
});

test('the locker no longer fetch()es preset cape URLs itself', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'skins', 'LockerView.jsx'), 'utf8');
  assert.ok(!/fetch\(cape\.textureUrl\)/.test(source));
  assert.ok(source.includes('presetTextureDataUrl(cape)'));
});
