/* Procedural 2D Nether, drawn on a canvas. Everything is a function of t in [0,1): a perfect loop. */
export const W = 640, H = 360, M = 28, LW = W + 2 * M;
export const OUT_W = 1920, OUT_H = 1080, S = OUT_W / W; // 3
const TAU = Math.PI * 2;
export const LAVA_Y = 292;

/* ---------- noise ---------- */
const hash = (x: number, y = 0, s = 0) => {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};
const smooth = (f: number) => f * f * (3 - 2 * f);
const n1 = (x: number, scale: number, seed: number) => {
  const p = x / scale, i = Math.floor(p), f = smooth(p - i);
  return hash(i, 0, seed) * (1 - f) + hash(i + 1, 0, seed) * f;
};
const fbm = (x: number, seed: number) => n1(x, 70, seed) * 0.55 + n1(x, 26, seed + 7) * 0.3 + n1(x, 9, seed + 13) * 0.15;
const frac = (v: number) => v - Math.floor(v);
const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const pal = (...h: string[]) => h.map(hex);
const P = {
  rack: pal('#3e1010', '#521616', '#661d1d', '#782525', '#8a2f2f', '#5a1919'),
  nylium: pal('#7d1515', '#9a1d1d', '#b52626', '#d23636', '#8a1717'),
  stem: pal('#4a1830', '#5e2040', '#742a50', '#8f3a62', '#3c1226'),
  wart: pal('#6a0a0a', '#7f0f0f', '#951515', '#b01d1d', '#5a0707'),
  shroom: pal('#ffb24a', '#ff9a2e', '#ffd27a', '#ffc35c'),
  glow: pal('#fff1b8', '#ffd870', '#f2b843', '#b8812a', '#ffe596'),
  obsid: pal('#0e0818', '#170e27', '#211538', '#2c1b4a', '#120a1f'),
  magma: pal('#3a0d06', '#55160a', '#ff6a12', '#ffa424', '#7a1f0b'),
  basalt: pal('#2b2a30', '#38363e', '#46444d', '#53505a'),
  lava: pal('#a82400', '#d43c00', '#ff5a00', '#ff7d12', '#ffa326', '#ffd25a', '#fff0a0'),
  portal: pal('#2a0466', '#4a0fa8', '#6b1fd8', '#8f3bff', '#b874ff', '#e0b8ff'),
};
const HAZE: RGB = hex('#3b0d0b');

/* ---------- block maps ---------- */
const E = 0, RACK = 1, NYL = 2, STEM = 3, WART = 4, SHROOM = 5, GLOW = 6, OBS = 7, MAGMA = 8, BASALT = 9;
const EMISSIVE = new Set([SHROOM, GLOW, MAGMA]);
type Layer = { B: number; cols: number; rows: number; map: Uint8Array; haze: number; ambient: number; lavaK?: number; extra?: (px: Px) => void };
type Px = { set: (x: number, y: number, c: RGB, a?: number, emissive?: boolean) => void };

function grid(B: number) { const cols = Math.ceil(LW / B), rows = Math.ceil(H / B); return { B, cols, rows, map: new Uint8Array(cols * rows) }; }
const at = (L: { cols: number; rows: number; map: Uint8Array }, x: number, y: number) => (x < 0 || y < 0 || x >= L.cols || y >= L.rows ? E : L.map[y * L.cols + x]);
const put = (L: { cols: number; map: Uint8Array; rows: number }, x: number, y: number, v: number) => { if (x >= 0 && y >= 0 && x < L.cols && y < L.rows) L.map[y * L.cols + x] = v; };

/** column of solid ground from screen-y `top` (px) to the bottom */
const fillDown = (L: ReturnType<typeof grid>, bx: number, topPx: number) => { for (let by = Math.floor(topPx / L.B); by < L.rows; by++) put(L, bx, by, RACK); };
const fillUp = (L: ReturnType<typeof grid>, bx: number, bottomPx: number) => { for (let by = 0; by < Math.ceil(bottomPx / L.B); by++) put(L, bx, by, RACK); };
const xOf = (L: { B: number }, bx: number) => bx * L.B + L.B / 2 - M; // screen x of a block column

/** grass-like tops: solid blocks with air above become nylium (crimson) */
function nyliumTops(L: ReturnType<typeof grid>) {
  for (let x = 0; x < L.cols; x++) for (let y = 1; y < L.rows; y++) if (at(L, x, y) === RACK && at(L, x, y - 1) === E && y * L.B < LAVA_Y - 4) put(L, x, y, NYL);
}

/* far: cavern walls and the ceiling */
function farLayer(): Layer {
  const L = grid(6);
  for (let bx = 0; bx < L.cols; bx++) {
    const x = xOf(L, bx);
    let ceil = 22 + fbm(x, 11) * 52;
    if (hash(bx, 3, 5) > 0.86) ceil += 18 + hash(bx, 4, 5) * 40; // stalactites
    fillUp(L, bx, ceil);
    let top = 999;
    if (x < 230) top = 150 + Math.pow(x / 230, 1.5) * 150 + (fbm(x, 21) - 0.5) * 40;
    if (x > 420) top = Math.min(top, 112 + Math.pow((W - x) / 220, 1.4) * 180 + (fbm(x, 31) - 0.5) * 44);
    if (Math.abs(x - 318) < 22) top = Math.min(top, 196 + Math.abs(x - 318) * 2.2 + hash(bx, 9, 9) * 10);
    if (top < 999) fillDown(L, bx, top);
  }
  for (const [cx, cy] of [[96, 0], [388, 0], [560, 0]]) glowCluster(L, cx, cy, 5);
  return { ...L, haze: 0.7, ambient: 0.4, lavaK: 0.7 };
}

