const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

let esbuild = null;
try {
  esbuild = require('esbuild');
} catch {
  esbuild = null;
}

test('BrowseView disables mod downloads for vanilla instances and renders warning', { skip: !esbuild && 'esbuild is not installed' }, () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-browse-ui-'));
  const entry = path.join(workDir, 'entry.jsx');
  const bundle = path.join(workDir, 'bundle.cjs');

  fs.writeFileSync(entry, `
globalThis.window = {
  native: { version: '3.9.66', openExternal() {}, minimize() {}, maximize() {}, close() {}, mods: { installed: async () => ({}) } },
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  fetch: async () => ({ ok: true, json: async () => ({ hits: [{ project_id: 'test-mod', title: 'Sodium', description: 'Optimization mod', downloads: 1000, follows: 50 }], total_hits: 1 }) })
};
globalThis.document = { documentElement: { dataset: {}, style: { setProperty() {} } }, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const React = require('react');
const { renderToString } = require('react-dom/server');
const { I18nProvider } = require(${JSON.stringify(path.join(ROOT, 'src/i18n/I18nProvider.jsx'))});
const BrowseView = require(${JSON.stringify(path.join(ROOT, 'src/features/browser/BrowseView.jsx'))}).default;

const vanillaInst = { id: 'v-1', name: 'My Vanilla', version: '1.20.4', loader: 'Vanilla' };

const html = renderToString(React.createElement(I18nProvider, null,
  React.createElement(BrowseView, {
    instances: [vanillaInst],
    selectedCluster: vanillaInst,
    onSelectCluster() {},
    onNotify() {},
    initialResults: [{ project_id: 'test-mod', title: 'Sodium', description: 'Optimization mod', downloads: 1000, follows: 50 }]
  })
));

process.stdout.write(html);
`);

  esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.png': 'dataurl', '.jpg': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
    outfile: bundle,
    logLevel: 'error',
    nodePaths: [path.join(ROOT, 'node_modules')]
  });

  const html = require('child_process').execFileSync('node', [bundle], { encoding: 'utf8' });

  // 1. Toast must be removed completely
  assert.equal(html.includes('browse-download-toast'), false, 'download toast should not exist');

  // 2. Vanilla warning banner must be shown
  assert.ok(html.includes('browse-vanilla-warning'), 'vanilla warning banner should be rendered');
  assert.ok(html.includes('is a Vanilla instance. Minecraft Vanilla does not support mods'), 'warning text explaining vanilla cannot run mods');

  // 3. Mod install button must be disabled for vanilla
  assert.ok(html.includes('is-disabled-vanilla'), 'install button should have disabled vanilla styling class');
  assert.ok(html.includes('Vanilla (No Mods)'), 'install button should show Vanilla (No Mods)');
});
