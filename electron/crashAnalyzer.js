/**
 * Noctra crash analyser.
 *
 * Pure function: game output + crash report + JVM error file + the mods on
 * disk in, a ranked diagnosis out. Every issue carries a plain-language
 * explanation, the lines that prove it, the mod files to blame and one-click
 * fixes the launcher knows how to apply (see crashReporter.js).
 *
 * Confidence scale: 95 = the loader said so verbatim, 80 = a known signature,
 * 60 = stack-trace blame, 40 = a heuristic.
 */

const MAX_EVIDENCE = 6;

/* --------------------------------------------------------------- lookups */

// Class-package prefixes of popular libraries -> the Modrinth project that ships them.
const KNOWN_LIBS = [
  ['net.fabricmc.fabric', 'fabric-api', 'Fabric API'],
  ['net.fabricmc.language.kotlin', 'fabric-language-kotlin', 'Fabric Language Kotlin'],
  ['thedarkcolour.kotlinforforge', 'kotlin-for-forge', 'Kotlin for Forge'],
  ['kotlin', 'fabric-language-kotlin', 'Fabric Language Kotlin', { forge: ['kotlin-for-forge', 'Kotlin for Forge'] }],
  ['me.shedaniel.clothconfig2', 'cloth-config', 'Cloth Config'],
  ['me.shedaniel.autoconfig', 'cloth-config', 'Cloth Config'],
  ['me.shedaniel.cloth', 'cloth-config', 'Cloth Config'],
  ['me.shedaniel.architectury', 'architectury-api', 'Architectury API'],
  ['dev.architectury', 'architectury-api', 'Architectury API'],
  ['me.shedaniel.rei', 'rei', 'Roughly Enough Items'],
  ['software.bernie.geckolib', 'geckolib', 'GeckoLib'],
  ['com.terraformersmc.modmenu', 'modmenu', 'Mod Menu'],
  ['dev.isxander.yacl3', 'yacl', 'YetAnotherConfigLib'],
  ['dev.isxander.yacl', 'yacl', 'YetAnotherConfigLib'],
  ['io.wispforest.owo', 'owo-lib', 'oωo'],
  ['me.lucko.fabric.api.permissions', 'fabric-permissions-api', 'Fabric Permissions API'],
  ['fuzs.forgeconfigapiport', 'forge-config-api-port', 'Forge Config API Port'],
  ['net.minecraftforge.fml.config', 'forge-config-api-port', 'Forge Config API Port', { fabricOnly: true }],
  ['com.electronwill.nightconfig', 'forge-config-api-port', 'Forge Config API Port', { fabricOnly: true }],
  ['fuzs.puzzleslib', 'puzzles-lib', 'Puzzles Lib'],
  ['mezz.jei', 'jei', 'Just Enough Items'],
  ['dev.emi.emi', 'emi', 'EMI'],
  ['net.blay09.mods.balm', 'balm', 'Balm'],
  ['com.teamresourceful.resourcefullib', 'resourceful-lib', 'Resourceful Lib'],
  ['dev.onyxstudios.cca', 'cardinal-components-api', 'Cardinal Components API'],
  ['org.ladysnake.cca', 'cardinal-components-api', 'Cardinal Components API'],
  ['eu.midnightdust.lib', 'midnightlib', 'MidnightLib'],
  ['net.caffeinemc.mods.sodium', 'sodium', 'Sodium'],
  ['me.jellysquid.mods.sodium', 'sodium', 'Sodium'],
  ['net.irisshaders', 'iris', 'Iris Shaders'],
  ['net.coderbot.iris', 'iris', 'Iris Shaders'],
  ['link.infra.indium', 'indium', 'Indium'],
  ['top.theillusivec4.curios', 'curios', 'Curios API'],
  ['dev.emi.trinkets', 'trinkets', 'Trinkets'],
  ['com.github.alexthe666.citadel', 'citadel', 'Citadel'],
  ['net.darkhax.bookshelf', 'bookshelf-lib', 'Bookshelf'],
  ['vazkii.patchouli', 'patchouli', 'Patchouli'],
  ['com.natamus.collective', 'collective', 'Collective'],
  ['mod.azure.azurelib', 'azurelib', 'AzureLib'],
  ['dev.latvian.mods.kubejs', 'kubejs', 'KubeJS'],
  ['dev.latvian.mods.rhino', 'rhino', 'Rhino'],
  ['snownee.kiwi', 'kiwi', 'Kiwi'],
  ['com.jamieswhiteshirt.reachentityattributes', 'reach-entity-attributes', 'Reach Entity Attributes'],
  ['me.fzzyhmstrs.fzzy_config', 'fzzy-config', 'Fzzy Config'],
  ['org.anti_ad.mc.libipn', 'libipn', 'libIPN'],
  ['com.mrcrayfish.framework', 'framework', 'Framework'],
  ['com.simibubi.create', 'create', 'Create'],
  ['org.quiltmc.qsl', 'qsl', 'Quilted Fabric API'],
  ['dev.kosmx.playerAnim', 'playeranimator', 'playerAnimator'],
  ['com.teamabnormals.blueprint', 'blueprint', 'Blueprint'],
  ['net.mehvahdjukaar.moonlight', 'moonlight', 'Moonlight Lib'],
  ['com.github.terrablender', 'terrablender', 'TerraBlender'],
  ['terrablender', 'terrablender', 'TerraBlender'],
  ['team.creative.creativecore', 'creativecore', 'CreativeCore'],
  ['dev.tr7zw.transition', 'transition', 'Transition'],
  ['com.anthonyhilyard.iceberg', 'iceberg', 'Iceberg'],
  ['com.anthonyhilyard.prism', 'prism-lib', 'Prism'],
  ['eu.pb4.placeholders', 'placeholder-api', 'Text Placeholder API'],
  ['eu.pb4.polymer', 'polymer', 'Polymer'],
  ['com.faboslav.friendsandfoes', 'friends-and-foes', 'Friends&Foes'],
  ['net.minecraftforge', null, 'Forge', { wrongLoaderOn: ['fabric', 'quilt'] }],
  ['net.neoforged', null, 'NeoForge', { wrongLoaderOn: ['fabric', 'quilt'] }],
  ['net.fabricmc.api', null, 'Fabric', { wrongLoaderOn: ['forge', 'neoforge'] }]
];

// Mod ids -> Modrinth slug when they differ.
const ID_TO_SLUG = {
  fabric: 'fabric-api',
  'fabric-api': 'fabric-api',
  'cloth-config2': 'cloth-config',
  cloth_config: 'cloth-config',
  architectury: 'architectury-api',
  yet_another_config_lib_v3: 'yacl',
  'yet-another-config-lib': 'yacl',
  yet_another_config_lib: 'yacl',
  owo: 'owo-lib',
  geckolib3: 'geckolib',
  forgeconfigapiport: 'forge-config-api-port',
  puzzleslib: 'puzzles-lib',
  kotlinforforge: 'kotlin-for-forge',
  resourcefullib: 'resourceful-lib',
  bookshelf: 'bookshelf-lib',
  fzzy_config: 'fzzy-config',
  roughlyenoughitems: 'rei',
  'roughly-enough-items': 'rei',
  supermartijn642configlib: 'supermartijn642s-config-lib',
  supermartijn642corelib: 'supermartijn642s-core-lib',
  prism: 'prism-lib',
  cristellib: 'cristel-lib',
  quilted_fabric_api: 'qsl',
  'placeholder-api': 'placeholder-api',
  'cardinal-components': 'cardinal-components-api',
  playeranimator: 'playeranimator',
  'player-animator': 'playeranimator'
};

const LIBRARY_IDS = new Set([
  'fabric-api', 'fabric', 'fabricloader', 'cloth-config', 'cloth-config2', 'architectury', 'geckolib', 'yet_another_config_lib_v3',
  'owo', 'forgeconfigapiport', 'puzzleslib', 'balm', 'resourcefullib', 'midnightlib', 'fabric-language-kotlin', 'kotlinforforge',
  'modmenu', 'collective', 'bookshelf', 'citadel', 'curios', 'trinkets', 'moonlight', 'creativecore', 'iceberg', 'prism', 'libipn',
  'mixinextras', 'cardinal-components', 'placeholder-api', 'fzzy_config', 'framework', 'blueprint', 'kiwi', 'terrablender', 'qsl',
  'quilted_fabric_api'
]);

const LOADER_IDS = new Set(['fabricloader', 'fabric-loader', 'quilt_loader', 'forge', 'neoforge', 'fml', 'javafml', 'lowcodefml']);
const PLATFORM_IDS = new Set(['minecraft', 'java', ...LOADER_IDS]);

// Well-known pairs that cannot run together. [a, b, why]
const INCOMPATIBLE_PAIRS = [
  ['sodium', 'optifine', 'Sodium and OptiFine both replace the renderer and cannot run together.'],
  ['iris', 'optifine', 'Iris and OptiFine both implement shaders and cannot run together.'],
  ['embeddium', 'optifine', 'Embeddium and OptiFine both replace the renderer.'],
  ['rubidium', 'optifine', 'Rubidium and OptiFine both replace the renderer.'],
  ['oculus', 'optifine', 'Oculus and OptiFine both implement shaders.'],
  ['sodium', 'embeddium', 'Embeddium is a Sodium port; only one of them can be installed.'],
  ['sodium', 'rubidium', 'Rubidium is a Sodium port; only one of them can be installed.'],
  ['embeddium', 'rubidium', 'Embeddium replaces Rubidium; keep only one.'],
  ['sodium', 'canvas', 'Canvas and Sodium both replace the renderer.'],
  ['starlight', 'phosphor', 'Starlight and Phosphor both rewrite the lighting engine.'],
  ['lithium', 'radium', 'Radium is a Lithium port; keep only one.'],
  ['iris', 'oculus', 'Oculus is an Iris port; keep only one.'],
  ['optifabric', 'sodium', 'OptiFabric loads OptiFine, which cannot run with Sodium.']
];

const DRIVER_LINKS = {
  nvidia: { name: 'NVIDIA', url: 'https://www.nvidia.com/Download/index.aspx' },
  amd: { name: 'AMD', url: 'https://www.amd.com/en/support/download/drivers.html' },
  intel: { name: 'Intel', url: 'https://www.intel.com/content/www/us/en/support/detect.html' }
};

const OVERLAY_DLLS = [
  [/RTSSHooks/i, 'RivaTuner / MSI Afterburner'],
  [/DiscordHook/i, 'the Discord overlay'],
  [/GameOverlayRenderer/i, 'the Steam overlay'],
  [/obs-(?:vulkan|opengl)|graphics-hook/i, 'OBS game capture'],
  [/nvspcap|nvcamera/i, 'the NVIDIA GeForce Experience overlay'],
  [/OWClient|overwolf/i, 'Overwolf'],
  [/bdcamvk|bdcap/i, 'Bandicam'],
  [/action_x64|mirillis/i, 'Mirillis Action!'],
  [/ReShade|dxgi\.dll/i, 'ReShade']
];

/* ---------------------------------------------------------------- helpers */

function parseMc(version) {
  const match = String(version || '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
}

/** The Java major Mojang ships for a Minecraft version. */
function javaForMinecraft(version) {
  const v = parseMc(version);
  if (!v) return 21;
  const [a, b, c] = v;
  if (a > 1) return 25;
  if (b >= 21 || (b === 20 && c >= 5)) return 21;
  if (b >= 18) return 17;
  if (b === 17) return 17;
  return 8;
}

function slugForId(id) {
  const clean = String(id || '').trim();
  if (!clean) return null;
  if (ID_TO_SLUG[clean]) return ID_TO_SLUG[clean];
  if (/^fabric-.+-v\d+$/.test(clean) || /^fabric-(?:api-base|api-lookup-api|.+-api)$/.test(clean)) return 'fabric-api';
  if (/^cardinal-components/.test(clean)) return 'cardinal-components-api';
  return clean.replace(/_/g, '-');
}

function isFabricModule(id) {
  return /^fabric(?:-|$)/.test(String(id || '')) && !['fabricloader', 'fabric-loader', 'fabric-language-kotlin'].includes(id);
}

function prettyId(id) {
  const slug = String(id || '');
  if (slug === 'fabric' || slug === 'fabric-api' || isFabricModule(slug)) return 'Fabric API';
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bApi\b/g, 'API');
}

