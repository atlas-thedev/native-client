const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');

/*
 * Java runtimes: discovery, inspection and compatibility.
 *
 * - probe(path): runs `java -XshowSettings:properties -version` and reads the
 *   real version, vendor and CPU architecture (x86 / x64 / arm64) of a binary.
 * - scan(): looks everywhere a runtime usually lives — PATH, JAVA_HOME, the
 *   registry, Program Files on every drive, other launchers' bundled runtimes,
 *   SDKMAN, Homebrew, /usr/lib/jvm… — and probes each one.
 * - checkCompat(): decides before launch whether a runtime can start a given
 *   Minecraft version with the chosen memory and JVM flags.
 * - gcPreset(): turns a garbage-collector preset into flags for that Java.
 */

const EXE = process.platform === 'win32' ? 'java.exe' : 'java';
const PROBE_TIMEOUT_MS = 8000;
const SCAN_TTL_MS = 60 * 1000;

let userDataDir = null;
const probeCache = new Map(); // key: path|mtime -> info|null
let scanCache = null; // { at, list }
let scanPromise = null;

function setUserData(dir) {
  userDataDir = dir;
}

/* ------------------------------------------------------------- inspection */

function normalizeArch(value, bits) {
  const v = String(value || '').toLowerCase();
  if (/aarch64|arm64/.test(v)) return 'arm64';
  if (/^arm/.test(v)) return 'arm';
  if (/amd64|x86_64|x64/.test(v)) return 'x64';
  if (/^(?:x86|i[3-6]86)$/.test(v)) return 'x86';
  if (Number(bits) === 32) return 'x86';
  if (Number(bits) === 64) return 'x64';
  return 'unknown';
}

/** "1.8.0_392" -> 8, "17.0.2" -> 17, "21" -> 21 */
function majorOf(versionString) {
  const text = String(versionString || '');
  const legacy = text.match(/^1\.(\d+)/);
  if (legacy) return Number(legacy[1]);
  const modern = text.match(/^(\d+)/);
  return modern ? Number(modern[1]) : null;
}

/** Parse the combined output of `java -XshowSettings:properties -version`. */
function parseProbeOutput(output, javaPath) {
  const prop = (name) => {
    const m = new RegExp(`^\\s*${name.replace(/\./g, '\\.')} = (.*)$`, 'm').exec(output);
    return m ? m[1].trim() : '';
  };
  const quoted = /version "([^"]+)"/.exec(output);
  const version = prop('java.version') || (quoted ? quoted[1] : '');
  if (!version) return null;
  const bits = Number(prop('sun.arch.data.model')) || (/64-Bit/i.test(output) ? 64 : null);
  const arch = normalizeArch(prop('os.arch'), bits);
  const vendor = prop('java.vendor') || prop('java.vm.vendor') || '';
  const runtime = prop('java.runtime.name');
  const vmName = prop('java.vm.name');
  return {
    path: javaPath,
    version,
    major: majorOf(version),
    arch,
    bits: bits || (arch === 'x86' || arch === 'arm' ? 32 : arch === 'unknown' ? null : 64),
    vendor: prettyVendor(vendor, vmName, output),
    home: prop('java.home') || null,
    jdk: /JDK|Development Kit/i.test(runtime) || fs.existsSync(path.join(path.dirname(javaPath), process.platform === 'win32' ? 'javac.exe' : 'javac')),
    vm: vmName || null
  };
}

