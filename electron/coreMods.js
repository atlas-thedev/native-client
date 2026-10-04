'use strict';
/**
 * Native's own mod ("native-client-<version>.jar") is installed and updated by the launcher
 * (see nativeMod.js). The mods manager may not disable or delete it.
 * Keep in sync with src/features/cluster/coreMods.js.
 */
const NATIVE_MOD_FILE = /^native-client-[\w.+-]+\.jar(\.disabled)?$/i;

const isNativeCoreMod = (filename) => NATIVE_MOD_FILE.test(String(filename || ''));

/** Throws when someone tries to turn off or remove the Native mod from an instance's mods folder. */
function assertNotCoreMod(folder, filename) {
  const inMods = String(folder || 'mods').replace(/[\\/]+$/, '') === 'mods';
  if (inMods && isNativeCoreMod(filename)) {
    throw new Error('Native Client is required and kept up to date by the launcher. It can’t be disabled or removed.');
  }
}

module.exports = { NATIVE_MOD_FILE, isNativeCoreMod, assertNotCoreMod };
