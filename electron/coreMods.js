'use strict';
/**
 * Noctra's own mod ("noctra-client-<version>.jar") is installed and updated by the launcher
 * (see noctraMod.js). The mods manager may not disable or delete it.
 * Keep in sync with src/features/cluster/coreMods.js.
 */
const NOCTRA_MOD_FILE = /^noctra-client-[\w.+-]+\.jar(\.disabled)?$/i;

const isNoctraCoreMod = (filename) => NOCTRA_MOD_FILE.test(String(filename || ''));

/** Throws when someone tries to turn off or remove the Noctra mod from an instance's mods folder. */
function assertNotCoreMod(folder, filename) {
  const inMods = String(folder || 'mods').replace(/[\\/]+$/, '') === 'mods';
  if (inMods && isNoctraCoreMod(filename)) {
    throw new Error('Noctra Client is required and kept up to date by the launcher. It can’t be disabled or removed.');
  }
}

module.exports = { NOCTRA_MOD_FILE, isNoctraCoreMod, assertNotCoreMod };
