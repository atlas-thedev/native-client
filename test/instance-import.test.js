'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

const imp = require('../electron/instanceImport');
const modpacks = require('../electron/modpacks');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'native-import-'));
const USER = path.join(HOME, 'native-user');
const app = { getPath: () => USER };
const handlers = {};
imp.init({ app, getWin: () => null }, { handle: (name, fn) => { handlers[name] = fn; } });
modpacks.init({ app, getWin: () => null }, { handle: () => {} });

const write = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const json = (p, v) => write(p, JSON.stringify(v));
const b = imp.bases({ XDG_DATA_HOME: path.join(HOME, '.local/share'), XDG_CONFIG_HOME: path.join(HOME, '.config') }, 'linux', HOME);

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

test.before(() => {
  // Modrinth App: app.db (+ WAL) and profile folders
  const mr = path.join(b.data, 'ModrinthApp');
  fs.mkdirSync(mr, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures/import/app.db'), path.join(mr, 'app.db'));
  fs.copyFileSync(path.join(__dirname, 'fixtures/import/app.db-wal'), path.join(mr, 'app.db-wal'));
  write(path.join(mr, 'profiles/Fresh/mods/sodium.jar'), 'jar');
  write(path.join(mr, 'profiles/Pack 005/saves/World/level.dat'), 'lvl');
  // CurseForge
  const cf = path.join(HOME, 'curseforge/minecraft/Instances/All the Mods');
  json(path.join(cf, 'minecraftinstance.json'), { name: 'All the Mods 9', gameVersion: '1.20.1', baseModLoader: { name: 'forge-47.2.0', minecraftVersion: '1.20.1' }, lastPlayed: '2026-10-01T10:00:00Z' });
  write(path.join(cf, 'mods/a.jar'), 'a'); write(path.join(cf, 'mods/b.jar'), 'b');
  write(path.join(cf, 'config/a.toml'), 'x=1');
  write(path.join(cf, 'logs/latest.log'), 'nope');
  // Prism with a custom instances folder
  const prism = path.join(b.data, 'PrismLauncher');
  write(path.join(prism, 'prismlauncher.cfg'), 'InstanceDir=my-instances\n');
  const pi = path.join(prism, 'my-instances/PvP');
  write(path.join(pi, 'instance.cfg'), 'name=PvP 1.8\niconKey=default\nOverrideMemory=true\nMaxMemAlloc=3072\n');
  json(path.join(pi, 'mmc-pack.json'), { components: [{ uid: 'net.minecraft', version: '1.21.1' }, { uid: 'net.fabricmc.fabric-loader', version: '0.16.9' }] });
  write(path.join(pi, '.minecraft/mods/fps.jar'), 'jar');
  write(path.join(pi, '.minecraft/options.txt'), 'fov:0.5');
  write(path.join(pi, '.minecraft/screenshots/a.png'), 'png');
  // ATLauncher
  json(path.join(b.data, 'ATLauncher/instances/Vanilla+/instance.json'), { id: '1.21.4', launcher: { name: 'Vanilla Plus', loaderVersion: { type: 'Quilt', version: '0.27.1' } } });
  // TLauncher-style .minecraft
  json(path.join(b.mc, 'TlauncherProfiles.json'), {});
  json(path.join(b.mc, 'launcher_profiles.json'), { profiles: {} });
  json(path.join(b.mc, 'versions/Fabric 1.20.1/Fabric 1.20.1.json'), { id: 'Fabric 1.20.1', inheritsFrom: '1.20.1', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient', libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.11' }] });
  json(path.join(b.mc, 'versions/1.12.2-forge-14.23.5.2860/1.12.2-forge-14.23.5.2860.json'), { id: '1.12.2-forge-14.23.5.2860', inheritsFrom: '1.12.2', libraries: [{ name: 'net.minecraftforge:forge:1.12.2-14.23.5.2860' }] });
  json(path.join(b.mc, 'versions/1.20.1/1.20.1.json'), { id: '1.20.1', mainClass: 'net.minecraft.client.main.Main' });
  write(path.join(b.mc, 'mods/shared.jar'), 'jar');
  write(path.join(b.mc, 'saves/W/level.dat'), 'lvl');
  write(path.join(b.mc, 'kubejs/x.js'), 'nope'); // not brought over from a shared folder
});

test('finds instances in every installed launcher', () => {
  const list = imp.scan(b);
  const by = Object.fromEntries(list.map((l) => [l.id, l]));
  assert.equal(by.modrinth.found, true);
  const fresh = by.modrinth.instances.find((i) => i.name === 'Fresh one');
  assert.deepEqual([fresh.version, fresh.loader, fresh.loaderVersion, fresh.mods], ['1.21.4', 'NeoForge', '21.4.1', 1]);
  assert.equal(by.modrinth.instances.length, 2, 'only profiles whose folder exists');
  const atm = by.curseforge.instances[0];
  assert.deepEqual([atm.name, atm.version, atm.loader, atm.loaderVersion, atm.mods], ['All the Mods 9', '1.20.1', 'Forge', '47.2.0', 2]);
  const pvp = by.prism.instances[0];
  assert.deepEqual([pvp.name, pvp.version, pvp.loader, pvp.loaderVersion, pvp.memoryMb], ['PvP 1.8', '1.21.1', 'Fabric', '0.16.9', 3072]);
  assert.deepEqual([by.atlauncher.instances[0].loader, by.atlauncher.instances[0].version], ['Quilt', '1.21.4']);
  assert.equal(by.tlauncher.found, true);
  const tl = Object.fromEntries(by.tlauncher.instances.map((i) => [i.name, i]));
  assert.deepEqual([tl['Fabric 1.20.1'].version, tl['Fabric 1.20.1'].loader, tl['Fabric 1.20.1'].loaderVersion], ['1.20.1', 'Fabric', '0.15.11']);
  assert.deepEqual([tl['1.12.2-forge-14.23.5.2860'].loader, tl['1.12.2-forge-14.23.5.2860'].loaderVersion], ['Forge', '14.23.5.2860']);
  assert.equal(tl['1.20.1'].loader, 'Vanilla');
  assert.ok(!by.minecraft, 'a TLauncher folder is not listed twice');
  assert.equal(by.multimc.found, false);
});