/** a glowstone cluster hanging under the ceiling at screen x */
function glowCluster(L: ReturnType<typeof grid>, cx: number, _cy: number, size: number) {
  const bx0 = Math.round((cx + M) / L.B);
  for (let i = -Math.floor(size / 2); i <= Math.floor(size / 2); i++) {
    const bx = bx0 + i;
    let by = 0; while (by < L.rows && at(L, bx, by) !== E) by++;
    const depth = Math.max(1, Math.round((size / 2 - Math.abs(i)) * 0.9 + hash(bx, 2, 77) * 1.5));
    for (let d = 0; d < depth; d++) put(L, bx, by + d, GLOW);
  }
}

/* mid: crimson island with fungi + portal, a ceiling shelf with glowstone, a left outcrop */
const MID = { portalX: 488, portalTopRow: 0, portalBlocks: 4 };
function midLayer(): Layer & { vines: number[][]; portal: { x: number; y: number; w: number; h: number }; fall: { x: number; w: number; top: number } } {
  const L = grid(10);
  const tops: number[] = [];
  for (let bx = 0; bx < L.cols; bx++) {
    const x = xOf(L, bx);
    let top = 999;
    if (x > 372) top = x < 440 ? 300 - (x - 372) * 1.35 : 210 + (fbm(x, 41) - 0.5) * 26;
    if (x > 466 && x < 562) top = 212; // flat for the portal
    if (x < 96) top = 232 + x * 0.55 + (fbm(x, 51) - 0.5) * 18;
    tops[bx] = top;
    if (top < 999) fillDown(L, bx, top);
    // ceiling shelf over the middle
    if (x > 90 && x < 420) {
      const bottom = 18 + Math.sin(((x - 90) / 330) * Math.PI) * 34 + (fbm(x, 61) - 0.5) * 22 + (hash(bx, 1, 8) > 0.8 ? 16 : 0);
      fillUp(L, bx, bottom);
    }
  }
  glowCluster(L, 160, 0, 5);
  glowCluster(L, 352, 0, 3);
  // magma where the island meets the lava
  for (let bx = 0; bx < L.cols; bx++) for (let by = Math.floor((LAVA_Y - 14) / L.B); by < L.rows; by++) if (at(L, bx, by) === RACK && hash(bx, by, 3) > 0.35) put(L, bx, by, MAGMA);
  nyliumTops(L);
  // portal frame (obsidian 4x5, inside 2x3 stays empty: drawn live)
  const pbx = Math.round((MID.portalX + M) / L.B), floorRow = Math.floor(212 / L.B);
  for (let i = 0; i < 5; i++) for (let j = 0; j < 6; j++) {
    const inside = i > 0 && i < 4 && j > 0 && j < 5;
    put(L, pbx + i, floorRow - 6 + j, inside ? E : OBS);
  }
  const portal = { x: (pbx + 1) * L.B - M, y: (floorRow - 5) * L.B, w: 3 * L.B, h: 4 * L.B };
  // crimson fungi
  const vines: number[][] = [];
  const tree = (sx: number, stemH: number, capW: number, capH: number, thick: number) => {
    const bx = Math.round((sx + M) / L.B);
    let gy = 0; while (gy < L.rows && at(L, bx, gy) === E) gy++;
    for (let t = 0; t < thick; t++) for (let h = 1; h <= stemH; h++) put(L, bx + t, gy - h, STEM);
    const capTop = gy - stemH - capH + 1;
    const cxm = bx + (thick - 1) / 2;
    for (let r = 0; r < capH; r++) {
      const half = Math.round(capW / 2 - (r === 0 ? 1.5 : 0) - (r === 1 ? 0.5 : 0));
      for (let c = -half; c <= half; c++) {
        const ex = Math.round(cxm + c);
        if (r === capH - 1 && Math.abs(c) < half - 0 && hash(ex, r, 4) > 0.55 && Math.abs(c) > thick) continue; // ragged underside
        put(L, ex, capTop + r, hash(ex, capTop + r, 99) > 0.86 ? SHROOM : WART);
      }
    }
    // hanging wart under the rim + weeping vines
    for (let c = -Math.round(capW / 2); c <= Math.round(capW / 2); c++) {
      const ex = Math.round(cxm + c);
      if (Math.abs(c) <= thick) continue;
      if (hash(ex, 5, 6) > 0.6) put(L, ex, capTop + capH, WART);
      if (hash(ex, 7, 6) > 0.35) vines.push([ex * L.B + 2 + Math.floor(hash(ex, 8, 6) * 6) - M, (capTop + capH + 1) * L.B, 8 + Math.floor(hash(ex, 9, 6) * 30)]);
    }
  };
  tree(410, 7, 9, 4, 1);
  tree(600, 10, 11, 4, 2);
  tree(36, 5, 7, 3, 1);
  const fallBx = Math.round((300 + M) / L.B);
  let ft = 0; while (ft < L.rows && at(L, fallBx, ft) !== E) ft++;
  return { ...L, haze: 0.22, ambient: 0.62, vines, portal, fall: { x: 296, w: 14, top: ft * L.B } };
}

