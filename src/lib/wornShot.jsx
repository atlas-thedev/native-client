import React, { useEffect, useState } from 'react';
import steveSkin from '../assets/steve.png';
import alexSkin from '../assets/alex.png';

/**
 * Store art for cosmetics: the piece worn on the player's own skin. Nothing is hand-placed: the camera is fitted
 * automatically to the piece plus the body part(s) it attaches to, and turns to whichever side the piece is on.
 *
 * Every shot is drawn once by one shared off-screen 3D viewer, one after another, and kept in memory and in
 * IndexedDB (keyed by the item's files and the skin), so the next visit paints instantly with no 3D work at all.
 */

const SIZE = 288;
const VERSION = 'v6';
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
/** A drawing that hangs (an image that never loads) must not block every picture queued after it. */
/** The picture on the stage, or null if it came out empty (lost GPU context), so a blank is never cached. */
function snapshot(viewer) {
  const gl = viewer.renderer?.getContext?.();
  if (!gl || gl.isContextLost?.()) { stage = null; return null; }
  const url = viewer.canvas.toDataURL('image/png');
  try {
    const w = viewer.canvas.width, h = viewer.canvas.height;
    const px = new Uint8Array(4 * 64);
    // sample a coarse grid of pixels; any non-transparent one means something was drawn
    let seen = false;
    for (let i = 0; i < 64 && !seen; i++) {
      gl.readPixels(Math.floor(((i % 8) + 0.5) * w / 8), Math.floor((Math.floor(i / 8) + 0.5) * h / 8), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px.subarray(i * 4, i * 4 + 4));
      if (px[i * 4 + 3]) seen = true;
    }
    if (!seen) return url.length > 3000 ? url : null;
  } catch { /* reading back is only a check */ }
  return url;
}
const capped = (promise, ms = 12000) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
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
  const mine = { viewer, THREE, ncm, skinKey: null };
  // If the GPU drops this context (too many 3D views open), build a fresh stage for the next picture.
  canvas.addEventListener('webglcontextlost', (event) => { event.preventDefault(); if (stage === mine) stage = null; try { viewer.dispose(); } catch {} }, { once: true });
  stage = mine;
  return stage;
}

/**
 * Fits the camera to the piece and the body part(s) it is attached to (a hat shows the whole head, wings the torso and
 * head, shoes both legs), looking from the side the piece is on, with a little padding.
 */
/**
 * Drops the few far-flung vertices of a piece (sparks, trailing particles) so they don't shrink the shot:
 * anything well outside the 4th-96th percentile box of the piece is left out of the framing.
 */
function trimStrays(pts, THREE) {
  if (pts.length < 160) return;
  const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(f * (arr.length - 1))))];
  const axes = ['x', 'y', 'z'].map((k) => pts.map((p) => p[k]).sort((a, b) => a - b));
  const lo = new THREE.Vector3(q(axes[0], 0.04), q(axes[1], 0.04), q(axes[2], 0.04));
  const hi = new THREE.Vector3(q(axes[0], 0.96), q(axes[1], 0.96), q(axes[2], 0.96));
  const pad = hi.clone().sub(lo).multiplyScalar(0.12).addScalar(1);
  const box = new THREE.Box3(lo.sub(pad), hi.add(pad));
  const kept = pts.filter((p) => box.containsPoint(p));
  if (kept.length > pts.length * 0.8) { pts.length = 0; pts.push(...kept); }
}

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
  trimStrays(pts, THREE);
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
  // hats, hoods and masks are shown from the front (their trails may hang behind); back items from behind
  const headOnly = [...attached].every((name) => name === 'head');
  const behind = !headOnly && piece.getCenter(new THREE.Vector3()).z < -1.5;
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
    try {
      const { source, model: resolved } = await prepare(skinUrl, model);
      await Promise.resolve(viewer.loadSkin(source, { model: resolved }));
    } catch {
      // the player's skin couldn't be loaded (offline, blocked host…): still show the piece, on the default skin
      await Promise.resolve(viewer.loadSkin(model === 'slim' ? alexSkin : steveSkin, { model: model === 'slim' ? 'slim' : 'default' }));
    }
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
    return snapshot(viewer);
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
    const run = chain.then(() => capped(draw(item, asset, skinUrl, model, prepare)));
    chain = run.catch(() => {});
    const url = await run;
    if (url) { memory.set(key, url); writeSaved(key, url); }
    return url;
  })().catch(() => null).finally(() => waiting.delete(key));
  waiting.set(key, job);
  return job;
}

