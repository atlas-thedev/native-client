const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeCrash, reportToText, exitMeaning } = require('../electron/crashAnalyzer');

const mod = (file, id, name, extra = {}) => ({
  file, ids: [id], name, version: extra.version || '1.0.0', loader: extra.loader || 'fabric',
  depends: extra.depends || {}, breaks: {}, mixins: extra.mixins || [`${id}.mixins.json`],
  packages: extra.packages || [], roots: extra.roots || [], mtime: extra.mtime || 1, size: 1
});

const instance = { id: 'i1', name: 'Test', version: '1.20.1', loader: 'Fabric', overrides: {} };

test('Fabric missing dependency -> install Fabric API', () => {
  const log = [
    '[12:00:01] [main/ERROR]: Incompatible mods found!',
    'net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!',
    'A potential solution has been determined, this may resolve your problem:',
    '\t - Install fabric-api, any version.',
    'More details:',
    "\t - Mod 'Sodium Extra' (sodium-extra) 0.5.1 requires any version of fabric-api, which is missing!",
    '\tat net.fabricmc.loader.impl.FormattedException.ofLocalized(FormattedException.java:51)'
  ].join('\n');
  const r = analyzeCrash({ log, exitCode: 1, instance, mods: [mod('sodium-extra.jar', 'sodium-extra', 'Sodium Extra', { depends: { 'fabric-api': '*' } })] });
  assert.equal(r.issues[0].id, 'missing-dependency');
  assert.equal(r.headline, 'Fabric API is missing');
  assert.equal(r.issues[0].fixes[0].kind, 'install-mod');
  assert.equal(r.issues[0].fixes[0].slug, 'fabric-api');
  assert.ok(r.issues[0].fixes[0].recommended);
  assert.ok(r.excerpt.some((row) => row.hit));
});

test('Mixin failure blames the mod that owns the mixin', () => {
  const log = '[Render thread/ERROR]: Mixin apply for mod iris failed iris.mixins.json:MixinGameRenderer from mod iris -> net.minecraft.class_757: org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException Critical injection failure';
  const r = analyzeCrash({ log, exitCode: -1, instance, mods: [mod('iris-1.6.jar', 'iris', 'Iris'), mod('sodium.jar', 'sodium', 'Sodium')] });
  assert.equal(r.issues[0].id, 'mixin-failure');
  assert.deepEqual(r.issues[0].culprits, ['iris-1.6.jar']);
  assert.equal(r.issues[0].fixes[0].kind, 'update-mod');
});

test('Out of memory suggests more memory within system RAM', () => {
  const log = 'Exception in thread "Render thread" java.lang.OutOfMemoryError: Java heap space\n\tat java.util.Arrays.copyOf(Arrays.java:3512)';
  const r = analyzeCrash({ log, exitCode: 1, instance, mods: [], memoryMaxGb: 2, totalMemGb: 16 });
  assert.equal(r.issues[0].id, 'out-of-memory');
  assert.equal(r.issues[0].fixes[0].kind, 'memory');
  assert.equal(r.issues[0].fixes[0].maxGb, 4);
});

test('Class file version -> needed Java, culprit by package', () => {
  const log = 'Exception in thread "main" java.lang.UnsupportedClassVersionError: me/jellysquid/mods/sodium/client/SodiumClientMod has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0\n\tat java.lang.ClassLoader.defineClass1(Native Method)';
  const r = analyzeCrash({ log, exitCode: 1, instance, mods: [mod('sodium.jar', 'sodium', 'Sodium', { packages: ['me.jellysquid.mods.sodium'] })] });
  assert.equal(r.issues[0].id, 'java-too-old');
  assert.match(r.headline, /Java 21, but Java 17/);
  assert.equal(r.issues[0].fixes[0].kind, 'java');
  assert.equal(r.issues[0].fixes[0].major, 21);
  assert.deepEqual(r.issues[0].culprits, ['sodium.jar']);
});