/* near: dark foreground ground and ceiling corners, framing the scene */
function nearLayer(): Layer & { fire: { x: number; y: number }; plants: number[][] } {
  const L = grid(16);
  for (let bx = 0; bx < L.cols; bx++) {
    const x = xOf(L, bx);
    let top = 999;
    if (x < 226) top = 300 + Math.max(0, x - 70) * 0.22 + (hash(bx, 0, 71) > 0.6 ? -16 : 0);
    if (x > 572) top = 318 - (x - 572) * 0.08;
    if (top < 999) fillDown(L, bx, top);
    let ceil = -1;
    if (x < 150) ceil = 44 - x * 0.22 + (hash(bx, 1, 72) > 0.6 ? 16 : 0);
    if (x > 540) ceil = 26 + (x - 540) * 0.12 + (hash(bx, 2, 72) > 0.7 ? 16 : 0);
    if (ceil > 0) fillUp(L, bx, ceil);
  }
  nyliumTops(L);
  // fire on a block
  const fbx = Math.round((150 + M) / L.B);
  let fy = 0; while (fy < L.rows && at(L, fbx, fy) === E) fy++;
  put(L, fbx, fy, RACK); // netherrack burns forever
  const plants: number[][] = [];
  for (let bx = 0; bx < L.cols; bx++) {
    if (bx === fbx) continue;
    let y = 0; while (y < L.rows && at(L, bx, y) === E) y++;
    if (y < L.rows && at(L, bx, y) === NYL && hash(bx, 0, 81) > 0.35) plants.push([bx * L.B - M, y * L.B, Math.floor(hash(bx, 1, 81) * 3)]);
  }
  return { ...L, haze: 0, ambient: 0.12, lavaK: 0.38, fire: { x: fbx * L.B - M, y: fy * L.B }, plants };
}

/* ---------- textures ---------- */
function texel(type: number, px: number, py: number, u: number, v: number, B: number): RGB {
  const h = hash(px, py, type * 17), hb = hash(px >> 1, py >> 1, type * 31);
  const pick = (p: RGB[], r: number) => p[Math.min(p.length - 1, Math.floor(r * p.length))];
  switch (type) {
    case RACK: return pick(P.rack, 0.15 + hb * 0.55 + h * 0.25);
    case NYL: {
      const drip = 2 + Math.floor(hash(px, 0, 5) * 3) + (hash(px, 1, 5) > 0.75 ? 3 : 0);
      return v < drip * (B / 16) + 1 ? pick(P.nylium, 0.2 + h * 0.6) : pick(P.rack, 0.15 + hb * 0.55 + h * 0.25);
    }
    case STEM: { const stripe = (u + Math.floor(hash(px, 0, 9) * 2)) % 4 < 2; return pick(P.stem, (stripe ? 0.55 : 0.05) + h * 0.45); }
    case WART: return pick(P.wart, 0.1 + hb * 0.6 + h * 0.3);
    case SHROOM: { const edge = u === 0 || v === 0 || u === B - 1 || v === B - 1; return edge ? P.shroom[1] : pick(P.shroom, h); }
    case GLOW: return pick(P.glow, hb * 0.55 + h * 0.45);
    case OBS: { const shine = hash(px >> 2, py >> 2, 3) > 0.9; return shine ? P.obsid[3] : pick(P.obsid.slice(0, 3), h); }
    case MAGMA: { const crack = hash(px >> 1, py, 41) > 0.72 || hash(px, py >> 1, 43) > 0.8; return crack ? (h > 0.5 ? P.magma[3] : P.magma[2]) : pick([P.magma[0], P.magma[1], P.magma[4]], h); }
    case BASALT: return pick(P.basalt, h);
  }
  return [0, 0, 0];
}

/* light reaching a pixel of the scene: lava from below, glowing blocks, the portal */
const EMITTERS: [number, number, number, number, RGB][] = [
  // x, y, radius, strength, colour
  [96, 52, 70, 0.6, hex('#ffcf70')], [388, 56, 70, 0.6, hex('#ffcf70')], [560, 52, 60, 0.45, hex('#ffcf70')],
  [160, 62, 90, 0.85, hex('#ffd27a')], [352, 50, 60, 0.6, hex('#ffd27a')],
  [508, 180, 80, 0.75, hex('#a35bff')], [300, 200, 70, 0.6, hex('#ff7a1a')], [158, 290, 60, 0.7, hex('#ff8a2a')],
  [410, 150, 60, 0.35, hex('#ffa040')], [600, 120, 70, 0.4, hex('#ffa040')],
];
function lightAt(x: number, y: number, ambient: number, lavaK = 1): RGB {
  const lava = Math.exp(-Math.max(0, LAVA_Y - y) / 70) * 1.05 * lavaK;
  let r = ambient + lava * 1.0, g = ambient * 0.8 + lava * 0.5, b = ambient * 0.75 + lava * 0.2;
  for (const [ex, ey, rad, k, c] of EMITTERS) {
    const d2 = (x - ex) ** 2 + (y - ey) ** 2, f = k * Math.exp(-d2 / (2 * rad * rad));
    r += f * c[0] / 255; g += f * c[1] / 255; b += f * c[2] / 255;
  }
  return [r, g, b];
}

