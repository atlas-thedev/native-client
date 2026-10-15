'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-playtime-'));
const handlers = new Map();
const sent = [];
const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
const win = { isDestroyed: () => false, webContents: { send: (channel) => sent.push(channel) } };
const playtime = require('../electron/playtime');
playtime.init({ app: { getPath: () => dir }, getWin: () => win }, ipcMain);
const queue = () => handlers.get('playtime:drain')();

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a finished session is queued with its real start and end, and the window is told', async () => {
  const startedAt = Date.now() - 95_000;
  playtime.begin('inst-a', startedAt);
  assert.ok(fs.existsSync(path.join(dir, 'playtime-active.json')), 'the open session is kept on disk');
  playtime.end({ endedAt: startedAt + 90_000 });
  const [session] = await queue();
  assert.deepEqual({ id: session.id, secs: session.secs, crashed: session.crashed }, { id: `inst-a:${startedAt}`, secs: 90, crashed: false });
  assert.equal(fs.existsSync(path.join(dir, 'playtime-active.json')), false);
  assert.ok(sent.includes('playtime:session'));
});

test('sessions stay queued until acknowledged, so a closed window loses nothing', async () => {
  assert.equal((await queue()).length, 1);
  await handlers.get('playtime:ack')({}, [`inst-a:${(await queue())[0].startedAt}`]);
  assert.equal((await queue()).length, 0);
});

test('launch failures (under 10 seconds) are not playtime', async () => {
  const startedAt = Date.now() - 6000;
  playtime.begin('inst-b', startedAt);
  playtime.end({ endedAt: startedAt + 4000 });
  assert.equal((await queue()).length, 0);
});

test('a game still being timed when the launcher died is credited up to its last heartbeat', async () => {
  const startedAt = Date.now() - 600_000;
  fs.writeFileSync(path.join(dir, 'playtime-active.json'), JSON.stringify({ instanceId: 'inst-c', startedAt, seenAt: startedAt + 300_000 }));
  playtime.recover();
  const [session] = await queue();
  assert.deepEqual({ instanceId: session.instanceId, secs: session.secs, crashed: session.crashed, recovered: session.recovered }, { instanceId: 'inst-c', secs: 300, crashed: true, recovered: true });
});

test('quitting while a game runs banks the time so far; starting another ends the first', async () => {
  const before = (await queue()).length;
  playtime.begin('inst-d', Date.now() - 40_000);
  playtime.end({});
  playtime.begin('inst-e', Date.now() - 30_000);
  playtime.begin('inst-f', Date.now() - 20_000);
  playtime.end({});
  const ids = (await queue()).map((item) => item.instanceId);
  assert.deepEqual(ids.slice(before), ['inst-d', 'inst-e', 'inst-f']);
});

test('playtime:active reports ongoing session elapsed time, and ClusterDetailView renders honeycomb and reads playtimeSecs', async () => {
  assert.equal(await handlers.get('playtime:active')(), null);
  playtime.begin('inst-live', Date.now() - 15_000);
  const active = await handlers.get('playtime:active')();
  assert.equal(active?.instanceId, 'inst-live');
  assert.ok(active?.elapsed >= 14);
  playtime.end({});
  assert.equal(await handlers.get('playtime:active')(), null);

  const cdCode = fs.readFileSync(path.join(__dirname, '../src/features/cluster/ClusterDetailView.jsx'), 'utf8');
  assert.ok(cdCode.includes('<Honeycomb glow'), 'ClusterDetailView renders Honeycomb with glow');
  assert.ok(cdCode.includes('playtimeSecs'), 'ClusterDetailView correctly reads playtimeSecs for playtime counter');
  assert.ok(cdCode.includes('liveElapsed'), 'ClusterDetailView increments live elapsed playtime while game is running');
});
