/**
 * Native cosmetic models (NCM v1) for three.js: the exact box-UV geometry, attachment and animation the
 * Minecraft mod uses (see native-mod CosmeticModel / CosmeticPose), so previews match the game.
 *
 *   const built = buildCosmetic(THREE, model, image);   // model = parsed NCM JSON, image = HTMLImageElement/canvas
 *   attachToPlayer(built, viewer.playerObject.skin);     // skinview3d SkinObject
 *   built.update(seconds, walk01);                       // every frame
 *   built.dispose();
 */

const ATTACH = { head: 'head', body: 'body', back: 'body', torso: 'body', rightarm: 'rightArm', leftarm: 'leftArm', rightleg: 'rightLeg', rightfoot: 'rightLeg', leftleg: 'leftLeg', leftfoot: 'leftLeg' };
const LIMIT_PARTS = 96;
const LIMIT_CUBES = 512;

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v, l) => Math.max(-l, Math.min(l, v));
const vec = (a, n, d) => Array.from({ length: n }, (_, i) => num(Array.isArray(a) ? a[i] : undefined, d[i]));

/** Validates and normalises a model exactly like the mod does. Throws on junk. */
export function parseCosmetic(json) {
  const root = typeof json === 'string' ? JSON.parse(json) : json;
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('model is not an object');
  if (num(root.format, 1) !== 1) throw new Error('unsupported model format');
  const [tw, th] = vec(root.texture, 2, [64, 64]).map((v) => Math.trunc(v));
  if (tw < 1 || th < 1 || tw > 1024 || th > 1024) throw new Error('bad texture size');
  if (!Array.isArray(root.parts) || !root.parts.length) throw new Error('model has no parts');
  const flat = [];
  let cubes = 0;
  const parts = (list, inherited, depth) => {
    if (depth > 8) throw new Error('model nests too deep');
    const out = [];
    for (const o of list) {
      if (!o || typeof o !== 'object') continue;
      if (flat.length >= LIMIT_PARTS) throw new Error('too many parts');
      const attach = inherited || ATTACH[String(o.attach || 'head').toLowerCase().replace(/_/g, '')] || 'head';
      const part = {
        id: String(o.id || `part${flat.length}`),
        attach,
        pivot: vec(o.pivot, 3, [0, 0, 0]).map((v) => clamp(v, 64)),
        rotation: vec(o.rotation, 3, [0, 0, 0]).map((v) => (clamp(v, 360) * Math.PI) / 180),
        layer: o.layer === 'glow' || o.layer === 'emissive' || o.glow === true ? 'glow' : o.layer === 'translucent' ? 'translucent' : 'cutout',
        armor: o.armor && typeof o.armor === 'object' ? { slot: String(o.armor.slot || 'none'), hide: o.armor.mode !== 'push', offset: vec(o.armor.offset, 3, [0, 0, 0]).map((v) => clamp(v, 8)) } : null,
        anim: (Array.isArray(o.anim) ? o.anim : []).slice(0, 8).map(parseAnim).filter(Boolean),
        cubes: [],
        children: []
      };
      for (const c of Array.isArray(o.cubes) ? o.cubes : []) {
        if (!c || typeof c !== 'object') continue;
        if (++cubes > LIMIT_CUBES) throw new Error('too many cubes');
        part.cubes.push({
          origin: vec(c.origin, 3, [0, 0, 0]).map((v) => clamp(v, 64)),
          size: vec(c.size, 3, [1, 1, 1]).map((v) => Math.max(0, Math.min(64, Math.round(v)))),
          uv: vec(c.uv, 2, [0, 0]).map((v) => Math.max(0, Math.min(1024, Math.trunc(v)))),
          inflate: Math.max(-2, Math.min(4, num(c.inflate, 0))),
          mirror: c.mirror === true
        });
      }
      flat.push(part);
      if (Array.isArray(o.children)) part.children = parts(o.children, attach, depth + 1);
      out.push(part);
    }
    return out;
  };
  const roots = parts(root.parts, null, 0);
  if (!roots.length) throw new Error('model has no parts');
  return { texture: [tw, th], roots, flat };
}

