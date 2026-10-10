import { prepareSkinSource, skinTextureUrl } from '../components/ui/SkinViewer3D.jsx';

/**
 * The signed-in player, waving, for "player" ads (the Discord card): their own skin is drawn into the
 * banner. Drawn once per skin by an off-screen 3D viewer and kept in memory + localStorage, so Home
 * paints it instantly the next time.
 */

const W = 360;
const H = 388;
const VERSION = 'p1';
const STORE_KEY = 'native.ads.playerShot.v1';
const memory = new Map();

const tag = (value) => {
  const text = String(value || '');
  let h = 5381;
  for (let i = 0; i < text.length; i += Math.max(1, Math.floor(text.length / 4000))) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length.toString(36)}${(h >>> 0).toString(36)}`;
};

function readStored(key) {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    return saved && saved.key === key ? saved.url : null;
  } catch { return null; }
}

function store(key, url) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ key, url })); } catch { /* quota: memory only */ }
}

async function draw(skinUrl, model) {
  const lib = await import('skinview3d');
  const { source, model: resolved } = await prepareSkinSource(skinUrl, model);
  const canvas = document.createElement('canvas');
  const viewer = new lib.SkinViewer({ canvas, width: W, height: H, preserveDrawingBuffer: true });
  try {
    viewer.renderer.setClearColor(0x000000, 0);
    viewer.background = null;
    viewer.autoRotate = false;
    viewer.animation = null;
    if (viewer.controls) viewer.controls.enabled = false;
    viewer.fov = 32;
    viewer.zoom = 0.78;
    await viewer.loadSkin(source, { model: resolved === 'slim' ? 'slim' : 'default' });
    const player = viewer.playerObject;
    player.rotation.y = 0.38;
    const s = player.skin;
    s.rightArm.rotation.set(0, 0, -2.55); // waving
    s.leftArm.rotation.set(0.15, 0, -0.12);
    s.rightLeg.rotation.x = 0.22;
    s.leftLeg.rotation.x = -0.22;
    s.head.rotation.set(-0.08, -0.18, 0);
    if (viewer.globalLight) viewer.globalLight.intensity = 2.6;
    if (viewer.cameraLight) viewer.cameraLight.intensity = 0.9;
    viewer.render();
    return canvas.toDataURL('image/png');
  } finally {
    try { viewer.dispose(); } catch { /* already gone */ }
  }
}

/** Data URL of the player waving, or null. */
export async function adPlayerShot(account) {
  let skinUrl = account?.skinUrl || null;
  let model = account?.model;
  try {
    const avatar = await window.native?.wardrobe?.avatar?.(account);
    if (avatar?.skinUrl) { skinUrl = avatar.skinUrl; model = avatar.model || model; }
  } catch { /* use the account's own */ }
  skinUrl = skinTextureUrl({ ...account, skinUrl });
  const key = `${VERSION}|${tag(skinUrl)}|${model || ''}`;
  if (memory.has(key)) return memory.get(key);
  const saved = readStored(key);
  if (saved) { memory.set(key, saved); return saved; }
  const url = await Promise.race([draw(skinUrl, model), new Promise((resolve) => setTimeout(() => resolve(null), 12000))]).catch(() => null);
  if (url && url.length > 3000) { memory.set(key, url); store(key, url); return url; }
  return null;
}

/** Last drawn shot, for the very first paint. */
export function lastAdPlayerShot() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null')?.url || null; } catch { return null; }
}