/* ---------- static layer images ---------- */
type Img = { color: HTMLCanvasElement; glow: HTMLCanvasElement };
function canvas(w: number, h: number) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function render(L: Layer): Img {
  const color = canvas(LW, H), glow = canvas(LW, H);
  const ci = color.getContext('2d')!.createImageData(LW, H), gi = glow.getContext('2d')!.createImageData(LW, H);
  const set = (x: number, y: number, c: RGB, a = 1, emissive = false) => {
    if (x < 0 || y < 0 || x >= LW || y >= H) return;
    const i = (y * LW + x) * 4;
    const ia = ci.data[i + 3] / 255, oa = a + ia * (1 - a);
    for (let k = 0; k < 3; k++) ci.data[i + k] = oa ? (c[k] * a + ci.data[i + k] * ia * (1 - a)) / oa : 0;
    ci.data[i + 3] = oa * 255;
    if (emissive) { gi.data[i] = c[0]; gi.data[i + 1] = c[1]; gi.data[i + 2] = c[2]; gi.data[i + 3] = 255 * a; }
    else if (a > 0.6) { gi.data[i] = 0; gi.data[i + 1] = 0; gi.data[i + 2] = 0; gi.data[i + 3] = 255; }
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < LW; x++) {
    const bx = Math.floor(x / L.B), by = Math.floor(y / L.B), type = at(L, bx, by);
    if (type === E) continue;
    const u = x - bx * L.B, v = y - by * L.B;
    let c = texel(type, x, y, u, v, L.B);
    const em = EMISSIVE.has(type);
    // block shading: lit tops, shadowed undersides, darker sides
    let shade = 1 + (hash(bx, by, 123) - 0.5) * 0.12;
    if (v === 0 && at(L, bx, by - 1) === E) shade *= 1.22;
    if (v >= L.B - 2 && at(L, bx, by + 1) === E) shade *= 0.62;
    if (u === 0 && at(L, bx - 1, by) === E) shade *= 0.85;
    if (u === L.B - 1 && at(L, bx + 1, by) === E) shade *= 0.85;
    const sx = x - M;
    if (!em) {
      const li = lightAt(sx, y, L.ambient, L.lavaK ?? 1);
      c = [c[0] * li[0] * shade, c[1] * li[1] * shade, c[2] * li[2] * shade];
    } else c = [c[0] * Math.min(1.15, shade + 0.1), c[1] * Math.min(1.15, shade + 0.1), c[2] * Math.min(1.15, shade + 0.1)];
    const hz = em ? L.haze * 0.35 : L.haze;
    c = [c[0] * (1 - hz) + HAZE[0] * hz, c[1] * (1 - hz) + HAZE[1] * hz, c[2] * (1 - hz) + HAZE[2] * hz];
    set(x, y, [clamp(c[0], 0, 255), clamp(c[1], 0, 255), clamp(c[2], 0, 255)], 1, em);
  }
  L.extra?.({ set });
  color.getContext('2d')!.putImageData(ci, 0, 0);
  glow.getContext('2d')!.putImageData(gi, 0, 0);
  return { color, glow };
}

