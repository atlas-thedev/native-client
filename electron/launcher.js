const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { Client } = require('minecraft-launcher-core');
const auth = require('./auth');
const settingsMod = require('./settings');
const javaMod = require('./java');
const javaRuntime = require('./javaRuntime');
const { downloadFile, fetchJson, writeFileAtomic } = require('./download');
const installRegistry = require('./installRegistry');
const wardrobeMod = require('./wardrobe');
const nativeMod = require('./nativeMod');
const adsMod = require('./ads');
const versionArt = require('./versionArt');
const socialMod = require('./social');
const gamePresence = require('./gamePresence');
const playHistory = require('./playHistory');
const crashReporter = require('./crashReporter');
const gameConsole = require('./gameConsole');
const loaders = require('./loaders');
loaders.patchMclc();
const { execFile } = require('child_process');

/**
 * Game launch pipeline (main process).
 *
 * Layout on disk (inside Electron userData):
 *   minecraft/                  <- shared root: versions, libraries, assets
 *     versions/  libraries/  assets/
 *     forge-installers/         <- cached Forge installer jars
 *     instances/<id>/           <- per-instance game dir (worlds, mods, configs)
 *
 * Sharing the root means a version's jars/assets download once; Fabric's
 * runtime files are verified before launch, while each instance still gets
 * its own isolated game directory.
 */

const launcher = new Client();
let deps = null; // { app, getWin }
let activeChild = null;
// The running game's mod-presence watcher (see gamePresence.js).
let modPresence = null;
let activeInstance = null;
let launchInProgress = false;
let activeFinish = null; // finish(code, signal) of the running game
let stopState = null; // { child, timer, fallback, forced }

// Cumulative download stats across the entire launch session
let cumulativeDownloadedBytes = 0;
const inFlightFiles = new Map(); // name -> bytes received so far
let lastProgressSentAt = 0;
let lastPercentSent = -1;
let lastPhaseSent = null;
let currentDetail = 'Downloading game files…';
let currentPhase = 'downloading';

/* ── Overall progress ─────────────────────────────────────────
   Every source (Java, loader libraries, MCLC's natives / jar / libraries /
   assets) used to report its own 0→100, so the bar restarted for each file
   and each stage. Stages now map onto one weighted 0→100 timeline that only
   ever moves forward; a stage that has nothing to do is simply skipped. */
const STAGES = [
  ['java', 12, 'Installing Java'],
  ['loader', 8, 'Downloading loader'],
  ['natives', 4, 'Downloading natives'],
  ['version-jar', 12, 'Downloading game'],
  ['classes-maven-custom', 3, 'Downloading loader libraries'],
  ['classes-custom', 3, 'Downloading loader libraries'],
  ['classes', 24, 'Downloading libraries'],
  ['assets', 32, 'Downloading assets'],
  ['assets-copy', 2, 'Copying assets']
];
const STAGE_INDEX = new Map(STAGES.map(([key], index) => [key, index]));
const STAGE_START = STAGES.reduce((starts, [, weight], index) => {
  starts.push(index === 0 ? 0 : starts[index - 1] + STAGES[index - 1][1]);
  return starts;
}, []);

let overallPercent = 0;
let overallStage = null;

function resetProgress() {
  overallPercent = 0;
  overallStage = null;
}

/** Count bytes for one file toward the session total. */
function trackBytes(key, received) {
  if (!key || !Number.isFinite(received)) return;
  const previous = inFlightFiles.get(key) || 0;
  if (received > previous) {
    cumulativeDownloadedBytes += received - previous;
    inFlightFiles.set(key, received);
  }
}

/**
 * Report progress for a stage. `fraction` is 0..1 within that stage.
 * `extra` may carry { detail, task, total, phase, force }.
 */
function reportProgress(stage, fraction, extra = {}) {
  const index = STAGE_INDEX.get(stage);
  if (index === undefined) return;
  const [, weight, label] = STAGES[index];
  const clamped = Math.max(0, Math.min(1, Number(fraction) || 0));
  const next = STAGE_START[index] + weight * clamped;
  // Never move backwards (parallel downloads can report out of order).
  if (next > overallPercent) overallPercent = next;
  overallStage = stage;

  const now = Date.now();
  if (!extra.force && now - lastProgressSentAt < 100 && clamped < 1) return;
  lastProgressSentAt = now;
  lastPercentSent = Math.round(overallPercent);
  lastPhaseSent = stage;

  const phase = extra.phase || (stage === 'assets' || stage === 'assets-copy' ? 'verifying' : 'downloading');
  currentPhase = phase;
  currentDetail = extra.detail || label;
  send('launcher:progress', {
    percent: Math.min(99, overallPercent),
    detail: currentDetail,
    phase,
    stage,
    stageLabel: label,
    stagePercent: Math.round(clamped * 100),
    task: extra.task ?? null,
    total: extra.total ?? null,
    bytes: cumulativeDownloadedBytes
  });
}

/** Lines Minecraft / the JVM print when the game dies on a fatal error. */
const gameLog = require('./gameLog');
const { GAME_CRASH_MARKER } = gameLog;