function prettyVendor(vendor, vmName, output) {
  const text = `${vendor} ${vmName} ${output.slice(0, 400)}`;
  if (/Temurin|Adoptium/i.test(text)) return 'Eclipse Temurin';
  if (/Microsoft/i.test(text)) return 'Microsoft';
  if (/Azul|Zulu/i.test(text)) return 'Azul Zulu';
  if (/Amazon|Corretto/i.test(text)) return 'Amazon Corretto';
  if (/BellSoft|Liberica/i.test(text)) return 'BellSoft Liberica';
  if (/GraalVM/i.test(text)) return 'GraalVM';
  if (/Semeru|OpenJ9|IBM/i.test(text)) return 'IBM Semeru';
  if (/JetBrains/i.test(text)) return 'JetBrains Runtime';
  if (/Mojang/i.test(text)) return 'Mojang';
  if (/AdoptOpenJDK/i.test(text)) return 'AdoptOpenJDK';
  if (/Oracle/i.test(text)) return /OpenJDK/i.test(text) ? 'Oracle OpenJDK' : 'Oracle';
  if (/Red Hat/i.test(text)) return 'Red Hat';
  return vendor || 'Unknown vendor';
}

function run(file, args, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let output = '';
    let done = false;
    let proc;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, output });
    };
    try {
      proc = spawn(file, args, { windowsHide: true });
    } catch {
      resolve({ code: -1, output: '' });
      return;
    }
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* gone */ }
      finish(-1);
    }, timeoutMs);
    proc.stdout?.on('data', (d) => { output += d; });
    proc.stderr?.on('data', (d) => { output += d; });
    proc.on('error', () => finish(-1));
    proc.on('close', (code) => finish(code));
  });
}

/** Inspect one java binary. Resolves null when it can't run. */
async function probe(javaPath) {
  if (!javaPath || typeof javaPath !== 'string') return null;
  let key = javaPath;
  try {
    const stat = fs.statSync(javaPath);
    if (stat.isDirectory()) {
      const inside = [path.join(javaPath, 'bin', EXE), path.join(javaPath, 'Contents', 'Home', 'bin', EXE)].find((p) => fs.existsSync(p));
      if (!inside) return null;
      return probe(inside);
    }
    key = `${javaPath}|${stat.mtimeMs}`;
  } catch {
    // bare command such as "java" on PATH
  }
  if (probeCache.has(key)) return probeCache.get(key);
  let { code, output } = await run(javaPath, ['-XshowSettings:properties', '-version']);
  // Very old or exotic VMs reject -XshowSettings; fall back to plain -version.
  if (code !== 0 && /Unrecognized option|Could not create the Java Virtual Machine/i.test(output)) {
    ({ code, output } = await run(javaPath, ['-version']));
  }
  const info = code === 0 ? parseProbeOutput(output, javaPath) : null;
  probeCache.set(key, info);
  return info;
}

/** The machine's real CPU architecture (not Electron's, which may be emulated). */
let hostArchCache = null;
function hostArch() {
  if (hostArchCache) return hostArchCache;
  let arch = normalizeArch(process.arch === 'ia32' ? 'x86' : process.arch);
  if (process.platform === 'win32') {
    const native = process.env.PROCESSOR_ARCHITEW6432 || process.env.PROCESSOR_ARCHITECTURE || '';
    if (/ARM64/i.test(native)) arch = 'arm64';
    else if (/AMD64/i.test(native)) arch = 'x64';
  } else if (process.platform === 'darwin' && arch !== 'arm64') {
    try {
      const out = require('child_process').execFileSync('sysctl', ['-in', 'hw.optional.arm64'], { encoding: 'utf8', timeout: 2000 });
      if (out.trim() === '1') arch = 'arm64';
    } catch { /* intel */ }
  }
  hostArchCache = arch;
  return arch;
}

/* -------------------------------------------------------------- discovery */

const VENDOR_DIRS = [
  'Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'AdoptOpenJDK', 'Microsoft', 'Zulu', 'Azul',
  'BellSoft', 'Amazon Corretto', 'Semeru', 'IBM', 'GraalVM', 'OpenJDK', 'RedHat', 'ojdkbuild', 'JetBrains'
];
const JAVA_DIR_HINT = /java|jdk|jre|jvm|adopt|temurin|zulu|corretto|liberica|semeru|graal|openjdk|runtime/i;