function sky(): HTMLCanvasElement {
  const c = canvas(W, H), x = c.getContext('2d')!, img = x.createImageData(W, H);
  const stops: [number, RGB][] = [[0, hex('#120303')], [0.3, hex('#2a0707')], [0.62, hex('#5a130c')], [0.8, hex('#9a2c10')], [1, hex('#d2551a')]];
  const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  for (let y = 0; y < H; y++) for (let px = 0; px < W; px++) {
    let t = y / LAVA_Y + (bayer[(y % 4) * 4 + (px % 4)] / 16 - 0.5) * 0.045; // ordered dithering for that retro gradient
    t = clamp(t);
    let i = 0; while (i < stops.length - 2 && t > stops[i + 1][0]) i++;
    const [t0, c0] = stops[i], [t1, c1] = stops[i + 1], f = smooth(clamp((t - t0) / (t1 - t0)));
    const q = (k: number) => Math.round((c0[k] * (1 - f) + c1[k] * f) / 6) * 6; // banded palette
    const o = (y * W + px) * 4; img.data[o] = q(0); img.data[o + 1] = q(1); img.data[o + 2] = q(2); img.data[o + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  return c;
}

/** a soft fog band texture (lowres), drifts with the camera */
function fog(seed: number, y0: number, h: number): HTMLCanvasElement {
  const c = canvas(LW + 80, H), x = c.getContext('2d')!, img = x.createImageData(LW + 80, H);
  for (let y = 0; y < H; y++) for (let px = 0; px < LW + 80; px++) {
    const d = (y - y0) / h, base = Math.exp(-d * d * 2.2);
    const n = n1(px + y * 0.6, 40, seed) * 0.6 + n1(px - y, 13, seed + 1) * 0.4;
    const a = clamp(base * (n - 0.25) * 1.5) * 0.55;
    const o = (y * (LW + 80) + px) * 4;
    img.data[o] = 150; img.data[o + 1] = 44; img.data[o + 2] = 30; img.data[o + 3] = Math.round(Math.round(a * 8) / 8 * 255);
  }
  x.putImageData(img, 0, 0);
  return c;
}

/* ---------- sprites ---------- */
const GHAST_FACE = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '..##........##..',
  '...##......##...',
  '................',
  '................',
  '.....######.....',
  '.....#....#.....',
  '................',
  '................',
  '................',
  '................',
  '................',
];
function ghastSprite(): HTMLCanvasElement {
  const c = canvas(16, 16), x = c.getContext('2d')!, img = x.createImageData(16, 16);
  for (let v = 0; v < 16; v++) for (let u = 0; u < 16; u++) {
    const face = GHAST_FACE[v][u] === '#';
    const h = hash(u, v, 501);
    let col: RGB = face ? hex('#4a4a4a') : h > 0.82 ? hex('#d9d9d9') : h > 0.15 ? hex('#f2f2f2') : hex('#ffffff');
    if (!face && (v === 15 || u === 15)) col = hex('#c9c9c9');
    const o = (v * 16 + u) * 4; img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  return c;
}

/* ---------- the scene ---------- */
type Built = {
  sky: HTMLCanvasElement; fogA: HTMLCanvasElement; fogB: HTMLCanvasElement;
  far: Img; mid: Img; near: Img; midL: ReturnType<typeof midLayer>; nearL: ReturnType<typeof nearLayer>; ghast: HTMLCanvasElement;
  dynFar: HTMLCanvasElement; dyn: HTMLCanvasElement; dynNear: HTMLCanvasElement; dynGlow: HTMLCanvasElement; bloom: HTMLCanvasElement;
};
let built: Built | null = null;
function build(): Built {
  if (built) return built;
  const midL = midLayer();
  const nearL = nearLayer();
  midL.extra = ({ set }) => {
    // weeping vines: thin crimson strands with a few bulbs
    for (const [vx, vy, len] of midL.vines) for (let i = 0; i < len; i++) {
      const xx = vx + M + Math.round(Math.sin(i * 0.5 + vx) * 0.6);
      const c = P.nylium[Math.floor(hash(vx, i, 3) * 4)];
      const li = lightAt(vx, vy + i, 0.6);
      set(xx, vy + i, [c[0] * li[0] * 0.9, c[1] * li[1] * 0.9, c[2] * li[2] * 0.9]);
      if (i % 5 === 3 && hash(vx, i, 5) > 0.5) set(xx + 1, vy + i, [c[0] * li[0], c[1] * li[1], c[2] * li[2]]);
    }
  };
  nearL.extra = ({ set }) => {
    // crimson roots and fungi on the foreground tops
    for (const [px, py, kind] of nearL.plants) {
      const base = px + M + 3;
      for (let s = 0; s < 3 + kind * 2; s++) {
        const sx = base + s * 3, hgt = 4 + Math.floor(hash(sx, kind, 9) * (6 + kind * 3));
        for (let i = 1; i <= hgt; i++) {
          const c = P.nylium[1 + Math.floor(hash(sx, i, 2) * 3)];
          const li = lightAt(px, py - i, 0.12, 0.38);
          set(sx + (i > hgt - 2 && s % 2 ? 1 : 0), py - i, [c[0] * li[0], c[1] * li[1], c[2] * li[2]]);
        }
      }
    }
  };
  built = {
    sky: sky(), fogA: fog(301, 196, 70), fogB: fog(302, 120, 46),
    far: render(farLayer()), mid: render(midL), near: render(nearL), midL, nearL, ghast: ghastSprite(),
    dynFar: canvas(LW, H), dyn: canvas(LW, H), dynNear: canvas(LW, H), dynGlow: canvas(LW, H), bloom: canvas(OUT_W / 2, OUT_H / 2),
  };
  return built;
}

/* ---------- animated parts (drawn into the dynamic lowres canvas each frame) ---------- */
function drawDynamic(b: Built, t: number, ox: { far: number; mid: number; near: number }) {
  const gc = b.dynGlow.getContext('2d')!;
  const targets = [b.dynFar, b.dyn, b.dynNear].map((c) => ({ c, img: c.getContext('2d')!.createImageData(LW, H) }));
  const gimg = gc.createImageData(LW, H), g = gimg.data;
  let d = targets[1].img.data;
  const target = (k: number) => { d = targets[k].img.data; };
  const put = (x: number, y: number, c: RGB, a = 1, glowK = 1) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= LW || y >= H) return;
    const i = (y * LW + x) * 4;
    const ia = d[i + 3] / 255, oa = a + ia * (1 - a);
    for (let k = 0; k < 3; k++) d[i + k] = oa ? (c[k] * a + d[i + k] * ia * (1 - a)) / oa : 0;
    d[i + 3] = oa * 255;
    for (let k = 0; k < 3; k++) g[i + k] = Math.max(g[i + k], c[k] * glowK);
    g[i + 3] = Math.max(g[i + 3], 255 * a);
  };
  const lavaCol = (v: number) => P.lava[Math.max(0, Math.min(P.lava.length - 1, Math.floor(v * P.lava.length)))];

  // lava sea
  for (let x = 0; x < LW; x++) {
    const sx = x - M - ox.mid;
    const surf = LAVA_Y + Math.round(Math.sin(sx * 0.07 + TAU * t * 3) * 1.2 + Math.sin(sx * 0.023 - TAU * t * 2) * 1.4);
    for (let y = surf; y < H; y++) {
      const depth = y - surf;
      const qx = sx >> 1, qy = y >> 1;
      const flow = Math.sin(qx * 0.21 + qy * 0.13 + TAU * t * 2) + Math.sin(qx * 0.07 - qy * 0.29 - TAU * t * 3) + Math.sin((qx + qy) * 0.11 + TAU * t * 1);
      let v = 0.34 + flow * 0.16 + (hash(qx, qy, 7) - 0.5) * 0.14;
      const crust = n1(qx * 1.0 + qy * 3.1 + Math.sin(TAU * t + qy * 0.2) * 6, 9, 71 + (qy % 7));
      if (depth < 2) v = 0.86 + hash(qx, 0, 3) * 0.12;
      else if (depth < 4) v = Math.max(v, 0.66);
      if (depth >= 4 && crust > 0.72 && v < 0.5) { put(x, y, crust > 0.82 ? hex('#3a0b04') : hex('#5c1406'), 1, 0); continue; }
      put(x, y, lavaCol(clamp(v)), 1, depth < 4 ? 0.9 : 0.5);
    }
    // bubbles that pop on the surface
    const bp = hash(Math.floor(sx / 23), 0, 61);
    if (bp > 0.72) {
      const ph = frac(t * (2 + Math.floor(bp * 3)) + bp * 7);
      if (ph < 0.18 && Math.abs((sx % 23) - 11) < 2) put(x, surf - 1 - Math.round(ph * 14), P.lava[6], 1, 1.2);
    }
  }

  // lavafalls (far + mid): streaks that scroll down, a full multiple of their period per loop
  const fall = (cx: number, w: number, top: number, layerOx: number, shade: number) => {
    const PER = 32, shift = t * PER * 20;
    for (let y = Math.max(0, Math.floor(top)); y < LAVA_Y + 2; y++) {
      const wob = Math.round(Math.sin(y * 0.15 + TAU * t * 4) * 0.8);
      for (let i = 0; i < w; i++) {
        const x = cx + M + layerOx + i + wob;
        const edge = i === 0 || i === w - 1;
        const ph = hash(i, 0, 17) * PER;
        const s = hash(i, Math.floor((((y - shift + ph) % PER) + PER) % PER / 3), 19);
        let v = 0.45 + s * 0.45 - (edge ? 0.3 : 0);
        put(x, y, (() => { const c = lavaCol(clamp(v)); return [c[0] * shade, c[1] * shade, c[2] * shade] as RGB; })(), 1, 1);
      }
    }
    // splash
    for (let k = 0; k < 10; k++) {
      const ph = frac(t * 6 + hash(k, cx, 3));
      const sx = cx + M + layerOx + w / 2 + (hash(k, cx, 5) - 0.5) * w * 2.4 * ph * 2;
      const sy = LAVA_Y - Math.sin(ph * Math.PI) * (6 + hash(k, cx, 7) * 8);
      put(sx, sy, P.lava[5 + (k % 2)], 1 - ph * 0.6, 1.3);
    }
  };
  target(0);
  fall(204, 6, 40, ox.far, 0.8);
  fall(118, 5, 46, ox.far, 0.7);
  target(1);
  fall(b.midL.fall.x, b.midL.fall.w, b.midL.fall.top, ox.mid, 1);

  // nether portal swirl
  const p = b.midL.portal;
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
    const u = (x - p.w / 2 + 0.5) / p.w, v = (y - p.h / 2 + 0.5) / p.h;
    const ang = Math.atan2(v, u), rad = Math.hypot(u, v * 0.7);
    const sw = Math.sin(ang * 2 + rad * 14 - TAU * t * 6) * 0.5 + Math.sin(rad * 22 + TAU * t * 4 + ang) * 0.3 + (hash(x >> 1, y >> 1, 9) - 0.5) * 0.35;
    const k = clamp(0.45 + sw * 0.45);
    put(p.x + M + ox.mid + x, p.y + y, P.portal[Math.min(5, Math.floor(k * 6))], 0.92, 1);
  }

  // fire on the netherrack block (foreground)
  target(2);
  const f = b.nearL.fire;
  for (let y = 0; y < 22; y++) for (let x = 0; x < 16; x++) {
    const hgt = 1 - y / 22;
    const tongue = Math.sin(x * 0.9 + TAU * t * 8 + Math.sin(TAU * t * 5) * 2) * 0.22 + Math.sin(x * 1.7 - TAU * t * 11) * 0.12;
    const heat = hgt * 1.05 + tongue - Math.abs(x - 7.5) / 12 + (hash(x, Math.floor(y / 2 + t * 600), 31) - 0.5) * 0.25;
    if (heat < 0.35) continue;
    const c: RGB = heat > 0.95 ? hex('#fff3a6') : heat > 0.75 ? hex('#ffc93a') : heat > 0.55 ? hex('#ff8a12') : hex('#d23a06');
    put(f.x + M + ox.near + x, f.y - 1 - y, c, 1, 1.25);
  }

  for (const tg of targets) tg.c.getContext('2d')!.putImageData(tg.img, 0, 0);
  gc.putImageData(gimg, 0, 0);
}

