const test = require('node:test');
const assert = require('node:assert/strict');
const jr = require('../electron/javaRuntime');

const TEMURIN_21 = `Property settings:
    file.encoding = UTF-8
    java.home = C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.4.7-hotspot
    java.runtime.name = OpenJDK Runtime Environment
    java.vendor = Eclipse Adoptium
    java.version = 21.0.4
    java.vm.name = OpenJDK 64-Bit Server VM
    os.arch = amd64
    sun.arch.data.model = 64

openjdk version "21.0.4" 2024-07-16 LTS
OpenJDK Runtime Environment Temurin-21.0.4+7 (build 21.0.4+7-LTS)
OpenJDK 64-Bit Server VM Temurin-21.0.4+7 (build 21.0.4+7-LTS, mixed mode, sharing)`;

const ORACLE_8_X86 = `Property settings:
    java.home = C:\\Program Files (x86)\\Java\\jre1.8.0_421
    java.vendor = Oracle Corporation
    java.version = 1.8.0_421
    java.vm.name = Java HotSpot(TM) Client VM
    os.arch = x86
    sun.arch.data.model = 32

java version "1.8.0_421"`;

test('probe output gives version, vendor and architecture', () => {
  const a = jr.parseProbeOutput(TEMURIN_21, 'C:/x/java.exe');
  assert.equal(a.major, 21);
  assert.equal(a.arch, 'x64');
  assert.equal(a.bits, 64);
  assert.equal(a.vendor, 'Eclipse Temurin');
  const b = jr.parseProbeOutput(ORACLE_8_X86, 'C:/y/java.exe');
  assert.equal(b.major, 8);
  assert.equal(b.arch, 'x86');
  assert.equal(b.bits, 32);
  assert.equal(b.vendor, 'Oracle');
  const c = jr.parseProbeOutput('openjdk version "17.0.2" 2022-01-18\nOpenJDK 64-Bit Server VM', '/j');
  assert.equal(c.major, 17);
  assert.equal(c.arch, 'x64');
  assert.equal(jr.normalizeArch('aarch64'), 'arm64');
  assert.equal(jr.parseProbeOutput('Error: could not find java.dll', '/j'), null);
});

test('compat check blocks Java that cannot start the version', () => {
  const rt = (major, extra = {}) => ({ major, version: String(major), arch: 'x64', bits: 64, vendor: 'Eclipse Temurin', ...extra });
  assert.equal(jr.checkCompat({ runtime: rt(21), requiredMajor: 21, mcVersion: '1.21.1', host: 'x64' }).status, 'ok');
  assert.equal(jr.checkCompat({ runtime: rt(17), requiredMajor: 21, mcVersion: '1.21.1', host: 'x64' }).issues[0].code, 'too-old');
  assert.equal(jr.checkCompat({ runtime: rt(17), requiredMajor: 8, mcVersion: '1.12.2', loader: 'forge', host: 'x64' }).issues[0].code, 'too-new-forge');
  assert.equal(jr.checkCompat({ runtime: rt(17), requiredMajor: 8, mcVersion: '1.16.5', loader: 'fabric', host: 'x64' }).status, 'warn');
  assert.equal(jr.checkCompat({ runtime: rt(8, { arch: 'x86', bits: 32 }), requiredMajor: 8, mcVersion: '1.8.9', memoryMaxGb: 4, host: 'x64' }).issues[0].code, '32-bit-memory');
  assert.equal(jr.checkCompat({ runtime: rt(21, { arch: 'arm64' }), requiredMajor: 21, mcVersion: '1.21.1', host: 'x64' }).issues[0].code, 'wrong-arch');
  assert.equal(jr.checkCompat({ runtime: rt(21), requiredMajor: 21, mcVersion: '1.21.1', host: 'arm64', platform: 'win32' }).issues[0].code, 'emulated');
  assert.equal(jr.checkCompat({ runtime: rt(21, { arch: 'arm64' }), requiredMajor: 17, mcVersion: '1.18.2', host: 'arm64', platform: 'darwin' }).issues[0].code, 'arm-natives');
  assert.equal(jr.checkCompat({ runtime: null }).issues[0].code, 'not-runnable');
});

