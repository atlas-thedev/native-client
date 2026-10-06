import React, { useEffect, useState } from 'react';

/**
 * Store art for cosmetics: the piece worn on the player's own skin. Nothing is hand-placed: the camera is fitted
 * automatically to the piece plus the body part(s) it attaches to, and turns to whichever side the piece is on.
 *
 * Every shot is drawn once by one shared off-screen 3D viewer, one after another, and kept in memory and in
 * IndexedDB (keyed by the item's files and the skin), so the next visit paints instantly with no 3D work at all.
 */

const SIZE = 288;
const VERSION = 'v4';
const memory = new Map(); // key -> data URL
const waiting = new Map(); // key -> Promise
let chain = Promise.resolve();
let stage = null; // { viewer, THREE, ncm, skinKey }

/* ---------- persistent copy ---------- */
let dbPromise = null;
const openDb = () => {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open('native-shots', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('shots');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbPromise;
};
const idb = async (mode, fn) => {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('shots', mode);
      const result = fn(tx.objectStore('shots'));
      tx.oncomplete = () => resolve(result?.result ?? null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch { resolve(null); }
  });
};
const readSaved = (key) => idb('readonly', (store) => store.get(key));
const writeSaved = async (key, value) => {
  const count = await idb('readonly', (store) => store.count());
  if (count > 400) await idb('readwrite', (store) => store.clear());
  return idb('readwrite', (store) => store.put(value, key));
};