function safeList(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Walk `dir` up to `depth` levels looking for bin/java. Only descends into
 * folders whose name looks Java-related past the first level, so scanning a
 * drive root stays cheap.
 */
function findBinaries(dir, depth, out, hintOnly = false) {
  const direct = path.join(dir, 'bin', EXE);
  if (fs.existsSync(direct)) {
    out.add(direct);
    return;
  }
  const mac = path.join(dir, 'Contents', 'Home', 'bin', EXE);
  if (fs.existsSync(mac)) {
    out.add(mac);
    return;
  }
  if (depth <= 0) return;
  for (const name of safeList(dir)) {
    if (name.startsWith('.') && name !== '.jdks') continue;
    if (hintOnly && !JAVA_DIR_HINT.test(name)) continue;
    findBinaries(path.join(dir, name), depth - 1, out, hintOnly);
  }
}

function windowsDrives() {
  const drives = [];
  for (let c = 67; c <= 90; c += 1) { // C..Z
    const root = `${String.fromCharCode(c)}:\\`;
    try {
      fs.accessSync(root);
      drives.push(root);
    } catch { /* no drive */ }
  }
  return drives;
}

function registryJavaHomes() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const keys = [
    'HKLM\\SOFTWARE\\JavaSoft',
    'HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft',
    'HKLM\\SOFTWARE\\Eclipse Adoptium',
    'HKLM\\SOFTWARE\\Eclipse Foundation',
    'HKLM\\SOFTWARE\\AdoptOpenJDK',
    'HKLM\\SOFTWARE\\Azul Systems',
    'HKLM\\SOFTWARE\\Microsoft\\JDK',
    'HKLM\\SOFTWARE\\BellSoft',
    'HKLM\\SOFTWARE\\Amazon Corretto'
  ];
  return Promise.all(keys.map((key) => new Promise((resolve) => {
    execFile('reg', ['query', key, '/s'], { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error || !stdout) return resolve([]);
      const homes = [];
      for (const line of stdout.split(/\r?\n/)) {
        const m = /^\s+(?:JavaHome|Path|InstallationPath)\s+REG_SZ\s+(.+)$/i.exec(line);
        if (m) homes.push(m[1].trim());
      }
      resolve(homes);
    });
  }))).then((lists) => lists.flat());
}

