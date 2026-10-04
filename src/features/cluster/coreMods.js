/**
 * Native's own Fabric/Quilt mod ("native-client-<version>.jar"). The launcher installs and
 * updates it on every launch, so the mods manager shows it as required: no toggle, no delete.
 * Keep in sync with electron/coreMods.js.
 */
export const NATIVE_MOD_FILE = /^native-client-[\w.+-]+\.jar(\.disabled)?$/i;

export const isNativeCoreMod = (filename) => NATIVE_MOD_FILE.test(String(filename || ''));

export function nativeModVersion(filename) {
  const match = /^native-client-(.+?)\.jar(\.disabled)?$/i.exec(String(filename || ''));
  return match ? match[1] : null;
}