/**
 * Decide whether a finished game process counts as a crash. A non-zero exit,
 * a crash marker in the output or a crash report on disk all say yes, and a
 * "clean" exit within seconds of launching without ever printing anything is
 * a failed start rather than a normal quit.
 */
function classifyExit({ code, signal, crashSeen = false, hasCrashRecord = false, startedAgo = Infinity, sawOutput = true }) {
  const userStopped = code === null && (signal === 'SIGTERM' || signal === 'SIGINT') && !crashSeen && !hasCrashRecord;
  if (userStopped) return { crashed: false, detail: '' };
  if (typeof code === 'number' && code !== 0) {
    return { crashed: true, detail: `Minecraft crashed (exit code ${code}). Analyzing the crash\u2026` };
  }
  if (crashSeen || hasCrashRecord) {
    return { crashed: true, detail: 'Minecraft crashed. Analyzing the crash\u2026' };
  }
  if (code === null && signal) {
    return { crashed: true, detail: `Minecraft was stopped unexpectedly (${signal}).` };
  }
  if (startedAgo < 6000 && !sawOutput) {
    return { crashed: true, detail: 'Minecraft closed right after starting. Check the logs.' };
  }
  return { crashed: false, detail: '' };
}

function send(channel, payload) {
  const win = deps?.getWin();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

let lastConsoleNote = '';
const setState = (status, detail = '') => {
  send('launcher:state', { status, detail });
  // Mirror launch milestones into the live console (download % ticks are noise).
  if (detail && ['preparing', 'launching', 'error', 'stopping'].includes(status) && detail !== lastConsoleNote) {
    lastConsoleNote = detail;
    gameConsole.pushLauncher(status === 'error' ? `Error: ${detail}` : detail);
  }
};

const rootDir = () => path.join(deps.app.getPath('userData'), 'minecraft');
const instanceDir = (id) => path.join(rootDir(), 'instances', id);

/** The Native session of the account being launched (Native account, or a premium account's own). */
function nativeIdentityFor(rawAccount) {
  try {
    const data = auth.readAccounts(deps.app.getPath('userData'));
    const saved = (data.accounts || []).find((entry) => entry.id === rawAccount?.id);
    if (!saved) return null;
    if (saved.type === 'native') {
      const token = saved.token || saved.sessionToken;
      return token ? { id: saved.id, name: saved.name || saved.username, token } : null;
    }
    return auth.linkedIdentity(saved);
  } catch { return null; }
}

/**
 * An offline account's worn skin/cape for the Native mod (this PC only, never
 * published). The textures go into Minecraft's own skin cache so the game
 * reads them from disk.
 */
function offlineLook(rawAccount, account) {
  if (rawAccount?.type !== 'offline') return null;
  try {
    const look = wardrobeMod.localLook({ ...account, ...rawAccount });
    if (!look) return null;
    const textureCache = require('./textureCache');
    nativeMod.seedSkinCache(path.join(rootDir(), 'assets', 'skins'),
      [look.skin, look.cape].filter(Boolean).map((hash) => ({ hash, bytes: textureCache.read(hash) })));
    return look;
  } catch { return null; }
}

function usesPost1216Rendering(mcVersion) {
  const match = String(mcVersion || '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const [, major, minor, patch = '0'] = match.map(Number);
  return major > 1 || (major === 1 && (minor > 21 || (minor === 21 && patch >= 6)));
}

/**
 * Quarantine jars which explicitly target another Minecraft version, plus the
 * pre-1.21.6 crosshair bytecode that calls the removed RenderSystem blend API.
 * Both can pass overly broad Fabric constraints and then crash at runtime. The
 * .disabled suffix is understood by the instance manager and is recoverable.
 */
function quarantineIncompatibleMods(gameDirectory, mcVersion) {
  const modsDirectory = path.join(gameDirectory, 'mods');
  if (!fs.existsSync(modsDirectory)) return [];

  let filenames;
  try {
    filenames = fs.readdirSync(modsDirectory).filter((name) => name.toLowerCase().endsWith('.jar'));
  } catch {
    return [];
  }

  const quarantined = [];
  for (const filename of filenames) {
    const source = path.join(modsDirectory, filename);
    try {
      const archive = new AdmZip(source);
      let metadata = {};
      const metadataEntry = archive.getEntry('fabric.mod.json');
      if (metadataEntry) metadata = JSON.parse(metadataEntry.getData().toString('utf8'));
      const identity = `${filename} ${metadata.id || ''} ${metadata.name || ''} ${metadata.version || ''}`;
      const explicitTarget = identity.match(/(?:^|[+_.-])mc[-_.]?(\d+\.\d+(?:\.\d+)?)(?:\b|[+_.-])/i)?.[1] || null;
      const targetsAnotherVersion = explicitTarget && explicitTarget !== mcVersion;
      const isLegacyCrosshair = usesPost1216Rendering(mcVersion) && /crosshair/i.test(identity) &&
        archive.getEntries().some((entry) => {
          if (entry.isDirectory || !entry.entryName.endsWith('.class')) return false;
          const bytes = entry.getData();
          return bytes.includes(Buffer.from('com/mojang/blaze3d/systems/RenderSystem')) &&
            bytes.includes(Buffer.from('enableBlend'));
        });
      if (!targetsAnotherVersion && !isLegacyCrosshair) continue;

      let disabledFilename = `${filename}.disabled`;
      let suffix = 1;
      while (fs.existsSync(path.join(modsDirectory, disabledFilename))) {
        disabledFilename = `${filename}.incompatible-${suffix}.disabled`;
        suffix += 1;
      }
      fs.renameSync(source, path.join(modsDirectory, disabledFilename));
      quarantined.push({
        filename,
        disabledFilename,
        reason: targetsAnotherVersion ? `targets Minecraft ${explicitTarget}` : 'uses the removed RenderSystem.enableBlend API'
      });
    } catch (error) {
      launcher.emit('debug', `[Native Client]: Could not inspect ${filename}: ${error.message}`);
    }
  }

  if (quarantined.length > 0) {
    const primaryManifest = path.join(modsDirectory, '.native-mods.json');
    const legacyManifest = path.join(modsDirectory, '.native-mods.json');
    const manifestFile = fs.existsSync(primaryManifest) ? primaryManifest : (fs.existsSync(legacyManifest) ? legacyManifest : primaryManifest);
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      for (const item of quarantined) {
        for (const [projectId, raw] of Object.entries(manifest)) {
          const entry = typeof raw === 'string' ? { filename: raw, folder: 'mods' } : raw;
          if (entry?.filename !== item.filename) continue;
          manifest[projectId] = { ...entry, filename: item.disabledFilename, enabled: false };
        }
      }
      writeFileAtomic(manifestFile, JSON.stringify(manifest, null, 2));
      if (manifestFile !== primaryManifest) {
        writeFileAtomic(primaryManifest, JSON.stringify(manifest, null, 2));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        launcher.emit('debug', `[Native Client]: Could not update the mod manifest: ${error.message}`);
      }
    }
  }

  return quarantined;
}

// Loader installs live in ./loaders; these wrappers keep the launch pipeline's
// progress reporting (state line, byte counter, stage bar) in one place.
const launchReport = ({ status, detail, key, received, fraction, task, total }) => {
  if (key) trackBytes(key, received);
  if (fraction !== null && fraction !== undefined) reportProgress('loader', fraction, { detail, task, total });
  if (status && detail) setState(status, detail);
};

const { mavenArtifact, fileMatches } = loaders;

/** Verify and repair Fabric's complete runtime before the less strict launch library runs. */
function ensureFabricLibraries(profile, kind = 'fabric') {
  return loaders.ensureLibraries(profile, { root: rootDir(), kind, report: launchReport });
}

/** Installs and verifies a Fabric / Quilt / Legacy Fabric profile; returns its version id. */
async function resolveFabric(mcVersion, requestedVersion = null, kind = 'fabric') {
  const result = await loaders.installFabricLike(kind, mcVersion, requestedVersion, { root: rootDir(), report: launchReport });
  return result.id;
}

/** Forge / NeoForge build -> validated jar for MCLC (installer, or universal jar for legacy Forge). */
async function resolveForge(mcVersion, requestedVersion = null, kind = 'forge') {
  const result = await loaders.installForgeLike(kind, mcVersion, requestedVersion, { root: rootDir(), report: launchReport });
  if (loaders.prepareForgeCache(rootDir(), mcVersion, result.jar)) {
    launcher.emit('debug', `[Native Client]: ${loaders.displayName(kind)} ${result.version} differs from the cached profile; regenerating`);
  }
  return result.jar;
}

/* ── install reconciliation ----------------------------------- */

/**
 * Minecraft Launcher Core names the asset index after the launch profile
 * (`fabric-loader-0.16.9-1.21.1`) while Mojang names it after the game version
 * (`1.21.1`). The content is identical, so keep a copy under the canonical
 * game-version name — that is the name install verification, other launchers,
 * and external tools look for.
 */
function ensureCanonicalAssetIndex(version, profileName) {
  try {
    if (!profileName) return null;
    const indexesDir = path.join(rootDir(), 'assets', 'indexes');
    const canonical = path.join(indexesDir, `${version}.json`);
    if (fs.existsSync(canonical)) return canonical;
    const source = path.join(indexesDir, `${profileName}.json`);
    if (!fs.existsSync(source)) return null;
    fs.copyFileSync(source, canonical);
    launcher.emit(
      'debug',
      `[Native Client]: Asset index ${path.basename(source)} is also available as ${path.basename(canonical)}`
    );
    return canonical;
  } catch (err) {
    launcher.emit('debug', `[Native Client]: Could not mirror the asset index: ${err.message}`);
    return null;
  }
}

/**
 * Store the exact files this install produced. Verification otherwise has to
 * guess which name the pipeline used, which is how a Fabric/Forge install could
 * keep reading as "assets not installed".
 */
function rememberInstall(instance, opts) {
  try {
    const root = rootDir();
    const profile = opts?.version?.custom || null;
    const versionDir = path.join(root, 'versions', profile || instance.version);
    const canonicalIndex = ensureCanonicalAssetIndex(instance.version, profile);
    const existing = (file) => (file && fs.existsSync(file) ? file : null);

    installRegistry.record({
      version: instance.version,
      loader: instance.loader || 'Vanilla',
      loaderVersion: instance.loaderVersion || null,
      files: {
        profile,
        jar: existing(path.join(versionDir, `${profile || instance.version}.jar`)),
        versionJson:
          existing(path.join(versionDir, `${instance.version}.json`)) ||
          existing(path.join(versionDir, `${profile || instance.version}.json`)),
        assetIndex:
          existing(canonicalIndex) ||
          existing(path.join(root, 'assets', 'indexes', `${profile || instance.version}.json`)),
        assetObjects: existing(path.join(root, 'assets', 'objects'))
      }
    });
  } catch (err) {
    launcher.emit('debug', `[Native Client]: Could not record the install: ${err.message}`);
  }
}

async function launch(payloadOrInstance = {}, maybeAccount = null, maybeOptions = {}) {
  let payload;
  if (payloadOrInstance && (payloadOrInstance.instance || payloadOrInstance.account)) {
    payload = { ...payloadOrInstance };
  } else {
    payload = {
      instance: payloadOrInstance,
      account: maybeAccount,
      ...maybeOptions
    };
  }

  if (activeChild || launchInProgress) {
    setState('error', activeChild ? 'The game is already running.' : 'A launch is already in progress.');
    return;
  }

  const rawInstance = payload.instance;
  if (!rawInstance) {
    setState('error', 'No instance specified to launch.');
    return;
  }

  const mcVersion = rawInstance.version || rawInstance.mc_version;
  if (!mcVersion) {
    setState('error', 'Instance is missing Minecraft version.');
    return;
  }

  const loader = String(rawInstance.loader || rawInstance.mc_loader || 'Vanilla');
  const loaderVersion = rawInstance.loaderVersion || rawInstance.mc_loader_version || null;

  const instance = {
    ...rawInstance,
    id: rawInstance.id || `instance-${mcVersion}`,
    version: mcVersion,
    loader,
    loaderVersion
  };
  lastConsoleNote = '';
  gameConsole.begin(instance);
  gameConsole.pushLauncher(`Launching ${instance.name || mcVersion} · Minecraft ${mcVersion} · ${loader}${loaderVersion ? ` ${loaderVersion}` : ''}`);

  const quarantined = quarantineIncompatibleMods(instanceDir(instance.id), mcVersion);
  if (quarantined.length > 0) {
    const names = quarantined.map((item) => item.filename).join(', ');
    setState('error', `Disabled incompatible mod${quarantined.length === 1 ? '' : 's'}: ${names}. Click Launch again to continue.`);
    gameConsole.end(instance.id, { note: 'Launch stopped before Minecraft started' });
    return;
  }

  const rawAccount = payload.account;
  const username = rawAccount?.username || rawAccount?.name || 'Player';
  const account = {
    ...rawAccount,
    username,
    name: username,
    useMicrosoft: Boolean(rawAccount?.useMicrosoft || rawAccount?.isMicrosoft)
  };

  launchInProgress = true;
  cumulativeDownloadedBytes = 0;
  inFlightFiles.clear();
  lastProgressSentAt = 0;
  lastPercentSent = -1;
  lastPhaseSent = null;
  currentDetail = 'Preparing…';
  currentPhase = 'preparing';
  resetProgress();
  try {
    const settings = settingsMod.get();

    // Per-instance overrides fall back to the global settings when disabled.
    const ov = instance.overrides || {};
    const memory = ov.memory?.enabled ? ov.memory : settings.memory;
    const resolution = ov.resolution?.enabled ? ov.resolution : settings.resolution;
    // JVM flags: the instance's own when it overrides them, else the launcher-wide ones.
    const instanceJvm = ov.jvmEnabled === true || (ov.jvmEnabled !== false && typeof ov.jvmArgs === 'string' && ov.jvmArgs.trim());
    const jvmChoice = instanceJvm
      ? { preset: ov.jvmPreset || 'none', args: ov.jvmArgs || '', scope: 'instance' }
      : { preset: settings.jvm?.preset || 'none', args: settings.jvm?.args || '', scope: 'global' };
    const memMaxGb = Math.max(0.5, Number(memory.max) || 4);
    const memMinGb = Math.max(0.5, Math.min(Number(memory.min) || 1, memMaxGb));

    // resolve the right Java for this MC version (auto-download if needed),
    // unless the instance pins its own Java binary.
    let javaPath;
    const overrideJava = ov.java?.enabled && ov.java.path ? ov.java.path : null;
    if (overrideJava) {
      javaPath = overrideJava;
    } else {
      try {
        javaPath = await javaMod.ensureJava(mcVersion, {
          setState,
          sendProgress: (p) => {
            trackBytes('java', p?.bytes);
            reportProgress('java', (p?.percent ?? 0) / 100, { detail: p?.detail });
          }
        });
      } catch (err) {
        setState('error', `Java setup failed: ${err.message}`);
        return;
      }
    }

    // Java compatibility check: version, CPU architecture, memory and GC flags.
    setState('preparing', 'Checking Java compatibility…');
    const runtime = await javaRuntime.probe(javaPath);
    const requiredJava = await javaMod.requiredMajor(mcVersion).catch(() => javaMod.fallbackMajor(mcVersion));
    const jvmArgs = javaRuntime.buildJvmArgs({ preset: jvmChoice.preset, args: jvmChoice.args, major: runtime?.major, memoryMaxGb: memMaxGb });
    if (runtime) {
      gameConsole.pushLauncher(`Java ${runtime.version} · ${runtime.vendor} · ${runtime.arch}${runtime.bits ? ` (${runtime.bits}-bit)` : ''} · needs Java ${requiredJava}+`);
    }
    if (jvmChoice.preset !== 'none' && !javaRuntime.gcPreset(jvmChoice.preset, runtime?.major, memMaxGb).length) {
      gameConsole.pushLauncher(`The ${jvmChoice.preset} GC preset is not available on Java ${runtime?.major ?? '?'}; using Java's default collector`);
    }
    const compat = javaRuntime.checkCompat({
      runtime,
      requiredMajor: requiredJava,
      mcVersion,
      loader,
      memoryMaxGb: memMaxGb,
      jvmArgs: jvmArgs.join(' '),
      preset: jvmChoice.preset
    });
    for (const issue of compat.issues.filter((i) => i.level === 'warn')) gameConsole.pushLauncher(`Warning: ${issue.message}`);
    if (compat.status === 'error') {
      const first = compat.issues.find((i) => i.level === 'error');
      const where = overrideJava ? ' Change the Java in this instance\'s Advanced settings.' : jvmChoice.scope === 'instance' ? ' Check this instance\'s JVM arguments.' : ' Check Settings → Java & Arguments.';
      for (const issue of compat.issues.filter((i) => i.level === 'error')) gameConsole.pushLauncher(`Blocked: ${issue.message}`);
      setState('error', `${first.message}${where}`);
      return;
    }

    // Microsoft accounts use a live session when Microsoft is reachable and
    // fall back to their saved profile in offline mode; offline and Native
    // accounts always launch with a local session. A launch never fails
    // just because there is no internet.
    if (account.useMicrosoft) setState('preparing', 'Refreshing Microsoft account…');
    const { authorization: authResult, mode: authMode } = await auth.getLaunchAuth(account);
    if (authMode === 'microsoft-offline') {
      gameConsole.pushLauncher(`Microsoft is unreachable or the sign-in expired: playing offline as ${authResult.name}. Singleplayer, LAN and offline-mode servers work; online-mode servers need a fresh sign-in.`);
    } else if (authMode === 'offline') {
      gameConsole.pushLauncher(`Offline account ${authResult.name}: singleplayer, LAN and offline-mode (online-mode=false) servers are available.`);
    }

    const opts = {
      root: rootDir(),
      version: { number: mcVersion, type: 'release' },
      // Megabytes (MCLC appends "M"), so half-GB steps work. The minimum never
      // exceeds the maximum: the JVM refuses to start otherwise.
      memory: {
        min: Math.round(memMinGb * 1024),
        max: Math.round(memMaxGb * 1024)
      },
      window: {
        width: resolution.width,
        height: resolution.height,
        fullscreen: resolution.fullscreen
      },
      overrides: { gameDirectory: instanceDir(instance.id) },
      authorization: authResult,
      javaPath
    };
    if (jvmArgs.length) opts.customArgs = jvmArgs;

    const isModern = (() => {
      const parts = String(mcVersion || '').split('.').map(Number);
      return parts[0] > 1 || (parts[0] === 1 && parts[1] >= 20);
    })();

    // Quick Play: MCLC turns opts.quickPlay into the right flags
    // (--quickPlayMultiplayer on 1.20+, --server/--port before that). Adding
    // the same flags to customLaunchArgs as well would pass them twice.
    if (payload?.quickJoinServer) {
      opts.quickPlay = {
        type: isModern ? 'multiplayer' : 'legacy',
        identifier: String(payload.quickJoinServer).trim()
      };
    } else if (payload?.quickJoinWorld && isModern) {
      opts.quickPlay = { type: 'singleplayer', identifier: String(payload.quickJoinWorld) };
    }

    try {
      const loaderKind = loaders.normalize(loader);
      const loaderName = loaders.displayName(loaderKind);
      if (loaders.isFabricLike(loaderKind)) {
        setState('preparing', `Resolving ${loaderName}…`);
        opts.version.custom = await resolveFabric(mcVersion, loaderVersion, loaderKind);
      } else if (loaders.isForgeLike(loaderKind)) {
        setState('preparing', `Resolving ${loaderName}…`);
        opts.forge = await resolveForge(mcVersion, loaderVersion, loaderKind);
      }

    } catch (err) {
      setState('error', err.message);
      return;
    }

    // Skins are cosmetic: a failure here (offline, API down) must never stop
    // the game from starting. Fabric/Quilt 1.16+ use the Native Client mod
    // (live skins + capes, signed in to the Native account); everything else
    // (older versions, Forge, NeoForge, Legacy Fabric) keeps CustomSkinLoader.
    if (loaders.normalize(loader) !== 'vanilla') {
      let modResult = { installed: false };
      try {
        modResult = await nativeMod.prepare({
          instance: { ...instance, loader },
          identity: nativeIdentityFor(rawAccount),
          gameDir: instanceDir(instance.id),
          cacheDir: path.join(deps.app.getPath('userData'), 'native-mod'),
          roots: socialMod.API_ROOTS,
          textureCache: (() => { try { return wardrobeMod.warmTextureCache(account); } catch { return null; } })(),
          // Offline accounts: their own skin shows in game on this PC only.
          local: offlineLook(rawAccount, account),
          // Discord Rich Presence lives in the mod now; the launcher setting switches it.
          presence: { discord: settingsMod.get().behavior?.discordRpc !== false },
          onState: (detail) => setState('preparing', detail)
        });
        if (modResult.warning) launcher.emit('debug', `[Native Client]: Native mod: ${modResult.warning}`);
        // Title-screen ads: the banners the launcher already downloaded.
        if (modResult.installed) await adsMod.writeForGame(instanceDir(instance.id)).catch(() => {});
        // Title-screen background: this version's artwork, the same picture as the instance card.
        if (modResult.installed) await versionArt.writeForGame(instanceDir(instance.id), instance).catch(() => {});
        if (modResult.installed) {
          gameConsole.pushLauncher(`Native Client mod ${modResult.version || modResult.filename} ready${modResult.signedIn ? ' · signed in to Native' : ' · guest mode'}`);
        }
      } catch (err) {
        gameConsole.pushLauncher(`Native Client mod unavailable: ${err.message}`);
      }

      if (modResult.installed) {
        try { wardrobeMod.removeSkinLoader(instance); } catch { /* leftover jar is harmless */ }
      } else {
        try {
          setState('preparing', 'Setting up CustomSkinLoader…');
          const wardrobe = await wardrobeMod.prepareFabricInstance(instance, account, (detail) => setState('preparing', detail));
          if (wardrobe?.warning) launcher.emit('debug', `[Native Client]: Wardrobe integration: ${wardrobe.warning}`);
        } catch (err) {
          gameConsole.pushLauncher(`Skins are unavailable for this session: ${err.message}`);
        }
      }
    }

  fs.mkdirSync(instanceDir(instance.id), { recursive: true });
  // Heal installs made by an older build before launching again.
  ensureCanonicalAssetIndex(instance.version, opts.version?.custom || null);
  setState('downloading', 'Downloading & verifying game files…');

  try {
    const child = await launcher.launch(opts);
    if (!child) {
      setState('error', 'Could not start the game process. Check the logs.');
      return;
    }
    // The pipeline finished downloading and verifying: the files on disk are
    // complete, so remember their real names for install detection.
    rememberInstall(instance, opts);
    activeChild = child;
    activeInstance = instance;
    const launchedAt = Date.now();
    crashReporter.beginSession({ instance, memoryMaxGb: memMaxGb, javaPath });
    setState('launching', 'Starting Minecraft…');
    socialMod.setPresence({
      status: 'in-game',
      activity: payload?.quickJoinServer ? 'In-game: Connecting…' : 'In-game: Starting…',
      serverAddress: payload?.quickJoinServer || null
    });
    // The Native mod reports exactly what the player is doing (it also drives Discord).
    gamePresence.clear(instanceDir(instance.id));
    modPresence?.stop();
    const presenceWatch = gamePresence.watch(instanceDir(instance.id), {
      since: launchedAt,
      onPresence: (presence) => {
        if (activeChild !== child) return;
        if (presence.server) {
          playHistory.recordServer({ address: presence.server.address, instanceId: instance.id ?? null, instanceName: instance.name ?? null });
        }
        socialMod.setPresence({ status: presence.status, activity: presence.activity, serverAddress: presence.serverAddress });
      }
    });
    modPresence = presenceWatch;
    send('launcher:progress', {
      percent: 100,
      detail: 'Starting Minecraft…',
      phase: 'launching',
      bytes: cumulativeDownloadedBytes
    });

    let sawOutput = false;
    let childFailed = false;
    let finished = false;
    let crashSeen = false;
    let crashKillTimer = null;
    let outputTail = '';
    const resetPresence = () => {
      presenceWatch.stop();
      if (modPresence === presenceWatch) modPresence = null;
      gamePresence.clear(instanceDir(instance.id));
      socialMod.setPresence({ status: 'in-launcher', activity: 'In Launcher', serverAddress: null });
    };
    // Chat shares stdout with the game's own diagnostics, so only trust
    // complete, non-chat lines when looking for crash markers.
    const classifyLine = gameLog.createLogClassifier();
    const crashLineReader = gameLog.createLineReader((line) => {
      if (!crashSeen && gameLog.isCrashLine(classifyLine(line))) onCrashMarker();
    });
    const captureOutput = (data) => {
      outputTail = `${outputTail}${String(data)}`.slice(-12000);
      crashReporter.capture(data);
      crashLineReader(data);
    };
    // Minecraft prints a marker when it hits a fatal error. Some mods leave the
    // JVM alive after that, so don't keep telling everyone the game is "starting".
    const onCrashMarker = () => {
      crashSeen = true;
      if (finished || activeChild !== child) return;
      setState('error', 'Minecraft crashed. Analyzing the crash\u2026');
      resetPresence();
      crashKillTimer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
      }, 4000);
    };
    const markRunning = () => {
      if (!sawOutput) {
        sawOutput = true;
        if (finished || crashSeen) return;
        setState('running', 'Minecraft is running');
        // The splash screen is up: stop advertising "Starting…" to friends.
        if (!payload?.quickJoinServer && !presenceWatch.isActive()) {
          socialMod.setPresence({ status: 'in-game', activity: 'In-game: Menus', serverAddress: null });
        }
        // launcher behavior once the game is up
        const win = deps.getWin();
        const action = settingsMod.get().behavior.launcherAction;
        if (win && !win.isDestroyed()) {
          if (action === 'minimize') win.minimize();
          else if (action === 'hide') win.hide();
        }
      }
    };
    gameConsole.pushLauncher(`Minecraft started (PID ${child.pid ?? '?'}) with Java ${javaPath || 'auto'}`);
    child.stdout?.on('data', (data) => { captureOutput(data); gameConsole.pushGame(data, 'stdout', instance.id); });
    child.stderr?.on('data', (data) => { captureOutput(data); gameConsole.pushGame(data, 'stderr', instance.id); });
    child.stdout?.on('data', markRunning);
    child.stderr?.on('data', markRunning);
    const runningFallback = setTimeout(() => {
      if (activeChild === child) markRunning();
    }, 2500);
    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      childFailed = true;
      clearTimeout(runningFallback);
      clearTimeout(crashKillTimer);
      if (activeChild === child) {
        activeChild = null;
        activeInstance = null;
      }
      nativeMod.clearHandoff(instanceDir(instance.id));
      setState('error', `Minecraft process failed: ${err.message}`);
      resetPresence();
      gameConsole.end(instance.id, { note: `Minecraft process failed: ${err.message}` });
    });
    const finish = async (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(runningFallback);
      clearTimeout(crashKillTimer);
      const startedAgo = Date.now() - launchedAt;
      const killed = Boolean(stopState && stopState.child === child);
      if (stopState?.child === child) {
        clearTimeout(stopState.timer);
        clearTimeout(stopState.fallback);
        stopState = null;
      }
      if (activeChild === child) {
        activeChild = null;
        activeInstance = null;
        activeFinish = null;
      }
      nativeMod.clearHandoff(instanceDir(instance.id));
      gameConsole.end(instance.id, { code, signal, killed });
      resetPresence();
      const record = await crashReporter.endSession(code, signal).catch(() => null);
      const verdict = killed
        ? { crashed: false, detail: '' }
        : classifyExit({ code, signal, crashSeen, hasCrashRecord: Boolean(record), startedAgo, sawOutput });
      if (verdict.crashed) {
        if (outputTail.includes('org/spongepowered/asm/launch/MixinBootstrap')) {
          setState('error', `${loaders.displayName(instance.loader)}'s Mixin failed to load after repair. Check the logs and try launching again.`);
        } else {
          setState('error', verdict.detail);
        }
      } else {
        setState('idle', '');
      }
      const win = deps.getWin();
      const { launcherAction, reopenOnExit } = settingsMod.get().behavior;
      // Always bring the launcher back after a crash so the report is visible.
      if (win && !win.isDestroyed() && launcherAction !== 'keep' && (reopenOnExit || verdict.crashed)) {
        win.show();
        if (win.isMinimized()) win.restore();
        if (verdict.crashed) win.focus();
      }
    };
    // 'exit' fires as soon as the process dies; 'close' waits for its pipes,
    // which a lingering child process can hold open. Use whichever comes first.
    child.on('exit', (code, signal) => {
      setTimeout(() => finish(code, signal), 1500);
    });
    child.on('close', (code, signal) => { finish(code, signal); });
    activeFinish = finish;
  } catch (err) {
    activeChild = null;
    setState('error', err.message);
  }
  } finally {
    launchInProgress = false;
    // The launch bailed out before a game process existed.
    if (!activeChild && gameConsole.isActive(instance.id)) {
      gameConsole.end(instance.id, { note: 'Launch stopped before Minecraft started' });
    }
  }
}

