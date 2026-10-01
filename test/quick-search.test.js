const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
let esbuild = null;
try { esbuild = require('esbuild'); } catch { esbuild = null; }

function load(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noctra-qs-'));
  const out = path.join(dir, 'out.cjs');
  esbuild.buildSync({ entryPoints: [path.join(ROOT, file)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error' });
  return require(out);
}

test('quick search ranks exact, prefix and initials matches sensibly', { skip: !esbuild && 'esbuild missing' }, () => {
  const qs = load('src/features/search/quickSearchScore.js');
  const items = [
    { id: 'a', group: 'actions', title: 'Create new instance', keywords: ['add'] },
    { id: 'b', group: 'pages', title: 'Instances' },
    { id: 'c', group: 'pages', title: 'Settings', keywords: ['preferences'] },
    { id: 'd', group: 'guides', title: 'Check for updates', keywords: ['version download'] }
  ];
  assert.equal(qs.rankItems(items, 'inst')[0].id, 'b');
  assert.equal(qs.rankItems(items, 'cni')[0].id, 'a', 'initials');
  assert.equal(qs.rankItems(items, 'prefer')[0].id, 'c', 'keywords');
  assert.equal(qs.rankItems(items, 'sod').length, 0, 'no loose keyword matches');
  assert.equal(qs.rankItems(items, '').length, 0);
  const parts = qs.highlight('Create new instance', 'new');
  assert.deepEqual(parts.filter((p) => p.hit).map((p) => p.text), ['new']);
});

test('quick search keeps Modrinth hits safe and recents bounded', { skip: !esbuild && 'esbuild missing' }, () => {
  const qs = load('src/features/search/quickSearchScore.js');
  assert.equal(qs.modrinthHitToItem({ project_id: '../x', title: 'Bad' }), null);
  const item = qs.modrinthHitToItem({ project_id: 'AANobbMI', title: 'Sodium', project_type: 'mod', icon_url: 'https://evil.example/x.png' });
  assert.equal(item.icon, null, 'icons only from the Modrinth CDN');
  assert.equal(item.command.type, 'project');
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  for (let i = 0; i < 20; i += 1) qs.pushRecent(`id${i}`, storage);
  assert.equal(qs.readRecents(storage).length, 8);
  assert.equal(qs.readRecents(storage)[0], 'id19');
  const merged = qs.mergeRemote([{ id: 'x', score: 40 }], [{ id: 'm' }]);
  assert.equal(merged[0].id, 'm', 'weak local matches put Modrinth first');
});

test('quick search is wired to the title bar, Ctrl+K and the How to page', () => {
  const nav = read('src/features/shell/AppNavbar.jsx');
  const shell = read('src/features/shell/Shell.jsx');
  assert.match(nav, /titlebar-search/);
  assert.match(nav, /onSelectTab\('guides'\)/);
  assert.match(shell, /key === 'k'/);
  assert.match(shell, /<QuickSearch/);
  assert.match(shell, /<GuidesView/);
  const css = read('src/features/search/QuickSearch.css');
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /-webkit-app-region: no-drag/);
});

test('guides only stream media from the Noctra guides host', { skip: !esbuild && 'esbuild missing' }, () => {
  const src = read('src/features/guides/guides.js');
  assert.match(src, /SAFE_MEDIA = \/\^https:\\\/\\\/api\\\.nativelaunch\\\.xyz\\\/guides\\\//);
  const guides = load('src/features/guides/guides.js');
  const ids = new Set();
  for (const guide of guides.GUIDES) {
    assert.ok(!ids.has(guide.id), `unique ${guide.id}`);
    ids.add(guide.id);
    assert.ok(guide.steps.length > 0, `${guide.id} has steps`);
  }
});