/* ---------- particles (full resolution) ---------- */
function particles(ctx: CanvasRenderingContext2D, t: number, glow: boolean) {
  // embers rising off the lava
  for (let i = 0; i < 150; i++) {
    const n = 1 + Math.floor(hash(i, 1, 1) * 3);
    const ph = frac(t * n + hash(i, 2, 1));
    const x0 = hash(i, 3, 1) * W;
    const rise = 120 + hash(i, 4, 1) * 170;
    const x = x0 + Math.sin(TAU * (t * (1 + (i % 3)) + hash(i, 5, 1))) * 10 + ph * (hash(i, 6, 1) - 0.4) * 50;
    const y = LAVA_Y - ph * rise;
    const life = 1 - ph;
    const flick = 0.75 + 0.25 * Math.sin(TAU * (t * 20 + hash(i, 7, 1)));
    const a = clamp(life * 1.4) * flick;
    const col = ph < 0.3 ? '255,226,120' : ph < 0.65 ? '255,150,40' : '220,70,20';
    const size = (hash(i, 8, 1) > 0.8 ? 2 : 1) * S;
    if (glow) {
      const gr = ctx.createRadialGradient(x * S, y * S, 0, x * S, y * S, 9 * S);
      gr.addColorStop(0, `rgba(${col},${0.35 * a})`); gr.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = gr; ctx.fillRect(x * S - 9 * S, y * S - 9 * S, 18 * S, 18 * S);
    } else { ctx.fillStyle = `rgba(${col},${a})`; ctx.fillRect(Math.round(x * S), Math.round(y * S), size, size); }
  }
  if (glow) return;
  // ash drifting down
  for (let i = 0; i < 80; i++) {
    const ph = frac(t * (1 + (i % 2)) + hash(i, 2, 2));
    const x = frac(hash(i, 3, 2) + ph * 0.25 * (i % 2 ? 1 : -1)) * W;
    const y = -10 + ph * (H + 20);
    const a = 0.25 + hash(i, 4, 2) * 0.35;
    ctx.fillStyle = `rgba(${hash(i, 5, 2) > 0.5 ? '190,170,165' : '120,100,98'},${a})`;
    ctx.fillRect(Math.round(x * S), Math.round(y * S), S, S);
  }
  // crimson spores near the forest
  for (let i = 0; i < 46; i++) {
    const cx = 380 + hash(i, 1, 3) * 280, cy = 90 + hash(i, 2, 3) * 150;
    const x = cx + Math.sin(TAU * (t * (1 + (i % 3)) + hash(i, 3, 3))) * 18;
    const y = cy + Math.cos(TAU * (t * (1 + (i % 2)) + hash(i, 4, 3))) * 12 - frac(t + hash(i, 5, 3)) * 0;
    const a = 0.45 + 0.4 * Math.sin(TAU * (t * 3 + hash(i, 6, 3)));
    ctx.fillStyle = `rgba(255,${60 + Math.floor(hash(i, 7, 3) * 50)},60,${clamp(a)})`;
    ctx.fillRect(Math.round(x * S), Math.round(y * S), S, S);
  }
}