function formatGb(value) {
  return Number.isInteger(value) ? `${value} GB` : `${value.toFixed(1)} GB`;
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

function describeRange(range) {
  const text = String(range || '').trim();
  if (!text || text === '*' || /^any version$/i.test(text)) return '';
  return text.replace(/^version\s+/i, '');
}

/* ----------------------------------------------------------- mod lookups */

function createModLookup(mods = []) {
  const byId = new Map();
  const byFile = new Map();
  const byMixin = new Map();
  const deep = [];
  const rootOwners = new Map();

  for (const mod of mods) {
    byFile.set(String(mod.file).toLowerCase(), mod);
    for (const id of mod.ids || []) if (!byId.has(id)) byId.set(id, mod);
    for (const config of mod.mixins || []) byMixin.set(String(config).toLowerCase(), mod);
    for (const pkg of mod.packages || []) deep.push([pkg, mod]);
    for (const root of mod.roots || []) {
      const owners = rootOwners.get(root) || new Set();
      owners.add(mod);
      rootOwners.set(root, owners);
    }
  }
  deep.sort((a, b) => b[0].length - a[0].length);

  const hasFabricApi = mods.some((mod) => (mod.ids || []).some((id) => id === 'fabric-api' || id === 'fabric'));

  const lookup = {
    mods,
    hasFabricApi,
    byId(id) {
      if (!id) return null;
      const key = String(id);
      return byId.get(key) || byId.get(key.replace(/-/g, '_')) || byId.get(key.replace(/_/g, '-')) || null;
    },
    has(id) {
      if (PLATFORM_IDS.has(id)) return true;
      if (isFabricModule(id) && hasFabricApi) return true;
      return Boolean(lookup.byId(id));
    },
    byFile(name) {
      if (!name) return null;
      const base = String(name).split(/[\\/]/).pop().toLowerCase().replace(/\.disabled$/, '');
      return byFile.get(base) || null;
    },
    byMixinConfig(name) {
      if (!name) return null;
      const key = String(name).toLowerCase().split(/[\\/]/).pop();
      const hit = byMixin.get(key);
      if (hit) return hit;
      // sodium.mixins.json / mixins.sodium.json / sodium-common.mixins.json
      const guess = key.replace(/\.json$/, '').replace(/(?:^mixins?\.|\.mixins?$|[-_.](?:common|client|fabric|forge|neoforge)$)/g, '');
      return lookup.byId(guess) || lookup.byId(guess.split(/[.-]/)[0]) || null;
    },
    forClass(className) {
      const cls = String(className || '').replace(/\//g, '.');
      if (!cls) return null;
      for (const [pkg, mod] of deep) if (cls.startsWith(`${pkg}.`) || cls === pkg) return mod;
      const parts = cls.split('.');
      const root = parts.slice(0, 3).join('.');
      const owners = rootOwners.get(root);
      if (owners && owners.size === 1) return [...owners][0];
      return null;
    },
    nameFor(id) {
      const mod = lookup.byId(id);
      return mod?.name || prettyId(id);
    }
  };
  return lookup;
}

function knownLibForClass(className, loader) {
  const cls = String(className || '').replace(/\//g, '.');
  const isForge = /forge/i.test(loader || '');
  const isFabric = /fabric|quilt/i.test(loader || '');
  let best = null;
  for (const entry of KNOWN_LIBS) {
    const [prefix] = entry;
    if ((cls === prefix || cls.startsWith(`${prefix}.`)) && (!best || prefix.length > best[0].length)) best = entry;
  }
  if (!best) return null;
  const [, slug, name, opts = {}] = best;
  if (opts.wrongLoaderOn) {
    const kind = String(loader || '').toLowerCase();
    return opts.wrongLoaderOn.some((item) => kind.includes(item)) ? { wrongLoader: name } : null;
  }
  if (opts.fabricOnly && !isFabric) return null;
  if (opts.forge && isForge) return { slug: opts.forge[0], name: opts.forge[1] };
  return { slug, name };
}

/* --------------------------------------------------------------- context */

const FRAME_RE = /^\s*at\s+(?:[\w.-]+(?:@[\w.+-]+)?\/)?(?:\/\/)?([\w$.]+)\.([\w$<>-]+)\(([^)]*)\)(.*)$/;
const THROWABLE_RE = /((?:[a-zA-Z_$][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error|Throwable|Failure)(?:\$[\w$]+)?)(?::\s*(.*))?$/;
const LOG_PREFIX_RE = /^(?:\[[^\]]*\]\s*)+(?::\s*)?|^\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+\S+\s+/;

function stripPrefix(line) {
  return String(line).replace(LOG_PREFIX_RE, '').trim();
}

function createContext(input) {
  const sources = [];
  if (input.crashReport) sources.push({ name: 'crash-report', label: input.crashReportFile || 'Crash report', text: String(input.crashReport) });
  if (input.hsErr) sources.push({ name: 'jvm', label: input.hsErrFile || 'JVM error log', text: String(input.hsErr) });
  if (input.log) sources.push({ name: 'log', label: 'Game output', text: String(input.log) });

  const lines = [];
  for (const source of sources) {
    const rows = source.text.replace(/\r\n?/g, '\n').split('\n');
    source.start = lines.length;
    rows.forEach((text, index) => lines.push({ src: source.name, n: index + 1, text }));
    source.end = lines.length;
  }

  const ctx = {
    input,
    sources,
    lines,
    issues: [],
    mods: createModLookup(input.mods || []),
    loader: String(input.instance?.loader || 'Vanilla'),
    mcVersion: String(input.instance?.version || ''),
    /** Every line matching `re`; returns [{ index, match, line }]. */
    findAll(re, { src = null, limit = 200 } = {}) {
      const out = [];
      for (let i = 0; i < lines.length && out.length < limit; i += 1) {
        if (src && lines[i].src !== src) continue;
        const match = lines[i].text.match(re);
        if (match) out.push({ index: i, match, line: lines[i].text });
      }
      return out;
    },
    find(re, options) {
      return ctx.findAll(re, { ...options, limit: 1 })[0] || null;
    },
    text(src) {
      return sources.filter((s) => !src || s.name === src).map((s) => s.text).join('\n');
    },
    add(issue) {
      ctx.issues.push(issue);
      return issue;
    }
  };
  return ctx;
}

/* --------------------------------------------------------- stack traces */

/** Groups throwable headers, their frames and their `Caused by` chain. */
function parseThrowables(ctx) {
  const chains = [];
  let chain = null;
  let block = null;
  const { lines } = ctx;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].text;
    const frame = raw.match(FRAME_RE);
    if (frame && block) {
      block.frames.push({ index: i, cls: frame[1], method: frame[2], location: frame[3], extra: frame[4] || '' });
      continue;
    }
    if (block && /^\s*\.\.\.\s*\d+\s+more/.test(raw)) continue;
    const text = stripPrefix(raw);
    const causedBy = /^\s*Caused by:\s*/.test(raw) || /^Caused by:/.test(text);
    const header = text.replace(/^Caused by:\s*/, '').replace(/^Exception in thread "[^"]*"\s*/, '').match(THROWABLE_RE);
    const nextIsFrame = lines[i + 1] && FRAME_RE.test(lines[i + 1].text);
    if (header && (nextIsFrame || causedBy)) {
      const head = text.replace(/^Caused by:\s*/, '').replace(/^Exception in thread "[^"]*"\s*/, '');
      if (!head.startsWith(header[1]) && !causedBy && !/Exception in thread/.test(text)) {
        // "Failed to start: java.lang.X: msg" - still a header when frames follow.
        if (!nextIsFrame) continue;
      }
      block = { index: i, type: header[1], message: (header[2] || '').trim(), frames: [], src: lines[i].src };
      if (causedBy && chain && chain.src === lines[i].src) chain.blocks.push(block);
      else {
        chain = { src: lines[i].src, blocks: [block], index: i };
        chains.push(chain);
      }
      continue;
    }
    if (block && /^\s*Suppressed:/.test(raw)) continue;
    block = null;
    if (!causedBy) chain = chain && /^\s*$/.test(raw) ? chain : null;
  }
  return chains;
}

/** The chain that actually ended the game. */
function primaryChain(ctx, chains) {
  if (!chains.length) return null;
  const report = chains.find((chain) => chain.src === 'crash-report');
  if (report) return report;
  const log = chains.filter((chain) => chain.src === 'log');
  // The last chain on a fatal-looking line wins; otherwise the last one.
  const fatal = [...log].reverse().find((chain) => {
    const line = ctx.lines[chain.index].text;
    return /FATAL|ERROR|Exception in thread "(?:main|Render thread|Server thread)"|Unreported exception|Minecraft has crashed|Failed to start|Encountered an unexpected exception/i.test(line)
      || /ERROR|FATAL/.test(ctx.lines[Math.max(0, chain.index - 1)].text);
  });
  return fatal || log[log.length - 1] || chains[chains.length - 1];
}

const PLATFORM_FRAME = /^(?:java\.|javax\.|jdk\.|sun\.|com\.sun\.|net\.minecraft\.|com\.mojang\.|org\.lwjgl\.|net\.fabricmc\.loader\.|org\.quiltmc\.loader\.|cpw\.mods\.|net\.minecraftforge\.(?:fml|eventbus|common\.ForgeHooks|client\.loading)|net\.neoforged\.(?:fml|bus|neoforge\.common\.CommonHooks)|org\.spongepowered\.|com\.google\.|io\.netty\.|it\.unimi\.|org\.apache\.|org\.slf4j\.|com\.llamalad7\.mixinextras\.|kotlin\.|scala\.|org\.objectweb\.|jdk\.internal|MC-BOOTSTRAP|oshi\.)/;

/**
 * Scores mods by how directly they appear in the crash: stack frames,
 * mixin handlers, Forge transformer tags, jar names and the crash report's
 * own "Suspected Mods" / "Mixins in Stacktrace" sections.
 */
function blameMods(ctx, chain) {
  const scores = new Map();
  const reasons = new Map();
  const bump = (mod, amount, reason, index) => {
    if (!mod) return;
    const lib = (mod.ids || []).some((id) => LIBRARY_IDS.has(id));
    const value = lib ? amount * 0.45 : amount;
    scores.set(mod.file, (scores.get(mod.file) || 0) + value);
    const list = reasons.get(mod.file) || { reasons: new Set(), lines: [] };
    list.reasons.add(reason);
    if (index !== undefined && list.lines.length < 4) list.lines.push(index);
    reasons.set(mod.file, list);
  };

  if (chain) {
    const blocks = [...chain.blocks];
    const root = blocks[blocks.length - 1];
    blocks.forEach((block) => {
      const isRoot = block === root;
      let rank = 0;
      for (const frame of block.frames.slice(0, 40)) {
        const handler = frame.method.match(/\$(?:[a-z]{3}\d{3}|[a-z]{2}\d{4}|[\da-f]{6})\$([a-z0-9_]+)\$/i)
          || frame.method.match(/^(?:handler|redirect|modify|wrap|localvar|constant|wrapOperation|wrapWithCondition)\$[\w]+\$([a-z0-9_]+)\$/i);
        if (handler) {
          bump(ctx.mods.byId(handler[1]), isRoot ? 6 : 4, 'Mixin in the crashing code', frame.index);
        }
        const jar = frame.extra.match(/~?\[([^\]%:!\s]+?\.jar)/);
        const fromJar = jar ? ctx.mods.byFile(jar[1]) : null;
        const tagged = [...frame.extra.matchAll(/(?:pl:)?mixin:[A-Z]+:([\w.-]+\.json)/g)].map((m) => ctx.mods.byMixinConfig(m[1]));
        tagged.forEach((mod) => bump(mod, isRoot ? 1.5 : 1, 'Patches the crashing code', frame.index));
        if (PLATFORM_FRAME.test(frame.cls) && !fromJar) continue;
        const mod = fromJar || ctx.mods.forClass(frame.cls);
        if (!mod) continue;
        const weight = (rank === 0 ? 7 : Math.max(1, 4 - rank)) * (isRoot ? 1.3 : 1);
        bump(mod, weight, rank === 0 ? 'Its code threw the error' : 'Its code is in the crash', frame.index);
        rank += 1;
      }
    });
  }

  // Crash report sections.
  const report = ctx.sources.find((s) => s.name === 'crash-report');
  if (report) {
    ctx.findAll(/^\s*(?:Suspected Mods?:\s*)?([^,\n]+?)\s*\(([\w.-]+)\),\s*Version:/, { src: 'crash-report' }).forEach(({ match, index }) => {
      bump(ctx.mods.byId(match[2]), 7, 'Named as a suspect by Minecraft', index);
    });
    ctx.findAll(/^\s*([\w.$]+)\s+\(([\w.-]+\.json)\)\s*$/, { src: 'crash-report' }).forEach(({ match, index }) => {
      bump(ctx.mods.byMixinConfig(match[2]) || ctx.mods.forClass(match[1]), 2.5, 'Mixin in the crashing code', index);
    });
    ctx.findAll(/^\s*Mod File:\s*(.+\.jar)\s*$/, { src: 'crash-report' }).forEach(({ match, index }) => {
      bump(ctx.mods.byFile(match[1]), 5, 'Named as a suspect by Minecraft', index);
    });
  }

  return [...scores.entries()]
    .map(([file, score]) => {
      const mod = ctx.mods.byFile(file);
      const why = reasons.get(file);
      return { file, id: mod?.ids?.[0] || null, name: mod?.name || file, score: Math.round(score * 10) / 10, reasons: [...why.reasons], lines: why.lines };
    })
    .sort((a, b) => b.score - a.score);
}