test('compat check catches GC flags the Java does not support', () => {
  const rt = (major, vendor = 'Eclipse Temurin') => ({ major, version: String(major), arch: 'x64', bits: 64, vendor });
  const codes = (opts) => jr.checkCompat({ requiredMajor: 8, mcVersion: '1.20.1', host: 'x64', ...opts }).issues.map((i) => i.code);
  assert.deepEqual(codes({ runtime: rt(11), jvmArgs: '-XX:+UseZGC' }), ['zgc-unsupported']);
  assert.deepEqual(codes({ runtime: rt(17), jvmArgs: '-XX:+UseZGC -XX:+ZGenerational' }), ['zgen-unsupported']);
  assert.deepEqual(codes({ runtime: rt(17, 'Oracle'), jvmArgs: '-XX:+UseShenandoahGC' }), ['shenandoah-oracle']);
  assert.deepEqual(codes({ runtime: rt(17), jvmArgs: '-XX:+UseConcMarkSweepGC' }), ['cms-removed']);
  assert.deepEqual(codes({ runtime: rt(21), jvmArgs: '-XX:+UseG1GC -XX:+UseZGC' }), ['multiple-gc']);
});

test('GC presets adapt to the Java version', () => {
  assert.deepEqual(jr.gcPreset('zgc', 21), ['-XX:+UseZGC', '-XX:+ZGenerational', '-XX:+DisableExplicitGC']);
  assert.deepEqual(jr.gcPreset('zgc', 25), ['-XX:+UseZGC', '-XX:+DisableExplicitGC']);
  assert.deepEqual(jr.gcPreset('zgc', 8), []);
  assert.ok(jr.gcPreset('aikar', 17).includes('-XX:G1HeapRegionSize=8M'));
  assert.ok(jr.gcPreset('aikar', 17, 16).includes('-XX:G1HeapRegionSize=16M'));
  assert.deepEqual(jr.gcPreset('none', 21), []);
});

test('JVM args: quotes, ignored memory flags and clashing collectors', () => {
  assert.deepEqual(jr.splitArgs('-Dfoo="a b" -Xss2M \'-Dx=1 2\''), ['-Dfoo=a b', '-Xss2M', '-Dx=1 2']);
  assert.deepEqual(jr.buildJvmArgs({ preset: 'none', args: '-Xmx8G -Xms2G -Xss2M' }), ['-Xss2M']);
  const mixed = jr.buildJvmArgs({ preset: 'aikar', args: '-XX:+UseZGC', major: 21 });
  assert.equal(mixed.filter((f) => /Use\w+GC/.test(f)).join(), '-XX:+UseZGC');
});

test('renderer JVM presets match the main process', async () => {
  const web = await import('../src/lib/jvmFlags.js');
  for (const preset of ['none', 'aikar', 'zgc', 'shenandoah']) {
    for (const major of [8, 11, 17, 21, 22, 25]) {
      for (const args of ['', '-Xss2M', '-XX:+UseG1GC -Dx="a b"']) {
        assert.deepEqual(web.buildJvmArgs({ preset, args, major, memoryMaxGb: 8 }), jr.buildJvmArgs({ preset, args, major, memoryMaxGb: 8 }));
      }
    }
  }
  assert.deepEqual(web.GC_PRESETS.map((p) => p.id), jr.GC_PRESETS.map((p) => p.id));
});

test('auto Java picks a native, 64-bit runtime closest to the requirement', () => {
  const { pickRuntime } = require('../electron/java')._internals;
  const host = jr.hostArch();
  const other = host === 'x64' ? 'arm64' : 'x64';
  const list = [
    { path: 'a', major: 25, arch: host, bits: 64, source: 'System PATH' },
    { path: 'b', major: 17, arch: host, bits: 64, source: 'Program Files' },
    { path: 'c', major: 17, arch: other, bits: 64, source: 'Drive D:' },
    { path: 'd', major: 8, arch: 'x86', bits: 32, source: 'Program Files' },
    { path: 'e', major: 8, arch: host, bits: 64, source: 'Minecraft Launcher' }
  ];
  assert.equal(pickRuntime(list, 17).path, 'b');
  assert.equal(pickRuntime(list, 21).path, 'a');
  assert.equal(pickRuntime(list, 8).path, 'e');
});

test('scan finds at least the Java this machine has on PATH (when present)', async () => {
  const list = await jr.scan({ force: true });
  assert.ok(Array.isArray(list));
  for (const rt of list) {
    assert.ok(rt.path && rt.major !== undefined && rt.arch);
  }
});
