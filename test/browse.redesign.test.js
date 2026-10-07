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

test('Browse redesign renders full-width glass grid and cards', { skip: !esbuild && 'esbuild is not installed' }, () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-browse-redesign-'));
  const entry = path.join(workDir, 'entry.jsx');
  const bundle = path.join(workDir, 'bundle.cjs');

  fs.writeFileSync(entry, `
globalThis.window = {
  native: {
    version: '3.9.105',
    openExternal() {},
    minimize() {},
    maximize() {},
    close() {},
    mods: { installed: async () => ({}) },
    settings: {
      load: async () => ({ resolution: { width: 1920, height: 1080 }, memory: { min: 1, max: 4 } }),
      systemMemory: async () => ({ totalGb: 16 })
    },
    instance: {
      worldList: async () => [],
      listDir: async () => []
    }
  },
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  fetch: async () => ({
    ok: true,
    json: async () => ({ hits: [{ project_id: 'iris', title: 'Iris Shaders', description: 'Modern shaders mod', downloads: 5000000, follows: 12000, display_categories: ['shaders', 'optimization'] }], total_hits: 1 })
  })
};
globalThis.document = { documentElement: { dataset: {}, style: { setProperty() {} } }, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const React = require('react');
const { renderToString } = require('react-dom/server');
const { I18nProvider } = require(${JSON.stringify(path.join(ROOT, 'src/i18n/I18nProvider.jsx'))});
const BrowseView = require(${JSON.stringify(path.join(ROOT, 'src/features/browser/BrowseView.jsx'))}).default;
const SettingsTab = require(${JSON.stringify(path.join(ROOT, 'src/features/cluster/SettingsTab.jsx'))}).default;

const fabricInst = { id: 'f-1', name: 'Fabric 1.21', version: '1.21.1', loader: 'Fabric', totalPlaytime: 3600 };

const browseHtml = renderToString(React.createElement(I18nProvider, null,
  React.createElement(BrowseView, {
    instances: [fabricInst],
    selectedCluster: fabricInst,
    onSelectCluster() {},
    onNotify() {},
    initialResults: [{ project_id: 'iris', title: 'Iris Shaders', description: 'Modern shaders mod', downloads: 5000000, follows: 12000, display_categories: ['shaders', 'optimization'] }]
  })
));

process.stdout.write('---SPLIT---');

const settingsHtml = renderToString(React.createElement(I18nProvider, null,
  React.createElement(SettingsTab, {
    cluster: { ...fabricInst, overrides: { resolution: { enabled: true, width: 1920, height: 1080 }, memory: { enabled: true, max: 8 }, jvmEnabled: true } },
    onUpdateCluster() {},
    onDirtyChange() {}
  })
));

process.stdout.write(browseHtml + '---SPLIT---' + settingsHtml);
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

  const raw = require('child_process').execFileSync('node', [bundle], { encoding: 'utf8' });
  const parts = raw.split('---SPLIT---');
  const browseHtml = parts[1];
  const settingsHtml = parts[2];

  // Assert BrowseView UI elements (redesign: full-width grid, no filter sidebar)
  assert.ok(browseHtml.includes('browse-header-bar'), 'Browse header bar is rendered');
  assert.ok(browseHtml.includes('Iris Shaders'), 'Project card title is rendered');
  assert.ok(browseHtml.includes('5.0M'), 'Downloads formatted in JetBrains Mono');
  assert.ok(browseHtml.includes('browse-btn-install'), 'Install button is rendered');

  // Assert SettingsTab UI elements
  // SettingsTab (per-instance overrides redesign)
  assert.ok(settingsHtml.includes('nis-banner'), 'Override summary banner rendered');
  assert.ok(settingsHtml.includes('of 4 overriding global'), 'Override count rendered');
  assert.ok(settingsHtml.includes('Game Resolution'), 'Game resolution card rendered');
  assert.ok(settingsHtml.includes('Native display'), 'Native display preset button rendered');
  assert.ok(settingsHtml.includes('Allocated Memory (RAM)'), 'Memory card rendered');
  assert.ok(settingsHtml.includes('nis-mem-quick'), 'Memory quick picks rendered');
  assert.ok(settingsHtml.includes('Java Runtime'), 'Java card rendered');
  assert.ok(settingsHtml.includes('Save changes'), 'Save changes button rendered');

  fs.rmSync(workDir, { recursive: true, force: true });
});

test('Instance manager renders big curved version banner, white active/hover icons and texts, and restored close geometry', () => {
  const cdCode = fs.readFileSync(path.join(ROOT, 'src/features/cluster/ClusterDetailView.jsx'), 'utf8');
  assert.ok(cdCode.includes('im-identity-banner-wrap'), 'Instance manager renders big version banner container');
  assert.ok(cdCode.includes('getClusterArt(cluster)'), 'Instance manager passes cluster to getClusterArt');

  const imCss = fs.readFileSync(path.join(ROOT, 'src/features/cluster/InstanceManager.css'), 'utf8');
  assert.ok(imCss.includes('.im-identity-banner-wrap'), 'Banner wrap is styled in InstanceManager.css');
  assert.ok(imCss.includes('top: 13px;'), 'Close button is vertically centered in toolbar without overlap');
  assert.ok(imCss.includes('padding: 0 64px 0 24px;'), 'Toolbar reserves right gutter for close button');
  assert.ok(imCss.includes('.instance-manager .im-nav.active'), 'Active nav item has its own state');
  assert.ok(/\.instance-manager \.im-nav \{[^}]*width: 100%/.test(imCss), 'Every nav item, including Advanced, is full width');
  assert.ok(!imCss.includes('.im-nav-settings {'), 'Advanced uses the same nav item styling as the other sections');

  for (const file of [
    'src/features/cluster/InstanceManager.css',
    'src/features/cluster/SettingsTab.css',
    'src/features/instances/InstancesView.css'
  ]) {
    const css = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/gradient\(/.test(css), `${file} uses solid colours only`);
    assert.ok(!/brand-glow|box-shadow:\s*0 0 \d+px/.test(css), `${file} has no glow effects`);
  }

  const smCss = fs.readFileSync(path.join(ROOT, 'src/features/cluster/ScreenshotManager.css'), 'utf8');
  assert.ok(smCss.includes('padding: 20px 24px 32px;'), 'Screenshot panel matches modal content padding');
  assert.ok(smCss.includes('background: transparent;'), 'Screenshot panel uses transparent background without box-in-box');

  const ddCss = fs.readFileSync(path.join(ROOT, 'src/components/ui/Dropdown.css'), 'utf8');
  assert.ok(ddCss.includes('.dropdown-option.active') && ddCss.includes('color: #ffffff;'), 'Dropdown active option text is white');
  assert.ok(ddCss.includes('.dropdown-option:hover:not(:disabled)') && ddCss.includes('color: #ffffff;'), 'Dropdown hover option text is white');
});

test('Browse default banner, matching instance content headers, and white plus icons', () => {
  const cardCode = fs.readFileSync(path.join(ROOT, 'src/features/browser/components/ProjectCard.jsx'), 'utf8');
  assert.ok(!cardCode.includes('defaultBanner'), 'Discover cards load no banner image');
  assert.ok(!cardCode.includes('featured_gallery'), 'Discover cards skip gallery banners');

  const detailCode = fs.readFileSync(path.join(ROOT, 'src/features/browser/components/ProjectDetail.jsx'), 'utf8');
  assert.ok(detailCode.includes('defaultBanner'), 'ProjectDetail imports default banner');
  assert.ok(detailCode.includes('Tricky_Trials.jpg'), 'ProjectDetail uses Tricky_Trials default banner');

  const smCode = fs.readFileSync(path.join(ROOT, 'src/features/cluster/ScreenshotManager.jsx'), 'utf8');
  assert.ok(smCode.includes('im-upload-banner sm-upload-banner'), 'Screenshot manager uses the same banner layout as other content pages');
  assert.ok(smCode.includes('im-upload-banner-title">Screenshots'), 'Screenshot banner carries the page title');

  const contentCode = fs.readFileSync(path.join(ROOT, 'src/features/cluster/InstanceContentTab.jsx'), 'utf8');
  assert.ok(!contentCode.includes('+ {title}'), 'Content page titles do not include a leading plus sign');

  const navbarCode = fs.readFileSync(path.join(ROOT, 'src/features/shell/AppNavbar.jsx'), 'utf8');
  const navbarCss = fs.readFileSync(path.join(ROOT, 'src/features/shell/AppNavbar.css'), 'utf8');
  assert.ok(navbarCode.includes('<Logo height={11} variant="mark"'), 'Title-bar logo matches the compact build text');
  assert.ok(navbarCss.includes('filter: grayscale(1)') && navbarCss.includes('opacity: 0.72'), 'Title-bar logo uses a muted grayscale treatment');

  const globalCss = fs.readFileSync(path.join(ROOT, 'src/styles/global.css'), 'utf8');
  assert.ok(globalCss.includes('svg.lucide-plus') && globalCss.includes('stroke: #ffffff !important;'), 'Plus icons across all pages are pure white');
});