/* ---------------------------------------------------- crash report facts */

function readFacts(ctx) {
  const pick = (re, src) => {
    const hit = ctx.find(re, src ? { src } : undefined);
    return hit ? hit.match[1].trim() : null;
  };
  const facts = {
    description: pick(/^Description:\s*(.+)$/, 'crash-report'),
    java: pick(/^\s*Java Version:\s*(.+)$/) || pick(/^#\s*JRE version:\s*(.+)$/, 'jvm'),
    jvm: pick(/^\s*Java VM Version:\s*(.+)$/),
    os: pick(/^\s*Operating System:\s*(.+)$/),
    cpu: pick(/^\s*CPUs?:\s*(.+)$/) || pick(/^\s*Processor Name:\s*(.+)$/),
    memory: pick(/^\s*Memory:\s*(.+)$/),
    gpu: pick(/^\s*Graphics card #0 name:\s*(.+)$/) || pick(/^\s*GL info:\s*'?([^']+?)(?:' \(|$)/) || pick(/^\s*Backend library:\s*(.+)$/),
    glVersion: pick(/^\s*GL info:\s*'.*?'\s*\(([^)]+)\)/) || pick(/^\s*OpenGL:\s*(.+)$/),
    loader: pick(/^\s*Fabric Mods:\s*$/) ? 'Fabric' : null,
    modded: pick(/^\s*Is Modded:\s*(.+)$/),
    jvmFlags: pick(/^\s*JVM Flags:\s*(.+)$/),
    time: pick(/^Time:\s*(.+)$/, 'crash-report')
  };
  const mem = String(facts.memory || '').match(/\((\d+) MiB\)\s*\/\s*\d+ bytes \((\d+) MiB\)(?:\s*up to\s*\d+ bytes \((\d+) MiB\))?/);
  if (mem) facts.memory = `${mem[1]} MiB used of ${mem[3] || mem[2]} MiB`;
  const javaStr = String(facts.java || '');
  const legacy = javaStr.match(/\b1\.(\d+)\.\d/);
  const modern = javaStr.match(/\b(\d{1,2})(?:\.\d|\b)/);
  facts.javaMajor = input0(ctx.input.javaMajor) || (legacy ? Number(legacy[1]) : modern ? Number(modern[1]) : null);
  facts.gpuVendor = vendorOf([facts.gpu, facts.glVersion].join(' '));
  return facts;
}

function input0(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
}

function vendorOf(text) {
  const t = String(text || '');
  if (/nvidia|geforce|quadro|rtx|gtx/i.test(t)) return 'nvidia';
  if (/\bamd\b|radeon|ati technologies|\bati\b/i.test(t)) return 'amd';
  if (/intel|iris\(r\)|uhd graphics|hd graphics/i.test(t)) return 'intel';
  return null;
}

/* ------------------------------------------------------------ exit codes */

function exitMeaning(code) {
  if (code === null || code === undefined) return null;
  const n = Number(code);
  const unsigned = n < 0 ? n + 2 ** 32 : n;
  const table = {
    0xC0000005: 'Access violation: native code (usually the graphics driver or an overlay) crashed the game.',
    0xC0000409: 'Stack buffer overrun: a native library, usually the graphics driver or an overlay, crashed the game.',
    0xC00000FD: 'Stack overflow in native code.',
    0xC0000374: 'Heap corruption in native code (driver, overlay or unstable RAM).',
    0xCFFFFFFF: 'The game stopped responding and was terminated. Commonly a graphics-driver hang.',
    0xC000013A: 'The game was closed from the console (Ctrl+C) or by Windows shutting down.',
    0xE0434352: 'A .NET component crashed inside the game process (often an overlay).'
  };
  if (table[unsigned]) return table[unsigned];
  if (n === 137) return 'The game was killed (SIGKILL). On Linux this usually means the system ran out of memory.';
  if (n === 134) return 'The game aborted (SIGABRT) in native code.';
  if (n === 139) return 'Segmentation fault (SIGSEGV) in native code, often the graphics driver.';
  if (n === 143) return 'The game was asked to stop (SIGTERM).';
  if (n === -1 || n === 255) return 'Minecraft stopped itself after an unrecoverable error.';
  if (n === 1) return 'Java stopped with a general error.';
  return null;
}

/* ------------------------------------------------------------------ fixes */

const Fix = {
  disable: (mod, why) => mod && ({ kind: 'disable-mod', file: mod.file, name: mod.name, label: `Disable ${mod.name}`, detail: why || mod.file }),
  update: (mod, why) => mod && ({ kind: 'update-mod', file: mod.file, name: mod.name, label: `Update ${mod.name}`, detail: why || 'Newest compatible version from Modrinth' }),
  install: (slug, name, why) => slug && ({ kind: 'install-mod', slug, name, label: `Install ${name}`, detail: why || 'Compatible version from Modrinth' }),
  memory: (gb, why) => ({ kind: 'memory', maxGb: gb, label: `Allocate ${formatGb(gb)} of memory`, detail: why || 'Saved for this instance' }),
  java: (major, why) => ({ kind: 'java', major, label: `Use Java ${major}`, detail: why || 'Downloads it if needed and uses it for this instance' }),
  javaAuto: () => ({ kind: 'java-auto', label: 'Let Noctra choose Java', detail: 'Removes the custom Java path from this instance' }),
  jvmReset: () => ({ kind: 'jvm-reset', label: 'Remove custom JVM arguments', detail: 'Launch with Noctra\'s defaults' }),
  jvmAdd: (args, why) => ({ kind: 'jvm-add', args, label: `Add ${args}`, detail: why }),
  loaderLatest: (loader, why) => ({ kind: 'loader-latest', label: `Update ${loader} Loader`, detail: why || 'Use the newest stable loader for this version' }),
  resetConfig: (file) => ({ kind: 'reset-config', path: file, label: `Reset ${file.split(/[\\/]/).pop()}`, detail: 'A backup is kept; the mod writes a fresh file' }),
  repair: (paths, why) => ({ kind: 'repair', paths, label: 'Repair game files', detail: why || 'Deletes the damaged files so they download again' }),
  openUrl: (url, label, detail) => ({ kind: 'open-url', url, label, detail }),
  openFolder: (sub, label, detail) => ({ kind: 'open-folder', sub, label, detail }),
  disableShaders: () => ({ kind: 'disable-shaders', label: 'Turn off shaders', detail: 'Keeps your shader packs; switches them off' }),
  resetResourcePacks: () => ({ kind: 'reset-resourcepacks', label: 'Turn off resource packs', detail: 'Keeps the packs; unloads them' }),
  forgeEarlyWindow: () => ({ kind: 'forge-early-window', label: 'Turn off the early loading screen', detail: 'Sets earlyWindowControl=false in fml.toml' })
};

function recommendedMemory(input, grow = true) {
  const current = Number(input.memoryMaxGb) || 4;
  const total = Number(input.totalMemGb) || 0;
  const ceiling = total ? Math.max(2, Math.floor(total * 0.6)) : 16;
  if (grow) {
    const target = Math.min(ceiling, Math.max(current + 2, Math.ceil(current * 1.5)));
    return target > current ? target : null;
  }
  const lower = total ? Math.max(1, Math.min(current - 1, Math.floor(total * 0.45))) : Math.max(1, current - 2);
  return lower < current ? lower : null;
}

/* ------------------------------------------------------------------ rules */

function ruleManualCrash(ctx) {
  const hit = ctx.find(/Manually triggered debug crash/);
  if (!hit) return;
  ctx.add({
    id: 'manual', category: 'game', severity: 'info', confidence: 99,
    title: 'You triggered this crash on purpose',
    explanation: 'Holding F3 + C for ten seconds makes Minecraft crash deliberately for debugging. Nothing is wrong.',
    evidence: [hit.index], fixes: [], culprits: []
  });
}

function ruleJavaVersion(ctx) {
  // Classes compiled for a newer Java than the one running.
  const tooOld = ctx.find(/compiled by a more recent version of the Java Runtime \(class file version (\d+)(?:\.\d+)?\)(?:, this version of the Java Runtime only recognizes class file versions up to (\d+))?/)
    || ctx.find(/UnsupportedClassVersionError:.*?(?:class file version|Unsupported major\.minor version) (\d+)/);
  if (tooOld) {
    const need = Number(tooOld.match[1]) - 44;
    const have = tooOld.match[2] ? Number(tooOld.match[2]) - 44 : null;
    const cls = tooOld.line.match(/([\w/$.]+) has been compiled/);
    const culprit = cls ? ctx.mods.forClass(cls[1]) : null;
    const target = Math.max(need, javaForMinecraft(ctx.mcVersion));
    ctx.add({
      id: 'java-too-old', category: 'java', severity: 'critical', confidence: 96,
      title: `Needs Java ${need}${have ? `, but Java ${have} is running` : ''}`,
      explanation: `${culprit ? `${culprit.name} was` : 'Part of the game was'} built for Java ${need}. The Java this instance uses is older and cannot read it.`,
      evidence: [tooOld.index],
      culprits: culprit ? [culprit.file] : [],
      fixes: [Fix.java(target), ctx.input.instance?.overrides?.java?.enabled ? Fix.javaAuto() : null, culprit && need > javaForMinecraft(ctx.mcVersion) ? Fix.disable(culprit, 'It needs a newer Java than this Minecraft version') : null]
    });
  }

  const fabricJava = ctx.find(/Mod '(.+?)' \(([\w.-]+)\) \S+ requires (?:version )?([\d.]+)(?: or later)? of [^\n]*?\(java\)/);
  if (fabricJava) {
    const mod = ctx.mods.byId(fabricJava.match[2]);
    const need = Math.ceil(Number(fabricJava.match[3]));
    ctx.add({
      id: 'java-too-old', category: 'java', severity: 'critical', confidence: 95,
      title: `${fabricJava.match[1]} needs Java ${need}`,
      explanation: `${fabricJava.match[1]} refuses to load on the Java version this instance uses.`,
      evidence: [fabricJava.index], culprits: mod ? [mod.file] : [],
      fixes: [Fix.java(Math.max(need, javaForMinecraft(ctx.mcVersion))), Fix.disable(mod)]
    });
  }

  // Running Java is too new for an old loader / old Forge.
  const tooNew = ctx.find(/Unsupported class file major version (\d+)/)
    || ctx.find(/class jdk\.internal\.loader\.ClassLoaders\$AppClassLoader cannot be cast to class java\.net\.URLClassLoader/)
    || ctx.find(/java\.lang\.NoSuchFieldException: ucp|Unable to make field .* accessible: module java\.base does not "opens/);
  if (tooNew) {
    const want = javaForMinecraft(ctx.mcVersion);
    const running = tooNew.match[1] ? Number(tooNew.match[1]) - 44 : null;
    ctx.add({
      id: 'java-too-new', category: 'java', severity: 'critical', confidence: 88,
      title: `Java${running ? ` ${running}` : ''} is too new for Minecraft ${ctx.mcVersion || 'this version'}`,
      explanation: `This loader was written for Java ${want} and breaks on newer Java releases.`,
      evidence: [tooNew.index], culprits: [],
      fixes: [Fix.java(want, `The Java Minecraft ${ctx.mcVersion} was made for`), ctx.input.instance?.overrides?.java?.enabled ? Fix.javaAuto() : null]
    });
  }

  const bits32 = ctx.find(/Java HotSpot\(TM\) Client VM|sun\.arch\.data\.model\s*=\s*32|\b32-bit\b.*\bJava\b/i);
  if (bits32 && ctx.find(/Could not reserve enough space|Invalid maximum heap size|OutOfMemoryError/)) {
    ctx.add({
      id: 'java-32bit', category: 'java', severity: 'critical', confidence: 82,
      title: '32-bit Java cannot use this much memory',
      explanation: '32-bit Java is limited to about 1.5 GB of memory. Use a 64-bit Java instead.',
      evidence: [bits32.index], culprits: [],
      fixes: [Fix.java(javaForMinecraft(ctx.mcVersion), 'Installs 64-bit Java for this instance')]
    });
  }
}

function ruleMemory(ctx) {
  const input = ctx.input;
  const heap = ctx.find(/OutOfMemoryError: (Java heap space|GC overhead limit exceeded|Metaspace|Requested array size exceeds VM limit)/)
    || ctx.find(/^Description:\s*Out of memory/i)
    || ctx.find(/Minecraft (?:has )?ran? out of memory/i);
  if (heap) {
    const next = recommendedMemory(input, true);
    const current = Number(input.memoryMaxGb) || null;
    ctx.add({
      id: 'out-of-memory', category: 'memory', severity: 'critical', confidence: 94,
      title: 'Minecraft ran out of memory',
      explanation: `${current ? `This instance is allowed ${formatGb(current)}. ` : ''}${next ? 'Your mods and settings need more than that.' : 'It already has as much as your PC can spare; lower your render distance or remove heavy mods.'}`,
      evidence: [heap.index], culprits: [],
      fixes: [next ? Fix.memory(next, `Up from ${formatGb(current || 4)}, within your ${input.totalMemGb ? formatGb(Math.round(input.totalMemGb)) : ''} of RAM`.trim()) : null]
    });
  }

  const reserve = ctx.find(/Could not reserve enough space for (?:\d+\w*\s+)?object heap|Invalid (?:maximum|initial) heap size|There is insufficient memory for the Java Runtime Environment to continue|Native memory allocation \((?:mmap|malloc)\) failed|The paging file is too small|OutOfMemoryError: (?:Direct buffer memory|unable to create (?:new )?native thread)|Cannot allocate memory/i);
  if (reserve) {
    const lower = recommendedMemory(input, false);
    ctx.add({
      id: 'memory-too-high', category: 'memory', severity: 'critical', confidence: 90,
      title: 'Not enough free RAM for the memory this instance asks for',
      explanation: 'Java could not reserve the memory set for this instance. Your PC does not have that much free, or other programs are using it.',
      evidence: [reserve.index], culprits: [],
      fixes: [lower ? Fix.memory(lower, 'Lower, so Java can start') : null]
    });
  }
}

function ruleJvmArgs(ctx) {
  const hit = ctx.find(/Unrecognized VM option '([^']+)'|Unrecognized option: (\S+)|Improperly specified VM option '([^']+)'|Error: Could not create the Java Virtual Machine|Error occurred during initialization of VM|Missing \+\/- setting for VM option '([^']+)'/);
  if (!hit) return;
  const option = hit.match[1] || hit.match[2] || hit.match[3] || hit.match[4] || null;
  const custom = Boolean(ctx.input.instance?.overrides?.jvmArgs);
  if (!option && ctx.issues.some((issue) => issue.category === 'memory' || issue.category === 'java')) return;
  ctx.add({
    id: 'jvm-args', category: 'java', severity: 'critical', confidence: option ? 93 : 70,
    title: option ? `Java does not understand "${option}"` : 'Java refused to start',
    explanation: option
      ? `The JVM argument ${option} is not supported by this Java version${custom ? ' and comes from this instance\'s custom arguments' : ''}.`
      : 'The Java Virtual Machine could not be created, usually because of an invalid argument or memory setting.',
    evidence: [hit.index], culprits: [],
    fixes: [custom ? Fix.jvmReset() : null, !custom ? Fix.javaAuto() : null]
  });
}

function ruleFabricResolution(ctx) {
  const missing = new Map();
  const add = (id, requester, range, index) => {
    const key = id;
    const entry = missing.get(key) || { id, requesters: new Set(), ranges: new Set(), lines: [] };
    if (requester) entry.requesters.add(requester);
    if (range) entry.ranges.add(range);
    entry.lines.push(index);
    missing.set(key, entry);
  };

  // Fabric 0.14+: "Mod 'A' (a) 1.0 requires version 2.0 or later of mod 'B' (b), which is missing!"
  ctx.findAll(/Mod '(.+?)' \(([\w.-]+)\) \S+ requires (.+?) of (?:mod )?(?:'.+?' \()?([\w.-]+)\)?, which is missing!?/).forEach(({ match, index }) => {
    if (PLATFORM_IDS.has(match[4])) return;
    add(match[4], match[2], describeRange(match[3]), index);
  });
  ctx.findAll(/^\s*-?\s*Install ([\w.-]+), (?:any version|version (.+?))\.?\s*$/).forEach(({ match, index }) => {
    if (!PLATFORM_IDS.has(match[1])) add(match[1], null, describeRange(match[2]), index);
  });
  // Fabric 0.12
  ctx.findAll(/Could not find required mod: ([\w.-]+) requires \{([\w.-]+) @ \[([^\]]*)\]\}/).forEach(({ match, index }) => {
    if (!PLATFORM_IDS.has(match[2])) add(match[2], match[1], describeRange(match[3]), index);
  });
  // Forge / NeoForge
  ctx.findAll(/Mod ID: '([\w.-]+)', Requested by: '([\w.-]+)', Expected range: '([^']*)', Actual version: '([^']*)'/).forEach(({ match, index }) => {
    if (PLATFORM_IDS.has(match[1])) return;
    if (/MISSING/i.test(match[4])) add(match[1], match[2], describeRange(match[3]), index);
  });
  ctx.findAll(/Mod ([\w.-]+) requires ([\w.-]+) (\S+(?: or above)?)/).forEach(({ match, index }) => {
    const next = ctx.lines[index + 1]?.text || '';
    if (PLATFORM_IDS.has(match[2])) return;
    if (/not installed/i.test(next) || /is not installed/.test(ctx.lines[index].text)) add(match[2], match[1], describeRange(match[3]), index);
  });

  if (missing.size) {
    const entries = [...missing.values()].filter((entry) => !ctx.mods.byId(entry.id) || isFabricModule(entry.id) && !ctx.mods.hasFabricApi);
    const seen = new Set();
    const fixes = [];
    const names = [];
    for (const entry of entries) {
      const slug = slugForId(entry.id);
      if (seen.has(slug)) continue;
      seen.add(slug);
      const name = prettyId(slug === 'fabric-api' ? 'fabric-api' : entry.id);
      names.push(name);
      const requesters = [...entry.requesters].map((id) => ctx.mods.nameFor(id));
      const range = [...entry.ranges][0];
      fixes.push(Fix.install(slug, name, [requesters.length ? `Needed by ${requesters.slice(0, 3).join(', ')}` : '', range ? `(${range})` : ''].filter(Boolean).join(' ')));
    }
    if (names.length) {
      const requesterMods = unique(entries.flatMap((entry) => [...entry.requesters])).map((id) => ctx.mods.byId(id)).filter(Boolean);
      ctx.add({
        id: 'missing-dependency', category: 'mods', severity: 'critical', confidence: 97,
        title: names.length === 1 ? `${names[0]} is missing` : `${names.length} required mods are missing`,
        explanation: names.length === 1
          ? `${requesterMods.length ? requesterMods.map((m) => m.name).slice(0, 3).join(', ') : 'A mod you installed'} cannot load without ${names[0]}.`
          : `Some of your mods depend on ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}, which are not installed.`,
        evidence: entries.flatMap((entry) => entry.lines).slice(0, MAX_EVIDENCE),
        culprits: [],
        fixes: [...fixes, ...(names.length === 1 ? requesterMods.slice(0, 2).map((m) => Fix.disable(m, `Or remove the mod that needs ${names[0]}`)) : [])]
      });
    }
  }

  // Wrong Minecraft version for a mod.
  const wrongMc = ctx.findAll(/Mod '(.+?)' \(([\w.-]+)\) (\S+) requires (.+?) of (?:mod )?(?:'.+?' \()?minecraft\)?, but only the wrong version is present: ([\w.+-]+)/);
  const forgeMc = ctx.findAll(/Mod ID: 'minecraft', Requested by: '([\w.-]+)', Expected range: '([^']*)', Actual version: '([^']*)'/);
  const mcHits = [
    ...wrongMc.map(({ match, index }) => ({ id: match[2], name: match[1], need: describeRange(match[4]), index })),
    ...forgeMc.map(({ match, index }) => ({ id: match[1], name: ctx.mods.nameFor(match[1]), need: match[2], index }))
  ];
  if (mcHits.length) {
    const mods = mcHits.map((hit) => ctx.mods.byId(hit.id)).filter(Boolean);
    ctx.add({
      id: 'wrong-minecraft-version', category: 'mods', severity: 'critical', confidence: 97,
      title: mcHits.length === 1 ? `${mcHits[0].name} is made for a different Minecraft version` : `${mcHits.length} mods are made for a different Minecraft version`,
      explanation: mcHits.length === 1
        ? `${mcHits[0].name} needs Minecraft ${mcHits[0].need || 'another version'}; this instance runs ${ctx.mcVersion}.`
        : `These mods do not support Minecraft ${ctx.mcVersion}: ${mcHits.map((h) => h.name).join(', ')}.`,
      evidence: mcHits.map((hit) => hit.index).slice(0, MAX_EVIDENCE),
      culprits: mods.map((m) => m.file),
      fixes: mods.flatMap((m) => [Fix.update(m, `Get the ${ctx.mcVersion} build`), Fix.disable(m)])
    });
  }

  // A dependency is installed, but in the wrong version.
  const wrongDep = ctx.findAll(/Mod '(.+?)' \(([\w.-]+)\) \S+ requires (.+?) of (?:mod )?(?:'(.+?)' \()?([\w.-]+)\)?, but only the wrong version is present: ([\w.+-]+)/)
    .filter(({ match }) => match[5] !== 'minecraft' && match[5] !== 'java');
  const forgeWrong = ctx.findAll(/Mod ID: '([\w.-]+)', Requested by: '([\w.-]+)', Expected range: '([^']*)', Actual version: '([^']*)'/)
    .filter(({ match }) => match[1] !== 'minecraft' && !/MISSING/i.test(match[4]));
  const depHits = [
    ...wrongDep.map(({ match, index }) => ({ requester: match[2], requesterName: match[1], dep: match[5], need: describeRange(match[3]), have: match[6], index })),
    ...forgeWrong.map(({ match, index }) => ({ requester: match[2], requesterName: ctx.mods.nameFor(match[2]), dep: match[1], need: match[3], have: match[4], index }))
  ];
  for (const hit of depHits.slice(0, 4)) {
    const depMod = ctx.mods.byId(hit.dep);
    const requester = ctx.mods.byId(hit.requester);
    const depName = LOADER_IDS.has(hit.dep) ? `${ctx.loader} Loader` : ctx.mods.nameFor(hit.dep);
    const loaderDep = LOADER_IDS.has(hit.dep);
    ctx.add({
      id: loaderDep ? 'loader-outdated' : 'dependency-version', category: 'mods', severity: 'critical', confidence: 96,
      title: `${hit.requesterName} needs ${depName} ${hit.need}`,
      explanation: `You have ${depName} ${hit.have}, but ${hit.requesterName} needs ${hit.need}.`,
      evidence: [hit.index], culprits: unique([requester?.file, depMod?.file]),
      fixes: loaderDep
        ? [Fix.loaderLatest(ctx.loader, `${hit.requesterName} needs ${hit.need}`), Fix.disable(requester)]
        : [Fix.update(depMod, `${hit.requesterName} needs ${hit.need}`), Fix.update(requester), Fix.disable(requester)]
    });
  }

  // Explicit incompatibility / "breaks".
  const breaks = ctx.findAll(/Mod '(.+?)' \(([\w.-]+)\) \S+ is incompatible with (.+?) of (?:mod )?(?:'(.+?)' \()?([\w.-]+)\)?/);
  for (const { match, index } of breaks.slice(0, 3)) {
    const a = ctx.mods.byId(match[2]);
    const b = ctx.mods.byId(match[5]);
    const bName = match[4] || ctx.mods.nameFor(match[5]);
    ctx.add({
      id: 'incompatible-mods', category: 'mods', severity: 'critical', confidence: 96,
      title: `${match[1]} does not work with ${bName}`,
      explanation: `${match[1]} declares that it breaks with ${bName}${describeRange(match[3]) ? ` ${describeRange(match[3])}` : ''}. Keep one of them.`,
      evidence: [index], culprits: unique([a?.file, b?.file]),
      fixes: [Fix.disable(b), Fix.disable(a), Fix.update(b)]
    });
  }

  // Duplicates reported by the loader.
  const dupes = ctx.findAll(/Duplicate mods? (?:found|detected)|Found duplicate mods?|Mod ID '?([\w.-]+)'? is (?:already )?(?:provided|present) by multiple|DuplicateModsFoundException|multiple copies of|Found \d+ copies of/i);
  if (dupes.length) {
    const staticDupes = findDuplicates(ctx);
    ctx.add({
      id: 'duplicate-mods', category: 'mods', severity: 'critical', confidence: 95,
      title: staticDupes.length ? `${staticDupes[0].keep.name} is installed more than once` : 'A mod is installed more than once',
      explanation: 'Two files provide the same mod. The loader stops rather than guess which one to use.',
      evidence: dupes.map((d) => d.index).slice(0, MAX_EVIDENCE),
      culprits: staticDupes.flatMap((d) => d.remove.map((m) => m.file)),
      fixes: staticDupes.flatMap((d) => d.remove.map((m) => Fix.disable(m, `Older copy; keeps ${d.keep.file}`)))
    });
  }
}

