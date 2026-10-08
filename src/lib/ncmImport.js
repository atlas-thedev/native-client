// Ported from the website admin: ItemsAdder / Nexo / Oraxen / ModelEngine / HMCCosmetics packs -> NCM v1 (JSON + atlas PNG)
import { unzipSync } from "fflate";
import { load as yamlLoad } from "js-yaml";
const D = Math.PI / 180;
const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const FLIP = [-1, 0, 0, 0, -1, 0, 0, 0, 1];
const mul = (a, b) => {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
};
const mv = (a, v) => [a[0] * v[0] + a[1] * v[1] + a[2] * v[2], a[3] * v[0] + a[4] * v[1] + a[5] * v[2], a[6] * v[0] + a[7] * v[1] + a[8] * v[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const rX = (d) => {
  const c = Math.cos(d * D), s = Math.sin(d * D);
  return [1, 0, 0, 0, c, -s, 0, s, c];
};
const rY = (d) => {
  const c = Math.cos(d * D), s = Math.sin(d * D);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
};
const rZ = (d) => {
  const c = Math.cos(d * D), s = Math.sin(d * D);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
};
const rotXYZ = (x, y, z) => mul(rX(x), mul(rY(y), rZ(z)));
const rotZYX = (x, y, z) => mul(rZ(z), mul(rY(y), rX(x)));
const compose = (a, b) => ({ R: mul(a.R, b.R), t: add(mv(a.R, b.t), a.t) });
const about = (o, R) => ({ R, t: sub(o, mv(R, o)) });
const apply = (m, p) => add(mv(m.R, p), m.t);
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-4);
const num = (v, d = 0) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : d;
};
const vec3 = (v, d = [0, 0, 0]) => [num(v?.[0], d[0]), num(v?.[1], d[1]), num(v?.[2], d[2])];
const r4 = (n) => Math.round(n * 1e4) / 1e4;
function euler(R) {
  const b = Math.asin(Math.max(-1, Math.min(1, -R[6])));
  let a, c;
  if (Math.abs(R[6]) < 0.99999) {
    a = Math.atan2(R[7], R[8]);
    c = Math.atan2(R[3], R[0]);
  } else {
    a = Math.atan2(-R[5], R[4]);
    c = 0;
  }
  return [a / D, b / D, c / D];
}
async function readZip(buffer) {
  const raw = unzipSync(new Uint8Array(buffer));
  const files = {};
  for (const [name, data] of Object.entries(raw)) if (!name.endsWith("/")) files[name.replace(/\\/g, "/")] = data;
  return files;
}
const text = (u8) => new TextDecoder().decode(u8);
function index(files) {
  const map = /* @__PURE__ */ new Map();
  for (const k of Object.keys(files)) map.set(k.toLowerCase(), k);
  return map;
}
function findSuffix(files, idx, suffix) {
  const s = suffix.toLowerCase();
  if (idx.has(s)) return idx.get(s);
  for (const [low, key] of idx) if (low.endsWith("/" + s)) return key;
  return null;
}
const HMC_SLOTS = { HELMET: "hats", BACKPACK: "back", OFFHAND: "hand", MAINHAND: "hand" };
const HMC_ALL = ["HELMET", "CHESTPLATE", "LEGGINGS", "BOOTS", "BACKPACK", "OFFHAND", "MAINHAND", "BALLOON"];
function colorOf(v) {
  if (v == null) return null;
  let rgb = null;
  if (typeof v === "number") rgb = [v >> 16 & 255, v >> 8 & 255, v & 255];
  else {
    const t = String(v).trim();
    const hex = t.match(/^#?([0-9a-f]{6})$/i);
    if (hex) rgb = [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
    const parts = t.split(/[\s,]+/).map(Number);
    if (!rgb && parts.length === 3 && parts.every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) rgb = parts;
  }
  if (!rgb || rgb.every((n) => n >= 250)) return null;
  return "#" + rgb.map((n) => Math.round(n).toString(16).padStart(2, "0")).join("");
}
const title = (id) => id.replace(/^.*[:/]/, "").replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
function discover(files) {
  const idx = index(files);
  const notes = [];
  const docs = [];
  for (const k of Object.keys(files)) {
    if (!/\.ya?ml$/i.test(k)) continue;
    try {
      const d = yamlLoad(text(files[k]));
      if (d && typeof d === "object") docs.push({ path: k, doc: d });
    } catch {
    }
  }
  const items = /* @__PURE__ */ new Map();
  const put = (id, model, ns, color = null) => {
    if (id && model) {
      items.set(String(id).toLowerCase(), { model: String(model), ns, color });
    }
  };
  for (const { doc } of docs) {
    if (doc.items && typeof doc.items === "object") {
      const ns = doc.info?.namespace || "minecraft";
      for (const [id, v] of Object.entries(doc.items)) {
        const m = v?.resource?.model_path || v?.resource?.model;
        const c = colorOf(v?.graphics?.color ?? v?.resource?.color ?? v?.color);
        if (m) {
          put(id, String(m).includes(":") ? m : `${ns}:${m}`, null, c);
          put(`${ns}:${id}`, String(m).includes(":") ? m : `${ns}:${m}`, null, c);
        }
      }
    }
    for (const [id, v] of Object.entries(doc)) {
      if (!v || typeof v !== "object") continue;
      const pack2 = v.Pack || v.pack;
      const m = pack2 && (pack2.model || pack2.parent_model);
      if (m) put(id, m, void 0, colorOf(v.color ?? pack2?.color));
    }
  }
  const bbs = /* @__PURE__ */ new Map();
  for (const k of Object.keys(files)) if (/\.bbmodel$/i.test(k)) bbs.set(k.split("/").pop().replace(/\.bbmodel$/i, "").toLowerCase(), k);
  const entries = [];
  const seen = /* @__PURE__ */ new Set();
  for (const { doc } of docs) {
    for (const [id, v] of Object.entries(doc)) {
      if (!v || typeof v !== "object" || typeof v.slot !== "string") continue;
      const hmc = v.slot.toUpperCase();
      if (!HMC_ALL.includes(hmc) || seen.has(id)) continue;
      const slot = HMC_SLOTS[hmc];
      if (!slot) {
        notes.push(`${id}: ${hmc === "BALLOON" ? "balloons" : `${hmc} cosmetics (armor skins)`} aren't supported`);
        continue;
      }
      const side = hmc === "OFFHAND" ? "left" : hmc === "MAINHAND" ? "right" : null;
      const mat = String(v.item?.material || "");
      const ref = mat.replace(/^(nexo|oraxen|itemsadder|ia):/i, "").toLowerCase();
      const modelId = v.model ? String(v.model).toLowerCase() : null;
      if (modelId && bbs.has(modelId)) {
        seen.add(id);
        entries.push({ id, name: title(id), slot, side, kind: "bb", bb: bbs.get(modelId), hmc });
        continue;
      }
      const it = items.get(ref) || items.get(ref.split(":").pop());
      if (it) {
        seen.add(id);
        entries.push({ id, name: title(id), slot, side, kind: "java", model: it.model, hmc, color: it.color || null });
        continue;
      }
      notes.push(`${id}: no model found (${mat || modelId || "no item"})`);
    }
  }
  if (!entries.length) {
    for (const [id, it] of items) if (!id.includes(":") && findModel(files, idx, it.model)) entries.push({ id, name: title(id), slot: "hats", side: null, kind: "java", model: it.model });
    for (const [id, k] of bbs) entries.push({ id, name: title(id), slot: "hats", side: null, kind: "bb", bb: k });
  }
  return { entries, notes };
}
const BUILTIN = {
  "block/block": { display: { thirdperson_righthand: { rotation: [75, 45, 0], translation: [0, 2.5, 0], scale: [0.375, 0.375, 0.375] }, thirdperson_lefthand: { rotation: [75, 45, 0], translation: [0, 2.5, 0], scale: [0.375, 0.375, 0.375] } } },
  "item/handheld": { display: { thirdperson_righthand: { rotation: [0, -90, 55], translation: [0, 4, 0.5], scale: [0.85, 0.85, 0.85] }, thirdperson_lefthand: { rotation: [0, 90, -55], translation: [0, 4, 0.5], scale: [0.85, 0.85, 0.85] } } },
  "item/generated": { display: { thirdperson_righthand: { rotation: [0, 0, 0], translation: [0, 3, 1], scale: [0.55, 0.55, 0.55] }, thirdperson_lefthand: { rotation: [0, 0, 0], translation: [0, 3, 1], scale: [0.55, 0.55, 0.55] }, head: { rotation: [0, 180, 0], translation: [0, 13, 7], scale: [1, 1, 1] } } }
};
const splitRef = (ref) => {
  const s = String(ref).replace(/^#/, "");
  const i = s.indexOf(":");
  return i < 0 ? ["minecraft", s] : [s.slice(0, i), s.slice(i + 1)];
};
function findModel(files, idx, ref) {
  const [ns, p] = splitRef(ref);
  return findSuffix(files, idx, `assets/${ns}/models/${p}.json`) || findSuffix(files, idx, `models/${p}.json`);
}
function loadJavaModel(files, idx, ref, depth = 0) {
  const key = findModel(files, idx, ref);
  const [, p] = splitRef(ref);
  if (!key) return { elements: null, textures: {}, display: {}, builtin: BUILTIN[p] || BUILTIN[p.replace(/^minecraft:/, "")] || null };
  const json = JSON.parse(text(files[key]).replace(/^\uFEFF/, ""));
  let parent = { elements: null, textures: {}, display: {} };
  if (json.parent && depth < 8) {
    const loaded = loadJavaModel(files, idx, json.parent, depth + 1);
    parent = loaded.builtin ? { elements: null, textures: {}, display: loaded.builtin.display || {} } : loaded;
  }
  return {
    elements: json.elements || parent.elements,
    textures: { ...parent.textures, ...json.textures || {} },
    display: { ...parent.display, ...json.display || {} },
    textureSize: json.texture_size
  };
}
const FACES = ["north", "south", "east", "west", "up", "down"];
function defaultUv(face, f, t) {
  const [x1, y1, z1] = f, [x2, y2, z2] = t;
  switch (face) {
    case "down":
      return [x1, 16 - z2, x2, 16 - z1];
    case "up":
      return [x1, z1, x2, z2];
    case "north":
      return [16 - x2, 16 - y2, 16 - x1, 16 - y1];
    case "south":
      return [x1, 16 - y2, x2, 16 - y1];
    case "west":
      return [z1, 16 - y2, z2, 16 - y1];
    default:
      return [16 - z2, 16 - y2, 16 - z1, 16 - y1];
  }
}
const resolveTexRef = (textures, ref) => {
  let r = ref, n = 0;
  while (typeof r === "string" && r.startsWith("#") && n++ < 10) r = textures[r.slice(1)];
  return typeof r === "string" && !r.startsWith("#") ? r : null;
};
async function decode(u8, mime = "image/png") {
  const bmp = await createImageBitmap(new Blob([u8], { type: mime }));
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  return g.getImageData(0, 0, c.width, c.height);
}
const dataUrlBytes = (url) => {
  const b = atob(url.slice(url.indexOf(",") + 1));
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
};
async function loadJavaTextures(files, idx, textures, used) {
  const out = {};
  for (const ref of used) {
    const [ns, p] = splitRef(ref);
    const key = findSuffix(files, idx, `assets/${ns}/textures/${p}.png`) || findSuffix(files, idx, `textures/${p}.png`);
    if (!key) throw new Error(`Missing texture ${ref}`);
    const img = await decode(files[key]);
    const tex = { w: img.width, h: img.height, data: img.data, frameH: img.height, seq: [0], frametime: 1, ux: img.width / 16, uy: img.height / 16 };
    const meta = idx.get((key + ".mcmeta").toLowerCase());
    if (meta) {
      try {
        const a = JSON.parse(text(files[meta])).animation;
        if (a) {
          const fw = num(a.width, img.width), fh = num(a.height, fw === img.width ? img.width : img.height);
          const count = Math.max(1, Math.floor(img.height / fh));
          tex.frameH = fh;
          tex.frametime = Math.max(1, num(a.frametime, 1));
          tex.seq = Array.isArray(a.frames) && a.frames.length ? a.frames.map((f) => typeof f === "object" ? num(f.index) : num(f)).filter((i) => i >= 0 && i < count) : Array.from({ length: count }, (_, i) => i);
          if (Array.isArray(a.frames) && a.frames.some((f) => typeof f === "object" && f.time)) tex.frametime = Math.max(1, num(a.frames.find((f) => typeof f === "object" && f.time).time, tex.frametime));
          tex.uy = tex.frameH / 16;
        }
      } catch {
      }
    }
    out[ref] = tex;
  }
  return out;
}
async function javaIR(files, idx, entry, side) {
  const m = loadJavaModel(files, idx, entry.model);
  if (!m.elements || !m.elements.length) throw new Error("This model has no elements (flat item sprites are not supported)");
  const used = /* @__PURE__ */ new Set();
  const elements = m.elements.map((e) => {
    const from = vec3(e.from), to = vec3(e.to);
    const faces = {};
    for (const f of FACES) {
      const face = e.faces?.[f];
      if (!face) continue;
      const tex = resolveTexRef(m.textures, face.texture);
      if (!tex) continue;
      used.add(tex);
      faces[f] = { uv: face.uv ? face.uv.map((v) => num(v)) : defaultUv(f, from, to), tex, rot: (num(face.rotation) % 360 + 360) % 360, ...Number.isInteger(face.tintindex) && face.tintindex >= 0 ? { tint: true } : {} };
    }
    const origin = e.rotation ? vec3(e.rotation.origin, [8, 8, 8]) : [8, 8, 8];
    let R = I3;
    if (e.rotation) {
      const a = num(e.rotation.angle);
      R = e.rotation.axis === "x" ? rX(a) : e.rotation.axis === "z" ? rZ(a) : rY(a);
    }
    return { from: from.map((v, i) => Math.min(v, to[i])), to: to.map((v, i) => Math.max(v, vec3(e.from)[i])), faces, xf: about(origin, R), rotated: Boolean(e.rotation && num(e.rotation.angle) !== 0), origin, anim: [] };
  }).filter((e) => Object.keys(e.faces).length);
  const textures = await loadJavaTextures(files, idx, m.textures, used);
  return { elements, textures, display: m.display, mode: "java" };
}
async function bbIR(files, entry) {
  const bb = JSON.parse(text(files[entry.bb]));
  const texList = [];
  for (const [i, t] of (bb.textures || []).entries()) {
    const src = t.source || t.relative_path;
    if (!src || !String(src).startsWith("data:")) {
      texList.push(null);
      continue;
    }
    const img = await decode(dataUrlBytes(src));
    const uw = num(t.uv_width, num(bb.resolution?.width, img.width)), uh = num(t.uv_height, num(bb.resolution?.height, img.height));
    texList.push({ w: img.width, h: img.height, data: img.data, frameH: img.height, seq: [0], frametime: 1, ux: img.width / uw, uy: img.height / uh });
  }
  const textures = {};
  texList.forEach((t, i) => {
    if (t) textures[`bb${i}`] = t;
  });
  const byUuid = new Map((bb.elements || []).map((e) => [e.uuid, e]));
  const anims = /* @__PURE__ */ new Map();
  const idle = (bb.animations || []).find((a) => /idle/i.test(a.name)) || (bb.animations || [])[0];
  if (idle) {
    const len = Math.max(0.2, num(idle.length, 1));
    for (const [uuid, an] of Object.entries(idle.animators || {})) {
      for (const channel of ["position", "rotation"]) {
        const kfs = (an.keyframes || []).filter((k) => k.channel === channel);
        if (kfs.length < 2) continue;
        for (let axis = 0; axis < 3; axis++) {
          const vals = kfs.sort((a, b) => num(a.time) - num(b.time)).map((k) => num(k.data_points?.[0]?.["xyz"[axis]]));
          const lo = Math.min(...vals), hi = Math.max(...vals);
          if (hi - lo < 0.01) continue;
          if (!anims.has(uuid)) anims.set(uuid, []);
          anims.get(uuid).push({ channel, axis, lo, hi, startsLow: vals[0] <= (lo + hi) / 2, cycles: 1 / len });
        }
      }
    }
  }
  const elements = [];
  const walk = (nodes, xf, inherited) => {
    for (const n of nodes || []) {
      if (typeof n === "string") {
        const e = byUuid.get(n);
        if (!e || e.type === "locator" || e.export === false || e.visibility === false && false) continue;
        if (e.type && e.type !== "cube") continue;
        const origin = vec3(e.origin);
        const rot = vec3(e.rotation);
        const faces = {};
        for (const f of FACES) {
          const face = e.faces?.[f];
          if (!face || face.texture === null || face.texture === void 0 || !textures[`bb${face.texture}`]) continue;
          faces[f] = { uv: (face.uv || [0, 0, 0, 0]).map((v) => num(v)), tex: `bb${face.texture}`, rot: (num(face.rotation) % 360 + 360) % 360 };
        }
        if (!Object.keys(faces).length) continue;
        const inf = num(e.inflate);
        const from = vec3(e.from).map((v) => v - inf), to = vec3(e.to).map((v) => v + inf);
        elements.push({ from, to, faces, xf: compose(xf, about(origin, rotZYX(rot[0], rot[1], rot[2]))), rotated: !near(rotZYX(rot[0], rot[1], rot[2]), I3) || xf.R.some((v, i) => Math.abs(v - I3[i]) > 1e-4), origin, anim: inherited });
      } else if (n && typeof n === "object") {
        const o = vec3(n.origin), r = vec3(n.rotation);
        const g = compose(xf, about(o, rotZYX(r[0], r[1], r[2])));
        walk(n.children, g, inherited.concat(anims.get(n.uuid) || []));
      }
    }
  };
  walk(bb.outliner, { R: I3, t: [0, 0, 0] }, []);
  if (!elements.length) throw new Error("This model has no cubes");
  return { elements, textures, display: {}, mode: "bb" };
}
const AXIS_FACE = { west: "x0", east: "x1", north: "z0", south: "z1", down: "y0", up: "y1" };
const BOX = [
  ["west", "l", "s", 2, -1, 1, 1],
  ["north", "m", "s", 0, 1, 1, 1],
  ["east", "n", "s", 2, 1, 1, 1],
  ["south", "p", "s", 0, -1, 1, 1],
  ["down", "m", "r", 0, 1, 2, -1],
  ["up", "n", "r", 0, 1, 2, -1]
];
function faceST(face, fx, fy, fz) {
  switch (face) {
    case "west":
      return [fz, 1 - fy];
    case "east":
      return [1 - fz, 1 - fy];
    case "north":
      return [1 - fx, 1 - fy];
    case "south":
      return [fx, 1 - fy];
    case "up":
      return [fx, fz];
    default:
      return [fx, 1 - fz];
  }
}
function sampleFace(tex, face, s, t, frame) {
  let tu = s, tv = t;
  if (face.rot === 90) {
    tu = t;
    tv = 1 - s;
  } else if (face.rot === 180) {
    tu = 1 - s;
    tv = 1 - t;
  } else if (face.rot === 270) {
    tu = 1 - t;
    tv = s;
  }
  const [u0, v0, u1, v1] = face.uv;
  let x = Math.floor((u0 + tu * (u1 - u0)) * tex.ux), y = Math.floor((v0 + tv * (v1 - v0)) * tex.uy);
  x = Math.max(0, Math.min(tex.w - 1, x));
  y = Math.max(0, Math.min(tex.frameH - 1, y)) + frame * tex.frameH;
  y = Math.min(tex.h - 1, y);
  const i = (y * tex.w + x) * 4;
  return [tex.data[i], tex.data[i + 1], tex.data[i + 2], tex.data[i + 3]];
}
function placement(ir, slot, variant, opts) {
  const user = num(opts.scale, 1);
  if (slot === "hats") {
    const d2 = ir.display.head || {};
    const s2 = vec3(d2.scale, [1, 1, 1]);
    const Rd2 = rotXYZ(...vec3(d2.rotation));
    const sigma2 = 0.625 * ((s2[0] + s2[1] + s2[2]) / 3) * user;
    const Q2 = mul(FLIP, Rd2);
    const tr = vec3(d2.translation);
    const base2 = add([0, -4, 0], mv(FLIP, tr.map((v) => v * 0.625)));
    const t0 = sub(base2, mv(Q2, [8, 8, 8].map((v) => v * sigma2)));
    return { attach: "head", Q: Q2, sigma: sigma2, t: add(t0, vec3(opts.offset)), fit: null };
  }
  if (slot === "hand") {
    const left = variant === "left";
    const d2 = ir.display[left ? "thirdperson_lefthand" : "thirdperson_righthand"] || {};
    const s2 = vec3(d2.scale, [1, 1, 1]);
    let rot = vec3(d2.rotation), tr = vec3(d2.translation);
    if (left) {
      tr = [-tr[0], tr[1], tr[2]];
      rot = [rot[0], -rot[1], -rot[2]];
    }
    const Rd2 = rotXYZ(...rot);
    const chain = mul(rX(-90), rY(180));
    const Q2 = mul(chain, Rd2);
    const sigma2 = (s2[0] + s2[1] + s2[2]) / 3 * user;
    const T = [(left ? -1 : 1) / 16, 0.125, -0.625].map((v) => v * 16);
    const inner = add(T, tr);
    const t0 = add(mv(chain, inner), mv(Q2, [8, 8, 8].map((v) => -v * sigma2)));
    return { attach: left ? "leftArm" : "rightArm", Q: Q2, sigma: sigma2, t: add(t0, vec3(opts.offset)), fit: null };
  }
  const d = ir.display.head || {};
  const Rd = ir.mode === "java" ? rotXYZ(...vec3(d.rotation)) : I3;
  const s = ir.mode === "java" ? vec3(d.scale, [1, 1, 1]) : [1, 1, 1];
  const base = slot === "balloon" ? 0.5 : ir.mode === "java" ? 0.3125 : 1;
  const sigma = base * ((s[0] + s[1] + s[2]) / 3) * user;
  const Q = mul(FLIP, Rd);
  const side = variant === "left" ? 1 : -1;
  return { attach: "body", Q, sigma, t: [0, 0, 0], fit: slot === "balloon" ? { x: side * 11, yMax: -14, zc: 0 } : { x: 0, yc: 5.5, zMin: 2 }, offset: vec3(opts.offset) };
}
function buildVariant(ir, entry, slot, variant, opts, atlas) {
  const P = placement(ir, slot, variant, opts);
  const { Q, sigma } = P;
  const placed = ir.elements.map((e) => ({ e, A: { R: mul(Q, e.xf.R), t: add(mv(Q, e.xf.t.map((v) => v * sigma)), P.t) }, sig: sigma }));
  let shift = [0, 0, 0];
  if (P.fit) {
    const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (const { e, A } of placed) {
      for (let i = 0; i < 8; i++) {
        const c = [i & 1 ? e.to[0] : e.from[0], i & 2 ? e.to[1] : e.from[1], i & 4 ? e.to[2] : e.from[2]];
        const q = add(mv(A.R, c.map((v) => v * sigma)), A.t);
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], q[k]);
          hi[k] = Math.max(hi[k], q[k]);
        }
      }
    }
    const f = P.fit;
    shift = [f.x - (lo[0] + hi[0]) / 2, f.yMax !== void 0 ? f.yMax - hi[1] : f.yc - (lo[1] + hi[1]) / 2, f.zMin !== void 0 ? f.zMin - lo[2] : f.zc - (lo[2] + hi[2]) / 2];
    shift = add(shift, P.offset);
  }
  return { P, placed, shift };
}
async function convert(files, entry, opts = {}) {
  const idx = index(files);
  const slot = opts.slot || entry.slot;
  const ir = entry.kind === "bb" ? await bbIR(files, entry) : await javaIR(files, idx, entry);
  const sided = slot === "hand" || slot === "balloon";
  const first = opts.side || entry.side || "right";
  const variants = sided ? [first, first === "left" ? "right" : "left"] : [null];
  const built = variants.map((v) => buildVariant(ir, entry, slot, v, opts, null));
  const sigma0 = built[0].P.sigma;
  let dens = 1;
  for (const e of ir.elements) for (const [f, face] of Object.entries(e.faces)) {
    const tex = ir.textures[face.tex];
    const du = Math.abs(face.uv[2] - face.uv[0]) * tex.ux, dv = Math.abs(face.uv[3] - face.uv[1]) * tex.uy;
    const sz = [e.to[0] - e.from[0], e.to[1] - e.from[1], e.to[2] - e.from[2]];
    const a = f === "north" || f === "south" ? [sz[0], sz[1]] : f === "east" || f === "west" ? [sz[2], sz[1]] : [sz[0], sz[2]];
    const [pu, pv] = face.rot % 180 ? [a[1], a[0]] : a;
    if (pu >= 0.5 && du > 0) dens = Math.max(dens, du / pu);
    if (pv >= 0.5 && dv > 0) dens = Math.max(dens, dv / pv);
  }
  let k = Math.max(1, Math.min(8, Math.ceil(dens / sigma0 - 1e-6)));
  for (; ; ) {
    const res = pack(ir, built, variants, slot, k, opts);
    if (res.ok || k === 1) {
      if (!res.ok) throw new Error("This model needs a bigger texture than Native allows");
      return await finish(res, entry, slot, variants, k);
    }
    k--;
  }
}
function pack(ir, built, variants, slot, k, opts) {
  const sigma = built[0].P.sigma;
  const tasks = [];
  const states = (e) => {
    let S = 1;
    for (const face of Object.values(e.faces)) S = Math.max(S, ir.textures[face.tex].seq.length);
    return Math.min(S, 16);
  };
  ir.elements.forEach((e, ei) => {
    const S = states(e);
    const dims = [0, 1, 2].map((a) => {
      const sz = (e.to[a] - e.from[a]) * sigma;
      return sz <= 1e-6 ? 0 : Math.max(1, Math.round(sz * k));
    });
    for (let st = 0; st < S; st++) tasks.push({ ei, st, S, dims });
  });
  const MAXW = Math.min(2048, 1024 * 1);
  const items = tasks.map((t) => {
    const [dx, dy, dz] = t.dims;
    t.w = 2 * dz + 2 * dx;
    t.h = dz + dy;
    return t;
  }).filter((t) => t.w > 0 && t.h > 0).sort((a, b) => b.h - a.h || b.w - a.w);
  let x = 0, y = 0, rowH = 0, usedW = 0;
  const al = (v) => Math.ceil(v / k) * k;
  for (const t of items) {
    if (x + t.w > MAXW && x > 0) {
      y += rowH;
      x = 0;
      rowH = 0;
    }
    t.x = x;
    t.y = y;
    x = al(x + t.w);
    rowH = Math.max(rowH, al(t.h));
    usedW = Math.max(usedW, x);
  }
  const H = y + rowH;
  const W = Math.max(k, al(usedW));
  if (W > 2048 || H > 2048 || W / k > 2048 || H / k > 2048) return { ok: false };
  const out = new Uint8ClampedArray(W * Math.max(H, k) * 4);
  const mask = new Uint8ClampedArray(W * Math.max(H, k) * 4);
  let tinted = false;
  const info = /* @__PURE__ */ new Map();
  for (const t of items) {
    const e = ir.elements[t.ei];
    const [dx, dy, dz] = t.dims;
    const cols = { l: 0, m: dz, n: dz + dx, o: dz + 2 * dx, p: 2 * dz + dx }, rows = { r: 0, s: dz };
    let translucent = false, any = false;
    for (const [jf, ck, rk, ua, us, va, vs] of BOX) {
      const dim = [dx, dy, dz];
      const fw = dim[ua], fh = dim[va];
      if (!fw || !fh) continue;
      let face = e.faces[jf], flipped = false;
      let source = face;
      if (!source) {
        const twin = { north: "south", south: "north", east: "west", west: "east", up: "down", down: "up" }[jf];
        const sz = [dx, dy, dz][{ north: 2, south: 2, east: 0, west: 0, up: 1, down: 1 }[jf]];
        if (sz === 0 && e.faces[twin]) {
          source = e.faces[twin];
          face = twin;
          flipped = true;
        }
      }
      if (!source) continue;
      const jface = flipped ? face : jf;
      const tex = ir.textures[source.tex];
      const frame = tex.seq[Math.min(tex.seq.length - 1, Math.floor(t.st * tex.seq.length / t.S))] || 0;
      const ox = t.x + cols[ck], oy = t.y + rows[rk];
      for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) {
        const a = (i + 0.5) / fw, b = (j + 0.5) / fh;
        const frac = [0.5, 0.5, 0.5];
        frac[ua] = us > 0 ? a : 1 - a;
        frac[va] = vs > 0 ? b : 1 - b;
        const side = AXIS_FACE[jf];
        const axis = "xyz".indexOf(side[0]);
        frac[axis] = side[1] === "1" ? 1 : 0;
        const [s, tt] = faceST(jface, frac[0], frac[1], frac[2]);
        const px = sampleFace(tex, source, s, tt, frame);
        const o = ((oy + j) * W + ox + i) * 4;
        out[o] = px[0];
        out[o + 1] = px[1];
        out[o + 2] = px[2];
        out[o + 3] = px[3];
        if (source.tint && px[3] > 0) {
          mask[o] = mask[o + 1] = mask[o + 2] = 255;
          mask[o + 3] = 255;
          tinted = true;
        }
        if (px[3] > 0) any = true;
        if (px[3] > 0 && px[3] < 255) translucent = true;
      }
    }
    info.set(`${t.ei}:${t.st}`, { x: t.x, y: t.y, translucent, empty: !any });
  }
  return { ok: true, W, H: Math.max(H, k), pixels: out, mask: tinted ? mask : null, info, tasks, sigma, built, ir };
}
async function finish(res, entry, slot, variants, k) {
  const { ir, built, sigma, info } = res;
  const parts = [];
  let cubes = 0;
  const stateCount = (ei) => res.tasks.filter((t) => t.ei === ei).length;
  built.forEach((bv, vi) => {
    const variant = variants[vi];
    const merged = /* @__PURE__ */ new Map();
    bv.placed.forEach(({ e, A }, ei) => {
      const S = stateCount(ei);
      const rotated = !near(A.R, bv.P.Q);
      const dims = res.tasks.find((t) => t.ei === ei).dims;
      const anims = [];
      let pivotShift = [0, 0, 0];
      for (const a of e.anim) {
        const world = mv(bv.P.Q, [a.axis === 0 ? 1 : 0, a.axis === 1 ? 1 : 0, a.axis === 2 ? 1 : 0]);
        const nax = [0, 1, 2].sort((p, q) => Math.abs(world[q]) - Math.abs(world[p]))[0];
        const sgn = world[nax] < 0 ? -1 : 1;
        const half = (a.hi - a.lo) / 2, mean = (a.hi + a.lo) / 2;
        const phase = ((a.startsLow ? 0.75 : 0.25) + (sgn < 0 ? 0.5 : 0)) % 1;
        if (a.channel === "position") {
          const dir = [a.axis === 0 ? mean : 0, a.axis === 1 ? mean : 0, a.axis === 2 ? mean : 0];
          pivotShift = add(pivotShift, mv(bv.P.Q, dir.map((v) => v * sigma)));
          anims.push({ type: "bob", axis: "xyz"[nax], speed: r4(a.cycles), amplitude: r4(half * sigma), phase });
        } else anims.push({ type: "swing", axis: "xyz"[nax], speed: r4(a.cycles), amplitude: r4(half), phase });
      }
      for (let st = 0; st < S; st++) {
        const isl = info.get(`${ei}:${st}`);
        if (!isl || isl.empty) continue;
        const layer = isl.translucent ? "translucent" : "cutout";
        const blink = S > 1 ? [{ type: "blink", axis: "y", speed: r4(20 / (Math.max(1, ir.textures[Object.values(e.faces)[0].tex].frametime) * S)), amplitude: r4(1 / S), phase: st === 0 ? 0 : r4((S - st) / S) }] : [];
        const key = rotated ? `r${ei}:${st}` : `m|${layer}|${st}|${JSON.stringify(anims)}`;
        let part = merged.get(key);
        if (!part) {
          const o2 = rotated ? e.origin : [8, 8, 8];
          const pivot = add(add(add(mv(A.R, [0, 0, 0]), A.t), mv(A.R, o2.map((v) => v * sigma))), add(bv.shift, pivotShift));
          part = {
            id: `${entry.id}-${variant || "x"}-${merged.size}`,
            attach: bv.P.attach,
            pivot: pivot.map(r4),
            rotation: euler(A.R).map(r4),
            // only hand items replace the held item
            ...variant ? { side: variant } : {},
            ...variant && slot === "hand" ? { armor: { slot: variant + "hand", mode: "hide" } } : {},
            ...layer === "translucent" ? { layer } : {},
            anim: [...blink, ...anims],
            cubes: [],
            _o: o2
          };
          merged.set(key, part);
        }
        const o = part._o;
        const sizes = dims.map((d) => d / k);
        const origin = [0, 1, 2].map((a) => (e.from[a] - o[a]) * sigma + ((e.to[a] - e.from[a]) * sigma - sizes[a]) / 2);
        part.cubes.push({ origin: origin.map(r4), size: sizes.map(r4), uv: [isl.x / k, isl.y / k] });
        cubes++;
      }
    });
    for (const p of merged.values()) {
      delete p._o;
      if (p.cubes.length) parts.push(p);
    }
  });
  if (!parts.length) throw new Error("Nothing visible to import");
  if (slot === "balloon") {
    for (const p of parts) if (!p.anim.some((a) => a.type === "bob")) p.anim.push({ type: "bob", axis: "y", speed: 0.35, amplitude: 1.2, phase: 0 });
  }
  if (parts.length > 512 || cubes > 2048) throw new Error(`Too complex (${parts.length} parts, ${cubes} cubes; limit 512 / 2048)`);
  const W = res.W, H = res.H;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d");
  g.putImageData(new ImageData(res.pixels, W, H), 0, 0);
  const png = await new Promise((r) => canvas.toBlob(r, "image/png"));
  const bytes = new Uint8Array(await png.arrayBuffer());
  let maskBytes = null;
  if (res.mask) {
    g.clearRect(0, 0, W, H);
    g.putImageData(new ImageData(res.mask, W, H), 0, 0);
    const m = await new Promise((r) => canvas.toBlob(r, "image/png"));
    maskBytes = new Uint8Array(await m.arrayBuffer());
  }
  if (!ir.elements.length) throw new Error("empty");
  const model = { format: 1, texture: [W / k, H / k], parts };
  return { model, png: bytes, mask: maskBytes, color: entry.color || null, info: { parts: parts.length, cubes, density: k, size: [W, H], slot, sides: variants.filter(Boolean) } };
}
async function bakeDye(png, mask, hex) {
  const load = async (bytes) => createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const base = await load(png);
  const W = base.width, H = base.height;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  g.drawImage(base, 0, 0);
  const img = g.getImageData(0, 0, W, H);
  let m = null;
  if (mask) {
    const mb = await load(mask);
    g.clearRect(0, 0, W, H);
    g.imageSmoothingEnabled = false;
    g.drawImage(mb, 0, 0, W, H);
    m = g.getImageData(0, 0, W, H).data;
  }
  const c = [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16));
  const d = img.data;
  for (let o = 0; o < d.length; o += 4) {
    if (!d[o + 3]) continue;
    const k = m ? m[o + 3] / 255 : 1;
    if (!k) continue;
    const r = d[o], gg = d[o + 1], b = d[o + 2];
    const lum = Math.min(255, Math.max(r, gg, b) * 0.35 + (0.299 * r + 0.587 * gg + 0.114 * b) * 0.65) / 255;
    d[o] = Math.round(r + (c[0] * lum - r) * k);
    d[o + 1] = Math.round(gg + (c[1] * lum - gg) * k);
    d[o + 2] = Math.round(b + (c[2] * lum - b) * k);
  }
  g.clearRect(0, 0, W, H);
  g.putImageData(img, 0, 0);
  const out = await new Promise((r) => canvas.toBlob(r, "image/png"));
  return new Uint8Array(await out.arrayBuffer());
}
export {
  bakeDye,
  convert,
  discover,
  readZip
};