/* ---------- compose a frame ---------- */
export function drawFrame(ctx: CanvasRenderingContext2D, t: number) {
  const b = build();
  // camera: a slow drift and breath, different per depth (parallax), periodic in t
  const cam = (amp: number) => Math.sin(TAU * t) * amp;
  const camY = (amp: number) => Math.sin(TAU * t * 2 + 0.6) * amp * 0.25;
  const ox = { far: cam(4), mid: cam(11), near: cam(22) };
  drawDynamic(b, t, ox);

  ctx.imageSmoothingEnabled = false;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.globalAlpha = 1;
  const layer = (img: CanvasImageSource, dx: number, dy: number, w = LW, h = H) => ctx.drawImage(img, Math.round((dx - M) * S), Math.round(dy * S), w * S, h * S);

  ctx.drawImage(b.sky, 0, 0, OUT_W, OUT_H);
  ctx.globalAlpha = 0.9; layer(b.fogB, cam(18) - 40, camY(4)); ctx.globalAlpha = 1;
  layer(b.far.color, ox.far, camY(2));
  layer(b.dynFar, 0, camY(2));
  // far lavafalls are in the dynamic canvas with the far offset baked in; mid things carry the mid offset
  // ghast, drifting across behind the island
  {
    const gx = W + 80 - frac(t + 0.35) * (W + 200), gy = 112 + Math.sin(TAU * t * 3) * 8;
    const gs = 2.4 * S, body = 16 * gs;
    const X = Math.round((gx + ox.far * 1.5) * S), Y = Math.round(gy * S);
    ctx.globalAlpha = 0.95;
    ctx.drawImage(b.ghast, X, Y, body, body);
    // tentacles
    ctx.fillStyle = '#e4e4e4';
    for (let k = 0; k < 9; k++) {
      const tx = X + Math.round(((k % 3) * 5 + 2 + Math.floor(k / 3) * 0.6) * gs);
      const len = (5 + hash(k, 1, 9) * 4 + Math.sin(TAU * (t * 6 + k * 0.13)) * 1.5) * gs;
      for (let s = 0; s < len; s += gs) ctx.fillRect(tx + Math.round(Math.sin(TAU * t * 6 + k + s / gs * 0.6) * gs * 0.6), Y + body + s, Math.round(gs), Math.round(gs));
    }
    ctx.globalAlpha = 1;
  }
  ctx.globalAlpha = 0.85; layer(b.fogA, cam(30) - 40, camY(6)); ctx.globalAlpha = 1;
  layer(b.mid.color, ox.mid, camY(5));
  layer(b.dyn, 0, camY(5)); // lava sea, mid lavafall, portal
  particles(ctx, t, false);

  // ---- bloom: emissive things only (black where solid blocks occlude), blurred and added ----
  const bc = b.bloom.getContext('2d')!;
  bc.globalCompositeOperation = 'source-over'; bc.filter = 'none'; bc.imageSmoothingEnabled = true;
  bc.fillStyle = '#000'; bc.fillRect(0, 0, b.bloom.width, b.bloom.height);
  const bs = S / 2;
  const bl = (img: CanvasImageSource, dx: number, dy: number) => bc.drawImage(img, (dx - M) * bs, dy * bs, LW * bs, H * bs);
  bl(b.far.glow, ox.far, camY(2));
  bl(b.dynGlow, 0, 0);
  bl(b.mid.glow, ox.mid, camY(5));
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.imageSmoothingEnabled = true;
  ctx.filter = 'blur(10px)'; ctx.globalAlpha = 0.55; ctx.drawImage(b.bloom, 0, 0, OUT_W, OUT_H);
  ctx.filter = 'blur(42px)'; ctx.globalAlpha = 0.5; ctx.drawImage(b.bloom, 0, 0, OUT_W, OUT_H);
  ctx.filter = 'none'; ctx.globalAlpha = 1;
  particles(ctx, t, true);
  // breathing light from the lava
  const breathe = 0.85 + 0.15 * Math.sin(TAU * t * 2);
  const lg = ctx.createLinearGradient(0, (LAVA_Y - 140) * S, 0, H * S);
  lg.addColorStop(0, 'rgba(255,90,20,0)'); lg.addColorStop(0.75, `rgba(255,96,24,${0.16 * breathe})`); lg.addColorStop(1, `rgba(255,140,40,${0.22 * breathe})`);
  ctx.fillStyle = lg; ctx.fillRect(0, 0, OUT_W, OUT_H);
  // glowstone / portal / fire flicker
  const flick = (x: number, y: number, r: number, col: string, a: number) => {
    const gr = ctx.createRadialGradient(x * S, y * S, 0, x * S, y * S, r * S);
    gr.addColorStop(0, `rgba(${col},${a})`); gr.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = gr; ctx.fillRect((x - r) * S, (y - r) * S, 2 * r * S, 2 * r * S);
  };
  flick(160 + ox.mid, 62, 80, '255,200,110', 0.16 + 0.04 * Math.sin(TAU * t * 7));
  flick(508 + ox.mid, 182, 70, '160,80,255', 0.2 + 0.06 * Math.sin(TAU * t * 5));
  ctx.restore();

  // ---- foreground: drawn after the light passes so it reads as a dark silhouette frame ----
  layer(b.near.color, ox.near, camY(9));
  layer(b.dynNear, 0, camY(9));
  bc.globalCompositeOperation = 'source-over'; bc.filter = 'none';
  bc.fillStyle = '#000'; bc.fillRect(0, 0, b.bloom.width, b.bloom.height);
  bl(b.near.glow, ox.near, camY(9));
  bc.globalCompositeOperation = 'lighter';
  bl(b.dynNear, 0, camY(9));
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.imageSmoothingEnabled = true;
  ctx.filter = 'blur(14px)'; ctx.globalAlpha = 0.6; ctx.drawImage(b.bloom, 0, 0, OUT_W, OUT_H);
  ctx.filter = 'none'; ctx.globalAlpha = 1;
  flick(158 + ox.near, b.nearL.fire.y - 10, 60, '255,140,40', 0.2 + 0.08 * Math.sin(TAU * t * 13) * Math.sin(TAU * t * 7));
  ctx.restore();

  // ---- grade: vignette + a darker top so the launcher UI stays readable ----
  const vg = ctx.createRadialGradient(OUT_W * 0.55, OUT_H * 0.55, OUT_H * 0.35, OUT_W * 0.55, OUT_H * 0.55, OUT_W * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(8,0,0,0.6)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, OUT_W, OUT_H);
}
