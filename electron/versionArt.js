'use strict';

/**
 * <game dir>/.native/version-art.jpg for the Native mod: the same version artwork the launcher shows on the
 * instance card, so the in-game title screen uses one still picture of that Minecraft version.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const ART_BY_PREFIX = [
  ['26.3', 'Dappled_Camp'], ['26.2', 'Chaos_Cubed'], ['26.1', 'Tiny_Takeover'],
  ['1.21.11', 'Mounts_Mayhem'], ['1.21.10', 'Copper_Age'], ['1.21', 'Tricky_Trials'],
  ['1.20', 'Trails_Tales'], ['1.19', 'Wild_Update'], ['1.18', 'Caves_Cliffs_2'], ['1.17', 'CavesAndCliffs'],
  ['1.16', 'Nether_Update'], ['1.15', 'Buzzy_Bees'], ['1.14', 'Village_Pillage'], ['1.13', 'Update_Aquatic'],
  ['1.12', 'World_Color'], ['1.11', 'Exploration_Update'], ['1.10', 'Frostburn_Update'], ['1.9', 'Combat_Update'],
  ['1.8', 'Bountiful_Update']
];

function artKeyFor(instance = {}) {
  const ver = String(instance.mc_version || instance.version || '').trim();
  for (const [prefix, key] of ART_BY_PREFIX) {
    if (ver === prefix || ver.startsWith(`${prefix}.`) || ver.startsWith(`${prefix}-`)) return key;
  }
  if (instance.artKey && /^[A-Za-z0-9_]+$/.test(instance.artKey)) return instance.artKey;
  if (/snapshot|^\d\dw\d\d/i.test(ver)) return 'Snapshot_Art';
  if (/^[0-9]{2}\.\d/.test(ver)) return 'Snapshot_Art';
  return null;
}

/** The bundled picture: src/assets/backgrounds in development, dist/assets/<Name>-<hash>.jpg once built. */
async function findArtFile(key, root = path.join(__dirname, '..')) {
  const dev = path.join(root, 'src', 'assets', 'backgrounds', `${key}.jpg`);
  try { if ((await fsp.stat(dev)).isFile()) return dev; } catch { /* packaged build */ }
  const dist = path.join(root, 'dist', 'assets');
  try {
    const hit = (await fsp.readdir(dist)).find((name) => name.startsWith(`${key}-`) && /\.jpe?g$/i.test(name));
    if (hit) return path.join(dist, hit);
  } catch { /* no build */ }
  return null;
}

async function writeForGame(gameDir, instance, root) {
  if (!gameDir) return false;
  const dir = path.join(gameDir, '.native');
  const target = path.join(dir, 'version-art.jpg');
  const key = artKeyFor(instance);
  const file = key ? await findArtFile(key, root) : null;
  if (!file) {
    await fsp.rm(target, { force: true }).catch(() => {});
    return false;
  }
  const bytes = await fsp.readFile(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${target}.tmp`;
  await fsp.writeFile(tmp, bytes);
  await fsp.rename(tmp, target);
  return true;
}

module.exports = { artKeyFor, findArtFile, writeForGame };