/** Every place a Java runtime might be on this machine, with a source label. */
async function candidatePaths() {
  const home = os.homedir();
  const found = new Map(); // path -> label
  const add = (p, label) => {
    if (p && !found.has(p)) found.set(p, label);
  };
  const addTree = (dir, depth, label, hintOnly = false) => {
    const out = new Set();
    findBinaries(dir, depth, out, hintOnly);
    for (const p of out) add(p, label);
  };

  // Runtimes Noctra downloaded itself.
  if (userDataDir) addTree(path.join(userDataDir, 'java'), 2, 'Noctra');

  // PATH and JAVA_HOME
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, EXE))) add(path.join(dir, EXE), 'System PATH');
  }
  for (const env of ['JAVA_HOME', 'JDK_HOME', 'JRE_HOME']) {
    if (process.env[env]) addTree(process.env[env], 0, env);
  }

  // Other launchers' bundled runtimes.
  const appData = process.env.APPDATA || (process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : path.join(home, '.local', 'share'));
  const localAppData = process.env.LOCALAPPDATA || appData;
  const launcherDirs = [
    [path.join(appData, process.platform === 'darwin' ? 'minecraft' : '.minecraft', 'runtime'), 'Minecraft Launcher', 4],
    [path.join(home, '.minecraft', 'runtime'), 'Minecraft Launcher', 4],
    [path.join(localAppData, 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'runtime'), 'Minecraft Launcher', 4],
    [path.join(appData, 'PrismLauncher', 'java'), 'Prism Launcher', 2],
    [path.join(home, '.local', 'share', 'PrismLauncher', 'java'), 'Prism Launcher', 2],
    [path.join(appData, 'ModrinthApp', 'meta', 'java_versions'), 'Modrinth App', 2],
    [path.join(appData, 'com.modrinth.theseus', 'meta', 'java_versions'), 'Modrinth App', 2],
    [path.join(home, 'curseforge', 'minecraft', 'Install', 'runtime'), 'CurseForge', 4],
    [path.join(appData, '.tlauncher', 'jvms'), 'TLauncher', 2],
    [path.join(appData, 'gdlauncher_next', 'datastore', 'java'), 'GDLauncher', 3],
    [path.join(appData, 'ATLauncher', 'runtimes'), 'ATLauncher', 3],
    [path.join(home, '.lunarclient', 'jre'), 'Lunar Client', 3]
  ];
  for (const [dir, label, depth] of launcherDirs) addTree(dir, depth, label);

  // Developer tools.
  addTree(path.join(home, '.jdks'), 1, 'IntelliJ');
  addTree(path.join(home, '.sdkman', 'candidates', 'java'), 1, 'SDKMAN');
  addTree(path.join(home, '.asdf', 'installs', 'java'), 1, 'asdf');
  addTree(path.join(home, 'scoop', 'apps'), 2, 'Scoop', true);

  if (process.platform === 'win32') {
    for (const drive of windowsDrives()) {
      for (const pf of ['Program Files', 'Program Files (x86)']) {
        for (const vendor of VENDOR_DIRS) addTree(path.join(drive, pf, vendor), 2, vendor === 'Java' ? 'Program Files' : vendor);
      }
      // Hand-extracted JDKs at the root of a drive (D:\jdk-21, E:\Java\…).
      addTree(drive, 2, `Drive ${drive.slice(0, 2)}`, true);
    }
    for (const javaHome of await registryJavaHomes()) addTree(javaHome, 0, 'Registry');
  } else if (process.platform === 'darwin') {
    addTree('/Library/Java/JavaVirtualMachines', 1, 'System');
    addTree(path.join(home, 'Library', 'Java', 'JavaVirtualMachines'), 1, 'User');
    for (const brew of ['/opt/homebrew/opt', '/usr/local/opt']) {
      for (const name of safeList(brew)) {
        if (/openjdk|temurin|zulu|java/i.test(name)) addTree(path.join(brew, name, 'libexec', 'openjdk.jdk'), 0, 'Homebrew');
      }
    }
    addTree('/Library/Internet Plug-Ins/JavaAppletPlugin.plugin', 0, 'System');
  } else {
    for (const base of ['/usr/lib/jvm', '/usr/lib64/jvm', '/usr/java', '/usr/local/java', '/opt/java', '/opt/jdk', '/opt']) {
      addTree(base, base === '/opt' ? 2 : 1, 'System', base === '/opt');
    }
    addTree('/var/lib/flatpak/runtime', 4, 'Flatpak', true);
  }
  return found;
}