/**
 * `<img>` of the worn cosmetic; shows `fallback` (the item's flat thumbnail) until the 3D shot is ready.
 * A "thumbnail" that is really the texture sheet (items without their own thumbnail) is never shown: it reads as a
 * thin stripe. A shot that fails is retried once a little later.
 */
export function WornShot({ item, asset, skinUrl, model, prepare, fallback = null, className = '', alt = '' }) {
  const key = asset ? shotKey(item, asset, skinUrl, model) : null;
  const [url, setUrl] = useState(() => (key ? peekWornShot(key) : null));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (!key) { setUrl(null); return undefined; }
    const hit = peekWornShot(key);
    if (hit) { setUrl(hit); return undefined; }
    // keep the last picture (e.g. the old colour) until the new one is drawn, so it never flashes empty
    let live = true;
    let timer = null;
    const attempt = (left) => wornShot({ item, asset, skinUrl, model, prepare }).then((value) => {
      if (!live) return;
      if (value) setUrl(value);
      else if (left > 0) timer = setTimeout(() => attempt(left - 1), 2500);
      else setFailed(true);
    });
    attempt(1);
    return () => { live = false; clearTimeout(timer); };
  }, [key]);
  const usable = fallback && fallback !== asset?.texture ? fallback : null;
  const src = url || usable;
  if (src) return <img className={className} src={src} alt={alt} draggable={false} />;
  return <span className={`${className} ${failed ? 'is-empty' : 'is-loading'}`} aria-hidden="true" />;
}

/* ---------- whole outfits (store bundles) ---------- */

const OUTFIT_W = 300;
const OUTFIT_H = 400;
export const outfitKey = (pieces, cape, skinUrl, model) => `${VERSION}|outfit|${pieces.map(({ item, asset }) => `${item?.id}:${tag(asset?.texture)}`).join(',')}|${cape ? `${cape.id}:${tag(cape.url)}` : '-'}|${tag(skinUrl)}|${model}`;

/** Fits the whole player (and everything they wear) from a three-quarter front view, a little from above. */
function frameOutfit(viewer, THREE, yaw) {
  viewer.playerObject.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(viewer.playerObject);
  if (box.isEmpty()) return;
  const pts = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) pts.push(new THREE.Vector3(x, y, z));
  const pitch = 0.1;
  const dir = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
  const up = new THREE.Vector3().crossVectors(dir, right).normalize();
  const center = box.getCenter(new THREE.Vector3());
  const aspect = OUTFIT_W / OUTFIT_H;
  const tanV = Math.tan((viewer.fov / 2) * Math.PI / 180) / 1.06;
  const tanH = tanV * aspect;
  let distance = 10;
  for (const p of pts) {
    const o = p.clone().sub(center);
    distance = Math.max(distance, Math.abs(o.dot(right)) / tanH + o.dot(dir), Math.abs(o.dot(up)) / tanV + o.dot(dir));
  }
  viewer.camera.position.copy(center).addScaledVector(dir, distance);
  viewer.camera.lookAt(center);
}

