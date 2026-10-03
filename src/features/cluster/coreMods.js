/**
 * Noctra's own Fabric/Quilt mod ("noctra-client-<version>.jar"). The launcher installs and
 * updates it on every launch, so the mods manager shows it as required: no toggle, no delete.
 * Keep in sync with electron/coreMods.js.
 */
export const NOCTRA_MOD_FILE = /^noctra-client-[\w.+-]+\.jar(\.disabled)?$/i;

export const isNoctraCoreMod = (filename) => NOCTRA_MOD_FILE.test(String(filename || ''));

export function noctraModVersion(filename) {
  const match = /^noctra-client-(.+?)\.jar(\.disabled)?$/i.exec(String(filename || ''));
  return match ? match[1] : null;
}
