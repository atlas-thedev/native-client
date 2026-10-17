'use strict';
/* MCLC never re-downloaded a damaged library (its sha1 check wasn't awaited); the launcher's patch does. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

require('../electron/loaders').patchMclc();
const Handler = require('minecraft-launcher-core/components/handler');

test('a damaged library is downloaded again; good, missing and generated ones are handled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-libs-'));
  const put = (rel, data) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), data); };
  const sha1 = (data) => crypto.createHash('sha1').update(data).digest('hex');
  put('a/good/1/good-1.jar', 'good');
  put('a/bad/1/bad-1.jar', 'half a file');
  put('a/gen/1/gen-1.jar', 'generated');
  const lib = (n, data, url = `https://libs.example/${n}`) => ({ name: `a:${n}:1`, downloads: { artifact: { path: `a/${n}/1/${n}-1.jar`, sha1: sha1(data), url } } });
  const downloaded = [];
  const fake = {
    parseRule: () => false,
    popString: Handler.prototype.popString,
    checkSum: async (hash, file) => sha1(fs.readFileSync(file)) === hash,
    downloadAsync: async (url) => { downloaded.push(url); },
    client: { emit: () => {} }
  };
  const libs = await Handler.prototype.downloadToDirectory.call(fake, dir, [
    lib('good', 'good'), lib('bad', 'the whole file'), lib('missing', 'x'), lib('gen', 'other', '')
  ], 'classes');
  assert.deepEqual(downloaded.sort(), ['https://libs.example/bad', 'https://libs.example/missing']);
  assert.equal(libs.length, 4);
  fs.rmSync(dir, { recursive: true, force: true });
});