async function drawOutfit(pieces, cape, skinUrl, model, prepare) {
  const s = await getStage();
  const { viewer, THREE, ncm } = s;
  const wantSkin = `${tag(skinUrl)}|${model}`;
  if (s.skinKey !== wantSkin) {
    try {
      const { source, model: resolved } = await prepare(skinUrl, model);
      await Promise.resolve(viewer.loadSkin(source, { model: resolved }));
    } catch {
      await Promise.resolve(viewer.loadSkin(model === 'slim' ? alexSkin : steveSkin, { model: model === 'slim' ? 'slim' : 'default' }));
    }
    s.skinKey = wantSkin;
  }
  const back = pieces.some(({ item }) => item?.slot === 'back');
  const built = [];
  const skin = viewer.playerObject.skin;
  const pose = [[skin.rightArm, -0.32, 0, 0.08], [skin.leftArm, 0.3, 0, -0.08], [skin.rightLeg, 0.24, 0, 0], [skin.leftLeg, -0.24, 0, 0]];
  try {
    viewer.setSize(OUTFIT_W, OUTFIT_H);
    if (cape && !back) {
      try { await viewer.loadCape(cape.url); } catch { viewer.loadCape(null); }
      if (viewer.playerObject.cape) { viewer.playerObject.cape.visible = true; viewer.playerObject.cape.position.z = -2.5; viewer.playerObject.cape.rotation.x = 0.22; }
    } else {
      viewer.loadCape(null);
      if (viewer.playerObject.cape) viewer.playerObject.cape.visible = false;
    }
    for (const { asset } of pieces) {
      try {
        const image = await ncm.loadImage(asset.texture);
        const one = ncm.attachToPlayer(ncm.buildCosmetic(THREE, asset.model, image), skin);
        one.update(0.35, 0);
        built.push(one);
      } catch { /* a broken piece is left out */ }
    }
    for (const [part, x, y, z] of pose) part?.rotation.set(x, y, z);
    frameOutfit(viewer, THREE, back ? 0.95 : 0.42);
    viewer.render();
    return snapshot(viewer);
  } finally {
    built.forEach((b) => { try { b.dispose(); } catch {} });
    for (const [part] of pose) part?.rotation.set(0, 0, 0);
    try { viewer.loadCape(null); } catch {}
    if (viewer.playerObject.cape) viewer.playerObject.cape.rotation.x = 0;
    viewer.setSize(SIZE, SIZE);
  }
}

/**
 * A whole look worn on `skinUrl`: every cosmetic in `pieces` ([{ item, asset }]) plus `cape` ({ id, url }), as a
 * PNG data URL. Drawn once on the shared viewer, then kept in memory and IndexedDB like the single-piece shots.
 */
export function outfitShot({ pieces = [], cape = null, skinUrl, model, prepare }) {
  const usable = pieces.filter(({ item, asset }) => item && asset?.model && asset?.texture);
  if (!usable.length && !cape) return Promise.resolve(null);
  const key = outfitKey(usable, cape, skinUrl, model);
  if (memory.has(key)) return Promise.resolve(memory.get(key));
  if (waiting.has(key)) return waiting.get(key);
  const job = (async () => {
    const saved = await readSaved(key);
    if (saved) { memory.set(key, saved); return saved; }
    const run = chain.then(() => capped(drawOutfit(usable, cape, skinUrl, model, prepare), 15000));
    chain = run.catch(() => {});
    const url = await run;
    if (url) { memory.set(key, url); writeSaved(key, url); }
    return url;
  })().catch(() => null).finally(() => waiting.delete(key));
  waiting.set(key, job);
  return job;
}

/** `<img>` of a whole look; waits until every piece's model has loaded (`ready`) so the shot is drawn once, complete. */
export function OutfitShot({ pieces, cape, skinUrl, model, prepare, ready = true, className = '', alt = '' }) {
  const usable = (pieces || []).filter(({ item, asset }) => item && asset?.model && asset?.texture);
  // a piece that never loads must not keep the picture empty: after a few seconds, draw what we have
  const [waited, setWaited] = useState(false);
  useEffect(() => { if (ready) return undefined; const t = setTimeout(() => setWaited(true), 6000); return () => clearTimeout(t); }, [ready]);
  const key = (ready || waited) && (usable.length || cape) ? outfitKey(usable, cape, skinUrl, model) : null;
  const [url, setUrl] = useState(() => (key ? memory.get(key) || null : null));
  useEffect(() => {
    if (!key) { setUrl(null); return undefined; }
    const hit = memory.get(key);
    if (hit) { setUrl(hit); return undefined; }
    setUrl(null);
    let live = true;
    outfitShot({ pieces: usable, cape, skinUrl, model, prepare }).then((value) => { if (live && value) setUrl(value); });
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (url) return <img className={className} src={url} alt={alt} draggable={false} />;
  return <span className={`${className} is-loading`} aria-hidden="true" />;
}