test('Crash report stack trace blames the mod whose code threw', () => {
  const crashReport = [
    '---- Minecraft Crash Report ----',
    'Time: 2024-05-01 12:00:00',
    'Description: Unexpected error',
    '',
    'java.lang.NullPointerException: Cannot invoke "Object.hashCode()" because "key" is null',
    '\tat java.util.HashMap.get(HashMap.java:556)',
    '\tat com.example.coolmod.client.HudRenderer.render(HudRenderer.java:42)',
    '\tat net.minecraft.class_329.handler$zza000$coolmod$onRender(class_329.java:1234)',
    '\tat net.minecraft.class_757.method_3192(class_757.java:900)',
    '',
    '-- System Details --',
    '\tJava Version: 17.0.8, Eclipse Adoptium',
    '\tGraphics card #0 name: NVIDIA GeForce RTX 3060'
  ].join('\n');
  const r = analyzeCrash({ crashReport, log: '', exitCode: -1, instance, mods: [mod('coolmod-2.jar', 'coolmod', 'Cool Mod', { packages: ['com.example.coolmod.client'] }), mod('sodium.jar', 'sodium', 'Sodium')] });
  assert.equal(r.issues[0].id, 'suspect-mod');
  assert.equal(r.suspects[0].file, 'coolmod-2.jar');
  assert.equal(r.facts.javaMajor, 17);
  assert.equal(r.facts.gpuVendor, 'nvidia');
  assert.equal(r.exception.type, 'java.lang.NullPointerException');
});

test('Ticking modded entity names the owning mod and location', () => {
  const crashReport = [
    'Description: Ticking entity',
    '',
    'java.lang.IllegalStateException: bad state',
    '\tat net.minecraft.class_1297.method_5773(class_1297.java:1)',
    '',
    '-- Entity being ticked --',
    'Details:',
    '\tEntity Type: alexsmobs:crow (com.github.alexthe666.alexsmobs.entity.EntityCrow)',
    "\tEntity's Exact location: 102.50, 64.00, -33.20"
  ].join('\n');
  const r = analyzeCrash({ crashReport, exitCode: -1, instance, mods: [mod('alexsmobs.jar', 'alexsmobs', "Alex's Mobs")] });
  assert.equal(r.issues[0].id, 'ticking');
  assert.match(r.summary, /alexsmobs:crow at 103, 64, -33/);
  assert.deepEqual(r.issues[0].culprits, ['alexsmobs.jar']);
});

test('JVM crash in the AMD driver points to the AMD download page', () => {
  const hsErr = [
    '#',
    '# A fatal error has been detected by the Java Runtime Environment:',
    '#',
    '#  EXCEPTION_ACCESS_VIOLATION (0xc0000005) at pc=0x00007ffb, pid=1234, tid=5678',
    '#',
    '# Problematic frame:',
    '# C  [atio6axx.dll+0x1a2b3c]',
    '#'
  ].join('\n');
  const r = analyzeCrash({ hsErr, exitCode: -1073741819, instance, mods: [] });
  assert.equal(r.issues[0].id, 'graphics-driver-crash');
  assert.equal(r.issues[0].fixes[0].kind, 'open-url');
  assert.match(r.issues[0].fixes[0].url, /amd\.com/);
  assert.match(r.exitMeaning, /Access violation/);
});

test('Missing library class -> install that library', () => {
  const log = [
    '[main/ERROR]: Failed to start the minecraft client',
    'java.lang.NoClassDefFoundError: me/shedaniel/clothconfig2/api/ConfigBuilder',
    '\tat com.example.mymod.Config.build(Config.java:10)',
    '\tat com.example.mymod.MyMod.onInitializeClient(MyMod.java:5)'
  ].join('\n');
  const r = analyzeCrash({ log, exitCode: 1, instance, mods: [mod('mymod.jar', 'mymod', 'My Mod', { packages: ['com.example.mymod'] })] });
  assert.equal(r.issues[0].id, 'missing-dependency');
  assert.equal(r.issues[0].fixes[0].slug, 'cloth-config');
  assert.match(r.issues[0].explanation, /My Mod/);
});

