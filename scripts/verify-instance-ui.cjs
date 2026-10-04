// Isolated Electron integration test. IPC fixtures never touch a user's library.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('node:assert/strict');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'native-ui-test-')));
app.commandLine.appendSwitch('disable-dev-shm-usage');
const instance = { id: 'visual-121', name: 'Tricky Trials', version: '1.21.7', mc_version: '1.21.7', loader: 'Fabric', mc_loader: 'Fabric', created: Date.now(), overrides: { resolution: { enabled: true, width: 1920, height: 1080 }, memory: { enabled: true, min: 1, max: 6 } } };
let library = { instances: [instance], selectedId: instance.id };
let manifest = Object.fromEntries(['Litematica', 'Mod Menu', 'Inventory Profiles Next', 'Chat Patches', 'FerriteCore'].map((title, i) => [String(i), { filename: `mod-${i}.jar`, folder: 'mods', metadata: { title, author: ['masa', 'Terraformers', 'blackd', 'OBro1961', 'malte0811'][i], version: ['0.26.3', '17.0.0', '2.3.1', '8.0-alpha.8', '8.2.0'][i] } }]));
let failWorlds = false, failSave = false;
let adminBadges = ['developer', 'early_supporter'];
const screenshotArt = (hue, title) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><defs><linearGradient id="s" y2="1"><stop stop-color="hsl(${hue} 75% 55%)"/><stop offset="1" stop-color="hsl(${hue + 60} 80% 16%)"/></linearGradient></defs><rect width="640" height="360" fill="url(#s)"/><circle cx="500" cy="80" r="34" fill="#fff6a8"/><path d="M0 285 150 130l100 102 105-142 155 195z" fill="#172b28"/><path d="M0 300h640v60H0z" fill="#173b27"/><text x="24" y="335" fill="white" font-family="sans-serif" font-size="22">${title}</text></svg>`).toString('base64')}`;
const screenshots = [{ name: 'castle-at-sunset.png', size: 1840000, modified: Date.now() - 7200000 }, { name: 'deep-dark-expedition.png', size: 960000, modified: Date.now() - 86400000 }];
const handles = {
  'instances:load': () => library,
  'instances:save': (_e, next) => { if (failSave) throw new Error('Test disk failure'); library = next; return true; },
  'settings:load': () => ({ onboarding: { completed: true, language: 'en' }, memory: { min: 1, max: 4 }, resolution: { width: 854, height: 480, fullscreen: false } }),
  'settings:systemMemory': () => ({ totalGb: 32 }), 'settings:save': () => true,
  'accounts:list': () => ({ accounts: [{ id: 'acc-1', name: 'OhLlama', type: 'native', token: 'visual-token' }], activeId: 'acc-1' }),
  'wardrobe:get': () => ({ active: null, skins: [], capes: [] }), 'wardrobe:sync': () => ({ ok: true }),
  'wardrobe:avatar': () => null,
  'instance:installedVersions': () => [{ version: '1.21.7', loader: 'Fabric' }], 'instance:isInstalled': () => true,
  'instance:worldList': async () => { await new Promise(r => setTimeout(r, 180)); if (failWorlds) throw new Error('Test world read failure'); return [{ name: 'Survival Kingdom', modified: Date.now() - 86400000, sizeBytes: 73400320, artSeed: 148 }, { name: 'Redstone Lab', modified: Date.now() - 604800000, sizeBytes: 18874368, artSeed: 24 }]; },
  'instance:screenshotList': () => screenshots,
  'instance:screenshotData': (_e, _id, name) => screenshotArt(name.includes('castle') ? 205 : 264, name),
  'instance:revealScreenshot': () => ({ ok: true }),
  'instance:deleteScreenshot': () => ({ ok: true }),
  'mods:installed': () => manifest,
  'mods:toggle': (_e, { projectId, enabled }) => { manifest[projectId].filename = manifest[projectId].filename.replace(/\.disabled$/, '') + (enabled ? '' : '.disabled'); return manifest; },
  'instance:listDir': (_e, _id, folder) => folder === 'mods' ? Object.values(manifest).map(mod => ({ name: mod.filename, size: 1820000 })) : [],
  'instance:openFolder': () => true,
  'settings:dataDir': () => '/tmp/native', 'news:list': () => ({ items: [] }), 'updater:status': () => ({ type: 'idle' }),
  'social:getFriends': () => ({ ok: true, friends: [{ id: 'friend-1', name: 'BuilderBee', status: 'online' }] }),
  'social:getStats': () => ({ ok: true, onlineUsers: 10500 }),
  'social:getRequests': () => ({ requests: { received: [], sent: [] } }),
  'social:getConversations': () => ({ conversations: {} }),
  'social:getBlocked': () => ({ blocked: [] }),
  'relay:getGroups': () => ({ ok: true, groups: [{ id: 'group-1', name: 'Realm Crew', memberCount: 6 }] }),
  'admin:status': () => ({ ok: true, isAdmin: true }),
  'admin:overview': () => ({ ok: true, overview: { users: 128, activeSessions: 46, onlineUsers: 31, messages: 8912, groups: 24, friendships: 206, database: { engine: 'SQLite', journalMode: 'WAL', sizeBytes: 7340032, checkedAt: Date.now(), tables: [{ name: 'users', rows: 128 }, { name: 'sessions', rows: 46 }, { name: 'friends', rows: 412 }, { name: 'friend_requests', rows: 17 }, { name: 'messages', rows: 7400 }, { name: 'groups', rows: 24 }, { name: 'group_members', rows: 180 }, { name: 'group_messages', rows: 1512 }] } } }),
  'admin:listUsers': () => ({ ok: true, users: [{ id: 'user-owner', email: 'owner@native.test', username: 'OhLlama', uuid: 'owner-uuid', isAdmin: true, badges: adminBadges, createdAt: Date.now() - 864000000, status: 'online', friendCount: 32, groupCount: 5, messageCount: 842 }, { id: 'user-builder', email: 'builder@native.test', username: 'BuilderBee', uuid: 'builder-uuid', isAdmin: false, badges: ['bug_hunter'], createdAt: Date.now() - 172800000, status: 'offline', friendCount: 8, groupCount: 2, messageCount: 94 }], page: 1, pageSize: 50, total: 2, totalPages: 1 }),
  'admin:setBadge': (_e, id, badge, granted) => { if (id === 'user-owner') adminBadges = granted ? [...new Set([...adminBadges, badge])] : adminBadges.filter(item => item !== badge); return { ok: true, user: { id, badges: adminBadges } }; }
};
for (const [name, fn] of Object.entries(handles)) ipcMain.handle(name, fn);
for (const name of ['window:minimize', 'window:maximize', 'window:close']) ipcMain.on(name, () => {});
const pause = (ms = 250) => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 675, frame: false, show: true, backgroundColor: '#060305', webPreferences: { preload: path.join(__dirname, '../electron/preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const js = code => win.webContents.executeJavaScript(code);
  const click = selector => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Missing control: ' + ${JSON.stringify(selector)}); el.click(); })()`);
  const input = (selector, value) => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const screenshot = async name => { await pause(); fs.writeFileSync(path.join(__dirname, `../screenshot-instance-${name}.png`), (await win.webContents.capturePage()).toPNG()); };
  try {
    await win.loadFile(path.join(__dirname, '../dist/index.html')); await pause(1500);
    const titleLogo = await js(`(() => { const el = document.querySelector('.native-wordmark .native-mark'); const rect = el?.getBoundingClientRect(); const style = el && getComputedStyle(el); return el ? { width: rect.width, height: rect.height, filter: style.filter, opacity: style.opacity } : null; })()`);
    assert.equal(titleLogo?.width, 11, 'Title-bar logo matches the compact text size');
    assert.equal(titleLogo?.height, 11, 'Title-bar logo stays square at text size');
    assert.match(titleLogo?.filter || '', /grayscale/, 'Title-bar logo is grayed');
    assert.equal(titleLogo?.opacity, '0.72', 'Title-bar logo uses the muted treatment');
    await js(`Array.from(document.querySelectorAll('.rail-btn')).find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('instances')).click()`); await pause();
    const launchActionVisual = await js(`(() => {
      const button = document.querySelector('.instance-card .launch-action');
      const icon = button?.querySelector('.launch-action-icon');
      const label = button?.querySelector('.launch-action-label');
      if (!button || !label) return null;
      return {
        hasButton: Boolean(button),
        hasIcon: Boolean(icon),
        text: label.textContent.trim()
      };
    })()`);
    assert.equal(Boolean(launchActionVisual?.hasButton), true, 'Launch/install action button is rendered');
    assert.equal(Boolean(launchActionVisual?.hasIcon), true, 'Launch/install action icon is rendered');
    assert.equal(await js(`!!document.querySelector('.instance-card-settings-btn')`), true, 'Instance cards expose a direct settings action');
    await click('.instances-browse-link-btn'); await pause();
    assert.equal(await js(`!!document.querySelector('.browse-back-link')`), false, 'Instances Browse tab has no redundant back link');
    assert.equal(await js(`!!document.querySelector('.browse-filter-heading') && !!document.querySelector('.browse-sort-select')`), true, 'Browse uses the refined filter controls');
    await click('.instances-browse-link-btn'); await pause();
    await click('.instance-card-settings-btn'); await pause(500);
    assert.equal(await js(`document.querySelector('.im-nav-settings')?.classList.contains('active')`), true, 'Direct settings action opens the instance Advanced page');
    await click('.im-close'); await pause();
    await js(`document.querySelector('.instance-card').focus()`);
    await click('.instance-card'); await pause(500);
    assert.equal(await js(`!!document.querySelector('[role="dialog"].instance-manager')`), true);
    assert.equal(await js(`document.getElementById('root').inert && !!document.querySelector('.instance-card')`), true, 'Underlying page stays mounted and inert');
    const geom = await js(`(() => { const r = document.querySelector('.instance-manager').getBoundingClientRect(); return [r.width, r.height]; })()`);
    assert.equal(geom[0] >= 900 && geom[1] >= 550, true, `Dialog is large and spacious: ${geom[0]}x${geom[1]}`);
    await screenshot('manager');
    await click('[aria-label="Enable Litematica"]'); await pause();
    assert.equal(manifest['0'].filename.endsWith('.disabled'), true);
    await click('[aria-label="Show enabled mods only"]'); await pause();
    assert.equal(await js(`document.querySelectorAll('.im-file-row').length`), 4);
    await click('.im-nav-worlds'); await screenshot('worlds-loading'); await pause(300); await screenshot('worlds');
    assert.equal(await js(`document.querySelectorAll('.im-world-art').length`), 2, 'World rows render colored artwork');
    assert.equal(await js(`document.querySelector('.im-upload-banner-title').textContent.trim()`), 'Worlds', 'Content page title has no decorative plus prefix');
    await click('.im-nav-screenshots'); await pause(350);
    assert.equal(await js(`document.querySelectorAll('.sm-card').length`), 2, 'Screenshot manager renders image cards');
    assert.equal(await js(`!!document.querySelector('.sm-upload-banner .im-upload-banner-icon svg')`), true, 'Screenshot manager uses the same banner icon layout as other content pages');
    assert.equal(await js(`document.querySelector('.sm-upload-banner .im-upload-banner-title').textContent.trim()`), 'Screenshots', 'Screenshot page title matches the shared content banner');
    await screenshot('screenshots');
    await click('.sm-card-actions button'); await pause(250);
    assert.equal(await js(`document.querySelectorAll('.sm-target-list > button').length`), 2, 'Share picker includes friends and groups');
    await screenshot('screenshot-share');
    await click('.sm-share-dialog header button');
    await click('.sm-card-preview'); await pause(250);
    assert.equal(await js(`!!document.querySelector('.sm-preview-dialog')`), true, 'Screenshot preview opens');
    await screenshot('screenshot-preview');
    await click('.sm-preview-dialog header button');
    failWorlds = true; await click('.im-nav-mods'); await click('.im-nav-worlds'); await pause(400);
    assert.match(await js(`document.querySelector('.im-error').textContent`), /Test world read failure/);
    failWorlds = false; await click('.im-error button'); await pause(400);
    await click('.im-nav-settings'); await screenshot('advanced');
    await input('[aria-label="Window width"]', ''); await input('[aria-label="Window width"]', '1600');
    assert.equal(await js(`document.querySelector('[aria-label="Window height"]').value`), '900');
    await js(`window.confirm = () => false; undefined`);
    await click('.im-close');
    assert.equal(await js(`!!document.querySelector('.instance-manager')`), true, 'Unsaved changes block accidental dismissal');
    await click('.im-nav-worlds'); await click('.im-nav-settings');
    assert.equal(await js(`document.querySelector('[aria-label="Window width"]').value`), '1600', 'Draft survives tab changes');
    failSave = true; await click('.im-settings-footer button'); await pause();
    assert.match(await js(`document.querySelector('.im-settings-footer').textContent`), /Test disk failure/);
    failSave = false; await click('.im-settings-footer button'); await pause();
    assert.equal(library.instances[0].overrides.resolution.width, 1600, 'Save persisted through IPC');
    await click('.im-close'); await pause();
    assert.equal(await js(`document.getElementById('root').inert`), false);
    assert.equal(await js(`document.activeElement.classList.contains('instance-card')`), true, 'Focus restored');
    await click('.instance-card'); await pause(); await click('.im-nav-settings');
    assert.equal(await js(`document.querySelector('[aria-label="Window width"]').value`), '1600', 'Saved values survive reopening');
    assert.equal(await js(`document.querySelector('.im-java-field input').matches(':disabled')`), true, 'Disabled JVM controls cannot be edited by keyboard');
    await js(`document.querySelector('.im-close').focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))`);
    assert.equal(await js(`document.querySelector('.instance-manager').contains(document.activeElement) && document.activeElement !== document.querySelector('.im-close')`), true, 'Keyboard focus wraps within the popup');
    await click('.im-nav-shaders'); await click('[aria-label="Browse compatible content"]'); await pause(1500);
    assert.equal(await js(`!!document.querySelector('.im-browser') && !document.querySelector('.browse-type-tabs')`), true);
    assert.match(await js(`document.querySelector('.browse-search input').placeholder`), /shader/i);
    await screenshot('browser');
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await pause();
    assert.equal(await js(`!!document.querySelector('.im-browser')`), false, 'Escape first returns from browser');
    win.setSize(680, 600); await pause(); await click('.im-nav-settings'); await screenshot('compact');
    assert.equal(await js(`(() => { const el = document.querySelector('.instance-manager'); return el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= innerWidth; })()`), true, 'No modal overflow at compact size');
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await pause();
    assert.equal(await js(`!!document.querySelector('.instance-manager')`), false, 'Escape closes manager');
    win.setSize(1200, 675); await pause();
    await js(`Array.from(document.querySelectorAll('.rail-btn')).find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('admin control')).click()`); await pause(500);
    assert.equal(await js(`!!document.querySelector('.admin-view') && document.querySelectorAll('.sp-metric').length === 4`), true, 'Confirmed admins can open the shared page-style overview');
    assert.equal(await js(`document.querySelector('.admin-database-panel').textContent.includes('group_messages')`), true, 'Database overview renders table counts');
    await screenshot('admin-overview');
    await click('.admin-tabs .instances-nav-tab:nth-child(2)'); await pause();
    assert.equal(await js(`document.querySelectorAll('.admin-user-row').length === 2`), true, 'Admin users tab renders user management rows');
    await click('[title="Grant Native Staff"]'); await pause();
    assert.equal(adminBadges.includes('staff'), true, 'Badge grant action reaches protected IPC');
    await screenshot('admin');
    console.log('PASS: compact gray title-bar logo, matching instance content headers without plus-prefixed titles, manager/preview, world artwork, protected admin pages, Browse controls, modal geometry, settings persistence, compact layout and Escape.');
    app.quit();
  } catch (error) { console.error(error); await screenshot('failure'); app.exit(1); }
});