/* ------------------------------------------------------------------ stop */

/**
 * Ends a process (and on Windows its whole tree). Graceful first: Windows gets
 * a close request (taskkill without /F → WM_CLOSE), others SIGTERM so the JVM
 * runs its shutdown hooks. `force` kills outright.
 */
function terminate(child, force) {
  const pid = child?.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    execFile('taskkill', args, { windowsHide: true }, (error) => {
      if (error && force) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    });
    return;
  }
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already gone */ }
  }
}

const STOP_GRACE_MS = 8000;

function stopGame({ force = false } = {}) {
  const child = activeChild;
  if (!child) return { ok: false, reason: 'not-running' };
  crashReporter.markKilled();
  if (!stopState || stopState.child !== child) {
    stopState = { child, timer: null, fallback: null, forced: false };
  }
  const forceKill = () => {
    if (activeChild !== child || stopState?.forced) return;
    stopState.forced = true;
    clearTimeout(stopState.timer);
    gameConsole.pushLauncher('Force-stopping Minecraft and its child processes');
    setState('stopping', 'Force-stopping Minecraft…');
    terminate(child, true);
    // A JVM stuck in the kernel can outlive SIGKILL for a moment, and a child
    // it spawned can hold the pipes open; don't leave the UI stuck on "Stopping".
    stopState.fallback = setTimeout(() => {
      if (activeChild === child && activeFinish) activeFinish(null, 'SIGKILL');
    }, 4000);
  };
  if (force || stopState.timer) {
    forceKill();
    return { ok: true, forced: true };
  }
  setState('stopping', 'Stopping Minecraft…');
  terminate(child, false);
  stopState.timer = setTimeout(forceKill, STOP_GRACE_MS);
  return { ok: true, forced: false };
}

