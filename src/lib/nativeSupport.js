/**
 * Where the Native Client mod (menu, HUD mods, cosmetics) runs. Same rules as
 * electron/nativeMod.js: Fabric or Quilt, Minecraft 1.16 and newer (26.x too).
 */
export function nativeSupport(loader, version) {
  const value = String(loader || '').toLowerCase().replace(/[\s_-]+/g, '');
  const loaderOk = Boolean(value) && !value.includes('legacy') && !value.includes('forge') && (value.includes('fabric') || value.includes('quilt'));
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(version || '').trim());
  const versionOk = Boolean(match) && (Number(match[1]) > 1 || Number(match[2]) >= 16);
  if (loaderOk && versionOk) return { ok: true };
  return { ok: false, loader: !loaderOk, version: !versionOk };
}