test('imports a copy with only the chosen parts', async () => {
  const pvp = imp.scan(b).find((l) => l.id === 'prism').instances[0];
  const made = await handlers['import:instance'](null, { source: 'prism', ...pvp, include: { mods: true, worlds: true, packs: true, settings: true, screenshots: false } });
  const dir = path.join(USER, 'minecraft/instances', made.id);
  assert.deepEqual([made.name, made.version, made.loader, made.memoryMb], ['PvP 1.8', '1.21.1', 'Fabric', 3072]);
  assert.ok(fs.existsSync(path.join(dir, 'mods/fps.jar')));
  assert.ok(fs.existsSync(path.join(dir, 'options.txt')));
  assert.ok(!fs.existsSync(path.join(dir, 'screenshots')), 'screenshots were left out');
  assert.ok(fs.existsSync(path.join(pvp.gameDir, 'mods/fps.jar')), 'the source is untouched');

  const tl = imp.scan(b).find((l) => l.id === 'tlauncher').instances.find((i) => i.name === 'Fabric 1.20.1');
  const copy = await imp.importInstance({ source: 'tlauncher', ...tl, include: { worlds: false } });
  const td = path.join(USER, 'minecraft/instances', copy.id);
  assert.ok(fs.existsSync(path.join(td, 'mods/shared.jar')));
  assert.ok(!fs.existsSync(path.join(td, 'saves')));
  assert.ok(!fs.existsSync(path.join(td, 'kubejs')), 'only known content from a shared .minecraft');
  assert.ok(!fs.existsSync(path.join(td, 'versions')) && !fs.existsSync(path.join(td, 'TlauncherProfiles.json')));
});

test('imports pack files: Prism export, .mrpack (overrides only) and folders', async () => {
  const zip = new AdmZip();
  zip.addFile('MyPack/instance.cfg', Buffer.from('name=Exported\n'));
  zip.addFile('MyPack/mmc-pack.json', Buffer.from(JSON.stringify({ components: [{ uid: 'net.minecraft', version: '1.20.4' }, { uid: 'org.quiltmc.quilt-loader', version: '0.26.0' }] })));
  zip.addFile('MyPack/.minecraft/mods/q.jar', Buffer.from('jar'));
  zip.addFile('../evil.txt', Buffer.from('no'));
  const zipPath = path.join(HOME, 'export.zip');
  zip.writeZip(zipPath);
  const made = await imp.importFile({ path: zipPath });
  assert.deepEqual([made.name, made.version, made.loader], ['Exported', '1.20.4', 'Quilt']);
  assert.ok(fs.existsSync(path.join(USER, 'minecraft/instances', made.id, 'mods/q.jar')));
  assert.ok(!fs.existsSync(path.join(USER, 'minecraft/evil.txt')));

  const mr = new AdmZip();
  mr.addFile('modrinth.index.json', Buffer.from(JSON.stringify({ formatVersion: 1, game: 'minecraft', name: 'Tiny Pack', versionId: '1', files: [], dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.5' } })));
  mr.addFile('overrides/config/tiny.json', Buffer.from('{}'));
  const mrPath = path.join(HOME, 'tiny.mrpack');
  mr.writeZip(mrPath);
  const pack = await imp.importFile({ path: mrPath });
  assert.deepEqual([pack.name, pack.version, pack.loader, pack.loaderVersion], ['Tiny Pack', '1.21.1', 'Fabric', '0.16.5']);
  assert.ok(fs.existsSync(path.join(USER, 'minecraft/instances', pack.id, 'config/tiny.json')));

  const cfDir = path.join(HOME, 'curseforge/minecraft/Instances/All the Mods');
  assert.equal(imp.detectFolder(cfDir).loader, 'Forge');
  await assert.rejects(imp.importFile({ path: path.join(HOME, 'curseforge') }), /Could not tell/);
});

test('reads version and loader from a game log when nothing else says', () => {
  const d = path.join(HOME, 'logged');
  write(path.join(d, 'logs/latest.log'), '[main/INFO]: Loading Minecraft 1.21.1 with Fabric Loader 0.16.9\n');
  assert.deepEqual(imp.fromLog(d), { version: '1.21.1', loader: 'Fabric', loaderVersion: '0.16.9' });
  write(path.join(d, 'logs/latest.log'), 'ModLauncher running: args [--fml.forgeVersion, 47.3.0, --fml.mcVersion, 1.20.1]');
  assert.deepEqual(imp.fromLog(d), { version: '1.20.1', loader: 'Forge', loaderVersion: '47.3.0' });
});