function init(dependencies, ipcMain) {
  deps = dependencies;
  installRegistry.init({ app: dependencies.app });

  launcher.on('download-status', ({ name, type, current, total }) => {
    trackBytes(`mclc:${type}:${name}`, current);

    // MCLC emits no 'progress' event for the client jar, only byte counts.
    if (type === 'version-jar') {
      reportProgress('version-jar', total ? current / total : 0, { detail: 'Downloading Minecraft' });
      return;
    }

    // Other files: keep the byte counter moving between stage events.
    const now = Date.now();
    if (overallStage && now - lastProgressSentAt >= 150) {
      lastProgressSentAt = now;
      send('launcher:progress', {
        percent: Math.min(99, overallPercent),
        detail: currentDetail,
        phase: currentPhase,
        stage: overallStage,
        bytes: cumulativeDownloadedBytes
      });
    }
  });

  launcher.on('progress', (e) => {
    if (!STAGE_INDEX.has(e.type)) return;
    const fraction = e.total ? e.task / e.total : 0;
    reportProgress(e.type, fraction, {
      task: e.task,
      total: e.total,
      detail: e.type === 'assets' && fraction >= 1 ? 'Preparing to start' : undefined,
      force: e.task === 0 || fraction >= 1
    });
  });

  let logBatch = [];
  let logTimeout = null;

  const flushLogs = () => {
    if (logBatch.length > 0) {
      send('launcher:log', logBatch);
      logBatch = [];
    }
    logTimeout = null;
  };

  const formatServerActivity = gameLog.formatServerActivity;

  // Fallback for games without the Native mod (vanilla, Forge, ...): guess from the log.
  const applyPresence = (hint) => {
    if (!hint || modPresence?.isActive()) return;
    if (hint.kind === 'server') {
      const { host, port } = hint;
      const serverAddress = `${host}:${port}`;
      const activityName = formatServerActivity(host);
      playHistory.recordServer({
        address: port === '25565' ? host : serverAddress,
        instanceId: activeInstance?.id ?? null,
        instanceName: activeInstance?.name ?? null
      });
      socialMod.setPresence({
        status: 'in-game',
        activity: `In-game: ${activityName}`,
        serverAddress
      });
      return;
    }
    if (hint.kind === 'singleplayer') {
      socialMod.setPresence({ status: 'in-game', activity: 'In-game: Singleplayer', serverAddress: null });
      return;
    }
    if (hint.kind === 'menus') {
      socialMod.setPresence({ status: 'in-game', activity: 'In-game: Menus', serverAddress: null });
    }
  };

  // Game output arrives in arbitrary chunks; re-assemble lines and skip chat
  // so other players can't spoof what friends see in Relay or Discord.
  const classifyPresenceLine = gameLog.createLogClassifier();
  const presenceLineReader = gameLog.createLineReader((line) => {
    if (!activeChild) return;
    applyPresence(gameLog.presenceFromLine(classifyPresenceLine(line)));
  });

  const queueLog = (line) => {
    const str = String(line);
    logBatch.push(str);
    if (!logTimeout) {
      logTimeout = setTimeout(flushLogs, 100);
    }
  };

  launcher.on('debug', (line) => {
    queueLog(line);
    // Skip MCLC's per-file chatter; keep the milestones.
    if (!/\[MCLC\]: (?:Downloaded|Attempting to download|Failed to download asset)/.test(String(line))) gameConsole.pushLauncher(line);
  });
  launcher.on('data', (data) => {
    presenceLineReader(data);
    queueLog(data);
  });

  ipcMain.on('launcher:launch', (_event, payload) => {
    launch(payload).catch((err) => {
      activeChild = null;
      setState('error', err.message);
    });
  });

  ipcMain.on('launcher:kill', (_event, options) => {
    stopGame({ force: Boolean(options?.force) });
  });
  ipcMain.handle('launcher:stop', (_event, options) => stopGame({ force: Boolean(options?.force) }));
}

module.exports = {
  init,
  isGameRunning: () => Boolean(activeChild),
  // Exported for focused launch-pipeline regression tests.
  _internals: {
    classifyExit,
    GAME_CRASH_MARKER,
    gameLog,
    mavenArtifact,
    fileMatches,
    ensureFabricLibraries,
    resolveFabric,
    ensureCanonicalAssetIndex,
    rememberInstall,
    usesPost1216Rendering,
    stopGame,
    terminate,
    quarantineIncompatibleMods,
    launch
  }
};
