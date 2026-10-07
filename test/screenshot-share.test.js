const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('screenshot sharing uploads once and sends the same image to friends and groups', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-share-'));
  const entry = path.join(workDir, 'entry.jsx');
  const bundle = path.join(workDir, 'bundle.cjs');
  fs.writeFileSync(entry, `
const calls = { reads: 0, uploads: 0, friends: [], groups: [] };
globalThis.window = { native: {
  instance: { screenshotData: async () => { calls.reads += 1; return 'data:image/png;base64,AAAA'; } },
  relay: { sendGroupMessage: async (id, payload) => { calls.groups.push({ id, payload }); return { ok: true }; } }
}, addEventListener() {}, removeEventListener() {} };
const { shareScreenshot } = require(${JSON.stringify(path.join(ROOT, 'src/features/cluster/ScreenshotManager.jsx'))});
const social = {
  uploadMedia: async (data, name) => { calls.uploads += 1; calls.upload = { data, name }; return { ok: true, url: 'https://cdn.test/shot.png' }; },
  sendMessage: async (id, content, media) => { calls.friends.push({ id, content, media }); return { ok: true }; }
};
(async () => {
  const result = await shareScreenshot({
    cluster: { id: 'inst-1', name: 'Survival' },
    shot: { name: 'castle.png' },
    social,
    recipients: [{ kind: 'friend', id: 'friend-1' }, { kind: 'group', id: 'group-1' }],
    caption: 'Look at this build'
  });
  process.stdout.write(JSON.stringify({ result, calls }));
})().catch((error) => { console.error(error); process.exit(1); });
`);

  require('esbuild').buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.png': 'dataurl' },
    outfile: bundle,
    logLevel: 'error',
    nodePaths: [path.join(ROOT, 'node_modules')]
  });

  const output = JSON.parse(execFileSync(process.execPath, [bundle], { encoding: 'utf8' }));
  fs.rmSync(workDir, { recursive: true, force: true });

  assert.deepEqual(output.result, { sent: 2, failed: 0, total: 2 });
  assert.equal(output.calls.reads, 1);
  assert.equal(output.calls.uploads, 1);
  assert.equal(output.calls.upload.name, 'castle.png');
  assert.equal(output.calls.friends[0].media.mediaUrl, 'https://cdn.test/shot.png');
  assert.equal(output.calls.groups[0].payload.mediaUrl, 'https://cdn.test/shot.png');
  assert.equal(output.calls.groups[0].payload.content, 'Look at this build');
});

test('ShareScreenshotDialog renders current user avatar, name, and badges', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-share-ui-'));
  const entry = path.join(workDir, 'entry.jsx');
  const bundle = path.join(workDir, 'bundle.cjs');
  fs.writeFileSync(entry, `
globalThis.window = {
  native: {
    relay: { getGroups: async () => ({ ok: true, groups: [] }) },
    accounts: { list: async () => ({ accounts: [], activeId: null }) },
    instance: { screenshotData: async () => 'data:image/png;base64,AAAA' }
  },
  addEventListener() {},
  removeEventListener() {}
};
globalThis.document = { addEventListener() {}, removeEventListener() {} };
const React = require('react');
const { renderToString } = require('react-dom/server');
const { ShareScreenshotDialog } = require(${JSON.stringify(path.join(ROOT, 'src/features/cluster/ScreenshotManager.jsx'))});

const html = renderToString(React.createElement(ShareScreenshotDialog, {
  cluster: { id: 'inst-1', name: 'Survival' },
  shot: { name: 'epic_castle.png', size: 102400, modified: Date.now() },
  social: { friends: [] },
  account: { name: 'OhLlama', badges: ['developer'] },
  onClose() {},
  onShared() {}
}));

process.stdout.write(html);
`);

  require('esbuild').buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.png': 'dataurl' },
    outfile: bundle,
    logLevel: 'error',
    nodePaths: [path.join(ROOT, 'node_modules')]
  });

  const output = execFileSync(process.execPath, [bundle], { encoding: 'utf8' });
  fs.rmSync(workDir, { recursive: true, force: true });

  assert.ok(output.includes('sm-share-sender'));
  assert.ok(output.includes('Sharing as'));
  assert.ok(output.includes('OhLlama'));
  assert.ok(output.includes('native-badges-strip'));
});

