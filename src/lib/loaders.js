/* Renderer mirror of electron/loaders.js naming and version ordering
   (kept in step by test/loaders.test.js). */

export const LOADER_KINDS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge', 'legacyfabric'];

export const LOADER_NAMES = {
  vanilla: 'Vanilla',
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge',
  legacyfabric: 'Legacy Fabric'
};

export const LOADER_BLURBS = {
  vanilla: 'No mod loader. Mods in the folder are ignored.',
  fabric: 'Lightweight and quick to update. Most performance mods live here.',
  quilt: 'Fabric-compatible fork. Runs most Fabric mods as well as Quilt mods.',
  forge: 'The classic loader. Most large content mods and older modpacks.',
  neoforge: 'The community fork of Forge, used by most modern modpacks.',
  legacyfabric: 'Fabric for Minecraft 1.3 to 1.13.2 (PvP clients, old versions).'
};

export function normalizeLoader(loader) {
  const value = String(loader || '').toLowerCase().replace(/[\s_-]+/g, '');
  if (!value || value === 'vanilla' || value === 'none') return 'vanilla';
  if (value.includes('legacy') && value.includes('fabric')) return 'legacyfabric';
  if (value.includes('neoforge') || value === 'neo') return 'neoforge';
  if (value.includes('quilt')) return 'quilt';
  if (value.includes('fabric')) return 'fabric';
  if (value.includes('forge')) return 'forge';
  return 'vanilla';
}

export const loaderName = (loader) => LOADER_NAMES[normalizeLoader(loader)];

/** "0.16.10" > "0.16.9", "1.0.0" > "1.0.0-beta.3". */
export function compareLoaderVersions(a, b) {
  const split = (value) => {
    const text = String(value || '');
    const dash = text.indexOf('-');
    return dash === -1 ? [text, ''] : [text.slice(0, dash), text.slice(dash + 1)];
  };
  const [aBase, aPre] = split(a);
  const [bBase, bPre] = split(b);
  const aParts = aBase.split(/[.+]/);
  const bParts = bBase.split(/[.+]/);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i += 1) {
    const x = aParts[i] ?? '0';
    const y = bParts[i] ?? '0';
    const nx = Number(x);
    const ny = Number(y);
    const diff = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x.localeCompare(y, 'en', { numeric: true });
    if (diff) return diff;
  }
  if (!aPre && bPre) return 1;
  if (aPre && !bPre) return -1;
  return aPre.localeCompare(bPre, 'en', { numeric: true });
}
