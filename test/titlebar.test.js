const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
test('title bar renders build, status, accessible search state and restore controls', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'native-titlebar-'));
  try {
    const entry = path.join(work, 'entry.jsx');
    const bundle = path.join(work, 'bundle.cjs');
    fs.writeFileSync(entry, `
      globalThis.window = { native: { version: '6.0.3' } };
      const React = require('react');
      const { renderToString } = require('react-dom/server');
      const AppNavbar = require(${JSON.stringify(path.join(ROOT, 'src/features/shell/AppNavbar.jsx'))}).default;
      const { I18nProvider } = require(${JSON.stringify(path.join(ROOT, 'src/i18n/I18nProvider.jsx'))});
      const { DownloadManagerProvider } = require(${JSON.stringify(path.join(ROOT, 'src/features/shell/DownloadManagerContext.jsx'))});
      process.stdout.write(renderToString(React.createElement(I18nProvider, null,
        React.createElement(DownloadManagerProvider, null,
          React.createElement(AppNavbar, {
            isMaximized: true, isSearchOpen: true, onOpenSearch() {}, onOpenWebsite() {},
            currentTab: 'home', liveUserCount: 123,
            updateStatus: { type: 'downloading', percent: 52 },
            networkStatus: { state: 'offline' }
          })
        )
      )));
    `);
    require('esbuild').buildSync({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl' }, nodePaths: [path.join(ROOT, 'node_modules')], logLevel: 'error' });
    const html = execFileSync(process.execPath, [bundle], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).replace(/<!--.*?-->/g, '').replace(/data:image[^"]*/g, 'image');
    assert.match(html, /native-build-version[^>]*>v6\.0\.3/);
    assert.match(html, /aria-expanded="true"/);
    assert.match(html, /aria-keyshortcuts="Control\+K"/);
    assert.match(html, /title="Restore down" aria-label="Restore down"/);
    assert.match(html, /title="Minimize" aria-label="Minimize"/);
    assert.match(html, /native-update-pill downloading/);
    assert.match(html, /--p:52%/);
    assert.match(html, /native-net-pill offline/);
    assert.match(html, /native-live-users/);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});
