'use strict';
/* Importing from the current Modrinth App (instances tables, custom app folder), the Minecraft Launcher's
   installations, and reusing the other launcher's game assets so they aren't downloaded again. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const imp = require('../electron/instanceImport');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'native-import-src-'));
const USER = path.join(HOME, 'native-user');
imp.init({ app: { getPath: () => USER }, getWin: () => null }, { handle: () => {} });
const b = imp.bases({ XDG_DATA_HOME: path.join(HOME, '.local/share'), XDG_CONFIG_HOME: path.join(HOME, '.config') }, 'linux', HOME);
const write = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const json = (p, v) => write(p, JSON.stringify(v));
const FIXTURE = path.join(__dirname, 'fixtures/import/modrinth-2026');
const MR = path.join(b.data, 'ModrinthApp');

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

test.before(() => {
  // app.db built from Modrinth's real migrations; the last three instances only exist in the -wal file
  fs.mkdirSync(MR, { recursive: true });
  fs.copyFileSync(path.join(FIXTURE, 'app.db'), path.join(MR, 'app.db'));
  fs.copyFileSync(path.join(FIXTURE, 'app.db-wal'), path.join(MR, 'app.db-wal'));
  for (const dir of ['Fabulously Optimized', 'Vanilla PvP', 'Pack 005']) write(path.join(MR, 'profiles', dir, 'options.txt'), 'fov:0.5');
  write(path.join(MR, 'profiles/Fabulously Optimized/mods/sodium.jar'), 'jar');
  // Modrinth's shared files: meta/assets, meta/libraries, meta/versions
  write(path.join(MR, 'meta/assets/objects/ab/ab' + '1'.repeat(38)), 'sound');
  write(path.join(MR, 'meta/assets/objects/cd/cd' + '2'.repeat(38)), 'texture');
  write(path.join(MR, 'meta/assets/objects/cd/not-an-object.txt'), 'x');
  write(path.join(MR, 'meta/libraries/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar'), 'lwjgl');
  write(path.join(MR, 'meta/versions/1.21.4/1.21.4.jar'), 'client');
});

test('reads names, versions and loaders from the 2026 Modrinth App database', () => {
  const mr = imp.scan(b).find((l) => l.id === 'modrinth');
  const by = Object.fromEntries(mr.instances.map((i) => [path.basename(i.gameDir), i]));
  assert.equal(mr.instances.length, 3, 'only instances whose folder exists');
  assert.deepEqual([by['Fabulously Optimized'].name, by['Fabulously Optimized'].version, by['Fabulously Optimized'].loader, by['Fabulously Optimized'].loaderVersion],
    ['Fabulously Optimized, my main', '1.21.4', 'Fabric', '0.16.10']);
  assert.deepEqual([by['Vanilla PvP'].name, by['Vanilla PvP'].version, by['Vanilla PvP'].loader], ['Vanilla PvP 🗡', '1.8.9', 'Vanilla']);
  assert.equal(by['Pack 005'].name, 'Renamed 005', 'a rename made in the app');
  assert.equal(by['Vanilla PvP'].lastPlayed, 1760100000 * 1000);
});

test('follows the Modrinth App folder the user moved (settings.custom_dir)', () => {
  const { DatabaseSync } = require('node:sqlite');
  const app = path.join(HOME, 'moved-app');
  const custom = path.join(HOME, 'D-drive/Modrinth');
  fs.mkdirSync(app, { recursive: true });
  fs.copyFileSync(path.join(FIXTURE, 'app.db'), path.join(app, 'app.db'));
  fs.copyFileSync(path.join(FIXTURE, 'app.db-wal'), path.join(app, 'app.db-wal'));
  const db = new DatabaseSync(path.join(app, 'app.db'));
  db.prepare('UPDATE settings SET custom_dir = ?').run(custom);
  db.close();
  write(path.join(custom, 'profiles/ATM10/mods/a.jar'), 'jar');
  const list = imp._internals.scanModrinth(app);
  assert.deepEqual(list.map((i) => [i.name, i.loader, i.version]), [['All the Mods 10', 'NeoForge', '1.21.1']]);
  assert.equal(path.dirname(list[0].gameDir), path.join(custom, 'profiles'));
});

test('lists the Minecraft Launcher installations by name', () => {
  const mc = path.join(HOME, 'official/.minecraft');
  json(path.join(mc, 'launcher_accounts.json'), {});
  json(path.join(mc, 'versions/1.21.4/1.21.4.json'), { id: '1.21.4', type: 'release', releaseTime: '2024-12-03T10:12:57+00:00' });
  json(path.join(mc, 'versions/1.21.1/1.21.1.json'), { id: '1.21.1', type: 'release', releaseTime: '2024-08-08T12:24:45+00:00' });
  json(path.join(mc, 'versions/26.1-snapshot-2/26.1-snapshot-2.json'), { id: '26.1-snapshot-2', type: 'snapshot', releaseTime: '2025-12-20T10:00:00+00:00' });
  json(path.join(mc, 'versions/fabric-loader-0.16.9-1.21.1/fabric-loader-0.16.9-1.21.1.json'), { id: 'fabric-loader-0.16.9-1.21.1', inheritsFrom: '1.21.1', libraries: [{ name: 'net.fabricmc:fabric-loader:0.16.9' }] });
  const own = path.join(HOME, 'official/survival');
  write(path.join(own, 'saves/World/level.dat'), 'lvl');
  json(path.join(mc, 'launcher_profiles.json'), {
    profiles: {
      a: { name: '', type: 'latest-release', lastVersionId: 'latest-release', lastUsed: '2026-10-01T10:00:00.000Z' },
      b: { name: 'My Survival', type: 'custom', lastVersionId: '1.21.1', gameDir: own, icon: 'data:image/png;base64,iVBORw0KGgo=' },
      c: { name: 'Fabric', type: 'custom', lastVersionId: 'fabric-loader-0.16.9-1.21.1', icon: 'Furnace' },
      d: { name: 'Gone', type: 'custom', lastVersionId: '1.12.2' }
    }
  });
  json(path.join(mc, 'launcher_profiles_microsoft_store.json'), { profiles: { s: { name: '', type: 'latest-snapshot', lastVersionId: 'latest-snapshot' } } });

  const out = imp._internals.scanMinecraftDir(mc);
  assert.ok(!out.tlauncher);
  const by = Object.fromEntries(out.minecraft.map((i) => [i.name, i]));
  assert.deepEqual([by['Latest release'].version, by['Latest release'].loader, by['Latest release'].shared], ['1.21.4', 'Vanilla', true]);
  assert.deepEqual([by['My Survival'].version, by['My Survival'].gameDir, by['My Survival'].shared], ['1.21.1', own, false]);
  assert.equal(by['My Survival'].icon, 'data:image/png;base64,iVBORw0KGgo=');
  assert.deepEqual([by.Fabric.version, by.Fabric.loader, by.Fabric.loaderVersion, by.Fabric.icon], ['1.21.1', 'Fabric', '0.16.9', null]);
  assert.equal(by['Latest snapshot'].version, '26.1-snapshot-2');
  assert.ok(!by.Gone, 'an installation whose version is not downloaded');
  assert.ok(!by['1.21.4'] && !by['1.21.1'], 'versions used by an installation are not listed twice');

  // the same folder with TLauncher too: installations stay with the Minecraft Launcher
  json(path.join(mc, 'TlauncherProfiles.json'), {});
  const both = imp._internals.scanMinecraftDir(mc);
  assert.ok(both.minecraft.some((i) => i.name === 'My Survival'));
  assert.ok(both.tlauncher.every((i) => i.name !== 'My Survival'));
});

test('reuses the other launcher\'s game assets, libraries and jar instead of downloading them', async () => {
  const native = path.join(USER, 'minecraft');
  const kept = path.join(native, 'assets/objects/cd/cd' + '2'.repeat(38));
  write(kept, 'native copy');
  const fo = imp.scan(b).find((l) => l.id === 'modrinth').instances.find((i) => i.name.startsWith('Fabulously'));
  assert.ok(imp.sharedStores(fo.gameDir, b).includes(path.resolve(MR, 'meta')));
  const made = await imp.importInstance({ source: 'modrinth', ...fo });
  assert.equal(fs.readFileSync(path.join(native, 'assets/objects/ab/ab' + '1'.repeat(38)), 'utf8'), 'sound');
  assert.equal(fs.readFileSync(kept, 'utf8'), 'native copy', 'files Native already has are never replaced');
  assert.ok(!fs.existsSync(path.join(native, 'assets/objects/cd/not-an-object.txt')));
  assert.equal(fs.readFileSync(path.join(native, 'libraries/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar'), 'utf8'), 'lwjgl');
  assert.equal(fs.readFileSync(path.join(native, 'versions/1.21.4/1.21.4.jar'), 'utf8'), 'client');
  assert.equal(made.imported.reused, 3);
  assert.ok(fs.existsSync(path.join(native, 'instances', made.id, 'mods/sodium.jar')));
  assert.ok(!fs.readdirSync(path.join(native, 'assets')).some((n) => n.startsWith('.link-probe')));
});

test('copies only what the version needs when links are not possible (another drive)', async () => {
  const store = path.join(HOME, 'other-drive/.minecraft');
  const objA = 'ee' + '3'.repeat(38), objB = 'ff' + '4'.repeat(38);
  write(path.join(store, 'assets/objects/ee', objA), 'needed');
  write(path.join(store, 'assets/objects/ff', objB), 'other version');
  json(path.join(store, 'assets/indexes/17.json'), { objects: { 'minecraft/sounds/a.ogg': { hash: objA, size: 6 } } });
  json(path.join(store, 'versions/1.21.1/1.21.1.json'), { id: '1.21.1', assetIndex: { id: '17' }, libraries: [{ downloads: { artifact: { path: 'com/mojang/brigadier/1.3.10/brigadier-1.3.10.jar' } } }, { downloads: { artifact: { path: '../../escape.jar' } } }] });
  write(path.join(store, 'libraries/com/mojang/brigadier/1.3.10/brigadier-1.3.10.jar'), 'brig');
  write(path.join(store, 'libraries/unused/x.jar'), 'x');
  const fsp = fs.promises;
  const realLink = fsp.link;
  fsp.link = async () => { const e = new Error('cross-device link'); e.code = 'EXDEV'; throw e; };
  try {
    const added = await imp.reuseSharedFiles([store], '1.21.1');
    assert.equal(added, 2);
  } finally { fsp.link = realLink; }
  const native = path.join(USER, 'minecraft');
  assert.equal(fs.readFileSync(path.join(native, 'assets/objects/ee', objA), 'utf8'), 'needed');
  assert.ok(!fs.existsSync(path.join(native, 'assets/objects/ff', objB)), 'other versions\' assets are not copied');
  assert.ok(fs.existsSync(path.join(native, 'libraries/com/mojang/brigadier/1.3.10/brigadier-1.3.10.jar')));
  assert.ok(!fs.existsSync(path.join(native, 'libraries/unused/x.jar')));
});
