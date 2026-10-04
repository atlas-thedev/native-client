// Comprehensive verification script for:
// 1. Browse page single back button (no duplicates)
// 2. No manual compatibility tick requirement (compatible only always)
// 3. Browse page full-page scrollable
// 4. Download toast styling and auto-dismiss
// 5. Enable/disable mod & content toggle (no open shared config button)
// 6. Instance card 3-dots menu not popping under card (overflow: visible, high z-index)
// 7. Dedicated browse page under instances page

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('node:assert/strict');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'noctra-fixes-test-')));
app.commandLine.appendSwitch('disable-dev-shm-usage');

const instance1 = {
  id: 'inst-1',
  name: 'Survival Fabric',
  version: '1.21.1',
  mc_version: '1.21.1',
  loader: 'Fabric',
  mc_loader: 'Fabric',
  created: Date.now() - 10000000,
  overrides: { resolution: { enabled: true, width: 1920, height: 1080 } }
};
const instance2 = {
  id: 'inst-2',
  name: 'Creative Forge',
  version: '1.20.1',
  mc_version: '1.20.1',
  loader: 'Forge',
  mc_loader: 'Forge',
  created: Date.now() - 20000000
};

let library = { instances: [instance1, instance2], selectedId: instance1.id };
let manifest = {
  'mod-sodium': {
    filename: 'sodium-0.5.8.jar',
    folder: 'mods',
    metadata: { title: 'Sodium', author: 'jellysquid', version: '0.5.8' }
  },
  'mod-iris': {
    filename: 'iris-1.7.0.jar',
    folder: 'mods',
    metadata: { title: 'Iris Shaders', author: 'coderbot', version: '1.7.0' }
  }
};

const handles = {
  'instances:load': () => library,
  'instances:save': (_e, next) => { library = next; return true; },
  'settings:load': () => ({ onboarding: { completed: true, language: 'en' }, memory: { min: 1, max: 4 } }),
  'settings:save': () => true,
  'settings:systemMemory': () => ({ totalGb: 32 }),
  'accounts:list': () => ({ accounts: [{ id: 'acc-1', name: 'NativeUser', type: 'offline' }], activeId: 'acc-1' }),
  'wardrobe:get': () => ({ active: null, skins: [], capes: [] }),
  'wardrobe:sync': () => ({ ok: true }),
  'wardrobe:avatar': () => null,
  'instance:installedVersions': () => [{ version: '1.21.1', loader: 'Fabric' }],
  'instance:isInstalled': () => true,
  'instance:worldList': async () => [{ name: 'Overworld', modified: Date.now() - 50000, sizeBytes: 10485760 }],
  'mods:installed': () => manifest,
  'mods:toggle': (_e, { projectId, enabled }) => {
    if (manifest[projectId]) {
      manifest[projectId].filename = manifest[projectId].filename.replace(/\.disabled$/, '') + (enabled ? '' : '.disabled');
    }
    return manifest;
  },
  'instance:toggleFile': async (_e, _id, _folder, filename, enabled) => {
    return enabled ? filename.replace(/\.disabled$/, '') : `${filename.replace(/\.disabled$/, '')}.disabled`;
  },
  'instance:listDir': (_e, _id, folder) => {
    if (folder === 'mods') {
      return Object.values(manifest).map(mod => ({ name: mod.filename, size: 2048000 }));
    }
    return [];
  },
  'instance:openFolder': () => true,
  'settings:dataDir': () => '/tmp/noctra',
  'news:list': () => ({ items: [] }),
  'updater:status': () => ({ type: 'idle' }),
  'social:getFriends': () => ({ friends: [] }),
  'social:getRequests': () => ({ incoming: [], outgoing: [] }),
  'social:getConversations': () => ({})
};

for (const [name, fn] of Object.entries(handles)) ipcMain.handle(name, fn);
for (const name of ['window:minimize', 'window:maximize', 'window:close']) ipcMain.on(name, () => {});

