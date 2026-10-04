const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../src/lib/skins.js'), 'utf8')
  .replace(/export const /g, 'const ')
  .replace(/export function /g, 'function ')
  .replace(/export \{[^}]+\};?/g, '')
  .replace(/export const accountIdentifier = skinIdentifier;/, 'const accountIdentifier = skinIdentifier;');

const skinIdentifier = new Function(`${source}; return skinIdentifier;`)();
const isLocalIdentity = new Function(`${source}; return isLocalIdentity;`)();
const loadSkinTexture = new Function(`${source}; return loadSkinTexture;`)();

test('Native and offline accounts default to Steve or Alex until a skin is uploaded', () => {
  assert.equal(skinIdentifier({ type: 'native', id: 'native-1', uuid: 'generated-uuid', name: 'PremiumName' }), 'MHF_Steve');
  assert.equal(skinIdentifier({ type: 'native', id: 'native-1', uuid: 'generated-uuid', name: 'PremiumName', model: 'slim' }), 'MHF_Alex');
  assert.equal(skinIdentifier({ type: 'offline', id: 'offline-1', uuid: 'generated-uuid', name: 'OfflineName' }), 'MHF_Steve');
  assert.equal(skinIdentifier(null, 'offline-1', 'OfflineName'), 'MHF_Steve');
});

test('Microsoft avatars continue to resolve by authoritative UUID', () => {
  assert.equal(skinIdentifier({ type: 'microsoft', uuid: '1234-5678', name: 'PremiumName' }), '12345678');
});

test('isLocalIdentity flags locally-generated accounts so they self-heal from the wardrobe', () => {
  assert.equal(isLocalIdentity({ type: 'native', id: 'native-1' }), true);
  assert.equal(isLocalIdentity({ type: 'offline', id: 'offline-1' }), true);
  assert.equal(isLocalIdentity({ id: 'native-abc' }), true);
  assert.equal(isLocalIdentity({ id: 'offline-abc' }), true);
  assert.equal(isLocalIdentity({ type: 'microsoft', uuid: '1234-5678', name: 'PremiumName' }), false);
  assert.equal(isLocalIdentity(undefined), false);
});

test('skin loader accepts both synchronous texture sources and asynchronous URLs', async () => {
  const canvasViewer = {
    loadSkin(sourceValue, options) {
      assert.equal(sourceValue, 'decoded-canvas');
      assert.deepEqual(options, { model: 'slim' });
      return undefined;
    }
  };
  await assert.doesNotReject(loadSkinTexture(canvasViewer, 'decoded-canvas', 'slim'));

  let urlFinished = false;
  const urlViewer = {
    loadSkin() {
      return Promise.resolve().then(() => { urlFinished = true; });
    }
  };
  await loadSkinTexture(urlViewer, 'https://example.test/skin.png', 'default');
  assert.equal(urlFinished, true);
});
