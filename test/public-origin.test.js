const test = require('node:test');
const assert = require('node:assert/strict');
const { originOf } = require('../server/media');

const req = (host, { proto = null, peer = '127.0.0.1' } = {}) => ({ headers: { host, ...(proto ? { 'x-forwarded-proto': proto } : {}) }, socket: { remoteAddress: peer } });

test('public domains always get https links, even when the proxy hop is plain http', () => {
  assert.equal(originOf(req('api.playnative.net')), 'https://api.playnative.net');
  assert.equal(originOf(req('api.playnative.net', { proto: 'http' })), 'https://api.playnative.net');
  assert.equal(originOf(req('api.playnative.net', { peer: '203.0.113.9' })), 'https://api.playnative.net');
});

test('local addresses keep their real scheme; unknown hosts fall back to the default', () => {
  assert.equal(originOf(req('localhost:3418')), 'http://localhost:3418');
  assert.equal(originOf(req('127.0.0.1:3418', { proto: 'https' })), 'https://127.0.0.1:3418');
  assert.equal(originOf(req('evil.example')), 'https://api.playnative.net');
});