function compareVersions(a, b) {
  const pa = String(a || '').split(/[^\d]+/).filter(Boolean).map(Number);
  const pb = String(b || '').split(/[^\d]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function findDuplicates(ctx) {
  const byId = new Map();
  for (const mod of ctx.mods.mods) {
    const id = mod.ids?.[0];
    if (!id || mod.loader === 'unknown') continue;
    const list = byId.get(id) || [];
    list.push(mod);
    byId.set(id, list);
  }
  return [...byId.entries()].filter(([, list]) => list.length > 1).map(([id, list]) => {
    const sorted = [...list].sort((a, b) => compareVersions(b.version, a.version) || b.mtime - a.mtime);
    return { id, keep: sorted[0], remove: sorted.slice(1) };
  });
}

function ruleMixin(ctx) {
  const patterns = [
    /Mixin apply for mod ([\w-]+) failed ([\w.-]+\.json):([\w.$]+)(?: from mod [\w-]+)? -> ([\w.$/]+)/,
    /Mixin apply failed ([\w.-]+\.json):([\w.$]+) -> ([\w.$/]+)/,
    /Critical injection failure:.*? in ([\w.-]+\.json):([\w.$]+)(?: from mod ([\w-]+))?/,
    /(?:InvalidInjectionException|InjectionError|MixinApplyError|InvalidMixinException|MixinTargetAlreadyLoadedException|InvalidAccessorException)\b.*?([\w.-]+\.json):([\w.$]+)(?: from mod ([\w-]+))?/,
    /Mixin prepare for mod ([\w-]+) failed ([\w.-]+\.json)/,
    /Mixin transformation of ([\w.$]+) failed/,
    /MixinTransformerError: An unexpected critical error was encountered/
  ];
  const hits = [];
  for (const re of patterns) {
    for (const { match, index, line } of ctx.findAll(re, { limit: 8 })) {
      let mod = null;
      const fromMod = line.match(/from mod ([\w-]+)/);
      if (fromMod) mod = ctx.mods.byId(fromMod[1]);
      if (!mod && /apply for mod|prepare for mod/.test(line)) mod = ctx.mods.byId(match[1]);
      const config = line.match(/([\w.-]+\.json)/);
      if (!mod && config) mod = ctx.mods.byMixinConfig(config[1]);
      const mixinClass = line.match(/\.json:([\w.$]+)/);
      if (!mod && mixinClass) mod = ctx.mods.forClass(mixinClass[1]);
      const target = line.match(/-> ([\w.$/]+)/) || line.match(/transformation of ([\w.$]+)/);
      const targetMod = target ? ctx.mods.forClass(target[1].replace(/\//g, '.')) : null;
      hits.push({ index, mod, targetMod, target: target?.[1] || null });
    }
  }
  if (!hits.length) return;
  // Mixin errors often hide their owner in the lines right after the header.
  for (const hit of hits) {
    if (hit.mod) continue;
    for (let i = hit.index + 1; i < Math.min(ctx.lines.length, hit.index + 12) && !hit.mod; i += 1) {
      const line = ctx.lines[i].text;
      const cfg = line.match(/([\w.-]+\.mixins?\.json)/) || line.match(/from mod ([\w-]+)/);
      if (cfg) hit.mod = /\.json$/.test(cfg[1]) ? ctx.mods.byMixinConfig(cfg[1]) : ctx.mods.byId(cfg[1]);
    }
  }
  const owners = unique(hits.map((h) => h.mod?.file)).map((file) => ctx.mods.byFile(file));
  const targets = unique(hits.map((h) => h.targetMod?.file)).map((file) => ctx.mods.byFile(file)).filter((m) => !owners.includes(m));
  const main = owners[0];
  if (!main && ctx.issues.some((issue) => issue.confidence >= 90)) return;
  ctx.add({
    id: 'mixin-failure', category: 'mods', severity: 'critical', confidence: main ? 90 : 62,
    title: main ? `${main.name} failed to patch the game` : 'A mod failed to patch the game',
    explanation: main
      ? `${main.name} could not apply its changes${targets.length ? ` to ${targets[0].name}` : ' to Minecraft'}. It is usually built for a different ${targets.length ? `version of ${targets[0].name}` : 'Minecraft version'} or clashes with another mod.`
      : 'A Mixin (a mod patching game code) failed. The mod responsible is usually outdated or conflicts with another mod.',
    evidence: hits.map((h) => h.index).slice(0, MAX_EVIDENCE),
    culprits: [...owners, ...targets].map((m) => m.file),
    fixes: [Fix.update(main), Fix.disable(main), ...targets.slice(0, 1).flatMap((m) => [Fix.update(m), Fix.disable(m, `${main ? main.name : 'The failing mod'} patches this mod`)])]
  });
}

function ruleModInit(ctx) {
  const hits = [
    ...ctx.findAll(/Could not execute entrypoint stage '(\w+)' due to errors, provided by '([\w-]+)'(?: at '([\w.$]+)')?/).map(({ match, index }) => ({ id: match[2], stage: match[1], index })),
    ...ctx.findAll(/Failed to create mod instance\. ModID: ([\w-]+)/).map(({ match, index }) => ({ id: match[1], index })),
    ...ctx.findAll(/(?:^|\s)([\w-]+) \(([\w-]+)\) has failed to load correctly/).map(({ match, index }) => ({ id: match[2], index })),
    ...ctx.findAll(/ModLoadingException: .*?\(([\w-]+)\) encountered an error during the (\w+) event phase/).map(({ match, index }) => ({ id: match[1], stage: match[2], index })),
    ...ctx.findAll(/Exception caught during firing event.*?\bmodid:? ?([\w-]+)/i).map(({ match, index }) => ({ id: match[1], index }))
  ].filter((hit) => !PLATFORM_IDS.has(hit.id));
  if (!hits.length) return;
  const mods = unique(hits.map((h) => ctx.mods.byId(h.id)?.file)).map((file) => ctx.mods.byFile(file));
  const name = mods[0]?.name || ctx.mods.nameFor(hits[0].id);
  ctx.add({
    id: 'mod-init', category: 'mods', severity: 'critical', confidence: 88,
    title: `${name} crashed while loading`,
    explanation: `${name} threw an error during start-up${hits[0].stage ? ` (${hits[0].stage} stage)` : ''}. It is usually outdated, missing a dependency, or broken by another mod.`,
    evidence: hits.map((h) => h.index).slice(0, MAX_EVIDENCE),
    culprits: mods.map((m) => m.file),
    fixes: mods.slice(0, 2).flatMap((m) => [Fix.update(m), Fix.disable(m)])
  });
}

function ruleMissingClass(ctx, chain) {
  const hits = ctx.findAll(/(?:NoClassDefFoundError|ClassNotFoundException)(?::| for)?\s*'?([\w/$.]+)/, { limit: 40 });
  if (!hits.length) return;
  const seen = new Set();
  for (const { match, index } of hits) {
    const cls = match[1].replace(/\//g, '.');
    if (seen.has(cls) || cls.length < 4) continue;
    seen.add(cls);
    // Who asked for it: first mod frame after the header.
    let requester = null;
    for (let i = index + 1; i < Math.min(ctx.lines.length, index + 60); i += 1) {
      const frame = ctx.lines[i].text.match(FRAME_RE);
      if (!frame) {
        if (/Caused by|^\S/.test(ctx.lines[i].text) && i > index + 1) break;
        continue;
      }
      const jar = frame[4]?.match(/~?\[([^\]%:!\s]+?\.jar)/);
      const mod = (jar && ctx.mods.byFile(jar[1])) || (!PLATFORM_FRAME.test(frame[1]) && ctx.mods.forClass(frame[1]));
      if (mod) {
        requester = mod;
        break;
      }
    }
    const lib = knownLibForClass(cls, ctx.loader);
    const owner = ctx.mods.forClass(cls);
    if (lib?.wrongLoader) {
      ctx.add({
        id: 'wrong-loader', category: 'mods', severity: 'critical', confidence: 90,
        title: `${requester ? requester.name : 'A mod'} is a ${lib.wrongLoader} mod`,
        explanation: `This instance runs ${ctx.loader}, but ${requester ? requester.name : 'one of your mods'} was made for ${lib.wrongLoader}. Mods only work on the loader they were built for.`,
        evidence: [index], culprits: requester ? [requester.file] : [],
        fixes: [Fix.disable(requester, `Made for ${lib.wrongLoader}`)]
      });
      continue;
    }
    if (lib && !ctx.mods.byId(lib.slug) && !(lib.slug === 'fabric-api' && ctx.mods.hasFabricApi)) {
      ctx.add({
        id: 'missing-dependency', category: 'mods', severity: 'critical', confidence: 88,
        title: `${lib.name} is missing`,
        explanation: `${requester ? requester.name : 'A mod'} uses ${lib.name}, which is not installed.`,
        evidence: [index], culprits: requester ? [requester.file] : [],
        fixes: [Fix.install(lib.slug, lib.name, requester ? `Needed by ${requester.name}` : null), Fix.disable(requester)]
      });
      continue;
    }
    if (/^(?:net\.minecraft|com\.mojang|net\.fabricmc\.fabric|net\.minecraftforge|net\.neoforged)\./.test(cls) || (owner && owner !== requester)) {
      const target = owner ? owner.name : /^net\.fabricmc\.fabric/.test(cls) ? 'Fabric API' : 'Minecraft';
      ctx.add({
        id: 'version-mismatch', category: 'mods', severity: 'critical', confidence: requester ? 78 : 55,
        title: requester ? `${requester.name} does not match your ${target} version` : `A mod does not match your ${target} version`,
        explanation: `${requester ? requester.name : 'A mod'} looked for ${cls.split('.').pop()} in ${target}, but that class does not exist in the installed version.`,
        evidence: [index], culprits: unique([requester?.file, owner?.file]),
        fixes: [Fix.update(requester), owner ? Fix.update(owner) : null, Fix.disable(requester)]
      });
    }
  }
}

function ruleMethodMismatch(ctx) {
  const hits = ctx.findAll(/java\.lang\.(NoSuchMethodError|NoSuchFieldError|AbstractMethodError|IncompatibleClassChangeError|IllegalAccessError|VerifyError)(?::\s*(.*))?/, { limit: 6 });
  if (!hits.length) return;
  const { match, index } = hits[0];
  const message = match[2] || '';
  const ownerClass = (message.match(/([a-z][\w]*(?:[./][\w$]+){2,})\.[\w$<>]+\(/) || message.match(/'[\w.$\[\] ]*?\s([a-z][\w]*(?:[./][\w$]+){2,})\.[\w$]+/) || message.match(/([a-z][\w]*(?:[./][\w$]+){2,})/))?.[1];
  const owner = ownerClass ? ctx.mods.forClass(ownerClass.replace(/\//g, '.')) : null;
  let caller = null;
  for (let i = index + 1; i < Math.min(ctx.lines.length, index + 40) && !caller; i += 1) {
    const frame = ctx.lines[i].text.match(FRAME_RE);
    if (!frame) continue;
    const jar = frame[4]?.match(/~?\[([^\]%:!\s]+?\.jar)/);
    caller = (jar && ctx.mods.byFile(jar[1])) || (!PLATFORM_FRAME.test(frame[1]) ? ctx.mods.forClass(frame[1]) : null);
  }
  if (!caller && !owner) return;
  const target = owner?.name || (/net[./]minecraft|com[./]mojang/.test(ownerClass || '') ? 'Minecraft' : 'another mod');
  ctx.add({
    id: 'version-mismatch', category: 'mods', severity: 'critical', confidence: caller ? 80 : 60,
    title: caller ? `${caller.name} is built for a different version of ${target}` : `${target} changed in a way a mod does not expect`,
    explanation: `${caller ? caller.name : 'A mod'} called code that ${target} no longer has (${match[1]}). Updating it${owner && owner !== caller ? ` or ${owner.name}` : ''} normally fixes this.`,
    evidence: [index], culprits: unique([caller?.file, owner?.file]),
    fixes: [Fix.update(caller), owner && owner !== caller ? Fix.update(owner) : null, Fix.disable(caller)]
  });
}

function ruleGraphics(ctx, facts) {
  const gl = ctx.find(/GLFW error (?:65542|65543|65545|65544)|WGL: The driver does not appear to support OpenGL|Pixel format not accelerated|No OpenGL context found in the current thread|Failed to create (?:the )?(?:OpenGL )?(?:context|window)|Couldn't set pixel format|OpenGL \d\.\d(?: or higher)? (?:is )?required|GLX: Failed to create context|libGL error: failed to load driver|Unable to find a valid OpenGL|EGL_NOT_INITIALIZED|Could not create context/i);
  const sodiumDriver = ctx.find(/sodium.*(?:graphics driver|driver version).*(?:not supported|incompatible|outdated|known to crash)|Threaded Optimization|The currently installed graphics driver is not supported/i);
  const hit = gl || sodiumDriver;
  if (!hit) return;
  const vendor = facts.gpuVendor || vendorOf(ctx.text('jvm')) || null;
  const link = vendor ? DRIVER_LINKS[vendor] : null;
  const threaded = /Threaded Optimization/i.test(hit.line);
  ctx.add({
    id: 'graphics-driver', category: 'graphics', severity: 'critical', confidence: gl ? 90 : 80,
    title: threaded ? 'NVIDIA "Threaded Optimization" breaks this setup' : 'Your graphics driver could not start Minecraft',
    explanation: threaded
      ? 'Sodium does not work with NVIDIA\'s Threaded Optimization. Turn it off in NVIDIA Control Panel > Manage 3D settings, or update the driver.'
      : `Minecraft could not create an OpenGL window.${facts.gpu ? ` GPU: ${facts.gpu}.` : ''} Installing the newest driver from your GPU maker (not Windows Update) fixes this almost every time. On laptops, make sure the game uses the dedicated GPU.`,
    evidence: [hit.index], culprits: [],
    fixes: link
      ? [Fix.openUrl(link.url, `Get the latest ${link.name} driver`, 'Opens the official download page')]
      : [Fix.openUrl(DRIVER_LINKS.nvidia.url, 'NVIDIA drivers', 'Official download page'), Fix.openUrl(DRIVER_LINKS.amd.url, 'AMD drivers', 'Official download page'), Fix.openUrl(DRIVER_LINKS.intel.url, 'Intel drivers', 'Official download page')]
  });
}

function ruleNativeCrash(ctx, facts) {
  const jvm = ctx.text('jvm') || ctx.text();
  if (!/A fatal error has been detected by the Java Runtime Environment/.test(jvm)) return;
  const kind = (jvm.match(/#\s+(EXCEPTION_\w+|SIG\w+)/) || [])[1] || 'native crash';
  const frameLine = ctx.find(/^#\s+([CjJvV])\s+\[([^\]+]+?)(?:\+0x[\da-f]+)?\]\s*(.*)$/i);
  const lib = frameLine ? frameLine.match[2].trim() : '';
  const loaded = jvm.slice(0, 200000);
  const overlay = OVERLAY_DLLS.find(([re]) => re.test(lib)) || OVERLAY_DLLS.find(([re]) => re.test(loaded) && /Dynamic libraries:[\s\S]*/.test(loaded) && new RegExp(re.source, 'i').test(loaded.split('Dynamic libraries:')[1] || ''));
  const driverVendor = /atio6axx|atioglxx|amdxc|aticfx|amdvlk|amdgpu/i.test(lib) ? 'amd'
    : /nvoglv|nvd3dum|nvwgf2um|libnvidia|nvcuda|libGLX_nvidia/i.test(lib) ? 'nvidia'
      : /ig\d+icd|igxelpicd|iglhxo|igdumd|igc(?:64|32)|i965_dri|iris_dri|intel/i.test(lib) ? 'intel' : null;
  const evidence = [frameLine?.index ?? ctx.find(/A fatal error has been detected/)?.index].filter((v) => v !== undefined);

  if (driverVendor) {
    const link = DRIVER_LINKS[driverVendor];
    ctx.add({
      id: 'graphics-driver-crash', category: 'graphics', severity: 'critical', confidence: 92,
      title: `The ${link.name} graphics driver crashed`,
      explanation: `The crash happened inside ${lib}, part of your ${link.name} driver. Update it from ${link.name}'s site. If it keeps happening, turn off shaders.`,
      evidence, culprits: [],
      fixes: [Fix.openUrl(link.url, `Get the latest ${link.name} driver`, 'Opens the official download page'), ctx.mods.byId('iris') || ctx.mods.byId('oculus') || ctx.mods.byId('optifine') ? Fix.disableShaders() : null]
    });
    return;
  }
  if (overlay) {
    ctx.add({
      id: 'overlay-crash', category: 'system', severity: 'critical', confidence: frameLine && overlay[0].test(lib) ? 90 : 62,
      title: `${overlay[1][0].toUpperCase()}${overlay[1].slice(1)} crashed the game`,
      explanation: `${overlay[1]} hooks into games to draw on top of them, and its hook crashed Minecraft. Turn it off for Minecraft or close it, then launch again.`,
      evidence, culprits: [], fixes: []
    });
    return;
  }
  const lwjgl = /lwjgl|openal|glfw/i.test(lib);
  const jvmLib = /jvm\.dll|libjvm/i.test(lib);
  ctx.add({
    id: 'native-crash', category: 'system', severity: 'critical', confidence: 58,
    title: `Java crashed in native code${lib ? ` (${lib})` : ''}`,
    explanation: lwjgl
      ? 'The crash happened in LWJGL, the game\'s graphics and sound layer. Updating your graphics driver and repairing game files usually fixes it.'
      : jvmLib
        ? 'Java itself crashed. This is usually caused by unstable RAM or overclocks, or a broken Java install. Try a fresh Java.'
        : `The JVM reported ${kind}. This is almost always the graphics driver, an overlay, or antivirus software injecting into Java.`,
    evidence, culprits: [],
    fixes: [
      jvmLib ? Fix.java(javaForMinecraft(ctx.mcVersion), 'Reinstalls a clean Java for this instance') : null,
      lwjgl ? Fix.repair(['natives'], 'Downloads fresh native libraries') : null,
      facts.gpuVendor ? Fix.openUrl(DRIVER_LINKS[facts.gpuVendor].url, `Get the latest ${DRIVER_LINKS[facts.gpuVendor].name} driver`, 'Opens the official download page') : null
    ]
  });
}

function ruleConfig(ctx) {
  const CONFIG_PATH = /((?:config|defaultconfigs)[\\/][^\s'"():]+\.(?:json5?|toml|cfg|properties|ya?ml|txt|conf|snbt))/;
  const hits = ctx.findAll(/(?:Failed (?:loading|to (?:load|read|parse)) config(?:uration)?(?: file)?|Error (?:loading|reading|parsing) config|Exception (?:loading|reading) config|Could not (?:load|read|parse) config|ParsingException|Configuration file .* is (?:corrupt|invalid)|JsonSyntaxException|MalformedJsonException|Not a JSON Object|Unterminated (?:object|array|string)|Expected .* but was)/i, { limit: 20 });
  const found = new Map();
  for (const { index } of hits) {
    for (let i = Math.max(0, index - 3); i < Math.min(ctx.lines.length, index + 4); i += 1) {
      const m = ctx.lines[i].text.match(CONFIG_PATH);
      if (m) {
        const rel = m[1].replace(/\\/g, '/');
        if (!found.has(rel)) found.set(rel, index);
        break;
      }
    }
  }
  if (!found.size) return;
  const files = [...found.keys()].slice(0, 3);
  const owner = ctx.mods.byId(files[0].split('/')[1].replace(/(?:[-_](?:client|common|server))?\.\w+$/, ''));
  ctx.add({
    id: 'corrupt-config', category: 'config', severity: 'critical', confidence: 86,
    title: `A config file is damaged: ${files[0].split('/').pop()}`,
    explanation: `${owner ? owner.name : 'A mod'} could not read ${files.join(', ')}. This happens after a crash while saving or a bad manual edit. Resetting the file lets the mod write a fresh one.`,
    evidence: [...found.values()].slice(0, MAX_EVIDENCE), culprits: owner ? [owner.file] : [],
    fixes: files.map((file) => Fix.resetConfig(file))
  });
}

function ruleCorruptFiles(ctx) {
  const hits = ctx.findAll(/ZipException|zip END header not found|invalid LOC header|invalid CEN header|error in opening zip file|Zip file is empty|Invalid or corrupt jarfile|ZipFile invalid|java\.io\.EOFException.*(?:jar|zip)|Failed to read (?:mod )?jar|Error reading (?:mod )?jar|not a valid mod file|Unexpected end of ZLIB input stream/i, { limit: 20 });
  if (!hits.length) return;
  const JAR = /((?:[A-Za-z]:)?[\\/][^\s:'"*?<>|]+?\.jar)|([\w.+-]+\.jar)/;
  const paths = new Set();
  const modFiles = new Set();
  for (const { index } of hits) {
    for (let i = Math.max(0, index - 2); i < Math.min(ctx.lines.length, index + 4); i += 1) {
      const m = ctx.lines[i].text.match(JAR);
      if (!m) continue;
      const full = m[1] || m[2];
      const mod = ctx.mods.byFile(full);
      if (mod) modFiles.add(mod.file);
      else if (/[\\/](?:libraries|versions)[\\/]/.test(full)) paths.add(full.replace(/\\/g, '/').replace(/^.*?\/((?:libraries|versions)\/)/, '$1'));
      break;
    }
  }
  const mods = [...modFiles].map((file) => ctx.mods.byFile(file));
  ctx.add({
    id: 'corrupt-files', category: 'files', severity: 'critical', confidence: mods.length || paths.size ? 88 : 64,
    title: mods.length ? `${mods[0].name} is damaged or not a real mod file` : 'Some game files are damaged',
    explanation: mods.length
      ? `${mods.map((m) => m.file).join(', ')} could not be opened. The download was probably interrupted. Reinstall it.`
      : 'Java could not open a game file. It was probably damaged by an interrupted download or antivirus software. Repairing downloads it again.',
    evidence: hits.map((h) => h.index).slice(0, MAX_EVIDENCE), culprits: mods.map((m) => m.file),
    fixes: [...mods.flatMap((m) => [Fix.update(m, 'Downloads a fresh copy'), Fix.disable(m)]), paths.size || !mods.length ? Fix.repair([...paths]) : null]
  });

  const main = ctx.find(/Could not find or load main class ([\w.]+)|ClassNotFoundException: net\.minecraft\.client\.main\.Main|ClassNotFoundException: (?:net\.fabricmc\.loader\.impl\.launch\.knot\.KnotClient|cpw\.mods\.bootstraplauncher)/);
  if (main && !ctx.issues.some((i) => i.id === 'jvm-args')) {
    ctx.add({
      id: 'corrupt-install', category: 'files', severity: 'critical', confidence: 84,
      title: 'The Minecraft install is incomplete',
      explanation: 'Java could not find the game\'s main class. Some version or loader files are missing or damaged.',
      evidence: [main.index], culprits: [], fixes: [Fix.repair(['versions', 'libraries-loader'], 'Downloads the version and loader files again')]
    });
  }
}

function ruleCorruptInstallMain(ctx) {
  if (ctx.issues.some((i) => i.id === 'corrupt-install' || i.id === 'jvm-args')) return;
  const main = ctx.find(/Could not find or load main class ([\w.]+)|ClassNotFoundException: net\.minecraft\.client\.main\.Main/);
  if (!main) return;
  ctx.add({
    id: 'corrupt-install', category: 'files', severity: 'critical', confidence: 82,
    title: 'The Minecraft install is incomplete',
    explanation: 'Java could not find the game\'s main class. Some version or loader files are missing or damaged.',
    evidence: [main.index], culprits: [], fixes: [Fix.repair(['versions', 'libraries-loader'], 'Downloads the version and loader files again')]
  });
}

function ruleWorld(ctx) {
  const hit = ctx.find(/Exception reading .*?\.(?:mca|dat)|Couldn't load chunk|Failed to (?:read|load) (?:level|chunk|player data)|Exception loading level\.dat|Caught exception while loading level\.dat|Level data could not be loaded|Couldn't read (?:world|level) data|Failed to load level\.dat|RegionFile.*(?:corrupt|invalid)|Chunk file at \[.*?\] is in the wrong location|Failed to decompress chunk|Invalid (?:chunk|region) (?:data|header)/i);
  if (!hit) return;
  let world = null;
  for (let i = Math.max(0, hit.index - 3); i < Math.min(ctx.lines.length, hit.index + 6) && !world; i += 1) {
    const m = ctx.lines[i].text.match(/saves[\\/]([^\\/\n'"]+)[\\/]/);
    if (m) world = m[1];
  }
  ctx.add({
    id: 'world-corruption', category: 'world', severity: 'critical', confidence: 80,
    title: world ? `The world "${world}" has damaged data` : 'A world has damaged data',
    explanation: 'Minecraft hit unreadable world data. It is usually from a crash or power loss while saving, or a removed mod. Restore a backup, or rename level.dat_old to level.dat in the world folder.',
    evidence: [hit.index], culprits: [],
    fixes: [Fix.openFolder(world ? `saves/${world}` : 'saves', world ? `Open "${world}" folder` : 'Open worlds folder', 'Restore a backup or level.dat_old')]
  });
}

function ruleTicking(ctx) {
  const desc = ctx.find(/^Description:\s*(Ticking (?:entity|block entity|player|screen)|Exception ticking world|Exception in server tick loop|Rendering (?:entity in world|block entity|screen|overlay|item|Block Entity)|Unexpected error|Watching Server|Exception generating new chunk|Feature placement|Loading NBT data)/i, { src: 'crash-report' });
  const watchdog = ctx.find(/A single server tick took ([\d.]+) seconds \(should be max 0\.05\)/);
  if (!desc && !watchdog) return null;
  const typeHit = ctx.find(/^\s*(?:Entity Type|Block Entity Type|Name|Block):\s*(?:Block\{)?([a-z0-9_.-]+):([a-z0-9_/.-]+)/, { src: 'crash-report' });
  const locHit = ctx.find(/^\s*(?:Entity's Exact location|Block location|Entity's Block location):\s*(?:World:\s*)?\(?\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)/, { src: 'crash-report' });
  // Without a concrete object (entity / block + location), a rendering or
  // generic description is better served by stack-trace blame.
  if (!watchdog && !typeHit && !locHit && !/^Ticking|ticking world/i.test(desc?.match[1] || '')) return null;
  const namespace = typeHit?.match[1];
  const owner = namespace && namespace !== 'minecraft' ? ctx.mods.byId(namespace) : null;
  const where = locHit ? ` at ${locHit.match.slice(1, 4).map((v) => Math.round(Number(v))).join(', ')}` : '';
  return {
    kind: desc?.match[1] || 'Watching Server',
    thing: typeHit ? `${typeHit.match[1]}:${typeHit.match[2]}` : null,
    owner, where,
    evidence: [desc?.index, typeHit?.index, locHit?.index, watchdog?.index].filter((v) => v !== undefined),
    watchdog: watchdog ? Number(watchdog.match[1]) : null
  };
}

function ruleShadersPacks(ctx) {
  const shader = ctx.find(/Failed to (?:compile|link) (?:shader|program)|ShaderCompileException|Shader compilation failed|Failed to load shader pack|Error while (?:loading|parsing) (?:the )?shader ?pack|iris.*?(?:crash|exception)|Could not compile (?:shader|program)/i);
  if (shader) {
    ctx.add({
      id: 'shader-pack', category: 'graphics', severity: 'critical', confidence: 80,
      title: 'Your shader pack crashed the game',
      explanation: 'The selected shader pack failed to compile on your GPU. It may be outdated, too heavy for your GPU, or need a newer Iris. Turn shaders off to get in, then try another pack.',
      evidence: [shader.index], culprits: [], fixes: [Fix.disableShaders()]
    });
  }
  const pack = ctx.find(/Failed to (?:load|reload) resource pack|Invalid resource pack|ResourcePack.*(?:crash|exception)|Caught error loading resourcepacks|Exception while reloading resources|Failed to load (?:textures|atlas)|resourcepacks[\\/][^\s]+.*(?:Exception|Error)/i);
  if (pack) {
    ctx.add({
      id: 'resource-pack', category: 'game', severity: 'critical', confidence: 70,
      title: 'A resource pack failed to load',
      explanation: 'One of your resource packs is broken or not made for this Minecraft version. Turn the packs off, start the game, then re-enable them one by one.',
      evidence: [pack.index], culprits: [], fixes: [Fix.resetResourcePacks()]
    });
  }
  const early = ctx.find(/EarlyDisplay|earlyWindow|DisplayWindow.*(?:failed|exception)|Failed to (?:initialize|create) (?:the )?early (?:display|window)|fml\.earlyWindowControl/i);
  if (early && /forge/i.test(ctx.loader) && ctx.find(/Exception|Error|failed/i, {})) {
    if (/(?:Exception|Error|fail)/i.test(early.line) || ctx.issues.some((i) => i.category === 'graphics')) {
      ctx.add({
        id: 'forge-early-window', category: 'graphics', severity: 'critical', confidence: 76,
        title: `${ctx.loader}'s loading screen crashed`,
        explanation: `${ctx.loader}'s early loading window cannot start on this GPU or driver. Turning it off skips the window, and the game loads normally.`,
        evidence: [early.index], culprits: [], fixes: [Fix.forgeEarlyWindow()]
      });
    }
  }
}

function ruleSystem(ctx) {
  const disk = ctx.find(/No space left on device|There is not enough space on the disk|IOException: (?:Not enough space|Disk full)/i);
  if (disk) {
    ctx.add({
      id: 'disk-full', category: 'system', severity: 'critical', confidence: 95,
      title: 'Your disk is full', explanation: 'Minecraft could not write files because the drive is out of space. Free up some space and launch again.',
      evidence: [disk.index], culprits: [], fixes: []
    });
  }
  const perm = ctx.find(/AccessDeniedException: (.+)|Access is denied|Permission denied|The process cannot access the file because it is being used by another process/i);
  if (perm) {
    ctx.add({
      id: 'file-access', category: 'system', severity: 'warning', confidence: 70,
      title: 'Minecraft was blocked from a file',
      explanation: 'A file was locked or access was denied. Antivirus scanning, OneDrive syncing or a second copy of the game running are the usual causes. Close other Minecraft windows and allow Noctra in your antivirus.',
      evidence: [perm.index], culprits: [], fixes: [Fix.openFolder('', 'Open instance folder', 'Check the file is not read-only')]
    });
  }
  const link = ctx.find(/UnsatisfiedLinkError:?(.*)|Failed to locate library: ([\w.-]+)|mach-o file, but is an incompatible architecture/);
  if (link) {
    const vcredist = /Can't find dependent libraries|vcruntime|msvcp/i.test(link.line + (ctx.lines[link.index + 1]?.text || ''));
    ctx.add({
      id: 'native-libraries', category: 'files', severity: 'critical', confidence: 80,
      title: vcredist ? 'A Windows system library is missing' : 'Native libraries failed to load',
      explanation: vcredist
        ? 'Java needs the Microsoft Visual C++ Redistributable, which is not installed on this PC.'
        : 'The game\'s native libraries (LWJGL) are missing, damaged, or for the wrong CPU architecture.',
      evidence: [link.index], culprits: [],
      fixes: vcredist
        ? [Fix.openUrl('https://aka.ms/vs/17/release/vc_redist.x64.exe', 'Install Visual C++ Redistributable', 'Official Microsoft download')]
        : [Fix.repair(['natives'], 'Downloads fresh native libraries'), Fix.java(javaForMinecraft(ctx.mcVersion), 'Installs Java for your CPU')]
    });
  }
  const so = ctx.find(/java\.lang\.StackOverflowError/);
  if (so) {
    ctx.add({
      id: 'stack-overflow', category: 'java', severity: 'warning', confidence: 55,
      title: 'The game ran out of stack space',
      explanation: 'Something recursed too deeply. Usually a mod loop (see the suspects) but big modpacks sometimes just need a larger stack.',
      evidence: [so.index], culprits: [], fixes: [Fix.jvmAdd('-Xss4M', 'Gives each thread a larger stack')]
    });
  }
  const path = ctx.find(/InvalidPathException|Illegal char <.> at index|Malformed input or input contains unmappable characters/);
  if (path) {
    ctx.add({
      id: 'path-characters', category: 'system', severity: 'warning', confidence: 65,
      title: 'A file path contains characters Java cannot handle',
      explanation: 'A folder or file name (often your Windows user name or a mod file) has characters Java misreads. Rename the file, or move Noctra\'s data to a plain folder.',
      evidence: [path.index], culprits: [], fixes: []
    });
  }
}

/* --------------------------------------------------------- static checks */

function ruleStaticMods(ctx) {
  const loader = ctx.loader.toLowerCase();
  if (loader === 'vanilla' || !ctx.mods.mods.length) return;
  const isFabricLike = loader === 'fabric' || loader === 'quilt';
  const isForgeLike = loader === 'forge' || loader === 'neoforge';

  // Mods for the wrong loader.
  const wrong = ctx.mods.mods.filter((mod) => (isFabricLike && (mod.loader === 'forge' || mod.loader === 'neoforge'))
    || (isForgeLike && (mod.loader === 'fabric' || mod.loader === 'quilt'))
    || (loader === 'fabric' && mod.loader === 'quilt'));
  if (wrong.length) {
    ctx.add({
      id: 'wrong-loader', category: 'mods', severity: isForgeLike ? 'critical' : 'warning', confidence: 72,
      title: wrong.length === 1 ? `${wrong[0].name} is not a ${ctx.loader} mod` : `${wrong.length} mods are for a different loader`,
      explanation: `This instance runs ${ctx.loader}. ${wrong.map((m) => `${m.name} (${m.loader})`).slice(0, 4).join(', ')} will not load and can break start-up.`,
      evidence: [], culprits: wrong.map((m) => m.file), fixes: wrong.slice(0, 4).map((m) => Fix.disable(m, `Made for ${m.loader}`)), static: true
    });
  }

  // Declared dependencies that are not installed.
  const missing = new Map();
  for (const mod of ctx.mods.mods) {
    if (mod.environment === 'server') continue;
    for (const id of Object.keys(mod.depends || {})) {
      if (ctx.mods.has(id) || PLATFORM_IDS.has(id) || /^(?:mixinextras|fabric-language-scala)$/.test(id)) continue;
      const list = missing.get(id) || [];
      list.push(mod);
      missing.set(id, list);
    }
  }
  if (missing.size && !ctx.issues.some((i) => i.id === 'missing-dependency')) {
    const entries = [...missing.entries()].slice(0, 5);
    ctx.add({
      id: 'missing-dependency', category: 'mods', severity: 'critical', confidence: 74,
      title: entries.length === 1 ? `${prettyId(entries[0][0])} is missing` : `${entries.length} required mods are missing`,
      explanation: entries.map(([id, mods]) => `${mods.map((m) => m.name).slice(0, 2).join(', ')} require${mods.length === 1 ? 's' : ''} ${prettyId(id)}`).join('; ') + '.',
      evidence: [], culprits: [], static: true,
      fixes: unique(entries.map(([id]) => slugForId(id))).map((slug) => Fix.install(slug, prettyId(slug), 'Declared as required'))
    });
  }

  // Duplicates on disk.
  const dupes = findDuplicates(ctx);
  if (dupes.length && !ctx.issues.some((i) => i.id === 'duplicate-mods')) {
    ctx.add({
      id: 'duplicate-mods', category: 'mods', severity: 'critical', confidence: 78,
      title: dupes.length === 1 ? `${dupes[0].keep.name} is installed twice` : `${dupes.length} mods are installed twice`,
      explanation: dupes.map((d) => `${d.keep.name}: ${[d.keep, ...d.remove].map((m) => m.file).join(' and ')}`).join('; ') + '.',
      evidence: [], culprits: dupes.flatMap((d) => d.remove.map((m) => m.file)), static: true,
      fixes: dupes.flatMap((d) => d.remove.map((m) => Fix.disable(m, `Older copy; keeps ${d.keep.file}`)))
    });
  }

  // Known conflicting pairs.
  for (const [a, b, why] of INCOMPATIBLE_PAIRS) {
    const ma = ctx.mods.byId(a);
    const mb = ctx.mods.byId(b);
    if (!ma || !mb || ma === mb) continue;
    const optifine = [ma, mb].find((m) => (m.ids || []).includes('optifine'));
    const drop = optifine || mb;
    ctx.add({
      id: 'known-conflict', category: 'mods', severity: 'critical', confidence: 80,
      title: `${ma.name} and ${mb.name} conflict`,
      explanation: why, evidence: [], culprits: [ma.file, mb.file], static: true,
      fixes: [Fix.disable(drop), Fix.disable(drop === ma ? mb : ma)]
    });
  }
}

/* -------------------------------------------------------------- assemble */

function reasonSentence(reason, name) {
  switch (reason) {
    case 'Its code threw the error': return `The error came from ${name}'s own code`;
    case 'Its code is in the crash': return `${name}'s code is part of the chain of calls that crashed`;
    case 'Mixin in the crashing code':
    case 'Patches the crashing code': return `${name} patches the exact code that crashed`;
    case 'Named as a suspect by Minecraft': return `Minecraft's crash report names ${name} as a suspect`;
    default: return `${name} is involved in the crash`;
  }
}

const SEVERITY = { critical: 3, warning: 2, info: 1 };

function fixId(fix) {
  return `${fix.kind}:${fix.file || fix.slug || fix.path || fix.url || fix.maxGb || fix.major || fix.args || fix.sub || (fix.paths || []).join(',') || ''}`;
}

function buildExcerpt(ctx, indices) {
  const wanted = new Set();
  const hits = new Set(indices);
  for (const index of indices) {
    for (let i = Math.max(0, index - 2); i <= Math.min(ctx.lines.length - 1, index + 3); i += 1) {
      if (ctx.lines[i].src === ctx.lines[index].src) wanted.add(i);
    }
  }
  const sorted = [...wanted].sort((a, b) => a - b).slice(0, 70);
  const out = [];
  let prev = -2;
  for (const i of sorted) {
    if (i !== prev + 1 && out.length) out.push({ gap: true });
    const line = ctx.lines[i];
    out.push({ n: line.n, src: line.src, text: line.text.slice(0, 400), hit: hits.has(i) });
    prev = i;
  }
  return out;
}

function analyzeCrash(input = {}) {
  const ctx = createContext(input);
  const facts = readFacts(ctx);
  const chains = parseThrowables(ctx);
  const chain = primaryChain(ctx, chains);
  const root = chain ? chain.blocks[chain.blocks.length - 1] : null;
  const top = chain ? chain.blocks[0] : null;
  const blame = blameMods(ctx, chain);

  const rules = [
    ruleManualCrash, ruleJavaVersion, ruleMemory, ruleJvmArgs, ruleFabricResolution, ruleMixin, ruleModInit,
    (c) => ruleMissingClass(c, chain), ruleMethodMismatch, (c) => ruleGraphics(c, facts), (c) => ruleNativeCrash(c, facts),
    ruleConfig, ruleCorruptFiles, ruleCorruptInstallMain, ruleWorld, ruleShadersPacks, ruleSystem
  ];
  for (const rule of rules) {
    try {
      rule(ctx);
    } catch {
      /* one broken rule never hides the others */
    }
  }

  const strongCulpritIssue = ctx.issues.some((issue) => issue.confidence >= 85 && issue.culprits?.length);
  const first = blame[0];
  const clear = first && (!blame[1] || first.score >= blame[1].score * 1.5);

  let ticking = null;
  try {
    ticking = ruleTicking(ctx);
  } catch {
    ticking = null;
  }
  if (ticking) {
    const owner = ticking.owner || (first && first.score >= 4 ? ctx.mods.byFile(first.file) : null);
    const label = ticking.thing ? `${ticking.thing}${ticking.where}` : ticking.where.trim();
    ctx.add({
      id: 'ticking', category: 'world', severity: 'critical', confidence: owner ? 78 : 60,
      title: ticking.watchdog
        ? `The game froze for ${Math.round(ticking.watchdog)} s${owner ? ` inside ${owner.name}` : ''}`
        : owner ? `${owner.name} crashed while ${/render/i.test(ticking.kind) ? 'drawing' : 'updating'} ${ticking.thing ? 'something in your world' : 'the game'}` : `Minecraft crashed: ${ticking.kind}`,
      explanation: ticking.watchdog
        ? 'One game tick took far too long, so Minecraft\'s watchdog stopped the game. A mod or a very busy area of the world (huge farms, many entities) is usually the cause.'
        : `The crash happened on ${label || 'an object in the world'}.${owner ? ` It belongs to ${owner.name}; updating it usually fixes this.` : ''} If it happens every time you load the world, the object keeps crashing the game until the mod is fixed.`,
      evidence: ticking.evidence, culprits: owner ? [owner.file] : [],
      fixes: owner ? [Fix.update(owner), Fix.disable(owner, 'Removing it may delete its blocks from your world')] : []
    });
  } else if (first && first.score >= 4 && !strongCulpritIssue) {
    const mod = ctx.mods.byFile(first.file);
    const second = blame[1] && blame[1].score >= 4 ? ctx.mods.byFile(blame[1].file) : null;
    ctx.add({
      id: 'suspect-mod', category: 'mods', severity: 'critical', confidence: clear ? Math.min(78, 50 + first.score * 2) : 52,
      title: clear ? `${first.name} most likely caused the crash` : `${first.name}${second ? ` or ${second.name}` : ''} likely caused the crash`,
      explanation: `${reasonSentence(first.reasons[0], first.name)}${root ? ` (${root.type.split('.').pop()}${root.message ? `: ${root.message.slice(0, 140)}` : ''})` : ''}. Update it first; if that does not help, disable it and launch again.`,
      evidence: [...first.lines, root?.index].filter((v) => v !== undefined),
      culprits: unique([first.file, second?.file]),
      fixes: [Fix.update(mod), Fix.disable(mod), second ? Fix.disable(second) : null]
    });
  }

  try {
    ruleStaticMods(ctx);
  } catch {
    /* ignore */
  }

  // Clean up, dedupe and rank.
  const byKey = new Map();
  for (const issue of ctx.issues) {
    issue.fixes = (issue.fixes || []).filter(Boolean);
    const seen = new Set();
    issue.fixes = issue.fixes.filter((fix) => {
      fix.id = fixId(fix);
      if (seen.has(fix.id)) return false;
      seen.add(fix.id);
      return true;
    });
    issue.culprits = unique(issue.culprits || []);
    issue.evidence = unique((issue.evidence || []).map(String)).map(Number).filter((n) => Number.isFinite(n));
    const key = `${issue.id}:${issue.title}`;
    const existing = byKey.get(key);
    if (!existing || existing.confidence < issue.confidence) byKey.set(key, issue);
  }
  let issues = [...byKey.values()];
  const hasLogIssue = issues.some((issue) => !issue.static && issue.severity === 'critical' && issue.id !== 'manual');
  issues.sort((a, b) => {
    const rank = (issue) => (issue.static && hasLogIssue ? -40 : 0) + issue.confidence + SEVERITY[issue.severity] * 4;
    return rank(b) - rank(a);
  });
  // A static finding that duplicates a log finding adds nothing.
  issues = issues.filter((issue, index) => !issue.static || !issues.slice(0, index).some((other) => other.id === issue.id));

  const meaning = exitMeaning(input.exitCode);
  if (!issues.length) {
    const vendor = facts.gpuVendor;
    const nativeExit = /native|driver|overlay/i.test(meaning || '');
    issues.push({
      id: 'unknown', category: nativeExit ? 'graphics' : 'game', severity: 'critical', confidence: nativeExit ? 50 : 30,
      title: facts.description && !/^Unexpected error$/i.test(facts.description)
        ? `Minecraft crashed: ${facts.description}`
        : root ? `Minecraft crashed with ${root.type.split('.').pop()}` : 'Minecraft closed unexpectedly',
      explanation: [meaning, root?.message ? `Error: ${root.message.slice(0, 200)}` : null,
        !meaning && !root ? 'No error was written before the game closed. Launch again. If it repeats, share the log so someone can take a look.' : null].filter(Boolean).join(' '),
      evidence: root ? [root.index] : [], culprits: [],
      fixes: nativeExit && vendor ? [{ ...Fix.openUrl(DRIVER_LINKS[vendor].url, `Get the latest ${DRIVER_LINKS[vendor].name} driver`, 'Opens the official download page') }] : []
    });
    issues[0].fixes.forEach((fix) => { fix.id = fixId(fix); });
  }

  const primary = issues[0];
  if (primary.fixes[0]) primary.fixes[0].recommended = true;

  const culpritFiles = unique(issues.flatMap((issue) => issue.culprits));
  const suspects = unique([...culpritFiles, ...blame.filter((b) => b.score >= 2).map((b) => b.file)]).slice(0, 6).map((file) => {
    const mod = ctx.mods.byFile(file);
    const scored = blame.find((b) => b.file === file);
    return {
      file,
      id: mod?.ids?.[0] || null,
      name: mod?.name || file,
      version: mod?.version || '',
      score: scored?.score || 0,
      reason: culpritFiles.includes(file) ? issues.find((i) => i.culprits.includes(file))?.title : scored?.reasons?.[0] || ''
    };
  });

  const evidence = unique([
    ...issues.slice(0, 3).flatMap((issue) => issue.evidence.slice(0, 4)).map(String),
    root && root.index !== undefined ? String(root.index) : null,
    top && top !== root ? String(top.index) : null
  ]).map(Number).slice(0, 12);

  return {
    version: 1,
    headline: primary.title,
    summary: primary.explanation,
    category: primary.category,
    confidence: primary.confidence,
    issues: issues.slice(0, 8).map(({ static: isStatic, ...issue }) => ({ ...issue, fromMetadata: Boolean(isStatic) })),
    suspects,
    facts,
    exception: root ? {
      type: root.type,
      message: root.message,
      top: top && top !== root ? { type: top.type, message: top.message } : null,
      frame: root.frames[0] ? `${root.frames[0].cls}.${root.frames[0].method}` : null
    } : null,
    exitCode: input.exitCode ?? null,
    exitMeaning: meaning,
    excerpt: buildExcerpt(ctx, evidence),
    modCount: ctx.mods.mods.length,
    sources: ctx.sources.map((s) => ({ name: s.name, label: s.label, lines: s.end - s.start }))
  };
}

/** Plain-text report for the clipboard and for pasting into support chats. */
function reportToText(report, meta = {}) {
  const lines = [];
  lines.push(`# Noctra crash report${meta.instanceName ? ` - ${meta.instanceName}` : ''}`);
  if (meta.version) lines.push(`Minecraft ${meta.version}${meta.loader ? ` - ${meta.loader}${meta.loaderVersion ? ` ${meta.loaderVersion}` : ''}` : ''}`);
  if (meta.at) lines.push(`When: ${new Date(meta.at).toISOString()}`);
  if (report.exitCode !== null && report.exitCode !== undefined) lines.push(`Exit code: ${report.exitCode}${report.exitMeaning ? ` (${report.exitMeaning})` : ''}`);
  lines.push('', `## ${report.headline}`, report.summary, `Confidence: ${report.confidence}%`);
  if (report.issues.length > 1) {
    lines.push('', '## Other findings');
    report.issues.slice(1).forEach((issue) => lines.push(`- ${issue.title} (${issue.confidence}%)`));
  }
  if (report.suspects.length) {
    lines.push('', '## Suspected mods');
    report.suspects.forEach((s) => lines.push(`- ${s.name}${s.version ? ` ${s.version}` : ''} (${s.file})`));
  }
  if (report.exception) lines.push('', '## Exception', `${report.exception.type}: ${report.exception.message || ''}`.trim());
  const f = report.facts || {};
  const facts = [['Java', f.java], ['OS', f.os], ['GPU', f.gpu], ['Memory', f.memory], ['Mods', report.modCount]].filter(([, v]) => v);
  if (facts.length) {
    lines.push('', '## System');
    facts.forEach(([k, v]) => lines.push(`- ${k}: ${v}`));
  }
  if (report.excerpt?.length) {
    lines.push('', '## Evidence', '```');
    report.excerpt.forEach((row) => lines.push(row.gap ? '...' : row.text));
    lines.push('```');
  }
  if (meta.shareUrl) lines.push('', `Full log: ${meta.shareUrl}`);
  return lines.join('\n');
}

module.exports = {
  analyzeCrash,
  reportToText,
  exitMeaning,
  javaForMinecraft,
  slugForId,
  _internals: { createContext, parseThrowables, primaryChain, blameMods, createModLookup, knownLibForClass, readFacts }
};