function parseAnim(a) {
  if (!a || typeof a !== 'object') return null;
  const t = String(a.type || '').toLowerCase();
  const type = t === 'flap' ? 'swing' : t;
  if (!['spin', 'swing', 'bob', 'blink'].includes(type)) return null;
  const axis = a.axis === 'x' ? 0 : a.axis === 'z' ? 2 : 1;
  const lim = (v, d, l) => clamp(num(v, d), l);
  return {
    type,
    axis,
    speed: lim(a.speed, type === 'spin' ? 90 : 1, 4000),
    amplitude: lim(a.amplitude, type === 'blink' ? 0.5 : 10, 360),
    moving: lim(a.moving, 0, 360),
    phase: lim(a.phase, 0, 1000)
  };
}

/** Same math as the mod's CosmeticPose: [px, py, pz, pitch, yaw, roll], visible. */
export function poseOf(part, time, moving, out = new Array(6)) {
  out[0] = part.pivot[0]; out[1] = part.pivot[1]; out[2] = part.pivot[2];
  out[3] = part.rotation[0]; out[4] = part.rotation[1]; out[5] = part.rotation[2];
  let visible = true;
  const walk = Math.max(0, Math.min(1, moving || 0));
  const cycle = (a) => { const c = (a.speed * time + a.phase) % 1; return c < 0 ? c + 1 : c; };
  for (const a of part.anim) {
    if (a.type === 'spin') out[3 + a.axis] += (((a.speed * time + a.phase * 360) % 360) * Math.PI) / 180;
    else if (a.type === 'swing') out[3 + a.axis] += (((a.amplitude + a.moving * walk) * Math.sin(2 * Math.PI * cycle(a))) * Math.PI) / 180;
    else if (a.type === 'bob') out[a.axis] += (a.amplitude + a.moving * walk) * Math.sin(2 * Math.PI * cycle(a));
    else if (a.type === 'blink' && cycle(a) >= a.amplitude) visible = false;
  }
  return visible;
}