function realKey(p) {
  try {
    return fs.realpathSync.native(p).toLowerCase();
  } catch {
    return String(p).toLowerCase();
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Find and inspect every Java on this machine. Cached for a minute. */
function scan({ force = false } = {}) {
  if (!force && scanCache && Date.now() - scanCache.at < SCAN_TTL_MS) return Promise.resolve(scanCache.list);
  if (scanPromise) return scanPromise;
  scanPromise = (async () => {
    const candidates = await candidatePaths();
    const entries = [...candidates.entries()];
    const seen = new Set();
    const unique = entries.filter(([p]) => {
      const key = realKey(p);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const host = hostArch();
    const probed = await mapLimit(unique, 6, async ([p, source]) => {
      const info = await probe(p);
      return info ? { ...info, source, label: source, native: info.arch === host } : null;
    });
    // One entry per java.home (bin/java and jre/bin/java of one JDK).
    const homes = new Set();
    const list = probed.filter(Boolean).filter((info) => {
      const key = (info.home || info.path).toLowerCase();
      if (homes.has(key)) return false;
      homes.add(key);
      return true;
    });
    list.sort((a, b) => (b.major || 0) - (a.major || 0) || Number(b.native) - Number(a.native) || String(a.path).localeCompare(String(b.path)));
    scanCache = { at: Date.now(), list };
    return list;
  })().finally(() => {
    scanPromise = null;
  });
  return scanPromise;
}

/* --------------------------------------------------------- compatibility */

const VERSION_RE = /^(\d+)\.(\d+)(?:\.(\d+))?/;
function mcParts(mcVersion) {
  const m = VERSION_RE.exec(String(mcVersion || ''));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] || 0) };
}

/** Old (pre-1.17) Minecraft and its loaders are built for Java 8. */
function isJava8Era(mcVersion) {
  const v = mcParts(mcVersion);
  return Boolean(v && v.major === 1 && v.minor < 17);
}

/** LWJGL builds before 1.19 ship no Apple Silicon natives. */
function lacksArmNatives(mcVersion) {
  const v = mcParts(mcVersion);
  return Boolean(v && v.major === 1 && v.minor < 19);
}

function hasGcFlag(args) {
  return /-XX:\+Use(?:G1|Z|Shenandoah|Parallel|ParallelOld|Serial|ConcMarkSweep|Epsilon)GC\b/.test(args);
}

/**
 * Can `runtime` start Minecraft `mcVersion`? Returns { status, issues } where
 * status is 'ok' | 'warn' | 'error' and each issue has { level, code, message }.
 */
function checkCompat({ runtime, requiredMajor, mcVersion, loader = 'vanilla', memoryMaxGb = 4, jvmArgs = '', preset = 'none', host = hostArch(), platform = process.platform } = {}) {
  const issues = [];
  const push = (level, code, message) => issues.push({ level, code, message });
  const loaderId = String(loader || 'vanilla').toLowerCase();

  if (!runtime) {
    push('error', 'not-runnable', 'This Java could not be started. Check the path, or let Noctra pick Java automatically.');
    return { status: 'error', issues };
  }
  const major = runtime.major;
  const need = Number(requiredMajor) || null;

  if (need && major && major < need) {
    push('error', 'too-old', `Minecraft ${mcVersion} needs Java ${need} or newer; this is Java ${major}.`);
  }
  if (major && major > 8 && isJava8Era(mcVersion)) {
    const v = mcParts(mcVersion);
    const forge = /forge|liteloader/.test(loaderId) && !/neoforge/.test(loaderId);
    // Forge ≤1.12 (LaunchWrapper) needs Java 8; 1.13–1.16 coremods need Nashorn, gone in Java 15.
    if (forge && (v?.minor <= 12 || major >= 15)) {
      push('error', 'too-new-forge', `Forge for Minecraft ${mcVersion} only runs on Java 8; this is Java ${major}.`);
    } else if (forge) {
      push('warn', 'too-new', `Forge for Minecraft ${mcVersion} is built for Java 8. Java ${major} may work, but Java 8 is safer.`);
    } else if (v && v.minor <= 12) {
      push('error', 'too-new-legacy', `Minecraft ${mcVersion} only runs reliably on Java 8; this is Java ${major}.`);
    } else {
      push('warn', 'too-new', `Minecraft ${mcVersion} was built for Java 8. Java ${major} usually works, but some mods break.`);
    }
  }

  if (runtime.arch === 'x86' || runtime.arch === 'arm' || runtime.bits === 32) {
    if (Number(memoryMaxGb) > 1.5) {
      push('error', '32-bit-memory', `This is a 32-bit Java, which can't use more than about 1.5 GB of memory (${memoryMaxGb} GB set). Use a 64-bit Java.`);
    } else {
      push('warn', '32-bit', 'This is a 32-bit Java. A 64-bit Java is faster and can use more memory.');
    }
  }
  if (runtime.arch !== 'unknown' && host !== 'unknown' && runtime.arch !== host) {
    if (host === 'arm64' && (runtime.arch === 'x64' || runtime.arch === 'x86')) {
      if (!(platform === 'darwin' && lacksArmNatives(mcVersion))) {
        push('warn', 'emulated', `This ${runtime.arch} Java runs through emulation on your ARM processor. A native arm64 Java is faster.`);
      }
    } else if (host === 'x64' && runtime.arch === 'x86') {
      // covered by the 32-bit notes
    } else if (host === 'x64' && runtime.arch === 'arm64') {
      push('error', 'wrong-arch', 'This Java is built for ARM processors and can\'t run on this PC.');
    }
  }
  if (platform === 'darwin' && runtime.arch === 'arm64' && lacksArmNatives(mcVersion)) {
    push('warn', 'arm-natives', `Minecraft ${mcVersion} has no native Apple Silicon libraries. If it fails to start, use an x64 Java (Rosetta).`);
  }

  // Garbage-collector flags this Java doesn't support stop the JVM outright.
  const args = String(jvmArgs || '');
  if (/-XX:\+UseZGC\b/.test(args) && major && major < 15) {
    push('error', 'zgc-unsupported', `ZGC needs Java 15 or newer; this is Java ${major}.`);
  }
  if (/-XX:\+ZGenerational\b/.test(args) && major && major < 21) {
    push('error', 'zgen-unsupported', `Generational ZGC needs Java 21 or newer; this is Java ${major}.`);
  }
  if (/-XX:\+UseShenandoahGC\b/.test(args)) {
    if (major && major < 12 && major !== 8) push('error', 'shenandoah-unsupported', `Shenandoah needs Java 12 or newer; this is Java ${major}.`);
    else if (/^Oracle$/.test(runtime.vendor)) push('error', 'shenandoah-oracle', 'Oracle\'s Java builds don\'t include Shenandoah. Use Temurin, Zulu or Microsoft OpenJDK.');
  }
  if (/-XX:\+UseConcMarkSweepGC\b/.test(args) && major && major >= 14) {
    push('error', 'cms-removed', `The CMS collector was removed in Java 14; this is Java ${major}.`);
  }
  const gcFlags = args.match(/-XX:\+Use(?:G1|Z|Shenandoah|Parallel|Serial|ConcMarkSweep|Epsilon)GC\b/g) || [];
  if (new Set(gcFlags).size > 1) {
    push('error', 'multiple-gc', `More than one garbage collector is selected (${[...new Set(gcFlags)].join(', ')}). Keep one.`);
  }
  if (preset && preset !== 'none' && hasGcFlag(args) && gcFlags.length && !gcPreset(preset, major).some((flag) => gcFlags.includes(flag))) {
    // custom flags already pick a collector; the preset's collector is skipped at launch
    push('warn', 'preset-overridden', 'Your custom arguments choose a garbage collector, so the preset\'s collector is skipped.');
  }

  const status = issues.some((i) => i.level === 'error') ? 'error' : issues.length ? 'warn' : 'ok';
  return { status, issues };
}

/* -------------------------------------------------------------- JVM flags */

const AIKAR = [
  '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200', '-XX:+UnlockExperimentalVMOptions',
  '-XX:+DisableExplicitGC', '-XX:+AlwaysPreTouch', '-XX:G1NewSizePercent=30', '-XX:G1MaxNewSizePercent=40',
  '-XX:G1HeapRegionSize=8M', '-XX:G1ReservePercent=20', '-XX:G1HeapWastePercent=5', '-XX:G1MixedGCCountTarget=4',
  '-XX:InitiatingHeapOccupancyPercent=15', '-XX:G1MixedGCLiveThresholdPercent=90', '-XX:G1RSetUpdatingPauseTimePercent=5',
  '-XX:SurvivorRatio=32', '-XX:+PerfDisableSharedMem', '-XX:MaxTenuringThreshold=1'
];
// Aikar's large-heap variant (12 GB+).
const AIKAR_LARGE = AIKAR.map((flag) => ({
  '-XX:G1NewSizePercent=30': '-XX:G1NewSizePercent=40',
  '-XX:G1MaxNewSizePercent=40': '-XX:G1MaxNewSizePercent=50',
  '-XX:G1HeapRegionSize=8M': '-XX:G1HeapRegionSize=16M',
  '-XX:G1ReservePercent=20': '-XX:G1ReservePercent=15',
  '-XX:InitiatingHeapOccupancyPercent=15': '-XX:InitiatingHeapOccupancyPercent=20'
}[flag] || flag));

const GC_PRESETS = [
  { id: 'none', label: 'Java default', short: 'Default', description: 'Let Java choose (G1 on Java 9+).' },
  { id: 'aikar', label: "Aikar's flags", short: "Aikar's", description: 'Tuned G1 for smooth frame times. Best general choice for modpacks.' },
  { id: 'zgc', label: 'ZGC', short: 'ZGC', description: 'Sub-millisecond pauses on big heaps (8 GB+). Java 17+, generational on 21+.', minJava: 15 },
  { id: 'shenandoah', label: 'Shenandoah', short: 'Shenandoah', description: 'Low-pause concurrent GC. Not in Oracle builds.', minJava: 12 }
];

/** Flags for a GC preset on a given Java major (empty when unsupported). */
function gcPreset(id, major, memoryMaxGb = 4) {
  switch (id) {
    case 'aikar':
      return Number(memoryMaxGb) >= 12 ? [...AIKAR_LARGE] : [...AIKAR];
    case 'zgc':
      if (major && major < 15) return [];
      // Generational ZGC: opt-in on 21–22, the default from 23, the only mode from 24.
      if (major === 21 || major === 22) return ['-XX:+UseZGC', '-XX:+ZGenerational', '-XX:+DisableExplicitGC'];
      return ['-XX:+UseZGC', '-XX:+DisableExplicitGC'];
    case 'shenandoah':
      if (major && major < 12 && major !== 8) return [];
      return ['-XX:+UseShenandoahGC', '-XX:+DisableExplicitGC', '-XX:+ParallelRefProcEnabled'];
    default:
      return [];
  }
}

/** Split a flags string like a shell would ("quoted values" stay one argument). */
function splitArgs(text) {
  const out = [];
  let current = '';
  let quote = null;
  let has = false;
  for (const ch of String(text || '')) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || current) out.push(current);
      current = '';
      has = false;
    } else {
      current += ch;
      has = true;
    }
  }
  if (has || current) out.push(current);
  return out;
}