/* ---------- keys ---------- */
const tag = (value) => {
  const text = String(value || '');
  let h = 5381;
  const step = Math.max(1, Math.floor(text.length / 4000));
  for (let i = 0; i < text.length; i += step) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length.toString(36)}${(h >>> 0).toString(36)}`;
};
export const shotKey = (item, asset, skinUrl, model) => `${VERSION}|${item?.id}|${tag(asset?.texture)}${tag(JSON.stringify(asset?.model || ''))}|${tag(skinUrl)}|${model}`;

/* ---------- drawing ---------- */
async function getStage() {
  if (stage) return stage;
  const [lib, THREE, ncm] = await Promise.all([import('skinview3d'), import('three'), import('./ncm.js')]);
  const canvas = document.createElement('canvas');
  const viewer = new lib.SkinViewer({ canvas, width: SIZE, height: SIZE, model: 'auto-detect', preserveDrawingBuffer: true });
  viewer.fov = 42;
  viewer.autoRotate = false;
  viewer.animation = null;
  if (viewer.controls) { viewer.controls.enabled = false; }
  viewer.renderPaused = true;
  stage = { viewer, THREE, ncm, skinKey: null };
  return stage;
}

/**
 * Fits the camera to the piece and the body part(s) it is attached to (a hat shows the whole head, wings the torso and
 * head, shoes both legs), looking from the side the piece is on, with a little padding.
 */
function frameShot(viewer, THREE, built) {
  const skin = viewer.playerObject.skin;
  viewer.playerObject.updateMatrixWorld(true);
  const piece = new THREE.Box3();
  for (const r of built.roots) if (r.object.visible !== false) piece.expandByObject(r.object);
  // the points that must be in frame: every vertex of the piece, plus the slice of the body it sits on (for context)
  const pts = [];
  const v = new THREE.Vector3();
  for (const r of built.roots) {
    if (r.object.visible === false) continue;
    r.object.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i += 1) pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).clone());
    });
  }
  const attached = new Set(built.roots.filter((r) => r.object.visible !== false).map((r) => r.attach));
  const context = piece.clone().expandByScalar(5);
  const floating = attached.has('body') && built.roots.some((r) => r.side); // balloons: show the whole player
  const addPart = (part) => {
    if (!part) return;
    const whole = new THREE.Box3().expandByObject(part);
    // a piece that floats away from the body (balloons) shows the whole part instead of a clipped sliver
    const box = !floating && piece.intersectsBox(whole) ? whole.clone().intersect(context) : whole;
    if (box.isEmpty()) return;
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) pts.push(new THREE.Vector3(x, y, z));
  };
  for (const name of attached) {
    if (name === 'head') addPart(skin.head);
    else if (name === 'body') { addPart(skin.body); addPart(skin.head); }
    else if (name === 'rightLeg' || name === 'leftLeg') { addPart(skin.rightLeg); addPart(skin.leftLeg); }
    else addPart(skin[name]);
  }
  if (!pts.length) return;
  const all = new THREE.Box3().setFromPoints(pts);
  const behind = piece.getCenter(new THREE.Vector3()).z < -1.5;
  const yaw = behind ? Math.PI - 0.5 : 0.5;
  const pitch = 0.14;
  const dir = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(up, dir).normalize();
  const trueUp = new THREE.Vector3().crossVectors(dir, right).normalize();
  const base = all.getCenter(new THREE.Vector3());
  // centre on the middle of what is actually visible from the camera, not on the middle of the box
  let loA = Infinity, hiA = -Infinity, loB = Infinity, hiB = -Infinity;
  for (const p of pts) { const o = p.clone().sub(base); const a = o.dot(right), b = o.dot(trueUp); loA = Math.min(loA, a); hiA = Math.max(hiA, a); loB = Math.min(loB, b); hiB = Math.max(hiB, b); }
  const center = base.clone().addScaledVector(right, (loA + hiA) / 2).addScaledVector(trueUp, (loB + hiB) / 2);
  const tan = Math.tan((viewer.fov / 2) * Math.PI / 180) / 1.05; // 5% padding
  let distance = 8;
  for (const p of pts) {
    const o = p.clone().sub(center);
    const side = Math.max(Math.abs(o.dot(right)), Math.abs(o.dot(trueUp)));
    distance = Math.max(distance, side / tan + o.dot(dir));
  }
  viewer.camera.position.copy(center).addScaledVector(dir, distance);
  viewer.camera.lookAt(center);
  if (viewer.controls) viewer.controls.target.copy(center);
}

async function draw(item, asset, skinUrl, model, prepare) {
  const s = await getStage();
  const { viewer, THREE, ncm } = s;
  const wantSkin = `${tag(skinUrl)}|${model}`;
  if (s.skinKey !== wantSkin) {
    const { source, model: resolved } = await prepare(skinUrl, model);
    await Promise.resolve(viewer.loadSkin(source, { model: resolved }));
    viewer.loadCape(null);
    s.skinKey = wantSkin;
  }
  const image = await ncm.loadImage(asset.texture);
  const built = ncm.attachToPlayer(ncm.buildCosmetic(THREE, asset.model, image), viewer.playerObject.skin);
  try {
    built.update(0.35, 0);
    if (viewer.playerObject.cape) viewer.playerObject.cape.visible = false;
    frameShot(viewer, THREE, built);
    viewer.render();
    return viewer.canvas.toDataURL('image/png');
  } finally {
    built.dispose();
  }
}

/** The shot if it is already in memory. */
export const peekWornShot = (key) => memory.get(key) || null;

/**
 * The cosmetic worn on `skinUrl`, as a PNG data URL (or null when it can't be drawn).
 * `prepare(skinUrl, model)` resolves { source, model } (the launcher's slim-arm detection).
 */
export function wornShot({ item, asset, skinUrl, model, prepare }) {
  if (!item || !asset?.model || !asset?.texture) return Promise.resolve(null);
  const key = shotKey(item, asset, skinUrl, model);
  if (memory.has(key)) return Promise.resolve(memory.get(key));
  if (waiting.has(key)) return waiting.get(key);
  const job = (async () => {
    const saved = await readSaved(key);
    if (saved) { memory.set(key, saved); return saved; }
    // one picture at a time keeps the shared viewer simple and the UI smooth
    const run = chain.then(() => draw(item, asset, skinUrl, model, prepare));
    chain = run.catch(() => {});
    const url = await run;
    if (url) { memory.set(key, url); writeSaved(key, url); }
    return url;
  })().catch(() => null).finally(() => waiting.delete(key));
  waiting.set(key, job);
  return job;
}

/** `<img>` of the worn cosmetic; shows `fallback` (the item's flat thumbnail) until the 3D shot is ready. */
export function WornShot({ item, asset, skinUrl, model, prepare, fallback = null, className = '', alt = '' }) {
  const key = asset ? shotKey(item, asset, skinUrl, model) : null;
  const [url, setUrl] = useState(() => (key ? peekWornShot(key) : null));
  useEffect(() => {
    if (!key) { setUrl(null); return undefined; }
    const hit = peekWornShot(key);
    if (hit) { setUrl(hit); return undefined; }
    setUrl(null);
    let live = true;
    wornShot({ item, asset, skinUrl, model, prepare }).then((value) => { if (live && value) setUrl(value); });
    return () => { live = false; };
  }, [key]);
  const src = url || fallback;
  return src ? <img className={className} src={src} alt={alt} draggable={false} /> : <span className={`${className} is-loading`} />;
}
