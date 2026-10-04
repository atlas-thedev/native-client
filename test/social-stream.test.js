'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'native-stream-ud-'));
let connections = 0;
const fake = http.createServer((req, res) => {
  if (req.url.startsWith('/v1/social/stream')) {
    connections += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"type":"hello"}\n\n'); // then silence, like a dead socket
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":true}');
});

test('a silent event stream is dropped and reconnected', async () => {
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  process.env.NATIVE_WARDROBE_API = `http://127.0.0.1:${fake.address().port}`;
  process.env.NATIVE_STREAM_SILENCE_MS = '500';
  process.env.NATIVE_TEST_USER_DATA = userData;
  const stub = require('./electron-stub.js');
  fs.writeFileSync(path.join(userData, 'accounts.json'), JSON.stringify({ activeId: 'u1', accounts: [{ id: 'u1', type: 'native', token: 't' }] }));
  const social = require('../electron/social.js');
  social.init({ app: stub.app, getWin: () => null }, { handle() {} });
  const end = Date.now() + 8000;
  while (connections < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  social.stopStream();
  assert.ok(connections >= 2, `expected a reconnect, saw ${connections} connection(s)`);
});

test.after(() => { fake.closeAllConnections?.(); fake.close(); fs.rmSync(userData, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });
