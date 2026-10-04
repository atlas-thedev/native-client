const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
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

test('InstancePickerModal renders correctly for multiple matching instances', { skip: !esbuild && 'esbuild is not installed' }, () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-picker-'));
  const entry = path.join(workDir, 'entry.jsx');
  const bundle = path.join(workDir, 'bundle.cjs');

  fs.writeFileSync(entry, `
globalThis.window = {
  native: { version: '3.9.23' },
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
};
globalThis.document = { documentElement: { dataset: {}, style: { setProperty() {} } }, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const React = require('react');
const { renderToString } = require('react-dom/server');
const { I18nProvider } = require(${JSON.stringify(path.join(ROOT, 'src/i18n/I18nProvider.jsx'))});
const InstancePickerModal = require(${JSON.stringify(path.join(ROOT, 'src/features/clusters/InstancePickerModal.jsx'))}).default;

const instances = [
  { id: 'inst-1', name: 'Survival Profile', version: '1.20.4', loader: 'Fabric', memoryMb: 4096, lastPlayed: Date.now() - 60000 },
  { id: 'inst-2', name: 'Modded RPG Profile', version: '1.20.4', loader: 'Fabric', memoryMb: 8192, lastPlayed: null }
];

// 1. Launch Mode
const htmlLaunch = renderToString(React.createElement(I18nProvider, null,
  React.createElement(InstancePickerModal, {
    open: true,
    mode: 'launch',
    version: '1.20.4',
    loader: 'Fabric',
    instances,
    onClose() {},
    onSelect() {},
    onCreateNew() {}
  })
));

// 2. Settings Mode
const htmlSettings = renderToString(React.createElement(I18nProvider, null,
  React.createElement(InstancePickerModal, {
    open: true,
    mode: 'settings',
    version: '1.20.4',
    loader: 'Fabric',
    instances,
    onClose() {},
    onSelect() {},
    onCreateNew() {}
  })
));

// 3. Closed
const htmlClosed = renderToString(React.createElement(I18nProvider, null,
  React.createElement(InstancePickerModal, {
    open: false,
    mode: 'launch',
    version: '1.20.4',
    loader: 'Fabric',
    instances
  })
));

process.stdout.write(JSON.stringify({ htmlLaunch, htmlSettings, htmlClosed }));
`);

  esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.png': 'dataurl', '.jpg': 'dataurl' },
    outfile: bundle,
    logLevel: 'error',
    nodePaths: [path.join(ROOT, 'node_modules')]
  });

  const raw = execFileSync(process.execPath, [bundle], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  fs.rmSync(workDir, { recursive: true, force: true });

  const { htmlLaunch, htmlSettings, htmlClosed } = JSON.parse(raw);

  // Assertions for closed state
  assert.equal(htmlClosed, '', 'closed modal renders nothing');

  // Assertions for launch mode
  assert.match(htmlLaunch, /instance-picker-backdrop/, 'backdrop is present');
  assert.match(htmlLaunch, /Launch Instance/, 'launch title is rendered');
  assert.match(htmlLaunch, /Survival Profile/, 'first instance name is rendered');
  assert.match(htmlLaunch, /Modded RPG Profile/, 'second instance name is rendered');
  assert.match(htmlLaunch, /instance-picker-thumb/, 'artwork thumbnail is rendered');
  assert.match(htmlLaunch, /4 GB/, 'first instance RAM formatted');
  assert.match(htmlLaunch, /8 GB/, 'second instance RAM formatted');
  assert.match(htmlLaunch, /New instance/, 'create new option present');

  // Assertions for settings mode
  assert.match(htmlSettings, /Select Instance/, 'settings title is rendered');
  assert.match(htmlSettings, /instance-picker-thumb/, 'artwork thumbnail is rendered in settings mode');
});