/** Minecraft ModelPart.Cuboid geometry (model space: pixels, y down, front = -z), with its exact box UV. */
function cubeGeometry(THREE, c, tw, th) {
  const [w, h, d] = c.size;
  const e = c.inflate;
  let x0 = c.origin[0] - e, x1 = c.origin[0] + w + e;
  const y0 = c.origin[1] - e, y1 = c.origin[1] + h + e;
  const z0 = c.origin[2] - e, z1 = c.origin[2] + d + e;
  if (c.mirror) [x0, x1] = [x1, x0];
  const V = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const [u, v] = c.uv;
  const l = u, m = u + d, n = u + d + w, o = u + d + 2 * w, p = u + 2 * d + w, q = u + 2 * d + 2 * w;
  const r = v, s = v + d, t = v + d + h;
  // [vertex indices], u1, v1, u2, v2 - verbatim from ModelPart.Cuboid; Quad maps v0->(u2,v1) v1->(u1,v1) v2->(u1,v2) v3->(u2,v2)
  const quads = [
    [[5, 4, 0, 1], m, r, n, s], // DOWN (model y0 = top of the head in game)
    [[2, 3, 7, 6], n, s, o, r], // UP
    [[0, 4, 7, 3], l, s, m, t], // WEST
    [[1, 0, 3, 2], m, s, n, t], // NORTH (front)
    [[5, 1, 2, 6], n, s, p, t], // EAST
    [[4, 5, 6, 7], p, s, q, t] // SOUTH (back)
  ];
  const pos = [], uvs = [], idx = [];
  for (const [vs, u1, v1, u2, v2] of quads) {
    let order = vs, uvq = [[u2, v1], [u1, v1], [u1, v2], [u2, v2]];
    if (c.mirror) { order = [...vs].reverse(); uvq = [...uvq].reverse(); }
    const base = pos.length / 3;
    order.forEach((vi, k) => { pos.push(...V[vi]); uvs.push(uvq[k][0] / tw, uvq[k][1] / th); });
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

/**
 * Builds three.js objects for a cosmetic. Returns { roots: [{ attach, object }], update(t, walk), setArmor(set), dispose() }.
 * Each root object is in the space of the vanilla part it attaches to (origin = that part's Minecraft pivot).
 */
export function buildCosmetic(THREE, modelJson, image) {
  const model = modelJson && modelJson.flat ? modelJson : parseCosmetic(modelJson);
  const texture = image && image.isTexture ? image : new THREE.Texture(image);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  if ('colorSpace' in texture) texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  const [tw, th] = model.texture;
  const materials = {
    cutout: new THREE.MeshStandardMaterial({ map: texture, alphaTest: 0.1, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 }),
    translucent: new THREE.MeshStandardMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide, roughness: 0.4, metalness: 0 }),
    glow: new THREE.MeshBasicMaterial({ map: texture, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
  };
  const nodes = [];
  const geometries = [];
  const make = (part) => {
    const group = new THREE.Group();
    group.name = `ncm:${part.id}`;
    group.rotation.order = 'ZYX'; // ModelPart.rotate: Z, then Y, then X
    const holder = new THREE.Group(); // armor push offset
    holder.add(group);
    for (const c of part.cubes) {
      const g = cubeGeometry(THREE, c, tw, th);
      geometries.push(g);
      const mesh = new THREE.Mesh(g, materials[part.layer]);
      if (part.layer === 'glow') mesh.renderOrder = 2;
      if (part.layer === 'translucent') mesh.renderOrder = 1;
      group.add(mesh);
    }
    nodes.push({ part, group, holder });
    for (const child of part.children) group.add(make(child));
    return holder;
  };
  const roots = model.roots.map((part) => {
    // Minecraft model space -> three.js (y up, facing +z): a 180 degree turn about x
    const space = new THREE.Group();
    space.rotation.x = Math.PI;
    space.add(make(part));
    return { attach: part.attach, object: space, part };
  });
  let armor = new Set();
  const pose = new Array(6);
  const built = {
    model,
    roots,
    update(time = 0, walk = 0) {
      for (const { part, group, holder } of nodes) {
        const hidden = part.armor && part.armor.hide && armor.has(part.armor.slot);
        const pushed = part.armor && !part.armor.hide && armor.has(part.armor.slot);
        holder.position.set(...(pushed ? part.armor.offset : [0, 0, 0]));
        const visible = poseOf(part, time, walk, pose);
        group.visible = visible && !hidden;
        group.position.set(pose[0], pose[1], pose[2]);
        group.rotation.set(pose[3], pose[4], pose[5], 'ZYX');
      }
    },
    setArmor(slots) { armor = new Set(slots || []); },
    detach() { for (const r of roots) r.object.parent?.remove(r.object); },
    dispose() {
      built.detach();
      geometries.forEach((g) => g.dispose());
      Object.values(materials).forEach((m) => m.dispose());
      texture.dispose();
    }
  };
  built.update(0, 0);
  return built;
}

/** Attaches a built cosmetic to a skinview3d SkinObject (viewer.playerObject.skin). */
export function attachToPlayer(built, skin) {
  for (const r of built.roots) {
    const part = skin[r.attach] || skin.head;
    // skinview3d places the body group at its centre; Minecraft's body pivot is the neck, 6 px higher
    r.object.position.set(0, r.attach === 'body' ? 6 : 0, r.attach === 'rightLeg' || r.attach === 'leftLeg' ? 0.1 : 0);
    part.add(r.object);
  }
  return built;
}

/** Loads an image (URL or data URL) for buildCosmetic. */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('texture failed to load'));
    img.src = src;
  });
}
