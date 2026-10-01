/*
 * JVM flag presets for the renderer. Mirrors electron/javaRuntime.js (the
 * main process builds the real launch flags); test/javaRuntime.test.js keeps
 * the two in sync.
 */

export function hasGcFlag(args) {
  return /-XX:\+Use(?:G1|Z|Shenandoah|Parallel|ParallelOld|Serial|ConcMarkSweep|Epsilon)GC\b/.test(args);
}

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

export const GC_PRESETS = [
  { id: 'none', label: 'Java default', short: 'Default', description: 'Let Java choose (G1 on Java 9+).' },
  { id: 'aikar', label: "Aikar's flags", short: "Aikar's", description: 'Tuned G1 for smooth frame times. Best general choice for modpacks.' },
  { id: 'zgc', label: 'ZGC', short: 'ZGC', description: 'Sub-millisecond pauses on big heaps (8 GB+). Java 17+, generational on 21+.', minJava: 15 },
  { id: 'shenandoah', label: 'Shenandoah', short: 'Shenandoah', description: 'Low-pause concurrent GC. Not in Oracle builds.', minJava: 12 }
];

/** Flags for a GC preset on a given Java major (empty when unsupported). */
export function gcPreset(id, major, memoryMaxGb = 4) {
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
export function splitArgs(text) {
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
export function buildJvmArgs({ preset = 'none', args = '', major = null, memoryMaxGb = 4 } = {}) {
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
