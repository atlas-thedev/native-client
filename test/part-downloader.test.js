const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const parts = require('../electron/partDownloader');

const DATA = crypto.randomBytes(1024 * 1024 + 12345);
const SHA = crypto.createHash('sha512').update(DATA).digest('base64');

function server({ ranges = true, failEvery = 0, delayMs = 0 } = {}) {
  let hits = 0;
  const requested = [];
  const srv = http.createServer((req, res) => {
    hits += 1;
    if (failEvery && hits % failEvery === 0) { res.destroy(); return; }
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    const send = (buf, status, headers) => {
      res.writeHead(status, { 'Content-Length': buf.length, ...headers });
      if (delayMs) setTimeout(() => res.end(buf), delayMs); else res.end(buf);
    };
    if (ranges && m) {
      const s = Number(m[1]); const e = Number(m[2]);
      requested.push(s);
      send(DATA.subarray(s, e + 1), 206, { 'Content-Range': `bytes ${s}-${e}/${DATA.length}` });
    } else send(DATA, 200, {});
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${srv.address().port}/Native-Client-Setup-9.9.9-x64.exe`,
    close: () => new Promise((r) => srv.close(r)),
    requested,
    hits: () => hits
  })));
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nc-parts-'));

test('downloads in parts and verifies', async () => {
  const s = await server();
  const dest = path.join(tmp(), 'setup.exe');
  const seen = [];
  const r = await parts.download({ url: s.url, dest, size: DATA.length, sha512: SHA, partSize: 64 * 1024, onProgress: (p) => seen.push(p) });
  await s.close();
  assert.equal(r.resumed, false);
  assert.ok(fs.readFileSync(dest).equals(DATA));
  assert.ok(!fs.existsSync(`${dest}.partial`) && !fs.existsSync(`${dest}.parts.json`));
  assert.equal(seen.at(-1).doneParts, seen.at(-1).parts);
  assert.equal(seen.at(-1).parts, Math.ceil(DATA.length / (64 * 1024)));
});

test('a paused download resumes from the saved parts', async () => {
  const s = await server({ delayMs: 5 });
  const dest = path.join(tmp(), 'setup.exe');
  const signal = { cancelled: false };
  await assert.rejects(parts.download({
    url: s.url, dest, size: DATA.length, sha512: SHA, partSize: 64 * 1024, connections: 2, signal,
    onProgress: (p) => { if (p.doneParts >= 5) signal.cancelled = true; }
  }), (e) => e.cancelled === true);
  const saved = await parts.inspect(dest);
  assert.ok(saved.doneParts >= 5 && saved.doneParts < saved.parts);
  const before = s.requested.length;
  const r = await parts.download({ url: s.url, dest, size: DATA.length, sha512: SHA, partSize: 64 * 1024 });
  await s.close();
  assert.equal(r.resumed, true);
  assert.ok(fs.readFileSync(dest).equals(DATA));
  // only the missing parts were fetched again
  assert.ok(s.requested.length - before <= saved.parts - saved.doneParts + 2);
});

test('flaky connections are retried per part', async () => {
  const s = await server({ failEvery: 4 });
  const dest = path.join(tmp(), 'setup.exe');
  await parts.download({ url: s.url, dest, size: DATA.length, sha512: SHA, partSize: 128 * 1024 });
  await s.close();
  assert.ok(fs.readFileSync(dest).equals(DATA));
});

test('a bad checksum throws the parts away', async () => {
  const s = await server();
  const dest = path.join(tmp(), 'setup.exe');
  await assert.rejects(parts.download({ url: s.url, dest, size: DATA.length, sha512: 'bad', partSize: 256 * 1024 }), /verification/);
  await s.close();
  assert.ok(!fs.existsSync(`${dest}.partial`) && !fs.existsSync(`${dest}.parts.json`) && !fs.existsSync(dest));
});

test('servers without range support are reported', async () => {
  const s = await server({ ranges: false });
  const dest = path.join(tmp(), 'setup.exe');
  await assert.rejects(parts.download({ url: s.url, dest, size: DATA.length, sha512: SHA, partSize: 256 * 1024 }), /ranges/);
  // ...and one whole-file part works
  await parts.download({ url: s.url, dest, size: DATA.length, sha512: SHA, partSize: DATA.length });
  await s.close();
  assert.ok(fs.readFileSync(dest).equals(DATA));
});

test('an already finished file is reused', async () => {
  const dir = tmp();
  const dest = path.join(dir, 'setup.exe');
  fs.writeFileSync(dest, DATA);
  const r = await parts.download({ url: 'http://127.0.0.1:9/never', dest, size: DATA.length, sha512: SHA });
  assert.equal(r.resumed, true);
});

test('pausing mid-part before the first part finishes keeps the bytes written so far', async () => {
  const ranges = [];
  const srv = http.createServer((req, res) => {
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    const s = Number(m[1]); const e = Number(m[2]);
    ranges.push([s, e]);
    res.writeHead(206, { 'Content-Length': e - s + 1, 'Content-Range': `bytes ${s}-${e}/${DATA.length}` });
    let pos = s;
    const step = 16 * 1024;
    const iv = setInterval(() => {
      if (res.destroyed || pos > e) { clearInterval(iv); res.end(); return; }
      const next = Math.min(e + 1, pos + step);
      res.write(DATA.subarray(pos, next));
      pos = next;
    }, 5);
    req.on('close', () => clearInterval(iv));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/setup.exe`;
  const dest = path.join(tmp(), 'setup.exe');
  const signal = { cancelled: false };
  try {
    await assert.rejects(parts.download({
      url, dest, size: DATA.length, sha512: SHA, partSize: DATA.length, connections: 1, signal,
      onProgress: (p) => { if (p.transferred >= 64 * 1024) signal.cancel(); }
    }), (e) => e.cancelled === true);
    const saved = await parts.inspect(dest);
    assert.ok(saved && saved.transferred >= 64 * 1024, 'mid-part progress is saved');
    assert.equal(saved.doneParts, 0);
    const r = await parts.download({ url, dest, size: DATA.length, sha512: SHA, partSize: DATA.length, connections: 1 });
    assert.equal(r.resumed, true);
    assert.equal(ranges[1][0], saved.transferred, 'resumes from exact saved byte offset');
    assert.ok(fs.readFileSync(dest).equals(DATA));
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
