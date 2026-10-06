'use strict';
/**
 * Native 3D cosmetics: hats, glasses, back items (wings, backpacks, jetpacks) and shoes.
 *
 * A cosmetic is a store item with `kind: 'cosmetic'` and a slot (its section). It ships as an NCM v1
 * model (JSON, box-UV cubes like Minecraft's own models, see native-mod CosmeticModel) plus a PNG
 * texture and a transparent thumbnail. Profiles wear at most one cosmetic per slot:
 *
 *   profile.cosmetics = { hats: 'propeller-cap', back: 'angel-wings' }
 *
 * The mod gets `k: [{ i, m, x }]` (item id, model hash, texture hash) in each skin directory entry.
 */

const SLOTS = ['hats', 'glasses', 'back', 'shoes'];
const SLOT_NAMES = { hats: 'Hats', glasses: 'Glasses', back: 'Wings & Backpacks', shoes: 'Shoes' };
const MAX_MODEL_BYTES = 256 * 1024; // the mod refuses bigger models
const MAX_TEXTURE_BYTES = 1024 * 1024;
const LIMIT_PARTS = 96;
const LIMIT_CUBES = 512;
const ATTACH = { head: 'head', body: 'body', back: 'body', torso: 'body', rightarm: 'rightArm', leftarm: 'leftArm', rightleg: 'rightLeg', rightfoot: 'rightLeg', leftleg: 'leftLeg', leftfoot: 'leftLeg' };
const ANIMS = ['spin', 'swing', 'flap', 'bob', 'blink'];

const isSlot = (value) => SLOTS.includes(value);
const isCosmetic = (item) => Boolean(item) && item.kind === 'cosmetic' && isSlot(item.slot);
const num = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Checks an NCM model the same way the mod parses it. Returns { parts, cubes, animated, texture: [w, h] }.
 * Throws a readable error for anything the game would refuse.
 */
function validateModel(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : typeof input === 'string' ? input : JSON.stringify(input);
  if (Buffer.byteLength(text) > MAX_MODEL_BYTES) throw new Error('That model is too big (256 KB max).');
  let root;
  try { root = JSON.parse(text); } catch { throw new Error('The model is not valid JSON.'); }
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('The model must be a JSON object.');
  if (root.format !== undefined && root.format !== 1) throw new Error('Unsupported model format (use format 1).');
  const tex = Array.isArray(root.texture) ? root.texture : [64, 64];
  const [tw, th] = [Math.trunc(tex[0] ?? 64), Math.trunc(tex[1] ?? 64)];
  if (!(tw >= 1 && th >= 1 && tw <= 1024 && th <= 1024)) throw new Error('The model texture size must be 1-1024.');
  if (!Array.isArray(root.parts) || !root.parts.length) throw new Error('The model has no parts.');
  let parts = 0;
  let cubes = 0;
  let animated = false;
  const walk = (list, depth) => {
    if (depth > 8) throw new Error('The model nests too deep (8 levels max).');
    for (const part of list) {
      if (!part || typeof part !== 'object') continue;
      if (++parts > LIMIT_PARTS) throw new Error(`Too many parts (${LIMIT_PARTS} max).`);
      if (part.attach !== undefined && !ATTACH[String(part.attach).toLowerCase().replace(/_/g, '')]) throw new Error(`Unknown attach point "${part.attach}".`);
      for (const cube of Array.isArray(part.cubes) ? part.cubes : []) {
        if (!cube || typeof cube !== 'object') continue;
        if (++cubes > LIMIT_CUBES) throw new Error(`Too many cubes (${LIMIT_CUBES} max).`);
        if (!Array.isArray(cube.size) || cube.size.length !== 3 || !cube.size.every(num)) throw new Error('Every cube needs a size [x, y, z].');
      }
      for (const anim of Array.isArray(part.anim) ? part.anim : []) {
        if (anim && ANIMS.includes(String(anim.type || '').toLowerCase())) animated = true;
      }
      if (Array.isArray(part.children)) walk(part.children, depth + 1);
    }
  };
  walk(root.parts, 0);
  if (!cubes) throw new Error('The model has no cubes.');
  return { parts, cubes, animated, texture: [tw, th] };
}

/** The cosmetics a profile wears, as { slot: item } for items that still exist in their slot. */
function wornItems(profile, findItem) {
  const out = {};
  const worn = profile && profile.cosmetics && typeof profile.cosmetics === 'object' ? profile.cosmetics : {};
  for (const slot of SLOTS) {
    const id = worn[slot];
    if (typeof id !== 'string' || !id) continue;
    let item = null;
    try { item = findItem(id); } catch {}
    if (isCosmetic(item) && item.slot === slot) out[slot] = item;
  }
  return out;
}

/** { slot: itemId } of what a profile wears. */
function wearing(profile, findItem) {
  const out = {};
  for (const [slot, item] of Object.entries(wornItems(profile, findItem))) out[slot] = item.id;
  return out;
}

/** A profile with this item taken off, or null when it wasn't worn. */
function withoutItem(profile, itemId) {
  if (!profile || !profile.cosmetics) return null;
  const slots = Object.keys(profile.cosmetics).filter((slot) => profile.cosmetics[slot] === itemId);
  if (!slots.length) return null;
  const cosmetics = { ...profile.cosmetics };
  for (const slot of slots) delete cosmetics[slot];
  return { ...profile, cosmetics };
}

/** A profile wearing `item` in its slot. */
function withItem(profile, item) {
  return { ...profile, cosmetics: { ...(profile.cosmetics || {}), [item.slot]: item.id } };
}

/** A profile with nothing in `slot`. */
function withoutSlot(profile, slot) {
  const cosmetics = { ...(profile.cosmetics || {}) };
  delete cosmetics[slot];
  return { ...profile, cosmetics };
}

/** Directory entries for the mod: [{ i, m, x }]. */
function directoryRefs(profile, findItem) {
  return Object.entries(wornItems(profile, findItem)).map(([slot, item]) => ({ i: item.id, s: slot, m: item.model, x: item.texture }));
}

/** Public description (CSL document, launcher, website). */
function documentRefs(profile, findItem, textureBase) {
  return Object.entries(wornItems(profile, findItem)).map(([slot, item]) => ({
    slot,
    id: item.id,
    name: item.name,
    modelUrl: `${textureBase}${item.model}`,
    textureUrl: `${textureBase}${item.texture}`
  }));
}

module.exports = {
  SLOTS, SLOT_NAMES, MAX_MODEL_BYTES, MAX_TEXTURE_BYTES,
  isSlot, isCosmetic, validateModel, wornItems, wearing, withoutItem, withItem, withoutSlot, directoryRefs, documentRefs
};
