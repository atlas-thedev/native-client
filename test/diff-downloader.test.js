'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const diff = require('../electron/diffDownloader');

const BLOCK = 64 * 1024;
function blockmap(buf) {
  const checksums = []; const sizes = [];
  for (let i = 0; i < buf.length; i += BLOCK) {
    const part = buf.subarray(i, Math.min(buf.length, i + BLOCK));
    checksums.push(crypto.createHash('sha256').update(part).digest('base64').slice(0, 24));
    sizes.push(part.length);
  }
  return zlib.gzipSync(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, checksums, sizes }] }));
}

function serve(files, stats) {
  const server = http.createServer((req, res) => {
    const body = files[req.url];
    if (!body) { res.statusCode = 404; return res.end(); }
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    if (!m) { res.end(body); return; }
    const [s, e] = [Number(m[1]), Number(m[2])];
    stats.ranged += e - s + 1;
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${s}-${e}/${body.length}`);
    res.end(body.subarray(s, e + 1));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

test('rebuilds the new installer from the old one plus only the changed blocks', async () => {
  const oldBuf = crypto.randomBytes(40 * BLOCK);
  const newBuf = Buffer.concat([oldBuf.subarray(0, 10 * BLOCK), crypto.randomBytes(3 * BLOCK), oldBuf.subarray(12 * BLOCK)]);
  const stats = { ranged: 0 };
  const server = await serve({ '/new.exe': newBuf, '/new.exe.blockmap': blockmap(newBuf), '/old.exe.blockmap': blockmap(oldBuf) }, stats);
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-'));
  const baseFile = path.join(dir, 'old.exe');
  fs.writeFileSync(baseFile, oldBuf);
  try {
    const out = await diff.download({
      url: `${base}/new.exe`, dest: path.join(dir, 'new.exe'), size: newBuf.length,
      sha512: crypto.createHash('sha512').update(newBuf).digest('base64'),
      baseFile, oldBlockmapUrl: `${base}/old.exe.blockmap`, newBlockmapUrl: `${base}/new.exe.blockmap`
    });
    assert.ok(fs.readFileSync(out.path).equals(newBuf));
    assert.strictEqual(out.downloadBytes, 3 * BLOCK);
    assert.strictEqual(stats.ranged, 3 * BLOCK);
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('refuses a base installer that does not match its blockmap', async () => {
  const oldBuf = crypto.randomBytes(8 * BLOCK);
  const server = await serve({ '/new.exe': oldBuf, '/new.exe.blockmap': blockmap(oldBuf), '/old.exe.blockmap': blockmap(oldBuf) }, { ranged: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-'));
  const baseFile = path.join(dir, 'old.exe');
  fs.writeFileSync(baseFile, oldBuf.subarray(0, 5 * BLOCK));
  try {
    await assert.rejects(diff.download({
      url: `${base}/new.exe`, dest: path.join(dir, 'new.exe'), size: oldBuf.length, sha512: 'x',
      baseFile, oldBlockmapUrl: `${base}/old.exe.blockmap`, newBlockmapUrl: `${base}/new.exe.blockmap`
    }), /does not match/);
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('small unchanged gaps between changes are fetched in one request', () => {
  const mk = (cs) => ({ offset: 0, checksums: cs, sizes: cs.map(() => 1000) });
  const { segments } = diff.plan(mk(['a', 'b', 'c', 'd']), mk(['x', 'b', 'y', 'd']));
  assert.deepStrictEqual(segments.map((s) => [s.copy, s.at, s.len]), [[false, 0, 3000], [true, 3000, 1000]]);
});
