const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function render(source) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-partners-ui-'));
  const entry = path.join(workDir, 'entry.jsx');
  const bundle = path.join(workDir, 'bundle.cjs');
  fs.writeFileSync(entry, source);
  require('esbuild').buildSync({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
    loader: { '.css': 'empty', '.png': 'dataurl', '.webp': 'dataurl' }, outfile: bundle, logLevel: 'error',
    nodePaths: [path.join(ROOT, 'node_modules')]
  });
  try { return execFileSync(process.execPath, [bundle], { encoding: 'utf8' }); }
  finally { fs.rmSync(workDir, { recursive: true, force: true }); }
}

test('partner card draws the partner with its motion preset and colours', () => {
  const html = render(`
globalThis.window = { native: {} };
const React = require('react');
const { renderToString } = require('react-dom/server');
const mod = require(${JSON.stringify(path.join(ROOT, 'src/features/partners/PartnerCard.jsx'))});
const aurex = mod.BUILT_IN_PARTNERS[0];
process.stdout.write(renderToString(React.createElement('div', null,
  React.createElement(mod.default, { partner: aurex, size: 'hero' }),
  React.createElement(mod.default, { partner: { ...aurex, animation: 'glitch', code: 'NATIVE10', logo: '/v1/site/partners/media/other.png' } }))));
`);
  assert.match(html, /Aurex Hosting/);
  assert.match(html, /pt-motion-aurora/);
  assert.match(html, /pt-motion-glitch/);
  assert.match(html, /--pt-accent:#8b5cf6/);
  assert.match(html, /NATIVE10/);
  assert.match(html, /https:\/\/api\.playnative\.net\/v1\/site\/partners\/media\/other\.png/);
  assert.match(html, /data:image\/webp;base64/, 'bundled Aurex art is used instead of the server copy');
});

test('admin partners editor lists partners and previews the selected one', () => {
  const html = render(`
globalThis.window = { native: { admin: {} } };
const React = require('react');
const { renderToString } = require('react-dom/server');
const AdminPartners = require(${JSON.stringify(path.join(ROOT, 'src/features/admin/AdminPartners.jsx'))}).default;
const doc = { settings: { partners: [{ id: 'aurex01', name: 'Aurex Hosting', website: 'https://www.aurex.lk/en', logo: '/v1/site/partners/media/aurex-logo-v1.webp', animation: 'orbit', accent: '#8b5cf6', enabled: true, tier: 'featured', order: 0 }] } };
process.stdout.write(renderToString(React.createElement(AdminPartners, { doc, setDoc() {} })));
`);
  assert.match(html, /Aurex Hosting/);
  assert.match(html, /Orbit/);
  assert.match(html, /Shown on playnative\.net/);
});