test('Wrong Minecraft version -> update or disable that mod', () => {
  const log = "\t - Mod 'Xaero's Minimap' (xaerominimap) 24.0.0 requires version 1.20.4 of minecraft, but only the wrong version is present: 1.20.1!";
  const r = analyzeCrash({ log, exitCode: 1, instance, mods: [mod('xaero.jar', 'xaerominimap', "Xaero's Minimap")] });
  assert.equal(r.issues[0].id, 'wrong-minecraft-version');
  assert.deepEqual(r.issues[0].fixes.map((f) => f.kind), ['update-mod', 'disable-mod']);
});

test('Static checks find duplicates and known conflicts', () => {
  const r = analyzeCrash({
    log: '', exitCode: 1, instance,
    mods: [
      mod('sodium-0.4.jar', 'sodium', 'Sodium', { version: '0.4.10' }),
      mod('sodium-0.5.jar', 'sodium', 'Sodium', { version: '0.5.8' }),
      { ...mod('OptiFine_HD.jar', 'optifine', 'OptiFine'), loader: 'optifine' }
    ]
  });
  const ids = r.issues.map((i) => i.id);
  assert.ok(ids.includes('duplicate-mods'));
  assert.ok(ids.includes('known-conflict'));
  const dup = r.issues.find((i) => i.id === 'duplicate-mods');
  assert.equal(dup.fixes[0].file, 'sodium-0.4.jar');
});

test('Unknown crash still returns a readable report', () => {
  const r = analyzeCrash({ log: 'nothing useful', exitCode: -805306369, instance, mods: [] });
  assert.equal(r.issues[0].id, 'unknown');
  assert.match(r.summary, /stopped responding/);
  assert.match(reportToText(r, { instanceName: 'Test', version: '1.20.1' }), /Native crash report/);
  assert.equal(exitMeaning(0), null);
});

test('a Fabric crash report (with a "Fabric Mods:" section) is analysed, not rejected', () => {
  const crashReport = [
    '---- Minecraft Crash Report ----',
    'Time: 2026-09-30 18:00:00',
    'Description: Exception in server tick loop',
    '',
    'java.lang.IllegalStateException: boom',
    '\tat net.minecraft.server.MinecraftServer.tick(MinecraftServer.java:1)',
    '',
    '-- System Details --',
    'Details:',
    '\tMinecraft Version: 1.21.1',
    '\tOperating System: Windows 11 (amd64) version 10.0',
    '\tJava Version: 21.0.4, Microsoft',
    '\tFabric Mods:',
    '\t\tfabric-api: Fabric API 0.100.0'
  ].join('\n');
  const r = analyzeCrash({ log: '', crashReport, exitCode: 1, instance, mods: [] });
  assert.ok(r.headline);
  assert.equal(r.facts?.loader ?? 'Fabric', 'Fabric');
});

test('Mixin "Error loading class" warnings are not blamed as a version mismatch', () => {
  const log = [
    '[12:00:01] [main/WARN]: Error loading class: com/mojang/authlib/yggdrasil/YggdrasilMinecraftSessionService (java.lang.ClassNotFoundException: com/mojang/authlib/yggdrasil/YggdrasilMinecraftSessionService)',
    '[12:00:01] [main/WARN]: Error loading class: net/minecraft/class_1297 (java.lang.ClassNotFoundException: net/minecraft/class_1297)',
    '[12:00:05] [Render thread/INFO]: Backend library: LWJGL version 3.3.3'
  ].join('\n');
  const r = analyzeCrash({ log, exitCode: 3221225477, instance: { ...instance, version: '26.3' }, mods: [mod('native.jar', 'native', 'Native Client')] });
  assert.ok(!r.issues.some((issue) => issue.id === 'version-mismatch'));
});