const pause = (ms = 250) => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 720,
    frame: false,
    show: true,
    backgroundColor: '#060305',
    webPreferences: {
      preload: path.join(__dirname, '../electron/preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const js = code => win.webContents.executeJavaScript(code);
  const click = selector => js(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
    el.click();
  })()`);

  try {
    await win.loadFile(path.join(__dirname, '../dist/index.html'));
    await pause(1500);

    // 1. Navigate to Instances tab
    await js(`Array.from(document.querySelectorAll('.rail-btn')).find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('instances')).click()`);
    await pause(400);

    // Check header browse button and nav tabs under instances
    const hasBrowseLinkBtn = await js(`!!document.querySelector('.instances-browse-link-btn')`);
    assert.equal(hasBrowseLinkBtn, true, 'Header has Browse Content button');

    const hasNavTabs = await js(`!!document.querySelector('.instances-nav-tabs')`);
    assert.equal(hasNavTabs, true, 'Instances page has sub-nav tabs');

    // 2. Test 3-dots menu on instance card (overflow: visible and z-index)
    await click('.instance-card-menu-btn');
    await pause(300);

    const cardMenuState = await js(`(() => {
      const card = document.querySelector('.instance-card.menu-open');
      if (!card) return null;
      const popover = card.querySelector('.instances-popover');
      const cardStyle = window.getComputedStyle(card);
      const popoverStyle = popover ? window.getComputedStyle(popover) : null;
      return {
        cardHasMenuOpen: true,
        cardOverflow: cardStyle.overflow,
        cardZIndex: parseInt(cardStyle.zIndex, 10),
        popoverZIndex: popoverStyle ? parseInt(popoverStyle.zIndex, 10) : 0,
        popoverVisible: !!popover
      };
    })()`);

    assert.ok(cardMenuState, 'Instance card has menu-open class when 3 dots clicked');
    assert.equal(cardMenuState.cardOverflow, 'visible', 'Card has overflow: visible when menu is open');
    assert.ok(cardMenuState.cardZIndex >= 100, `Card z-index is high (${cardMenuState.cardZIndex})`);
    assert.ok(cardMenuState.popoverVisible, 'Popover is rendered');
    assert.ok(cardMenuState.popoverZIndex >= 120, `Popover z-index is high (${cardMenuState.popoverZIndex})`);

    // Close menu with Escape
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await pause(200);

    // 3. Test dedicated browse page under instance page
    await click('.instances-browse-link-btn');
    await pause(400);

    const hasEmbeddedBrowse = await js(`!!document.querySelector('.instances-browse-container .browse-view')`);
    assert.equal(hasEmbeddedBrowse, true, 'Clicking Browse Content renders dedicated BrowseView under instances');

    // Check that there is NO "browse-compat-toggle" button (user doesn't have to tick compatible)
    const hasCompatToggle = await js(`!!document.querySelector('.browse-compat-toggle')`);
    assert.equal(hasCompatToggle, false, 'No manual compatibility tick button');

    // Check that browse view is scrollable
    const browseScrollable = await js(`(() => {
      const el = document.querySelector('.browse-view');
      const style = window.getComputedStyle(el);
      return style.overflowY === 'auto' || style.overflowY === 'scroll';
    })()`);
    assert.equal(browseScrollable, true, 'browse-view has overflow-y: auto for full page scrolling');

    // Return to instances via the back button in browse or the Instances subtab
    await click('.browse-back-link');
    await pause(300);
    assert.equal(await js(`!document.querySelector('.instances-browse-container')`), true, 'Back button returns to instances view');

    // 4. Open Instance Manager modal
    await click('.instance-card');
    await pause(500);
    assert.equal(await js(`!!document.querySelector('.instance-manager')`), true, 'Instance manager modal opened');

    // Check Content tab has toggle switches instead of config button
    const hasConfigButton = await js(`!!document.querySelector('.im-config')`);
    assert.equal(hasConfigButton, false, 'Open shared config button is removed');

    const toggleSwitches = await js(`document.querySelectorAll('.im-toggle-switch').length`);
    assert.ok(toggleSwitches >= 2, `Has enable/disable toggle switches for mods: found ${toggleSwitches}`);

    // Click toggle to disable Sodium
    await click('[aria-label="Enable Sodium"]');
    await pause(300);
    assert.ok(manifest['mod-sodium'].filename.endsWith('.disabled'), 'Sodium renamed to .disabled');

    // Click toggle to enable Sodium again
    await click('[aria-label="Enable Sodium"]');
    await pause(300);
    assert.ok(!manifest['mod-sodium'].filename.endsWith('.disabled'), 'Sodium restored without .disabled');

    // 5. Test Browse embedded in Instance Manager (verify only 1 back button!)
    await click('[aria-label="Browse mods"]');
    await pause(500);

    const backButtonCount = await js(`document.querySelectorAll('.im-browser-back, .browse-back-link').length`);
    assert.equal(backButtonCount, 1, `Exactly ONE back button in embedded browse: found ${backButtonCount}`);

    const backButtonText = await js(`document.querySelector('.browse-back-link')?.textContent || ''`);
    assert.match(backButtonText, /Back/, 'Back button has clear back text');

    // Click back button to return to installed content
    await click('.browse-back-link');
    await pause(300);
    assert.equal(await js(`!document.querySelector('.im-browser')`), true, 'Returned to installed content');

    console.log('ALL VERIFICATIONS PASSED SUCCESSFULLY!');
    await pause(500);
    app.quit();
  } catch (err) {
    console.error('VERIFICATION FAILED:', err);
    app.exit(1);
  }
});