/**
 * Final JVM flags: preset first, then the user's own flags (which win). A
 * preset whose collector clashes with a collector picked in the custom flags
 * is dropped, as are memory flags (the launcher sets -Xms/-Xmx itself).
 */
function buildJvmArgs({ preset = 'none', args = '', major = null, memoryMaxGb = 4 } = {}) {
  const custom = splitArgs(args).filter((flag) => !/^-Xm[sx]\d/i.test(flag));
  const customText = custom.join(' ');
  let presetFlags = gcPreset(preset, major, memoryMaxGb);
  if (hasGcFlag(customText)) presetFlags = presetFlags.filter((flag) => !/-XX:\+Use\w+GC|ZGenerational/.test(flag) || customText.includes(flag));
  if (presetFlags.length && !presetFlags.some((f) => /Use\w+GC/.test(f)) && preset !== 'none' && hasGcFlag(customText)) {
    // Only the tuning flags of another collector would remain; they'd be meaningless.
    presetFlags = presetFlags.filter((flag) => /DisableExplicitGC|AlwaysPreTouch|PerfDisableSharedMem/.test(flag));
  }
  return [...presetFlags, ...custom];
}

module.exports = {
  setUserData,
  probe,
  scan,
  hostArch,
  majorOf,
  normalizeArch,
  parseProbeOutput,
  checkCompat,
  gcPreset,
  buildJvmArgs,
  splitArgs,
  GC_PRESETS,
  _internals: { candidatePaths, findBinaries, probeCache, clearScan: () => { scanCache = null; } }
};
