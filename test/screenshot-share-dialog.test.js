const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

require('./electron-stub');
const instance = require('../electron/instance');

const ROOT = path.join(__dirname, '..');
const MANAGER = JSON.stringify(path.join(ROOT, 'src/features/cluster/ScreenshotManager.jsx'));

/** Bundles a small script that imports the real ScreenshotManager and prints a JSON result. */
function run(body) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-share-dialog-'));
  const entry = path.join(workDir, 'entry.jsx');
  const bundle = path.join(workDir, 'bundle.cjs');
  fs.writeFileSync(entry, `
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const calls = { reads: [], uploads: [], friends: [], groups: [] };
globalThis.window = { native: {
  instance: { screenshotData: async (id, name, options) => { calls.reads.push(options); return 'data:image/jpeg;base64,AAAA'; } },
  relay: { sendGroupMessage: async (id) => { if (id === 'g-bad') throw new Error('group offline'); calls.groups.push(id); return { ok: true }; }, getGroups: async () => ({ ok: true, groups: [] }) }
}, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout };
globalThis.localStorage = { getItem: () => null, setItem() {} };
const manager = require(${MANAGER});
${body}
`);
  require('esbuild').buildSync({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
    loader: { '.css': 'empty', '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' },
    outfile: bundle, logLevel: 'error', nodePaths: [path.join(ROOT, 'node_modules')]
  });
  const out = execFileSync(process.execPath, [bundle], { encoding: 'utf8' });
  fs.rmSync(workDir, { recursive: true, force: true });
  return JSON.parse(out);
}

test('a failing recipient never stops the others, and a retry reuses the upload', () => {
  const out = run(`
const social = {
  uploadMedia: async (data, name) => { calls.uploads.push(name); return { ok: true, url: 'https://cdn.test/s.jpg' }; },
  sendMessage: async (id) => { if (id === 'f-bad') return { ok: false, error: 'Blocked' }; calls.friends.push(id); return { ok: true }; }
};
(async () => {
  const base = { cluster: { id: 'i', name: 'Survival' }, shot: { name: 'big.png' }, social, caption: '' };
  const recipients = [
    { kind: 'friend', id: 'f-ok', name: 'Alice' }, { kind: 'friend', id: 'f-bad', name: 'Bob' },
    { kind: 'group', id: 'g-bad', name: 'Squad' }, { kind: 'group', id: 'g-ok', name: 'Team' }];
  const first = await manager.shareScreenshot({ ...base, recipients });
  const retry = await manager.shareScreenshot({ ...base, recipients: [recipients[1]], upload: first.upload });
  process.stdout.write(JSON.stringify({ first, retry, calls }));
})();`);
  assert.equal(out.first.sent, 2);
  assert.equal(out.first.failed, 2);
  assert.deepEqual(out.first.failedTargets.map((f) => f.name).sort(), ['Bob', 'Squad']);
  assert.equal(out.first.failedTargets.find((f) => f.name === 'Bob').error, 'Blocked');
  assert.equal(out.first.failedTargets.find((f) => f.name === 'Squad').error, 'group offline');
  assert.deepEqual(out.first.sentTargets.sort(), ['friend:f-ok', 'group:g-ok']);
  assert.equal(out.calls.uploads.length, 1, 'the retry sent the same upload');
  assert.deepEqual(out.calls.reads, [{ thumbnail: false, share: true }], 'asks the main process for a shareable (size-capped) copy');
  assert.equal(out.calls.uploads[0], 'big.jpg', 'a picture saved as JPEG gets a .jpg name');
  assert.equal(out.retry.failed, 1);
});

test('the dialog shows each friend\'s real face, online friends first, and the sender\'s avatar', () => {
  const out = run(`
const social = { friends: [
  { id: 'f1', name: 'Zed', status: 'offline', skinUrl: null },
  { id: 'f2', name: 'Alice', status: 'in-game', activity: 'Playing Hypixel', skinUrl: 'https://skins.test/alice.png' },
  { id: 'f3', name: 'Bob', status: 'online', skinUrl: null }] };
const html = renderToStaticMarkup(React.createElement(manager.ShareScreenshotDialog, {
  cluster: { id: 'i', name: 'Survival' }, shot: { name: 'castle.png', size: 2048, modified: 0 }, social,
  account: { id: 'me', name: 'Steve', type: 'offline' }, onClose() {}, onShared() {} }));
process.stdout.write(JSON.stringify({ html, presence: ['in-game', 'online', 'offline'].map((status) => manager.presenceOf({ kind: 'friend', status })) }));`);
  const html = out.html;
  const order = ['Alice', 'Bob', 'Zed'].map((name) => html.indexOf(`<strong>${name}`));
  assert.ok(order.every((at) => at > 0), 'every friend is listed');
  assert.ok(order[0] < order[1] && order[1] < order[2], 'in-game, then online, then offline');
  assert.match(html, /Playing Hypixel/);
  assert.match(html, /sm-section-label">Friends</);
  assert.doesNotMatch(html, /lucide-user-round/, 'no generic user icon in place of a face');
  assert.match(html, /sm-target-face/, 'friends get a real avatar');
  assert.match(html, /Steve/, 'the sender is shown as in chat');
  assert.match(html, /How it will look in chat/);
  assert.deepEqual(out.presence.map((p) => p.status), ['in-game', 'online', 'offline']);
  assert.equal(out.presence[0].color, '#d9a6da', 'same colours as the Relay inbox');
});

test('big screenshots are shrunk under the server limit, small ones are sent untouched', () => {
  const sizes = { 92: 9e6, 85: 7.6e6, 75: 6.2e6, 62: 4e6 };
  const made = [];
  const fake = (w, h) => ({
    getSize: () => ({ width: w, height: h }),
    resize: ({ width, height }) => fake(width, height),
    toJPEG(quality) { made.push([w, quality]); return Buffer.alloc(sizes[quality]); }
  });
  const bytes = instance.compressForShare(fake(3840, 2160));
  assert.ok(bytes.length <= 7 * 1024 * 1024);
  assert.deepEqual(made.at(-1), [2560, 75], 'first fit: 2560 wide at quality 75');
  assert.equal(instance.compressForShare({ getSize: () => ({ width: 0, height: 0 }) }), null);
  const never = { getSize: () => ({ width: 100, height: 100 }), resize: () => never, toJPEG: () => Buffer.alloc(9e6) };
  assert.equal(instance.compressForShare(never), null, 'nothing fits: no picture rather than a broken one');
});
