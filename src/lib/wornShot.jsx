import React, { useEffect, useState } from 'react';

/**
 * Store art for cosmetics: the piece worn on the player's own skin, framed on the part of the body it sits on
 * (hats and glasses on the head, wings from behind, shoes on the feet).
 *
 * Every shot is drawn once by one shared off-screen 3D viewer, one after another, and kept in memory and in
 * IndexedDB (keyed by the item's files and the skin), so the next visit paints instantly with no 3D work at all.
 */

const SIZE = 288;
const VERSION = 'v3';
// target = the point looked at (skinview3d units, feet at y -16), height = how much of the body fits the frame,
// yaw = turn of the camera around the player (0 = from the front, PI = from behind).
const FRAMES = {
  hats: { target: [0, 12.5, 0], height: 23, yaw: 0.5, pitch: 0.16 },
  glasses: { target: [0, 12, 0], height: 16.5, yaw: 0.42, pitch: 0.06 },
  back: { target: [0, 3.5, 0], height: 38, yaw: Math.PI - 0.5, pitch: 0.1 },
  shoes: { target: [0, -9.5, 0], height: 23, yaw: 0.55, pitch: 0.24 }
};

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
    const frame = FRAMES[item.slot] || FRAMES.hats;
    built.update(0.35, 0);
    if (viewer.playerObject.cape) viewer.playerObject.cape.visible = false;
    const distance = frame.height / (2 * Math.tan((viewer.fov / 2) * Math.PI / 180));
    const [tx, ty, tz] = frame.target;
    const flat = Math.cos(frame.pitch) * distance;
    viewer.camera.position.set(tx + Math.sin(frame.yaw) * flat, ty + Math.sin(frame.pitch) * distance, tz + Math.cos(frame.yaw) * flat);
    viewer.camera.lookAt(tx, ty, tz);
    if (viewer.controls) { viewer.controls.target.set(tx, ty, tz); }
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
