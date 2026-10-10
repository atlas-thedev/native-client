/*
 * Camera shots for a skinview3d viewer, like the website's fitting room:
 * the camera eases to a height + zoom (head for hats, feet for shoes, ...) and
 * the user can zoom in and out on top of that. Orbiting by drag keeps working.
 *
 *   const cam = createCamera(viewer);
 *   cam.fly(SHOTS.hats); cam.zoomBy(1.2); cam.reset(); cam.dispose();
 */

import { Box3 } from 'three';

/** [target height, zoom] per part of the player (skinview3d units, fov 42). */
export const SHOTS = {
  all: [-1, 0.68],
  hats: [10, 1.05],
  glasses: [9, 1.2],
  back: [3, 0.66],
  shoes: [-11, 1.05],
  hand: [-4, 0.8],
  // balloons float well above the head: frame the whole player and the balloon
  balloon: [13, 0.42],
  cloak: [1, 0.66]
};

const MIN_ZOOM = 0.55;
const MAX_ZOOM = 2.6;
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches || document.documentElement.dataset.motion === 'reduced';

export function createCamera(viewer) {
  const state = { y: SHOTS.all[0], zoom: SHOTS.all[1], user: 1, shot: SHOTS.all, frame: 0, dead: false };

  const place = (y, zoom) => {
    if (state.dead || !viewer?.camera || !viewer.controls) return;
    const c = viewer.camera.position;
    const t = viewer.controls.target;
    const angle = Math.atan2(c.x - t.x, c.z - t.z);
    const dist = 4.5 + 16.5 / Math.tan((viewer.fov / 360) * Math.PI) / zoom;
    t.set(0, y, 0);
    c.set(Math.sin(angle) * dist, y + 2, Math.cos(angle) * dist);
    viewer.camera.lookAt(t);
    state.y = y;
    state.zoom = zoom;
    if (viewer.renderPaused) viewer.render?.();
  };

  const ease = (y, zoom, duration = 750) => {
    cancelAnimationFrame(state.frame);
    if (reducedMotion() || duration <= 0) { place(y, zoom); return; }
    const from = { y: state.y, zoom: state.zoom };
    const start = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - start) / duration);
      const e = 1 - Math.pow(1 - k, 3);
      place(from.y + (y - from.y) * e, from.zoom + (zoom - from.zoom) * e);
      if (k < 1 && !state.dead) state.frame = requestAnimationFrame(step);
    };
    state.frame = requestAnimationFrame(step);
  };

  /**
   * Wide shots keep the whole player in the picture, tall hats and balloons included: the shot is moved up
   * (and pulled back if needed) until the player's bounding box fits. Close-ups are left alone.
   */
  const fit = (shot) => {
    if (!shot || shot[1] > 0.9 || !viewer?.playerObject) return shot;
    try {
      const T = Math.tan((viewer.fov / 360) * Math.PI);
      const halfFor = (zoom) => 4.5 * T + 16.5 / zoom;
      viewer.playerObject.updateWorldMatrix(true, true);
      const box = new Box3().setFromObject(viewer.playerObject);
      if (!Number.isFinite(box.max.y) || !Number.isFinite(box.min.y)) return shot;
      const top = box.max.y + 2, bottom = box.min.y - 2;
      let [y, zoom] = shot;
      let half = halfFor(zoom);
      if (top - bottom > half * 2) {
        half = (top - bottom) / 2;
        zoom = Math.max(MIN_ZOOM, 16.5 / Math.max(1, half - 4.5 * T));
        half = halfFor(zoom);
      }
      if (y + half < top) y = top - half;
      if (y - half > bottom) y = Math.max(shot[0], bottom + half);
      return [y, zoom];
    } catch {
      return shot;
    }
  };

  const clampUser = (value) => Math.min(MAX_ZOOM / state.shot[1], Math.max(MIN_ZOOM / state.shot[1], value));

  return {
    /** Ease to a shot ([y, zoom]); keeps the user's zoom unless `resetZoom`. */
    fly(shot = SHOTS.all, { resetZoom = true, duration } = {}) {
      state.shot = shot;
      if (resetZoom) state.user = 1;
      state.user = clampUser(state.user);
      const framed = fit(shot);
      ease(framed[0], framed[1] * state.user, duration);
    },
    /** Re-frame the current shot (e.g. after a cosmetic loaded), keeping the user's zoom. */
    refit(duration = 400) {
      const framed = fit(state.shot);
      ease(framed[0], framed[1] * state.user, duration);
    },
    /** Zoom in (>1) or out (<1) by a factor. */
    zoomBy(factor, { animate = true } = {}) {
      state.user = clampUser(state.user * factor);
      const framed = fit(state.shot);
      ease(framed[0], framed[1] * state.user, animate ? 320 : 0);
    },
    canZoomIn: () => state.shot[1] * state.user < MAX_ZOOM - 0.01,
    canZoomOut: () => state.shot[1] * state.user > MIN_ZOOM + 0.01,
    reset() { state.user = 1; const framed = fit(state.shot); ease(framed[0], framed[1], 500); },
    dispose() { state.dead = true; cancelAnimationFrame(state.frame); }
  };
}
