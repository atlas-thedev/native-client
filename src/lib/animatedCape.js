/**
 * Animated capes (shared by the launcher; the website carries the same logic in TypeScript).
 *
 * An animated cape is a vertical strip of `frames` equally tall frames. skinview3d only knows
 * static capes, so we repaint the cape texture from the strip on a timer. Every frame size works:
 * 2:1 (64x32 ... 2048x1024), 22:17 and 46:22 are used as they are; any other ratio is stretched
 * into a 2:1 texture so odd custom sizes still show up on the cape.
 */

export const CAPE_FRAME_SIZES = [
  { label: '64x32', width: 64, height: 32 },
  { label: '128x64', width: 128, height: 64 },
  { label: '256x128', width: 256, height: 128 },
  { label: '512x256', width: 512, height: 256 },
  { label: '1024x512', width: 1024, height: 512 },
  { label: '2048x1024', width: 2048, height: 1024 }
];

export const MAX_FRAMES = 240;
export const MAX_FPS = 30;

const NATIVE_RATIOS = [[2, 1], [22, 17], [46, 22]];
export const isNativeCapeRatio = (width, height) => NATIVE_RATIOS.some(([a, b]) => width * b === height * a);

/** Size of the texture one frame is painted at (2:1 unless the frame already has a skinview3d ratio). */
export function textureSizeFor(frameWidth, frameHeight) {
  if (isNativeCapeRatio(frameWidth, frameHeight)) return { width: frameWidth, height: frameHeight };
  return { width: frameWidth, height: Math.max(1, Math.round(frameWidth / 2)) };
}

/** Pixel grid unit of the cape's front face for a texture of this size. */
function capeUnit(width, height) {
  if (width * 22 === height * 46) return width / 46;
  if (width * 17 === height * 22) return width / 22;
  return width / 64;
}

export function loadStripImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not read the animation image.'));
    image.src = src;
  });
}

/** Paint frame `index` of a strip into `ctx` (a canvas of textureSizeFor(...)). */
export function paintFrame(ctx, image, frames, index) {
  const frameWidth = image.naturalWidth || image.width;
  const frameHeight = Math.floor((image.naturalHeight || image.height) / frames);
  const { width, height } = textureSizeFor(frameWidth, frameHeight);
  ctx.clearRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = !(width === frameWidth && height === frameHeight);
  ctx.drawImage(image, 0, index * frameHeight, frameWidth, frameHeight, 0, 0, width, height);
}

/**
 * Animate a skinview3d viewer's cape. Returns { stop() }.
 * Load the still first frame with viewer.loadCape() (that decides cape/elytra and visibility); this only
 * repaints the texture over time, and only when the frame index changes.
 */
export function startCapeAnimation(viewer, image, { frames, fps }) {
  const frameWidth = image.naturalWidth || image.width;
  const frameHeight = Math.floor((image.naturalHeight || image.height) / frames);
  const { width, height } = textureSizeFor(frameWidth, frameHeight);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  let stopped = false;
  let last = -1;
  let raf = 0;
  const rate = Math.min(MAX_FPS, Math.max(1, fps || 10));

  const draw = (index) => {
    paintFrame(ctx, image, frames, index);
    try {
      viewer.loadCape(canvas, { makeVisible: false });
      if (viewer.renderPaused) viewer.render();
    } catch {
      /* a viewer that was disposed mid-frame */
    }
  };
  const tick = (now) => {
    if (stopped) return;
    const index = Math.floor((now * rate) / 1000) % frames;
    if (index !== last) { last = index; draw(index); }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return { stop() { stopped = true; cancelAnimationFrame(raf); } };
}

/** Draw the front of the cape (the part you see from the front) into a small canvas. */
export function drawCapeFront(canvas, image, frames, index) {
  const frameWidth = image.naturalWidth || image.width;
  const frameHeight = frames > 1 ? Math.floor((image.naturalHeight || image.height) / frames) : (image.naturalHeight || image.height);
  const unit = capeUnit(frameWidth, frameHeight);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, unit, index * frameHeight + unit, 10 * unit, 16 * unit, 0, 0, canvas.width, canvas.height);
}

/** Frames/ fps guess for an uploaded strip: a 2:1 frame (or 22:17 / 46:22) whose height divides the strip. */
export function guessFrames(width, height) {
  for (const [a, b] of NATIVE_RATIOS) {
    const frameHeight = (width * b) / a;
    if (Number.isInteger(frameHeight) && frameHeight > 0 && height % frameHeight === 0 && height / frameHeight >= 2) {
      return { frames: height / frameHeight, frameWidth: width, frameHeight };
    }
  }
  return null;
}

/** Cut the first frame of a strip out as a PNG data URL (it doubles as the normal, static cape). */
export function firstFrameDataUrl(image, frames) {
  const frameWidth = image.naturalWidth || image.width;
  const frameHeight = Math.floor((image.naturalHeight || image.height) / frames);
  const canvas = document.createElement('canvas');
  canvas.width = frameWidth;
  canvas.height = frameHeight;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, 0, 0, frameWidth, frameHeight, 0, 0, frameWidth, frameHeight);
  return canvas.toDataURL('image/png');
}
