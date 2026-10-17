// ItemsAdder / Nexo / Oraxen / ModelEngine / HMCCosmetics / MagicCosmetics / Blockbench / ResourcePack / NCM -> NCM v1 (JSON + atlas PNG)
import { unzipSync, unzlibSync, zlibSync } from "fflate";
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
const r4 = (n) => {
  const v = Math.round(n * 1e4) / 1e4;
  return Math.abs(v) < 1e-6 ? 0 : v;
};

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

// Pure-JS PNG decoder/encoder so pack imports work identically in browser and Node tests.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function u32be(b, o) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function writeU32be(b, o, v) {
  b[o] = (v >>> 24) & 255;
  b[o + 1] = (v >>> 16) & 255;
  b[o + 2] = (v >>> 8) & 255;
  b[o + 3] = v & 255;
}

function pngChunk(kind, data) {
  const out = new Uint8Array(12 + data.length);
  writeU32be(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = kind.charCodeAt(i);
  out.set(data, 8);
  writeU32be(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function encodePngBytes(pixels, width, height) {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  writeU32be(ihdr, 0, width);
  writeU32be(ihdr, 4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const c1 = pngChunk("IHDR", ihdr);
  const c2 = pngChunk("IDAT", zlibSync(raw, { level: 6 }));
  const c3 = pngChunk("IEND", new Uint8Array(0));
  const out = new Uint8Array(sig.length + c1.length + c2.length + c3.length);
  let off = 0;
  for (const part of [sig, c1, c2, c3]) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

function decodePngBytes(u8) {
  const b = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
  if (b.length < 33 || u32be(b, 0) !== 0x89504e47) return null;
  let off = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  let idatLen = 0;
  while (off + 8 <= b.length) {
    const len = u32be(b, off);
    const kind = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
    const data = b.subarray(off + 8, off + 8 + len);
    if (kind === "IHDR") {
      width = u32be(data, 0);
      height = u32be(data, 4);
      depth = data[8];
      type = data[9];
      interlace = data[12];
    } else if (kind === "PLTE") palette = data;
    else if (kind === "tRNS") trns = data;
    else if (kind === "IDAT") {
      idat.push(data);
      idatLen += data.length;
    } else if (kind === "IEND") break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || width < 1 || height < 1 || width > 4096 || height > 4096) return null;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels || (type === 3 && !palette)) return null;
  const comp = new Uint8Array(idatLen);
  let pOff = 0;
  for (const d of idat) {
    comp.set(d, pOff);
    pOff += d.length;
  }
  let raw;
  try {
    raw = unzlibSync(comp);
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[row + x - channels] : 0;
      const up = y > 0 ? px[row - stride + x] : 0;
      const c = x >= channels && y > 0 ? px[row - stride + x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (a + up) >> 1;
      else if (filter === 4) {
        const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      px[row + x] = v & 255;
    }
  }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    const o = i * 4;
    if (type === 6) {
      out[o] = px[o];
      out[o + 1] = px[o + 1];
      out[o + 2] = px[o + 2];
      out[o + 3] = px[o + 3];
    } else if (type === 2) {
      out[o] = px[i * 3];
      out[o + 1] = px[i * 3 + 1];
      out[o + 2] = px[i * 3 + 2];
      out[o + 3] = 255;
    } else if (type === 0) {
      out[o] = out[o + 1] = out[o + 2] = px[i];
      out[o + 3] = 255;
    } else if (type === 4) {
      out[o] = out[o + 1] = out[o + 2] = px[i * 2];
      out[o + 3] = px[i * 2 + 1];
    } else {
      const k = px[i];
      out[o] = palette[k * 3] || 0;
      out[o + 1] = palette[k * 3 + 1] || 0;
      out[o + 2] = palette[k * 3 + 2] || 0;
      out[o + 3] = trns && k < trns.length ? trns[k] : 255;
    }
  }
  return { width, height, data: out };
}

async function readZip(buffer) {
  const raw = unzipSync(new Uint8Array(buffer));
  const files = {};
  for (const [name, data] of Object.entries(raw)) {
    const clean = name.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!clean || clean.endsWith("/") || clean.includes("__MACOSX/") || clean.split("/").pop().startsWith("._")) continue;
    files[clean] = data;
  }
  return files;
}

const text = (u8) => new TextDecoder().decode(u8);

function index(files) {
  const map = new Map();
  for (const k of Object.keys(files)) map.set(k.toLowerCase(), k);
  return map;
}

function findSuffix(files, idx, suffix) {
  const s = suffix.toLowerCase().replace(/^\/+/, "");
  if (idx.has(s)) return idx.get(s);
  for (const [low, key] of idx) if (low.endsWith("/" + s)) return key;
  return null;
}

function detectNamespaces(files) {
  const set = new Set();
  for (const k of Object.keys(files)) {
    const m = k.match(/(?:^|\/)assets\/([^/]+)\//i);
    if (m && m[1]) set.add(m[1].toLowerCase());
  }
  set.delete("minecraft");
  return [...set, "minecraft"];
}

const HMC_SLOTS = {
  HELMET: "hats",
  HAT: "hats",
  HEAD: "hats",
  GLASSES: "glasses",
  EYES: "glasses",
  FACE: "glasses",
  MASK: "glasses",
  BACKPACK: "back",
  BACK: "back",
  WINGS: "back",
  BAG: "back",
  CAPE: "back",
  CLOAK: "back",
  BALLOON: "back",
  CHESTPLATE: "back",
  CHEST: "back",
  BOOTS: "shoes",
  SHOES: "shoes",
  FEET: "shoes",
  OFFHAND: "hand",
  MAINHAND: "hand",
  HAND: "hand",
  WEAPON: "hand"
};
const HMC_ALL = [...Object.keys(HMC_SLOTS), "LEGGINGS"];

function guessSlotFromHint(...hints) {
  const joined = hints.filter(Boolean).join(" ").toLowerCase();
  if (/\b(glasses|goggles|sunglasses|shades|visor|monocle|eyepatch|blindfold|eyes)\b|[_/-](glasses|goggles|shades|visor|monocle)\b/.test(joined)) return "glasses";
  if (/\b(boots?|shoes?|sneakers?|sandals?|slippers?|greaves|heels|footwear|feet)\b|[_/-](boots?|shoes?|sneakers?|feet)\b/.test(joined)) return "shoes";
  if (/\b(wings?|backpack|jetpack|bag|satchel|quiver|cape|cloak|tail|back|balloon|scabbard|shell)\b|[_/-](wings?|backpack|bag|tail|back|balloon)\b/.test(joined)) return "back";
  if (/\b(sword|blade|dagger|katana|scythe|staff|wand|scepter|bow|crossbow|gun|rifle|pistol|shield|hammer|axe|mace|spear|halberd|trident|lantern|torch|umbrella|parasol|fan|guitar| plush|hand|offhand|mainhand|weapon|tool)\b|[_/-](sword|staff|wand|shield|axe|hammer|spear|lantern|umbrella|hand|weapon)\b/.test(joined)) return "hand";
  if (/\b(hat|helmet|crown|tiara|horns?|ears?|halo|antlers?|hood|cap|beanie|beret|bandana|headband|ribbon|hairpin|mask|head|hair|wig|wreath|sombrero|fedora|wizard)\b|[_/-](hat|helmet|crown|horn|ear|halo|hood|cap|mask|head)\b/.test(joined)) return "hats";
  return null;
}

function guessSlotFromDisplay(display) {
  if (!display || typeof display !== "object") return null;
  const hasHead = Boolean(display.head && Object.keys(display.head).length);
  const hasHand = Boolean((display.thirdperson_righthand && Object.keys(display.thirdperson_righthand).length) || (display.thirdperson_lefthand && Object.keys(display.thirdperson_lefthand).length));
  if (hasHead && !hasHand) return "hats";
  if (hasHand && !hasHead) return "hand";
  return null;
}

function colorOf(v) {
  if (v == null) return null;
  let rgb = null;
  if (typeof v === "number") rgb = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
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

const stripFormatting = (s) => String(s || "").replace(/&[0-9a-fk-orx]|§[0-9a-fk-orx]|<[^>]+>/gi, "").trim();
const title = (id) => stripFormatting(id).replace(/^.*[:/]/, "").replace(/\.(bbmodel|json|png)$/i, "").replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();

function cleanModelRef(raw, defaultNs = null) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim().replace(/\\/g, "/").replace(/\.json$/i, "");
  const assetMatch = s.match(/^(?:.*\/)?assets\/([^/]+)\/models\/(.+)$/i);
  if (assetMatch) return `${assetMatch[1].toLowerCase()}:${assetMatch[2]}`;
  s = s.replace(/^models\//i, "");
  if (defaultNs && !s.includes(":")) return `${defaultNs}:${s}`;
  return s;
}

function scanCustomModelData(files) {
  const byMaterialCmd = new Map();
  const byCmdOnly = new Map();
  const byItemModel = new Map();
  for (const k of Object.keys(files)) {
    if (!/\.json$/i.test(k)) continue;
    const itemModelMatch = k.match(/(?:^|\/)assets\/([^/]+)\/models\/item\/([^/]+)\.json$/i) || k.match(/(?:^|\/)models\/item\/([^/]+)\.json$/i);
    const itemsDefMatch = k.match(/(?:^|\/)assets\/([^/]+)\/items\/([^/]+)\.json$/i);
    if (!itemModelMatch && !itemsDefMatch) continue;
    let json;
    try {
      json = JSON.parse(text(files[k]).replace(/^\uFEFF/, ""));
    } catch {
      continue;
    }
    if (itemModelMatch && Array.isArray(json?.overrides)) {
      const ns = itemModelMatch[2] ? itemModelMatch[1].toLowerCase() : "minecraft";
      const mat = (itemModelMatch[2] || itemModelMatch[1]).toLowerCase();
      for (const ov of json.overrides) {
        const cmd = ov?.predicate?.custom_model_data;
        const m = ov?.model;
        if (cmd !== undefined && m) {
          const ref = cleanModelRef(String(m), ns !== "minecraft" ? ns : null);
          byMaterialCmd.set(`${mat}:${cmd}`, ref);
          if (!byCmdOnly.has(String(cmd))) byCmdOnly.set(String(cmd), ref);
        }
      }
    }
    if (itemsDefMatch && json?.model) {
      const ns = itemsDefMatch[1].toLowerCase();
      const itemName = itemsDefMatch[2].toLowerCase();
      const mObj = json.model;
      if (typeof mObj.model === "string") {
        const ref = cleanModelRef(mObj.model, ns);
        byItemModel.set(`${ns}:${itemName}`, ref);
        byItemModel.set(itemName, ref);
      }
      if (Array.isArray(mObj.entries)) {
        for (const entry of mObj.entries) {
          const threshold = entry?.threshold;
          const subModel = entry?.model?.model;
          if (threshold !== undefined && typeof subModel === "string") {
            const ref = cleanModelRef(subModel, ns);
            byMaterialCmd.set(`${itemName}:${threshold}`, ref);
            if (!byCmdOnly.has(String(threshold))) byCmdOnly.set(String(threshold), ref);
          }
        }
      }
    }
  }
  return { byMaterialCmd, byCmdOnly, byItemModel };
}

function discover(files) {
  const idx = index(files);
  const namespaces = detectNamespaces(files);
  const { byMaterialCmd, byCmdOnly, byItemModel } = scanCustomModelData(files);
  const notes = [];
  const docs = [];
  for (const k of Object.keys(files)) {
    if (!/\.ya?ml$/i.test(k)) continue;
    try {
      const d = yamlLoad(text(files[k]));
      if (d && typeof d === "object") docs.push({ path: k, doc: d });
    } catch {
      // ignore malformed yaml
    }
  }

  const items = new Map();
  const put = (id, model, ns, color = null, slotHint = null, displayName = null) => {
    if (!id || !model) return;
    const clean = cleanModelRef(String(model), ns);
    if (!clean) return;
    items.set(String(id).toLowerCase(), {
      id: String(id),
      model: clean,
      ns,
      color,
      slotHint,
      name: displayName ? stripFormatting(displayName) : null
    });
  };

  for (const { path: docPath, doc } of docs) {
    const ns = doc.info?.namespace ? String(doc.info.namespace).toLowerCase() : null;
    const iaSections = [doc.items, doc.equipments].filter((s) => s && typeof s === "object");
    for (const sec of iaSections) {
      for (const [id, v] of Object.entries(sec)) {
        if (!v || typeof v !== "object") continue;
        const m = v?.resource?.model_path || v?.resource?.model || v?.model_path || v?.model;
        const c = colorOf(v?.graphics?.color ?? v?.resource?.color ?? v?.color);
        const dispName = v?.display_name || v?.name || null;
        const iaSlot = (v?.behaviours?.hat || v?.specific_properties?.hat) ? "hats" : guessSlotFromHint(docPath, id, m, v?.type, v?.slot);
        if (m) {
          const targetNs = ns || namespaces[0] || "minecraft";
          put(id, m, targetNs, c, iaSlot, dispName);
          put(`${targetNs}:${id}`, m, targetNs, c, iaSlot, dispName);
        }
      }
    }
    for (const [id, v] of Object.entries(doc)) {
      if (!v || typeof v !== "object" || id === "info" || id === "items" || id === "equipments" || id === "categories") continue;
      const pack2 = v.Pack || v.pack;
      if (pack2 && typeof pack2 === "object") {
        let m = pack2.model || pack2.parent_model || v.item_model || pack2.item_model;
        if (!m && (pack2.custom_model_data || pack2.model_data)) {
          const cmd = pack2.custom_model_data ?? pack2.model_data;
          const mat = String(v.material || v.type || "").toLowerCase();
          m = byMaterialCmd.get(`${mat}:${cmd}`) || byCmdOnly.get(String(cmd));
        }
        if (!m && pack2.generate_model === false) m = id;
        const mech = v.Mechanics || v.mechanics || {};
        const oxSlot = mech.hat ? "hats" : mech.backpack ? "back" : guessSlotFromHint(docPath, id, m, mech?.cosmetic?.slot);
        const dispName = v.displayname || v.itemname || v.name || null;
        if (m) put(id, m, namespaces[0] !== "minecraft" ? namespaces[0] : null, colorOf(v.color ?? pack2?.color), oxSlot, dispName);
      }
    }
  }

  for (const [key, ref] of byItemModel) {
    if (!items.has(key)) {
      put(key, ref, null, null, guessSlotFromHint(key, ref), null);
    }
  }

  const bbs = new Map();
  for (const k of Object.keys(files)) {
    if (/\.bbmodel$/i.test(k)) {
      bbs.set(k.split("/").pop().replace(/\.bbmodel$/i, "").toLowerCase(), k);
    }
  }

  const entries = [];
  const seen = new Set();
  const seenModelKeys = new Set();

  const collectCosmeticConfigs = (obj, out = []) => {
    if (!obj || typeof obj !== "object") return out;
    for (const [k, v] of Object.entries(obj)) {
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      if (typeof v.slot === "string" || typeof v.type === "string" && HMC_ALL.includes(v.type.toUpperCase())) {
        out.push([k, v]);
      } else if (["cosmetics", "hats", "backpacks", "wardrobe", "items"].includes(k.toLowerCase())) {
        for (const [subId, subVal] of Object.entries(v)) {
          if (subVal && typeof subVal === "object" && !Array.isArray(subVal)) {
            const inferredSlot = k.toLowerCase() === "hats" ? "HAT" : k.toLowerCase() === "backpacks" ? "BACKPACK" : subVal.slot || subVal.type;
            if (typeof inferredSlot === "string") out.push([subId, { ...subVal, slot: inferredSlot }]);
          }
        }
      }
    }
    return out;
  };

  for (const { path: docPath, doc } of docs) {
    for (const [id, v] of collectCosmeticConfigs(doc)) {
      if (seen.has(id)) continue;
      const rawSlot = String(v.slot || v.type || "").toUpperCase();
      if (!HMC_ALL.includes(rawSlot)) continue;
      const mappedSlot = HMC_SLOTS[rawSlot];
      if (!mappedSlot) {
        notes.push(`${id}: ${rawSlot} cosmetics (leggings) aren't supported`);
        continue;
      }
      const isBalloon = rawSlot === "BALLOON";
      const side = rawSlot === "OFFHAND" ? "left" : rawSlot === "MAINHAND" ? "right" : null;
      const itemBlock = v.item && typeof v.item === "object" ? v.item : v;
      const dispName = itemBlock?.name || itemBlock?.display_name || itemBlock?.["display-name"] || v.name || null;
      const entryName = dispName ? stripFormatting(dispName) : title(id);
      const color = colorOf(itemBlock?.color ?? itemBlock?.dye?.color ?? v.color);
      const modelId = v.model ? String(v.model).toLowerCase().replace(/\.bbmodel$/i, "") : null;
      if (modelId && bbs.has(modelId)) {
        seen.add(id);
        const bbKey = bbs.get(modelId);
        seenModelKeys.add(bbKey.toLowerCase());
        entries.push({ id, name: entryName, slot: mappedSlot, balloon: isBalloon, side, kind: "bb", bb: bbKey, hmc: rawSlot, color });
        continue;
      }
      const mat = String(itemBlock?.material || itemBlock?.type || itemBlock?.item || "");
      const ref = mat.replace(/^(nexo|oraxen|itemsadder|ia|hmccosmetics|cosmeticscore):/i, "").toLowerCase();
      const explicitModel = itemBlock?.model || itemBlock?.["model-id"] || itemBlock?.item_model || v.model;
      const cmd = itemBlock?.["model-data"] ?? itemBlock?.["custom-model-data"] ?? itemBlock?.custom_model_data ?? v["model-data"] ?? v["custom-model-data"];
      let it = items.get(ref) || items.get(ref.split(":").pop()) || (explicitModel ? items.get(String(explicitModel).toLowerCase()) : null);
      if (!it && cmd !== undefined) {
        const cleanMat = ref.split(":").pop().toLowerCase();
        const cmdModel = byMaterialCmd.get(`${cleanMat}:${cmd}`) || byCmdOnly.get(String(cmd));
        if (cmdModel) it = { model: cmdModel, color };
      }
      if (!it && explicitModel && findModel(files, idx, String(explicitModel), namespaces)) {
        it = { model: String(explicitModel), color };
      }
      if (!it && ref && findModel(files, idx, ref, namespaces)) {
        it = { model: ref, color };
      }
      if (it) {
        const resolvedKey = findModel(files, idx, it.model, namespaces);
        if (resolvedKey) seenModelKeys.add(resolvedKey.toLowerCase());
        const refinedSlot = (rawSlot === "HELMET" || rawSlot === "HEAD" || rawSlot === "CHESTPLATE")
          ? (guessSlotFromHint(docPath, id, it.model) || mappedSlot)
          : mappedSlot;
        seen.add(id);
        entries.push({
          id,
          name: entryName || it.name || title(id),
          slot: refinedSlot,
          balloon: isBalloon,
          side,
          kind: "java",
          model: it.model,
          hmc: rawSlot,
          color: color || it.color || null
        });
        continue;
      }
      notes.push(`${id}: no model found (${mat || modelId || "no item"})`);
    }
  }

  // Also include ItemsAdder / Oraxen / Nexo / 1.21.4+ items whose models exist in the zip and weren't already added above.
  for (const [id, it] of items) {
    if (id.includes(":")) continue;
    const modelKey = findModel(files, idx, it.model, namespaces);
    if (!modelKey || seenModelKeys.has(modelKey.toLowerCase()) || seen.has(id)) continue;
    let parsedDisplay = null;
    try {
      const m = loadJavaModel(files, idx, it.model, 0, namespaces);
      if (!m.elements || !m.elements.length) continue;
      parsedDisplay = m.display;
    } catch {
      continue;
    }
    seen.add(id);
    seenModelKeys.add(modelKey.toLowerCase());
    const slot = it.slotHint || guessSlotFromHint(id, it.model, modelKey) || guessSlotFromDisplay(parsedDisplay) || "hats";
    entries.push({
      id,
      name: it.name || title(id),
      slot,
      side: slot === "hand" ? "right" : null,
      kind: "java",
      model: it.model,
      color: it.color || null
    });
  }

  // Include any unreferenced .bbmodel files in the zip.
  for (const [id, k] of bbs) {
    if (seenModelKeys.has(k.toLowerCase()) || seen.has(id)) continue;
    seen.add(id);
    seenModelKeys.add(k.toLowerCase());
    const slot = guessSlotFromHint(k, id) || "hats";
    entries.push({ id, name: title(id), slot, side: slot === "hand" ? "right" : null, kind: "bb", bb: k });
  }

  // Include any NCM v1 JSON models or standalone 3D Java JSON models in the zip that weren't referenced by YAML configs.
  const parentKeys = new Set();
  const candidateJsonModels = [];
  for (const k of Object.keys(files)) {
    if (!/\.json$/i.test(k) || /\.mcmeta$/i.test(k)) continue;
    if (/(?:^|\/)(pack|sounds|font|lang|blockstates|atlases)\b/i.test(k)) continue;
    let json;
    try {
      json = JSON.parse(text(files[k]).replace(/^\uFEFF/, ""));
    } catch {
      continue;
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) continue;
    if (json.parent) {
      const pk = findModel(files, idx, String(json.parent), namespaces);
      if (pk) parentKeys.add(pk.toLowerCase());
    }
    if (Array.isArray(json.parts) && json.parts.length > 0 && (json.format === 1 || json.format === undefined)) {
      candidateJsonModels.push({ key: k, json, kind: "ncm" });
    } else if (Array.isArray(json.elements) && json.elements.length > 0) {
      candidateJsonModels.push({ key: k, json, kind: "java" });
    }
  }

  for (const cand of candidateJsonModels) {
    const lowKey = cand.key.toLowerCase();
    if (seenModelKeys.has(lowKey) || parentKeys.has(lowKey)) continue;
    const baseId = cand.key.split("/").pop().replace(/\.json$/i, "");
    const id = seen.has(baseId) ? cand.key.replace(/\.json$/i, "").replace(/[^a-z0-9_-]+/gi, "-") : baseId;
    if (cand.kind === "ncm") {
      const attach = String(cand.json.parts[0]?.attach || "").toLowerCase();
      const slotFromAttach = attach.includes("leg") || attach.includes("foot") ? "shoes"
        : attach.includes("arm") ? "hand"
        : attach === "body" || attach === "back" || attach === "torso" ? "back"
        : guessSlotFromHint(cand.key, baseId) || "hats";
      seen.add(id);
      seenModelKeys.add(lowKey);
      entries.push({ id, name: title(baseId), slot: slotFromAttach, side: slotFromAttach === "hand" ? "right" : null, kind: "ncm", ncmKey: cand.key });
    } else {
      let loaded;
      try {
        loaded = loadJavaModel(files, idx, cand.key, 0, namespaces);
      } catch {
        continue;
      }
      if (!loaded.elements || !loaded.elements.length) continue;
      const slot = guessSlotFromHint(cand.key, baseId) || guessSlotFromDisplay(loaded.display) || "hats";
      seen.add(id);
      seenModelKeys.add(lowKey);
      entries.push({ id, name: title(baseId), slot, side: slot === "hand" ? "right" : null, kind: "java", model: cand.key });
    }
  }

  return { entries, notes };
}

const BUILTIN = {
  "block/block": { display: { thirdperson_righthand: { rotation: [75, 45, 0], translation: [0, 2.5, 0], scale: [0.375, 0.375, 0.375] }, thirdperson_lefthand: { rotation: [75, 45, 0], translation: [0, 2.5, 0], scale: [0.375, 0.375, 0.375] } } },
  "item/handheld": { display: { thirdperson_righthand: { rotation: [0, -90, 55], translation: [0, 4, 0.5], scale: [0.85, 0.85, 0.85] }, thirdperson_lefthand: { rotation: [0, 90, -55], translation: [0, 4, 0.5], scale: [0.85, 0.85, 0.85] } } },
  "item/generated": { display: { thirdperson_righthand: { rotation: [0, 0, 0], translation: [0, 3, 1], scale: [0.55, 0.55, 0.55] }, thirdperson_lefthand: { rotation: [0, 0, 0], translation: [0, 3, 1], scale: [0.55, 0.55, 0.55] }, head: { rotation: [0, 180, 0], translation: [0, 13, 7], scale: [1, 1, 1] } } }
};

const splitRef = (ref) => {
  const s = String(ref || "").trim().replace(/^#/, "").replace(/\\/g, "/");
  const i = s.indexOf(":");
  return i < 0 ? [null, s] : [s.slice(0, i).toLowerCase(), s.slice(i + 1)];
};

function findModel(files, idx, ref, namespaces = ["minecraft"]) {
  if (!ref) return null;
  const raw = String(ref).trim().replace(/\\/g, "/");
  if (idx.has(raw.toLowerCase())) return idx.get(raw.toLowerCase());
  if (idx.has((raw + ".json").toLowerCase())) return idx.get((raw + ".json").toLowerCase());
  const [explicitNs, rawPath] = splitRef(raw);
  const p = rawPath.replace(/\.json$/i, "").replace(/^\/+/, "").replace(/^models\//i, "");
  const nsList = explicitNs ? [explicitNs, ...namespaces.filter((n) => n !== explicitNs)] : [...namespaces, "minecraft"];
  for (const ns of nsList) {
    const hit = findSuffix(files, idx, `assets/${ns}/models/${p}.json`)
      || findSuffix(files, idx, `assets/${ns}/models/item/${p}.json`)
      || findSuffix(files, idx, `assets/${ns}/models/block/${p}.json`);
    if (hit) return hit;
  }
  const direct = findSuffix(files, idx, `models/${p}.json`)
    || findSuffix(files, idx, `models/item/${p}.json`)
    || findSuffix(files, idx, `models/block/${p}.json`)
    || findSuffix(files, idx, `${p}.json`);
  if (direct) return direct;
  const base = p.split("/").pop().toLowerCase() + ".json";
  const matches = [];
  for (const [low, key] of idx) {
    if (low === base || low.endsWith("/" + base)) matches.push(key);
  }
  if (matches.length === 1) return matches[0];
  return null;
}

function loadJavaModel(files, idx, ref, depth = 0, namespaces = ["minecraft"]) {
  const key = findModel(files, idx, ref, namespaces);
  const [, rawP] = splitRef(ref);
  const p = rawP.replace(/\.json$/i, "").replace(/^minecraft:/, "");
  if (!key) return { elements: null, textures: {}, display: {}, builtin: BUILTIN[p] || null, modelKey: null };
  const json = JSON.parse(text(files[key]).replace(/^\uFEFF/, ""));
  let parent = { elements: null, textures: {}, display: {} };
  if (json.parent && depth < 8) {
    const loaded = loadJavaModel(files, idx, json.parent, depth + 1, namespaces);
    parent = loaded.builtin ? { elements: null, textures: {}, display: loaded.builtin.display || {} } : loaded;
  }
  return {
    elements: json.elements || parent.elements,
    textures: { ...parent.textures, ...(json.textures || {}) },
    display: { ...parent.display, ...(json.display || {}) },
    textureSize: json.texture_size || parent.textureSize,
    modelKey: key
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
  if (typeof r === "string" && !r.startsWith("#")) return r;
  const vals = Object.entries(textures || {}).filter(([k, v]) => k !== "particle" && typeof v === "string" && !v.startsWith("#")).map(([, v]) => v);
  if (vals.length === 1) return vals[0];
  return null;
};

async function decode(u8, mime = "image/png") {
  const pure = decodePngBytes(u8);
  if (pure) return pure;
  if (typeof createImageBitmap === "function" && typeof document !== "undefined") {
    const bmp = await createImageBitmap(new Blob([u8], { type: mime }));
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    return g.getImageData(0, 0, c.width, c.height);
  }
  throw new Error("Could not decode PNG image");
}

const dataUrlBytes = (url) => {
  const b = atob(url.slice(url.indexOf(",") + 1));
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
};

function findTextureFile(files, idx, ref, namespaces = ["minecraft"], modelKey = null) {
  if (!ref) return null;
  const raw = String(ref).trim().replace(/\\/g, "/");
  if (idx.has(raw.toLowerCase())) return idx.get(raw.toLowerCase());
  if (idx.has((raw + ".png").toLowerCase())) return idx.get((raw + ".png").toLowerCase());
  const [explicitNs, rawPath] = splitRef(raw);
  const p = rawPath.replace(/\.png$/i, "").replace(/^\/+/, "").replace(/^textures\//i, "");
  const modelNsMatch = modelKey ? modelKey.match(/(?:^|\/)assets\/([^/]+)\//i) : null;
  const modelNs = modelNsMatch ? modelNsMatch[1].toLowerCase() : null;
  const nsList = [...new Set([explicitNs, modelNs, ...namespaces, "minecraft"].filter(Boolean))];
  for (const ns of nsList) {
    const hit = findSuffix(files, idx, `assets/${ns}/textures/${p}.png`)
      || findSuffix(files, idx, `assets/${ns}/textures/item/${p}.png`)
      || findSuffix(files, idx, `assets/${ns}/textures/block/${p}.png`)
      || findSuffix(files, idx, `assets/${ns}/textures/entity/${p}.png`)
      || findSuffix(files, idx, `assets/${ns}/${p}.png`);
    if (hit) return hit;
  }
  const direct = findSuffix(files, idx, `textures/${p}.png`)
    || findSuffix(files, idx, `textures/item/${p}.png`)
    || findSuffix(files, idx, `textures/block/${p}.png`)
    || findSuffix(files, idx, `${p}.png`);
  if (direct) return direct;
  if (modelKey && modelKey.includes("/")) {
    const dir = modelKey.slice(0, modelKey.lastIndexOf("/"));
    const base = p.split("/").pop();
    const rel = findSuffix(files, idx, `${dir}/${base}.png`) || findSuffix(files, idx, `${dir}/${p}.png`);
    if (rel) return rel;
  }
  const basePng = p.split("/").pop().toLowerCase() + ".png";
  const byBase = [];
  for (const [low, key] of idx) {
    if (low === basePng || low.endsWith("/" + basePng)) byBase.push(key);
  }
  if (byBase.length === 1) return byBase[0];
  if (byBase.length > 1 && modelNs) {
    const nsHit = byBase.find((k) => k.toLowerCase().includes(`assets/${modelNs}/`));
    if (nsHit) return nsHit;
    return byBase[0];
  }
  const allPngs = Object.keys(files).filter((k) => /\.png$/i.test(k) && !/pack\.png$/i.test(k));
  if (allPngs.length === 1) return allPngs[0];
  return null;
}

async function loadJavaTextures(files, idx, textures, used, namespaces = ["minecraft"], modelKey = null) {
  const out = {};
  for (const ref of used) {
    const key = findTextureFile(files, idx, ref, namespaces, modelKey);
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
        // ignore invalid mcmeta
      }
    }
    out[ref] = tex;
  }
  return out;
}

async function javaIR(files, idx, entry, namespaces = ["minecraft"]) {
  const m = loadJavaModel(files, idx, entry.model, 0, namespaces);
  if (!m.elements || !m.elements.length) throw new Error("This model has no 3D cubes (flat item sprites are not supported)");
  const used = new Set();
  const elements = m.elements.map((e) => {
    const from = vec3(e.from), to = vec3(e.to);
    const faces = {};
    for (const f of FACES) {
      const face = e.faces?.[f];
      if (!face) continue;
      const tex = resolveTexRef(m.textures, face.texture);
      if (!tex) continue;
      used.add(tex);
      faces[f] = {
        uv: face.uv ? face.uv.map((v) => num(v)) : defaultUv(f, from, to),
        tex,
        rot: ((num(face.rotation) % 360) + 360) % 360,
        ...(Number.isInteger(face.tintindex) && face.tintindex >= 0 ? { tint: true } : {})
      };
    }
    const origin = e.rotation ? vec3(e.rotation.origin, [8, 8, 8]) : [8, 8, 8];
    let R = I3;
    if (e.rotation) {
      const a = num(e.rotation.angle);
      R = e.rotation.axis === "x" ? rX(a) : e.rotation.axis === "z" ? rZ(a) : rY(a);
    }
    return {
      from: from.map((v, i) => Math.min(v, to[i])),
      to: to.map((v, i) => Math.max(v, vec3(e.from)[i])),
      faces,
      xf: about(origin, R),
      rotated: Boolean(e.rotation && num(e.rotation.angle) !== 0),
      origin,
      anim: []
    };
  }).filter((e) => Object.keys(e.faces).length);
  const textures = await loadJavaTextures(files, idx, m.textures, used, namespaces, m.modelKey);
  return { elements, textures, display: m.display, mode: "java" };
}

async function bbIR(files, idx, entry, namespaces = ["minecraft"]) {
  const bb = JSON.parse(text(files[entry.bb]).replace(/^\uFEFF/, ""));
  const texList = [];
  for (const t of bb.textures || []) {
    const src = t.source || "";
    let imgBytes = null;
    if (typeof src === "string" && src.startsWith("data:")) {
      imgBytes = dataUrlBytes(src);
    } else {
      const candidate = t.relative_path || t.path || t.name || src;
      const key = findTextureFile(files, idx, candidate, namespaces, entry.bb);
      if (key) imgBytes = files[key];
    }
    if (!imgBytes) {
      texList.push(null);
      continue;
    }
    const img = await decode(imgBytes);
    const uw = num(t.uv_width, num(bb.resolution?.width, img.width));
    const uh = num(t.uv_height, num(bb.resolution?.height, img.height));
    texList.push({ w: img.width, h: img.height, data: img.data, frameH: img.height, seq: [0], frametime: 1, ux: img.width / uw, uy: img.height / uh });
  }
  if (!texList.some(Boolean)) {
    const fallbackKey = findTextureFile(files, idx, entry.bb.replace(/\.bbmodel$/i, ".png"), namespaces, entry.bb);
    if (fallbackKey) {
      const img = await decode(files[fallbackKey]);
      const uw = num(bb.resolution?.width, img.width);
      const uh = num(bb.resolution?.height, img.height);
      texList[0] = { w: img.width, h: img.height, data: img.data, frameH: img.height, seq: [0], frametime: 1, ux: img.width / uw, uy: img.height / uh };
    }
  }
  const textures = {};
  texList.forEach((t, i) => {
    if (t) textures[`bb${i}`] = t;
  });
  const firstTexKey = Object.keys(textures)[0] || null;
  const byUuid = new Map((bb.elements || []).map((e) => [e.uuid, e]));
  const anims = new Map();
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
  const visitedUuids = new Set();
  const pushCube = (e, xf, inherited) => {
    if (!e || e.type === "locator" || e.export === false || e.visibility === false) return;
    if (e.type && e.type !== "cube") return;
    visitedUuids.add(e.uuid);
    const origin = vec3(e.origin);
    const rot = vec3(e.rotation);
    const faces = {};
    for (const f of FACES) {
      const face = e.faces?.[f];
      if (!face || face.texture === null) continue;
      const texKey = face.texture !== undefined && textures[`bb${face.texture}`] ? `bb${face.texture}` : firstTexKey;
      if (!texKey) continue;
      faces[f] = { uv: (face.uv || [0, 0, 0, 0]).map((v) => num(v)), tex: texKey, rot: ((num(face.rotation) % 360) + 360) % 360 };
    }
    if (!Object.keys(faces).length) return;
    const inf = num(e.inflate);
    const from = vec3(e.from).map((v) => v - inf), to = vec3(e.to).map((v) => v + inf);
    elements.push({
      from: from.map((v, i) => Math.min(v, to[i])),
      to: to.map((v, i) => Math.max(v, from[i])),
      faces,
      xf: compose(xf, about(origin, rotZYX(rot[0], rot[1], rot[2]))),
      rotated: !near(rotZYX(rot[0], rot[1], rot[2]), I3) || xf.R.some((v, i) => Math.abs(v - I3[i]) > 1e-4),
      origin,
      anim: inherited
    });
  };
  const walk = (nodes, xf, inherited) => {
    for (const n of nodes || []) {
      if (typeof n === "string") {
        pushCube(byUuid.get(n), xf, inherited);
      } else if (n && typeof n === "object") {
        if (n.type === "cube" || n.from && n.to) {
          pushCube(n, xf, inherited);
        } else {
          const o = vec3(n.origin), r = vec3(n.rotation);
          const g = compose(xf, about(o, rotZYX(r[0], r[1], r[2])));
          walk(n.children, g, inherited.concat(anims.get(n.uuid) || []));
        }
      }
    }
  };
  walk(bb.outliner, { R: I3, t: [0, 0, 0] }, []);
  for (const e of bb.elements || []) {
    if (!visitedUuids.has(e.uuid)) pushCube(e, { R: I3, t: [0, 0, 0] }, []);
  }
  if (!elements.length) throw new Error("This Blockbench model has no textured cubes");
  return { elements, textures, display: bb.display || {}, mode: "bb" };
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

const DEFAULT_ATTACH_FOR_SLOT = {
  hats: "head",
  glasses: "head",
  back: "body",
  shoes: "rightLeg",
  hand: "rightArm"
};

function placement(ir, slot, variant, opts) {
  const user = num(opts.scale, 1);
  const isBalloon = slot === "balloon" || Boolean(opts.balloon && slot === "back");
  if (slot === "hats" || slot === "glasses") {
    const d2 = ir.display?.head || {};
    const s2 = vec3(d2.scale, [1, 1, 1]);
    const Rd2 = rotXYZ(...vec3(d2.rotation));
    const sigma2 = 0.625 * ((s2[0] + s2[1] + s2[2]) / 3) * user;
    const Q2 = mul(FLIP, Rd2);
    const tr = vec3(d2.translation);
    const base2 = add([0, -4, 0], mv(FLIP, tr.map((v) => v * 0.625)));
    const t0 = sub(base2, mv(Q2, [8, 8, 8].map((v) => v * sigma2)));
    return { attach: "head", Q: Q2, sigma: sigma2, t: t0, fit: null };
  }
  if (slot === "hand") {
    const left = variant === "left";
    const d2 = ir.display?.[left ? "thirdperson_lefthand" : "thirdperson_righthand"] || {};
    const s2 = vec3(d2.scale, [1, 1, 1]);
    let rot = vec3(d2.rotation), tr = vec3(d2.translation);
    if (left) {
      tr = [-tr[0], tr[1], tr[2]];
      rot = [rot[0], -rot[1], -rot[2]];
    }
    const Rd2 = rotXYZ(...rot);
    const chain = mul(rX(-90), rY(180));
    const Q2 = mul(chain, Rd2);
    const sigma2 = ((s2[0] + s2[1] + s2[2]) / 3) * user;
    const T = [(left ? -1 : 1) / 16, 0.125, -0.625].map((v) => v * 16);
    const inner = add(T, tr);
    const t0 = add(mv(chain, inner), mv(Q2, [8, 8, 8].map((v) => -v * sigma2)));
    return { attach: left ? "leftArm" : "rightArm", Q: Q2, sigma: sigma2, t: t0, fit: null };
  }
  if (slot === "shoes") {
    const attach = variant === "leftLeg" ? "leftLeg" : "rightLeg";
    const d = ir.display?.head || {};
    const Rd = ir.mode === "java" ? rotXYZ(...vec3(d.rotation)) : I3;
    const s = ir.mode === "java" ? vec3(d.scale, [1, 1, 1]) : [1, 1, 1];
    const base = ir.mode === "java" ? 0.5 : 1;
    const sigma = base * ((s[0] + s[1] + s[2]) / 3) * user;
    const Q = mul(FLIP, Rd);
    return { attach, Q, sigma, t: [0, 0, 0], fit: { x: 0, yMax: 12, zc: 0 } };
  }
  const d = ir.display?.head || {};
  const Rd = ir.mode === "java" ? rotXYZ(...vec3(d.rotation)) : I3;
  const s = ir.mode === "java" ? vec3(d.scale, [1, 1, 1]) : [1, 1, 1];
  const base = isBalloon ? 0.5 : ir.mode === "java" ? 0.3125 : 1;
  const sigma = base * ((s[0] + s[1] + s[2]) / 3) * user;
  const Q = mul(FLIP, Rd);
  const side = variant === "left" ? 1 : -1;
  return {
    attach: "body",
    Q,
    sigma,
    t: [0, 0, 0],
    fit: isBalloon ? { x: side * 11, yMax: -14, zc: 0 } : { x: 0, yc: 5.5, zMin: 2 }
  };
}

function buildVariant(ir, entry, slot, variant, opts) {
  const user = num(opts.scale, 1);
  const P1 = placement(ir, slot, variant, { ...opts, scale: 1 });
  const { Q, sigma: sigma1 } = P1;
  const sigma = sigma1 * user;
  const hasSplitShoes = slot === "shoes"
    && ir.elements.some((e) => e.to[0] <= 8.05)
    && ir.elements.some((e) => e.from[0] >= 7.95)
    && ir.elements.every((e) => e.to[0] <= 8.05 || e.from[0] >= 7.95);
  const lo1 = [1e9, 1e9, 1e9], hi1 = [-1e9, -1e9, -1e9];
  for (const e of ir.elements) {
    const active = !hasSplitShoes || (variant === "leftLeg" ? e.to[0] <= 8.05 : e.from[0] >= 7.95);
    if (!active) continue;
    const R1 = mul(Q, e.xf.R);
    const t1 = add(mv(Q, e.xf.t.map((v) => v * sigma1)), P1.t);
    for (let i = 0; i < 8; i++) {
      const c = [i & 1 ? e.to[0] : e.from[0], i & 2 ? e.to[1] : e.from[1], i & 4 ? e.to[2] : e.from[2]];
      const q = add(mv(R1, c.map((v) => v * sigma1)), t1);
      for (let k = 0; k < 3; k++) {
        lo1[k] = Math.min(lo1[k], q[k]);
        hi1[k] = Math.max(hi1[k], q[k]);
      }
    }
  }
  let shift1 = [0, 0, 0];
  if (P1.fit && lo1[0] <= hi1[0]) {
    const f = P1.fit;
    shift1 = [
      f.x - (lo1[0] + hi1[0]) / 2,
      f.yMax !== void 0 ? f.yMax - hi1[1] : f.yc - (lo1[1] + hi1[1]) / 2,
      f.zMin !== void 0 ? f.zMin - lo1[2] : f.zc - (lo1[2] + hi1[2]) / 2
    ];
  }
  const c1 = lo1[0] <= hi1[0]
    ? [0, 1, 2].map((k) => (lo1[k] + hi1[k]) / 2 + shift1[k])
    : [0, 0, 0];
  const P = { ...P1, sigma, t: P1.t.map((v) => v * user) };
  const placed = ir.elements.map((e, ei) => {
    const active = !hasSplitShoes || (variant === "leftLeg" ? e.to[0] <= 8.05 : e.from[0] >= 7.95);
    return {
      e,
      ei,
      active,
      A: { R: mul(Q, e.xf.R), t: add(mv(Q, e.xf.t.map((v) => v * sigma)), P.t) },
      sig: sigma
    };
  });
  const shift = [0, 1, 2].map((k) => shift1[k] * user + c1[k] * (1 - user));
  return { P, placed, shift };
}

/**
 * Computes the bounding-box center [cx, cy, cz] of a group of NCM parts in their attachment space.
 */
function computePartsCenter(parts) {
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  let count = 0;
  const walkPart = (p, parentXf) => {
    if (!p || typeof p !== "object") return;
    const piv = vec3(p.pivot);
    const rot = vec3(p.rotation);
    const localXf = { R: rotZYX(rot[0], rot[1], rot[2]), t: piv };
    const xf = parentXf ? compose(parentXf, localXf) : localXf;
    for (const c of p.cubes || []) {
      const o = vec3(c.origin), sz = vec3(c.size);
      for (let i = 0; i < 8; i++) {
        const corner = [
          o[0] + (i & 1 ? sz[0] : 0),
          o[1] + (i & 2 ? sz[1] : 0),
          o[2] + (i & 4 ? sz[2] : 0)
        ];
        const pt = apply(xf, corner);
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], pt[k]);
          hi[k] = Math.max(hi[k], pt[k]);
        }
        count++;
      }
    }
    for (const child of p.children || []) walkPart(child, xf);
  };
  for (const p of parts || []) walkPart(p, null);
  if (!count) return [0, 0, 0];
  return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2].map(r4);
}

/**
 * Computes the primary bounding-box center [cx, cy, cz] of an NCM model in its attachment space.
 */
function computeModelCenter(modelJson, side = null) {
  try {
    const root = typeof modelJson === "string" ? JSON.parse(modelJson) : modelJson;
    if (!root || !Array.isArray(root.parts) || !root.parts.length) return [0, 0, 0];
    const firstSide = side || root.parts.find((p) => p?.side)?.side || null;
    const primaryAttach = root.parts.find((p) => !firstSide || !p?.side || p.side === firstSide)?.attach || root.parts[0]?.attach;
    const relevant = root.parts.filter((p) => p && p.attach === primaryAttach && (!firstSide || !p.side || p.side === firstSide));
    return computePartsCenter(relevant.length ? relevant : root.parts);
  } catch {
    return [0, 0, 0];
  }
}

/**
 * Applies a 3D offset [ox, oy, oz] and Euler 'ZYX' rotation [rx, ry, rz] (in degrees) around the visual
 * center of each attachment group in an NCM model, optionally updating root attachment points for a slot.
 */
function transformNcmModel(modelJson, { offset = [0, 0, 0], rotation = [0, 0, 0], primarySide = null, slot = null } = {}) {
  const root = JSON.parse(JSON.stringify(typeof modelJson === "string" ? JSON.parse(modelJson) : modelJson));
  if (!root || !Array.isArray(root.parts)) return root;
  const off = vec3(offset);
  const rot = vec3(rotation);
  const hasTransform = off.some((v) => Math.abs(v) > 1e-4) || rot.some((v) => Math.abs(v) > 1e-4);
  if (slot && DEFAULT_ATTACH_FOR_SLOT[slot]) {
    for (const p of root.parts) {
      if (!p || typeof p !== "object") continue;
      if (slot === "hats" || slot === "glasses") p.attach = "head";
      else if (slot === "back") p.attach = "body";
      else if (slot === "hand") p.attach = p.side === "left" ? "leftArm" : "rightArm";
      else if (slot === "shoes" && p.attach !== "leftLeg" && p.attach !== "rightLeg") p.attach = "rightLeg";
    }
  }
  if (!hasTransform) return root;

  const groups = new Map();
  for (const p of root.parts) {
    if (!p || typeof p !== "object") continue;
    const gKey = `${p.attach || "head"}|${p.side || ""}`;
    if (!groups.has(gKey)) groups.set(gKey, []);
    groups.get(gKey).push(p);
  }

  for (const [, groupParts] of groups) {
    const center = computePartsCenter(groupParts);
    const partSide = groupParts[0]?.side || null;
    const mirrorOppositeHand = Boolean(primarySide && partSide && partSide !== primarySide);
    const gOff = mirrorOppositeHand ? [-off[0], off[1], off[2]] : off;
    const gRot = mirrorOppositeHand ? [rot[0], -rot[1], -rot[2]] : rot;
    const R_user = rotZYX(gRot[0], gRot[1], gRot[2]);
    for (const p of groupParts) {
      const piv = vec3(p.pivot);
      const pRot = vec3(p.rotation);
      const rel = sub(piv, center);
      const newPiv = add(add(center, gOff), mv(R_user, rel));
      const newRot = euler(mul(R_user, rotZYX(pRot[0], pRot[1], pRot[2])));
      p.pivot = newPiv.map(r4);
      p.rotation = newRot.map(r4);
    }
  }
  return root;
}

/**
 * Scales an existing NCM model and repacks its PNG texture (and optional dye mask) so box UVs remain exact
 * in both Three.js and Minecraft's integer ModelPart.Cuboid constructor.
 */
async function scaleNcmAsset(modelJson, pngBytes, maskBytes = null, scale = 1) {
  const s = num(scale, 1);
  const root = JSON.parse(JSON.stringify(typeof modelJson === "string" ? JSON.parse(modelJson) : modelJson));
  if (Math.abs(s - 1) < 1e-3 || !pngBytes) {
    return { model: root, png: pngBytes, mask: maskBytes };
  }
  const img = await decode(pngBytes);
  const maskImg = maskBytes ? await decode(maskBytes) : null;
  const [tw0, th0] = Array.isArray(root.texture) ? root.texture.map((v) => Math.max(1, Math.trunc(num(v, 64)))) : [64, 64];
  const kx = img.width / tw0;
  const ky = img.height / th0;
  const k = Math.max(1, Math.min(8, Math.round((kx + ky) / 2)));

  const cubeTasks = [];
  const collectCubes = (parts) => {
    for (const p of parts || []) {
      for (const c of p.cubes || []) {
        const [w0, h0, d0] = vec3(c.size, [1, 1, 1]);
        const [u0, v0] = [num(c.uv?.[0], 0), num(c.uv?.[1], 0)];
        const dims = [w0, h0, d0].map((sz) => (sz * s <= 1e-6 ? 0 : Math.max(1, Math.round(sz * s * k))));
        const [dx, dy, dz] = dims;
        cubeTasks.push({
          cube: c,
          w0,
          h0,
          d0,
          u0,
          v0,
          dims,
          w: 2 * dz + 2 * dx,
          h: dz + dy
        });
      }
      if (Array.isArray(p.children)) collectCubes(p.children);
    }
  };
  collectCubes(root.parts);

  const valid = cubeTasks.filter((t) => t.w > 0 && t.h > 0).sort((a, b) => b.h - a.h || b.w - a.w);
  const MAXW = 2048;
  let x = 0, y = 0, rowH = 0, usedW = 0;
  const al = (v) => Math.ceil(v / k) * k;
  for (const t of valid) {
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
  const H = Math.max(k, y + rowH);
  const W = Math.max(k, al(usedW));
  const out = new Uint8ClampedArray(W * H * 4);
  const outMask = maskImg ? new Uint8ClampedArray(W * H * 4) : null;

  const copyRect = (srcImg, dstBuf, sx0, sy0, sw, sh, dx0, dy0, dw, dh) => {
    if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;
    for (let j = 0; j < dh; j++) {
      const sy = Math.max(0, Math.min(srcImg.height - 1, Math.floor((sy0 + ((j + 0.5) / dh) * sh) * ky)));
      for (let i = 0; i < dw; i++) {
        const sx = Math.max(0, Math.min(srcImg.width - 1, Math.floor((sx0 + ((i + 0.5) / dw) * sw) * kx)));
        const si = (sy * srcImg.width + sx) * 4;
        const di = ((dy0 + j) * W + (dx0 + i)) * 4;
        dstBuf[di] = srcImg.data[si];
        dstBuf[di + 1] = srcImg.data[si + 1];
        dstBuf[di + 2] = srcImg.data[si + 2];
        dstBuf[di + 3] = srcImg.data[si + 3];
      }
    }
  };

  for (const t of valid) {
    const { u0, v0, w0, h0, d0, dims, x: tx, y: ty } = t;
    const [dx, dy, dz] = dims;
    const faces = [
      [u0 + d0, v0, w0, d0, tx + dz, ty, dx, dz],
      [u0 + d0 + w0, v0, w0, d0, tx + dz + dx, ty, dx, dz],
      [u0, v0 + d0, d0, h0, tx, ty + dz, dz, dy],
      [u0 + d0, v0 + d0, w0, h0, tx + dz, ty + dz, dx, dy],
      [u0 + d0 + w0, v0 + d0, d0, h0, tx + dz + dx, ty + dz, dz, dy],
      [u0 + 2 * d0 + w0, v0 + d0, w0, h0, tx + 2 * dz + dx, ty + dz, dx, dy]
    ];
    for (const [sx0, sy0, sw, sh, dx0, dy0, dw, dh] of faces) {
      copyRect(img, out, sx0, sy0, sw, sh, dx0, dy0, dw, dh);
      if (maskImg && outMask) copyRect(maskImg, outMask, sx0, sy0, sw, sh, dx0, dy0, dw, dh);
    }
    t.cube.size = [dx / k, dy / k, dz / k].map(r4);
    t.cube.origin = vec3(t.cube.origin).map((v) => r4(v * s));
    if (typeof t.cube.inflate === "number") t.cube.inflate = r4(t.cube.inflate * s);
    t.cube.uv = [tx / k, ty / k];
  }

  const groups = new Map();
  for (const p of root.parts || []) {
    if (!p || typeof p !== "object") continue;
    const gKey = `${p.attach || "head"}|${p.side || ""}`;
    if (!groups.has(gKey)) groups.set(gKey, []);
    groups.get(gKey).push(p);
  }
  const scaleChildren = (children) => {
    for (const ch of children || []) {
      ch.pivot = vec3(ch.pivot).map((v) => r4(v * s));
      if (Array.isArray(ch.children)) scaleChildren(ch.children);
    }
  };
  for (const [, groupParts] of groups) {
    const center = computePartsCenter(groupParts);
    for (const p of groupParts) {
      const piv = vec3(p.pivot);
      p.pivot = add(center, sub(piv, center).map((v) => v * s)).map(r4);
      if (Array.isArray(p.children)) scaleChildren(p.children);
    }
  }
  root.texture = [W / k, H / k];
  return {
    model: root,
    png: encodePngBytes(out, W, H),
    mask: outMask ? encodePngBytes(outMask, W, H) : null
  };
}

async function convertNcmEntry(files, idx, entry, opts = {}) {
  const rawModel = JSON.parse(text(files[entry.ncmKey]).replace(/^\uFEFF/, ""));
  const slot = opts.slot || entry.slot || "hats";
  const baseName = entry.ncmKey.replace(/\.json$/i, "");
  const texKey = findTextureFile(files, idx, baseName, detectNamespaces(files), entry.ncmKey);
  if (!texKey) throw new Error(`Missing PNG texture for ${entry.id}`);
  const maskKey = findSuffix(files, idx, `${baseName}_mask.png`) || findSuffix(files, idx, `${baseName}-mask.png`);
  const scaled = await scaleNcmAsset(rawModel, files[texKey], maskKey ? files[maskKey] : null, num(opts.scale, 1));
  const transformed = transformNcmModel(scaled.model, {
    offset: opts.offset || [0, 0, 0],
    rotation: opts.rotation || [0, 0, 0],
    primarySide: opts.side || entry.side || "right",
    slot
  });
  const img = await decode(scaled.png);
  let cubes = 0;
  for (const p of transformed.parts || []) cubes += (p.cubes || []).length;
  return {
    model: transformed,
    png: scaled.png,
    mask: scaled.mask,
    color: entry.color || null,
    info: {
      parts: (transformed.parts || []).length,
      cubes,
      density: Math.max(1, Math.round(img.width / (transformed.texture?.[0] || img.width))),
      size: [img.width, img.height],
      slot,
      sides: [...new Set((transformed.parts || []).map((p) => p.side).filter(Boolean))]
    }
  };
}

async function convert(files, entry, opts = {}) {
  const idx = index(files);
  const namespaces = detectNamespaces(files);
  const slot = opts.slot || entry.slot || "hats";
  if (entry.kind === "ncm") {
    return convertNcmEntry(files, idx, entry, { ...opts, slot });
  }
  const convertOpts = { ...opts, slot, balloon: entry.balloon };
  const ir = entry.kind === "bb" ? await bbIR(files, idx, entry, namespaces) : await javaIR(files, idx, entry, namespaces);
  const isBalloon = slot === "balloon" || Boolean(entry.balloon && slot === "back");
  const sided = slot === "hand" || isBalloon;
  const first = opts.side || entry.side || "right";
  const variants = slot === "shoes"
    ? ["rightLeg", "leftLeg"]
    : sided
      ? [first, first === "left" ? "right" : "left"]
      : [null];
  const built = variants.map((v) => buildVariant(ir, entry, slot, v, convertOpts));
  const sigma0 = built[0].P.sigma;
  let dens = 1;
  for (const e of ir.elements) {
    for (const [f, face] of Object.entries(e.faces)) {
      const tex = ir.textures[face.tex];
      const du = Math.abs(face.uv[2] - face.uv[0]) * tex.ux, dv = Math.abs(face.uv[3] - face.uv[1]) * tex.uy;
      const sz = [e.to[0] - e.from[0], e.to[1] - e.from[1], e.to[2] - e.from[2]];
      const a = f === "north" || f === "south" ? [sz[0], sz[1]] : f === "east" || f === "west" ? [sz[2], sz[1]] : [sz[0], sz[2]];
      const [pu, pv] = face.rot % 180 ? [a[1], a[0]] : a;
      if (pu >= 0.5 && du > 0) dens = Math.max(dens, du / pu);
      if (pv >= 0.5 && dv > 0) dens = Math.max(dens, dv / pv);
    }
  }
  let k = Math.max(1, Math.min(8, Math.ceil(dens / sigma0 - 1e-6)));
  for (; ; ) {
    const res = pack(ir, built, variants, slot, k, convertOpts);
    if (res.ok || k === 1) {
      if (!res.ok) throw new Error("This model needs a bigger texture than Native allows (2048x2048 max)");
      return await finish(res, entry, slot, variants, k, convertOpts);
    }
    k--;
  }
}

function pack(ir, built, variants, slot, k) {
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
  const MAXW = 2048;
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
  const info = new Map();
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
      const frame = tex.seq[Math.min(tex.seq.length - 1, Math.floor((t.st * tex.seq.length) / t.S))] || 0;
      const ox = t.x + cols[ck], oy = t.y + rows[rk];
      for (let j = 0; j < fh; j++) {
        for (let i = 0; i < fw; i++) {
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
    }
    info.set(`${t.ei}:${t.st}`, { x: t.x, y: t.y, translucent, empty: !any });
  }
  return { ok: true, W, H: Math.max(H, k), pixels: out, mask: tinted ? mask : null, info, tasks, sigma, built, ir };
}

async function finish(res, entry, slot, variants, k, opts = {}) {
  const { ir, built, sigma, info } = res;
  const parts = [];
  let cubes = 0;
  const isBalloon = slot === "balloon" || Boolean(opts.balloon && slot === "back");
  const stateCount = (ei) => res.tasks.filter((t) => t.ei === ei).length;
  built.forEach((bv, vi) => {
    const variant = variants[vi];
    const isSidedVariant = variant === "left" || variant === "right";
    const merged = new Map();
    bv.placed.forEach(({ e, A, ei, active }) => {
      if (!active) return;
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
            ...(isSidedVariant ? { side: variant } : {}),
            ...(isSidedVariant && slot === "hand" ? { armor: { slot: variant + "hand", mode: "hide" } } : {}),
            ...(slot === "shoes" ? { armor: { slot: "feet", mode: "hide" } } : {}),
            ...(layer === "translucent" ? { layer } : {}),
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
  if (isBalloon) {
    for (const p of parts) if (!p.anim.some((a) => a.type === "bob")) p.anim.push({ type: "bob", axis: "y", speed: 0.35, amplitude: 1.2, phase: 0 });
  }
  if (parts.length > 512 || cubes > 2048) throw new Error(`Too complex (${parts.length} parts, ${cubes} cubes; limit 512 / 2048)`);
  const W = res.W, H = res.H;
  const bytes = encodePngBytes(res.pixels, W, H);
  const maskBytes = res.mask ? encodePngBytes(res.mask, W, H) : null;
  if (!ir.elements.length) throw new Error("empty");
  const baseModel = { format: 1, texture: [W / k, H / k], parts };
  const model = transformNcmModel(baseModel, {
    offset: opts.offset || [0, 0, 0],
    rotation: opts.rotation || [0, 0, 0],
    primarySide: opts.side || entry.side || "right"
  });
  const storeSlot = slot === "balloon" ? "back" : slot;
  const sides = variants.filter((v) => v === "left" || v === "right");
  return {
    model,
    png: bytes,
    mask: maskBytes,
    color: entry.color || null,
    info: { parts: parts.length, cubes, density: k, size: [W, H], slot: storeSlot, sides }
  };
}

async function bakeDye(png, mask, hex) {
  const base = await decode(png);
  const W = base.width, H = base.height;
  const d = new Uint8ClampedArray(base.data);
  let m = null, mW = W, mH = H;
  if (mask) {
    const mb = await decode(mask);
    m = mb.data;
    mW = mb.width;
    mH = mb.height;
  }
  const c = [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      if (!d[o + 3]) continue;
      let k = 1;
      if (m) {
        const mx = mW === W ? x : Math.min(mW - 1, Math.floor((x * mW) / W));
        const my = mH === H ? y : Math.min(mH - 1, Math.floor((y * mH) / H));
        k = m[(my * mW + mx) * 4 + 3] / 255;
        if (!k) continue;
      }
      const r = d[o], gg = d[o + 1], b = d[o + 2];
      const lum = Math.min(255, Math.max(r, gg, b) * 0.35 + (0.299 * r + 0.587 * gg + 0.114 * b) * 0.65) / 255;
      d[o] = Math.round(r + (c[0] * lum - r) * k);
      d[o + 1] = Math.round(gg + (c[1] * lum - gg) * k);
      d[o + 2] = Math.round(b + (c[2] * lum - b) * k);
    }
  }
  return encodePngBytes(d, W, H);
}

export {
  bakeDye,
  computeModelCenter,
  convert,
  discover,
  readZip,
  scaleNcmAsset,
  transformNcmModel
};
