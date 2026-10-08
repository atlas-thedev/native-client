const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { dialog, net, shell } = require('electron');
const { downloadFile, writeFileAtomic } = require('./download');
const safeFile = require('./safeFile');
const textureCache = require('./textureCache');

/**
 * Locker / wardrobe storage (main process).
 *
 * Every skin and cape the player uploads is kept as a library item in
 * `{userData}/wardrobe/{accountKey}/`. One skin and one cape are *active*; the
 * active pair is what CustomSkinLoader renders in game and what gets published
 * to the Native wardrobe API (api.nativelaunch.xyz, see skin-server/).
 *
 * Older profiles stored three fixed "slots" (skin + cape + model each). Those
 * are migrated on read: every filled slot becomes a library item and the
 * selected slot becomes the active outfit.
 */

const API_ROOT = 'https://api.nativelaunch.xyz';

/**
 * The wardrobe API usually runs on Native Cloud (scripts/api.nativelaunch.xyz.nginx
 * proxies it to skin-server/server.js on port 3418). Set NATIVE_WARDROBE_API to
 * point a build at a self-hosted instance, e.g. http://127.0.0.1:3418 for the
 * server started by `npm run skin-server`.
 */
const apiRoot = () => String(process.env.NATIVE_WARDROBE_API || API_ROOT).replace(/\/+$/, '');
const SLOT_COUNT = 3; // legacy wardrobe.json
const ITEM_LIMIT = 60;
const MAX_PNG_BYTES = 5 * 1024 * 1024;
// Animated capes are a vertical strip of frames, so they are much taller (and bigger) than a skin.
const MAX_ANIM_BYTES = 16 * 1024 * 1024;
const MAX_ANIM_FRAMES = 240;
const MAX_ANIM_FPS = 30;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

let deps = null;

/** Electron's own connectivity flag: instant, no request. Defaults to online when unknown. */
function isOnline() {
  try { return net?.isOnline ? net.isOnline() : true; } catch { return true; }
}


const wardrobeRoot = () => path.join(deps.app.getPath('userData'), 'wardrobe');
const cacheDir = () => path.join(deps.app.getPath('userData'), 'cache', 'skins');
const accountKey = (account) => crypto.createHash('sha256').update(String(account?.id || account?.name || 'guest')).digest('hex').slice(0, 24);
const accountDir = (account) => path.join(wardrobeRoot(), accountKey(account));
const metadataPath = (account) => path.join(accountDir(account), 'wardrobe.json');
const itemPath = (account, filename) => path.join(accountDir(account), filename);

const OFFICIAL_CAPES = [
  { id: 'cherry-blossom', name: 'Cherry Blossom', file: 'cherry-blossom.png', hash: 'be05a2d92dd043034c9ae6d7c8415e8bc990080ba4dc4c70e9ea92cf9a89705c' },
  { id: 'founders', name: "Founder's Cape", file: 'founders.png', hash: '99aba02ef05ec6aa4d42db8ee43796d6cd50e4b2954ab29f0caeb85f96bf52a1' },
  { id: 'anniversary-15', name: '15th Anniversary', file: 'anniversary-15.png', hash: '0b4f4ee1bf094876a8454838b7cd07184dce86428b3cab4122b3bb7d67e530b6' },
  { id: 'purple-heart', name: 'Purple Heart', file: 'purple-heart.png', hash: '6836989ef37c72e84552410f178740a3d630ed4ecdce14029e6e9e155980d06c' },
  { id: 'followers', name: "Follower's Cape", file: 'followers.png', hash: '77065df71efe39771d3af4832ed62803c551772cc2f78e744d52822ae949f6c6' },
  { id: 'vanilla', name: 'Vanilla Cape', file: 'vanilla.png', hash: 'f9a76537647989f9a0b6d001e320dac591c359e9e61a31f4ce11c88f207f0ad4' },
  { id: 'migrator', name: 'Migrator Cape', file: 'migrator.png', hash: '2340c0e03dd24a11b15a8b33c2a7e9e32abb2051b2481d0ba7defd635ca7a933' }
];

function getOfficialCapeByName(name) {
  const clean = String(name || '').trim().toLowerCase();
  return OFFICIAL_CAPES.find((c) => c.name.toLowerCase() === clean || c.id.toLowerCase() === clean);
}

function getOfficialCapeByHash(hash) {
  if (!hash) return null;
  const clean = String(hash).trim().toLowerCase();
  return OFFICIAL_CAPES.find((c) => c.hash.toLowerCase() === clean);
}

function getOfficialCapeBuffer(nameOrId) {
  const cape = typeof nameOrId === 'object' && nameOrId ? nameOrId : (getOfficialCapeByName(nameOrId) || OFFICIAL_CAPES.find(c => c.id === nameOrId));
  if (!cape) return null;
  const p1 = path.join(__dirname, 'capes', cape.file);
  if (fs.existsSync(p1)) return fs.readFileSync(p1);
  const p2 = path.join(__dirname, '..', 'src', 'assets', 'capes', cape.file);
  if (fs.existsSync(p2)) return fs.readFileSync(p2);
  return null;
}

/**
 * The v2 key derived from public account details. Anyone could compute it, so
 * it is only kept to recognise (and rotate away from) legacy installs.
 */
function deterministicSyncKey(account) {
  const seed = String(account?.email || account?.uuid || account?.id || account?.name || 'guest').toLowerCase().trim();
  return crypto.createHash('sha256').update(`noctra-wardrobe-v2:${seed}`).digest('hex').slice(0, 48);
}

function newSyncKey() {
  return crypto.randomBytes(24).toString('hex');
}

function isLegacySyncKey(account, key) {
  if (!account || !key) return false;
  return key === deterministicSyncKey(account);
}

function emptyMetadata(account) {
  return { version: 2, activeSkin: null, activeCape: null, model: 'classic', items: [], syncKey: newSyncKey(account) };
}

/* ── items ───────────────────────────────────────────────────── */

function normalizeModel(value) {
  return value === 'slim' ? 'slim' : 'classic';
}

function cleanName(value, fallback) {
  const name = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return name || fallback;
}

/** `{ frames, fps }` of an animated cape item, or null. */
function normalizeAnim(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const frames = Math.floor(Number(raw.frames));
  const fps = Math.round(Number(raw.fps));
  if (!(frames >= 2 && frames <= MAX_ANIM_FRAMES)) return null;
  return { frames, fps: Math.min(MAX_ANIM_FPS, Math.max(1, Number.isFinite(fps) ? fps : 10)) };
}

function normalizeItem(raw, fallbackId) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind === 'cape' ? 'cape' : raw.kind === 'skin' ? 'skin' : null;
  if (!kind) return null;
  const anim = kind === 'cape' && raw.stillFile ? normalizeAnim(raw.anim) : null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId,
    kind,
    file: String(raw.file || ''),
    name: cleanName(raw.name, kind === 'cape' ? 'Cape' : 'Skin'),
    model: normalizeModel(raw.model),
    createdAt: Number(raw.createdAt) || Date.now(),
    favorite: Boolean(raw.favorite),
    // Animated cape: `file` is the whole strip, `stillFile` its first frame (the normal cape).
    ...(anim ? { anim, stillFile: String(raw.stillFile), ...(raw.storeId ? { storeId: String(raw.storeId).slice(0, 64) } : {}) } : {})
  };
}

/** Convert a legacy three-slot profile into library items. */
function migrateLegacy(value) {
  const metadata = emptyMetadata();
  metadata.syncKey = typeof value.syncKey === 'string' && value.syncKey.length >= 32 ? value.syncKey : metadata.syncKey;
  const slotIndex = Number.isInteger(value.selected) ? value.selected : 0;

  (value.slots || []).slice(0, SLOT_COUNT).forEach((slot, index) => {
    for (const kind of ['skin', 'cape']) {
      const file = slot?.[kind];
      if (!file) continue;
      const item = normalizeItem(
        { id: crypto.randomUUID(), kind, file, name: `Outfit ${index + 1}`, model: slot.model, createdAt: Date.now(), favorite: true },
        crypto.randomUUID()
      );
      if (!item) continue;
      metadata.items.push(item);
      if (index === slotIndex) {
        if (kind === 'skin') {
          metadata.activeSkin = item.id;
          metadata.model = item.model;
        } else {
          metadata.activeCape = item.id;
        }
      }
    }
  });

  return metadata;
}

function sanitizeMetadata(raw, account) {
  if (!raw || typeof raw !== 'object') return emptyMetadata(account);
  if (Array.isArray(raw.slots) && !Array.isArray(raw.items)) return migrateLegacy(raw);

  const metadata = emptyMetadata(account);
  metadata.syncKey = typeof raw.syncKey === 'string' && raw.syncKey.length >= 32 ? raw.syncKey : metadata.syncKey;
  metadata.model = normalizeModel(raw.model);
  metadata.items = (Array.isArray(raw.items) ? raw.items : [])
    .map((item, index) => normalizeItem(item, `item-${index}`))
    .filter((item) => item && item.file)
    .slice(0, ITEM_LIMIT);
  metadata.activeSkin = metadata.items.some((item) => item.id === raw.activeSkin) ? raw.activeSkin : null;
  metadata.activeCape = metadata.items.some((item) => item.id === raw.activeCape) ? raw.activeCape : null;
  metadata.lastModifiedAt = Number(raw.lastModifiedAt) || null;
  metadata.lastSyncedAt = Number(raw.lastSyncedAt) || null;
  return metadata;
}

function loadMetadata(account) {
  const { value: raw, status } = safeFile.readJsonDetailed(metadataPath(account), null);
  const metadata = sanitizeMetadata(raw, account);
  if (!metadata.syncKey || metadata.syncKey.length < 32) {
    metadata.syncKey = newSyncKey();
  }
  // Unreadable file: work from memory, never overwrite the user's library.
  if (status === 'corrupt') return metadata;

  // Automatic upgrade: verify that any cape items matching official presets use authentic textures
  let upgraded = false;
  for (const item of metadata.items) {
    if (item.kind === 'cape') {
      const official = getOfficialCapeByName(item.name);
      if (official) {
        const officialBuf = getOfficialCapeBuffer(official);
        if (officialBuf) {
          const targetPath = itemPath(account, item.file);
          let replace = false;
          try {
            if (!fs.existsSync(targetPath)) {
              replace = true;
            } else {
              const currentBuf = fs.readFileSync(targetPath);
              if (!currentBuf.equals(officialBuf)) {
                replace = true;
              }
            }
          } catch {
            replace = true;
          }
          if (replace) {
            try {
              fs.mkdirSync(accountDir(account), { recursive: true });
              writeFileAtomic(targetPath, officialBuf);
              upgraded = true;
            } catch {}
          }
        }
      }
    }
  }

  // Persist the migrated shape, a new sync key, or upgraded items on read.
  if (!raw || raw.version !== 2 || upgraded || raw.syncKey !== metadata.syncKey) {
    saveMetadata(account, metadata);
  }
  return metadata;
}

function saveMetadata(account, metadata) {
  fs.mkdirSync(accountDir(account), { recursive: true });
  writeFileAtomic(metadataPath(account), JSON.stringify({ ...metadata, version: 2 }, null, 2));
}

const findItem = (metadata, id) => metadata.items.find((item) => item.id === id) || null;
const activeItem = (metadata, kind) => findItem(metadata, kind === 'skin' ? metadata.activeSkin : metadata.activeCape);

/* ── PNG validation ──────────────────────────────────────────── */

function pngInfoBuffer(buffer, label = 'PNG', { animated = false } = {}) {
  if (!buffer || buffer.length <= 24) throw new Error(`The selected ${label} is too small.`);
  if (buffer.length > (animated ? MAX_ANIM_BYTES : MAX_PNG_BYTES)) throw new Error(`Choose a PNG smaller than ${animated ? 16 : 5} MB.`);
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`The selected file is not a valid ${label}.`);
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > (animated ? 32768 : 4096)) throw new Error('The PNG dimensions are not supported.');
  if (animated && width * height > 33_554_432) throw new Error('That animation is too large. Use fewer or smaller frames.');
  return { width, height, size: buffer.length };
}

/**
 * An animated cape is a vertical strip of `frames` equally tall frames plus its first frame as a
 * normal cape. Every frame size is welcome (64×32 … 2048×1024, or any custom ratio).
 */
function validateAnimatedCape(strip, still, anim) {
  const info = pngInfoBuffer(strip, 'animation', { animated: true });
  const spec = normalizeAnim(anim);
  if (!spec) throw new Error('An animated cape needs between 2 and 240 frames.');
  if (info.height % spec.frames !== 0) throw new Error(`The strip height (${info.height}px) does not divide into ${spec.frames} frames.`);
  const frameHeight = info.height / spec.frames;
  const first = pngInfoBuffer(still, 'cape');
  if (first.width !== info.width || first.height !== frameHeight) throw new Error('The cape preview must match one frame of the strip.');
  return { ...spec, width: info.width, frameHeight };
}

function pngInfo(filePath) {
  const buffer = fs.readFileSync(filePath);
  const info = pngInfoBuffer(buffer);
  return { ...info, buffer };
}

function decodeBase64Texture(value, options) {
  const raw = String(value || '').replace(/^data:image\/png;base64,/i, '');
  if (!raw) throw new Error('No texture data was received.');
  const buffer = Buffer.from(raw, 'base64');
  pngInfoBuffer(buffer, 'PNG', options);
  return buffer;
}

function dataUrl(account, file) {
  try {
    return `data:image/png;base64,${fs.readFileSync(itemPath(account, file)).toString('base64')}`;
  } catch {
    return null;
  }
}

function stripDataUrl(account, id) {
  const item = findItem(loadMetadata(account), id);
  return item?.anim ? dataUrl(account, item.file) : null;
}

/* ── public state ────────────────────────────────────────────── */

function publicItem(account, item, metadata) {
  // Only Native store capes animate; a self-made animation from an older launcher shows its first frame.
  const animated = Boolean(item.anim && item.stillFile && item.storeId);
  return {
    id: item.id,
    kind: item.kind,
    name: item.name,
    model: item.model,
    createdAt: item.createdAt,
    favorite: item.favorite,
    ageDays: Math.max(0, Math.floor((Date.now() - item.createdAt) / 86_400_000)),
    active: (item.kind === 'skin' ? metadata.activeSkin : metadata.activeCape) === item.id,
    // Animated capes expose their first frame as `url`, so anything that cannot animate shows a normal cape.
    url: dataUrl(account, item.anim && item.stillFile ? item.stillFile : item.file),
    ...(animated ? { animated: true, anim: { ...item.anim }, ...(item.storeId ? { storeId: item.storeId } : {}) } : {})
  };
}

const warmingSkins = new Map();

/**
 * Fetch and cache the player's real skin texture to `{cache}/{username}.png`.
 * Returns a promise that resolves `true` once a texture is on disk (or already
 * was) and `false` otherwise. Concurrent calls for the same username share one
 * in-flight fetch so the background warm (from `publicState`) and an awaited
 * caller (the `wardrobe:avatar` handler) never fetch twice.
 */
// Skin cache files are keyed per identity. A Microsoft account and a Native
// account can share a username, so a bare `<username>.png` let one account
// show the other's skin.
// Offline accounts are local-only: their wardrobe never touches the Native API
// (anyone could otherwise publish skins under a name they do not own).
function isLocalOnlyAccount(account) {
  return account?.type === 'offline' || String(account?.id || '').startsWith('offline-');
}

function isMicrosoftAccount(account) {
  return account?.type === 'microsoft' || account?.isMicrosoft === true;
}

function skinCacheFile(account) {
  const username = cleanName(account?.name, 'Player');
  if (!isMicrosoftAccount(account)) return path.join(cacheDir(), `${username}.png`);
  const id = String(account.uuid || account.id || username).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(cacheDir(), `ms-${id || 'player'}.png`);
}

function warmSkinCache(account) {
  if (!account?.name || account.name === 'guest' || !deps?.app) return Promise.resolve(false);
  const target = skinCacheFile(account);
  const username = path.basename(target, '.png');
  if (fs.existsSync(target)) return Promise.resolve(true);
  if (!isOnline()) return Promise.resolve(false);
  if (warmingSkins.has(username)) return warmingSkins.get(username);

  const task = (async () => {
    fs.mkdirSync(cacheDir(), { recursive: true });

    // 1. Try Native wardrobe server first (local accounts only — the server
    // looks skins up by username, which would hand a Microsoft account the
    // skin of a Native account with the same name).
    if (!isMicrosoftAccount(account) && !isLocalOnlyAccount(account)) try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      const cslRes = await fetch(`${apiRoot()}/csl/${encodeURIComponent(username)}.json`, { signal: controller.signal });
      clearTimeout(timeout);
      if (cslRes.ok) {
        const data = await cslRes.json();
        const remoteSkinUrl = data.skin || data.skins?.default || data.skins?.slim;
        if (remoteSkinUrl) {
          const tCtrl = new AbortController();
          const tTimeout = setTimeout(() => tCtrl.abort(), 4000);
          const texRes = await fetch(remoteSkinUrl, { signal: tCtrl.signal });
          clearTimeout(tTimeout);
          if (texRes.ok) {
            const buf = Buffer.from(await texRes.arrayBuffer());
            if (buf.length > 24) {
              writeFileAtomic(target, buf);
              return true;
            }
          }
        }
      }
    } catch {}

    // 2. Try Mojang session server or mc-heads for Microsoft accounts only
    if (account?.isMicrosoft || account?.type === 'microsoft') {
      let mojangUrl = null;
      const rawUuid = account.uuid ? String(account.uuid).replace(/-/g, '') : null;
      if (rawUuid) {
        try {
          const sCtrl = new AbortController();
          const sTimeout = setTimeout(() => sCtrl.abort(), 3500);
          const sess = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${rawUuid}`, { signal: sCtrl.signal });
          clearTimeout(sTimeout);
          if (sess.ok) {
            const sdata = await sess.json();
            const texProp = sdata?.properties?.find((p) => p.name === 'textures');
            if (texProp?.value) {
              const parsed = JSON.parse(Buffer.from(texProp.value, 'base64').toString('utf8'));
              mojangUrl = parsed?.textures?.SKIN?.url;
            }
          }
        } catch {}
      }

      const fetchUrl = mojangUrl || `https://mc-heads.net/skin/${encodeURIComponent(account.uuid || account.name)}`;
      const fCtrl = new AbortController();
      const fTimeout = setTimeout(() => fCtrl.abort(), 5000);
      const res = await fetch(fetchUrl, { signal: fCtrl.signal });
      clearTimeout(fTimeout);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 24) {
          writeFileAtomic(target, buf);
          return true;
        }
      }
    }
    return false;
  })().catch(() => false).finally(() => warmingSkins.delete(username));

  warmingSkins.set(username, task);
  return task;
}

const officialSkinCache = new Map(); // uuid -> { at, value }
async function officialSkin(account) {
  const uuid = String(account?.uuid || '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(uuid) || !isMicrosoftAccount(account)) return null;
  const hit = officialSkinCache.get(uuid);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return hit?.value || null;
    const data = await res.json();
    const prop = (data?.properties || []).find((p) => p.name === 'textures');
    const textures = prop?.value ? JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8'))?.textures : null;
    const skin = textures?.SKIN;
    const value = skin?.url ? {
      skinUrl: String(skin.url).replace(/^http:/, 'https:'),
      capeUrl: textures?.CAPE?.url ? String(textures.CAPE.url).replace(/^http:/, 'https:') : null,
      model: skin.metadata?.model === 'slim' ? 'slim' : 'classic'
    } : { skinUrl: null, capeUrl: null, model: 'classic' };
    officialSkinCache.set(uuid, { at: Date.now(), value });
    return value;
  } catch { return hit?.value || null; }
}

function publicState(account) {
  const metadata = loadMetadata(account);
  const items = metadata.items.map((item) => publicItem(account, item, metadata));
  const skin = items.find((item) => item.kind === 'skin' && item.active) || null;
  const cape = items.find((item) => item.kind === 'cape' && item.active) || null;

  let skinUrl = skin?.url || null;
  let capeUrl = cape?.url || null;

  // If no custom skin is active, check if we have a cached texture on disk for this account
  if (!skinUrl && account?.name && account.name !== 'guest' && deps?.app) {
    const cachedSkinPath = skinCacheFile(account);
    if (fs.existsSync(cachedSkinPath)) {
      try {
        skinUrl = `data:image/png;base64,${fs.readFileSync(cachedSkinPath).toString('base64')}`;
      } catch {}
    } else {
      warmSkinCache(account);
    }
  }

  return {
    version: 2,
    model: metadata.model,
    items,
    skins: items.filter((item) => item.kind === 'skin'),
    capes: items.filter((item) => item.kind === 'cape'),
    favorites: items.filter((item) => item.favorite),
    latest: [...items].sort((a, b) => b.createdAt - a.createdAt).slice(0, 12),
    // Field names kept stable for the account object and 3D viewer.
    active: {
      skinId: skin?.id || null,
      model: metadata.model,
      skinUrl,
      capeUrl,
      hasSkin: Boolean(skinUrl),
      hasCape: Boolean(capeUrl),
      // Whole frame strip of the active animated cape (`capeUrl` is its first frame).
      capeAnim: cape?.animated ? { ...cape.anim, stripUrl: stripDataUrl(account, cape.id) } : null,
      skin,
      cape
    }
  };
}

/* ── mutations ───────────────────────────────────────────────── */

function storeItem(account, kind, buffer, { name, model, favorite = false, anim = null, still = null } = {}) {
  const metadata = loadMetadata(account);
  const targetName = cleanName(name, kind === 'cape' ? 'Cape' : 'Skin');
  const existing = metadata.items.find((item) => item.kind === kind && item.name === targetName);

  let id;
  let file;
  if (existing) {
    id = existing.id;
    file = existing.file;
    existing.model = kind === 'skin' ? normalizeModel(model || existing.model) : 'classic';
    existing.createdAt = Date.now();
  } else {
    id = crypto.randomUUID();
    file = `${kind}-${id.slice(0, 8)}.png`;
    const item = {
      id,
      kind,
      file,
      name: targetName,
      model: kind === 'skin' ? normalizeModel(model) : 'classic',
      createdAt: Date.now(),
      favorite: Boolean(favorite)
    };
    metadata.items.unshift(item);
  }

  fs.mkdirSync(accountDir(account), { recursive: true });
  writeFileAtomic(itemPath(account, file), buffer);

  // Animated cape: keep the first frame next to the strip. Replacing an animation with a plain cape drops it.
  const target = metadata.items.find((item) => item.id === id);
  if (kind === 'cape' && target) {
    if (anim && still) {
      const stillFile = file.replace(/\.png$/, '.still.png');
      writeFileAtomic(itemPath(account, stillFile), still);
      target.anim = anim;
      target.stillFile = stillFile;
    } else {
      if (target.stillFile) fs.rmSync(itemPath(account, target.stillFile), { force: true });
      delete target.anim;
      delete target.stillFile;
    }
  }

  if (kind === 'skin') {
    metadata.activeSkin = id;
    metadata.model = existing ? existing.model : normalizeModel(model);
  } else {
    metadata.activeCape = id;
  }
  metadata.lastModifiedAt = Date.now();

  const removed = metadata.items.splice(ITEM_LIMIT);
  for (const stale of removed) {
    if (!metadata.items.some((it) => it.file === stale.file)) {
      fs.rmSync(itemPath(account, stale.file), { force: true });
      if (stale.stillFile) fs.rmSync(itemPath(account, stale.stillFile), { force: true });
    }
  }

  saveMetadata(account, metadata);
  return publicState(account);
}

function addItemFromBase64(account, { kind, dataUrl: value, name, model, anim, stillDataUrl }) {
  if (!account?.id) throw new Error('Sign in to use the locker.');
  if (kind !== 'skin' && kind !== 'cape') throw new Error('Invalid locker item.');
  if (anim) {
    // Animated capes are Native Store items: get them from the Store page, not from a file.
    throw new Error('Animated capes come from the Native Store. You can upload static capes.');
  }
  return storeItem(account, kind, decodeBase64Texture(value), { name, model });
}

async function chooseTexture(account, kind, { name = null, model = 'classic' } = {}) {
  if (!account?.id || (kind !== 'skin' && kind !== 'cape')) throw new Error('Invalid locker request.');
  const result = await dialog.showOpenDialog({
    title: kind === 'skin' ? 'Choose Minecraft skin' : 'Choose Minecraft cape',
    properties: ['openFile'],
    filters: [{ name: 'PNG texture', extensions: ['png'] }]
  });
  if (result.canceled || !result.filePaths[0]) return publicState(account);
  const filePath = result.filePaths[0];
  const info = pngInfo(filePath);
  return storeItem(account, kind, info.buffer, {
    name: name || path.basename(filePath, path.extname(filePath)),
    model
  });
}

function applyItem(account, id) {
  const metadata = loadMetadata(account);
  const item = findItem(metadata, id);
  if (!item) throw new Error('That locker item no longer exists.');
  if (item.kind === 'skin') {
    metadata.activeSkin = item.id;
    metadata.model = item.model;
  } else {
    metadata.activeCape = item.id;
  }
  metadata.lastModifiedAt = Date.now();
  saveMetadata(account, metadata);
  return publicState(account);
}

function clearActive(account, kind) {
  const metadata = loadMetadata(account);
  if (kind === 'cape') metadata.activeCape = null;
  else metadata.activeSkin = null;
  metadata.lastModifiedAt = Date.now();
  saveMetadata(account, metadata);
  return publicState(account);
}

function setFavorite(account, id, favorite) {
  const metadata = loadMetadata(account);
  const item = findItem(metadata, id);
  if (!item) throw new Error('That locker item no longer exists.');
  item.favorite = Boolean(favorite);
  saveMetadata(account, metadata);
  return publicState(account);
}

function renameItem(account, id, name) {
  const metadata = loadMetadata(account);
  const item = findItem(metadata, id);
  if (!item) throw new Error('That locker item no longer exists.');
  item.name = cleanName(name, item.kind === 'cape' ? 'Cape' : 'Skin');
  // Renaming the skin you wear changes what other devices see, so it counts as a local change to sync.
  if (item.kind === 'skin' && metadata.activeSkin === item.id) metadata.lastModifiedAt = Date.now();
  saveMetadata(account, metadata);
  return publicState(account);
}

function setModel(account, model) {
  const metadata = loadMetadata(account);
  metadata.model = normalizeModel(model);
  const skin = activeItem(metadata, 'skin');
  if (skin) skin.model = metadata.model;
  metadata.lastModifiedAt = Date.now();
  saveMetadata(account, metadata);
  return publicState(account);
}

function removeItem(account, id) {
  const metadata = loadMetadata(account);
  const item = findItem(metadata, id);
  if (!item) return publicState(account);
  metadata.items = metadata.items.filter((entry) => entry.id !== id);
  if (metadata.activeSkin === id) metadata.activeSkin = null;
  if (metadata.activeCape === id) metadata.activeCape = null;
  metadata.lastModifiedAt = Date.now();
  saveMetadata(account, metadata);
  fs.rmSync(itemPath(account, item.file), { force: true });
  if (item.stillFile) fs.rmSync(itemPath(account, item.stillFile), { force: true });
  return publicState(account);
}

/* ── sync + in-game integration ──────────────────────────────── */

function readActiveBuffers(account) {
  const metadata = loadMetadata(account);
  const read = (file) => {
    if (!file) return null;
    try {
      return fs.readFileSync(itemPath(account, file));
    } catch {
      return null;
    }
  };
  const capeItem = activeItem(metadata, 'cape');
  const hasStill = Boolean(capeItem?.anim && capeItem.stillFile);
  // `cape` is always a normal cape texture (the first frame of an animation); `capeAnim` carries the strip.
  // Only Native store capes are sent animated - the server refuses anything else anyway.
  const cape = read(hasStill ? capeItem.stillFile : capeItem?.file);
  const strip = hasStill && capeItem.storeId && cape ? read(capeItem.file) : null;
  const skinItem = activeItem(metadata, 'skin');
  return {
    metadata,
    skin: read(skinItem?.file),
    skinName: skinItem?.name || null,
    cape,
    capeAnim: strip ? { strip, frames: capeItem.anim.frames, fps: capeItem.anim.fps } : null
  };
}

/** Copies the account's worn skin, cape and cape animation into the shared texture cache (for the mod). */
function warmTextureCache(account) {
  try {
    const { skin, cape, capeAnim } = readActiveBuffers(account);
    for (const bytes of [skin, cape, capeAnim?.strip]) if (bytes) textureCache.write(bytes);
  } catch { /* best-effort */ }
  return textureCache.dir();
}

/**
 * An offline account's worn look, for the Native mod to show on this PC only
 * (never published: other players can't see offline skins). Textures are
 * written into the shared cache; returns their hashes, or null.
 */
function localLook(account) {
  if (!isLocalOnlyAccount(account) || !account?.name) return null;
  try {
    const { metadata, skin, cape } = readActiveBuffers(account);
    const skinHash = skin ? textureCache.write(skin) : null;
    const capeHash = cape ? textureCache.write(cape) : null;
    if (!skinHash && !capeHash) return null;
    const skinItem = activeItem(metadata, 'skin');
    return { name: String(account.name), skin: skinHash, cape: capeHash, slim: (skinItem?.model || metadata.model) === 'slim' };
  } catch { return null; }
}

/* ── cape store (website + launcher) ─────────────────────────── */

let catalogCache = { at: 0, data: null };
const CATALOG_TTL = 60_000;
const catalogDiskFile = () => path.join(deps.app.getPath('userData'), 'store-catalog.json');
/** The last catalogue we saw, kept on disk so the Store still opens offline. */
function readCatalogFromDisk() {
  try {
    const data = JSON.parse(fs.readFileSync(catalogDiskFile(), 'utf8'));
    return data && Array.isArray(data.items) ? data : null;
  } catch { return null; }
}
function writeCatalogToDisk(data) {
  try { fs.writeFileSync(catalogDiskFile(), JSON.stringify(data)); } catch { /* best-effort */ }
}

/** Public store catalogue (sections + items). Falls back to the last good copy when offline. */
async function fetchStoreCatalog({ force = false } = {}) {
  if (!force && catalogCache.data && Date.now() - catalogCache.at < CATALOG_TTL) return catalogCache.data;
  try {
    const response = await fetch(`${apiRoot()}/v1/store/catalog`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data?.ok || !Array.isArray(data.items)) throw new Error('Bad catalogue');
    catalogCache = { at: Date.now(), data };
    writeCatalogToDisk(data);
    scheduleStorePrefetch();
    return data;
  } catch (error) {
    if (!catalogCache.data) { const saved = readCatalogFromDisk(); if (saved) catalogCache = { at: 0, data: saved }; }
    if (catalogCache.data) return { ...catalogCache.data, stale: true };
    throw new Error(`Couldn't load the store (${error?.message || 'offline'}).`);
  }
}

async function storeCapeName(id) {
  if (!id) return null;
  try {
    const found = (await fetchStoreCatalog()).items.find((item) => item.id === id);
    if (found?.name) return found.name;
  } catch {}
  return String(id).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const stripCache = new Map(); // url -> data URL (store previews are shared by every account)

/** A store item's whole animation strip as a data URL, for the in-launcher preview. */
const stripJobs = new Map(); // url -> in-flight download, so the prefetch and the Locker never fetch the same strip twice
async function fetchStoreStrip(itemId) {
  const catalog = await fetchStoreCatalog();
  const item = catalog.items.find((entry) => entry.id === itemId);
  if (!item) throw new Error('That store item does not exist.');
  const url = item.stripUrl || item.stillUrl;
  if (!url) throw new Error('That store item has no texture.');
  if (stripCache.has(url)) return stripCache.get(url);
  if (stripJobs.has(url)) return stripJobs.get(url);
  const job = (async () => {
    // Saved to the shared texture cache, so wearing it later (or seeing it in game) needs no new download.
    const bytes = await textureCache.fetchCached(url, { maxBytes: MAX_ANIM_BYTES, timeoutMs: 25_000 });
    if (!bytes) throw new Error('Couldn’t download that cape.');
    pngInfoBuffer(bytes, item.stripUrl ? 'animation' : 'cape', { animated: Boolean(item.stripUrl) });
    const value = `data:image/png;base64,${bytes.toString('base64')}`;
    if (stripCache.size > 120) stripCache.delete(stripCache.keys().next().value);
    stripCache.set(url, value);
    return value;
  })().finally(() => stripJobs.delete(url));
  stripJobs.set(url, job);
  return job;
}

const cosmeticCache = new Map(); // item id -> { key, value }

/**
 * A store cosmetic's 3D parts for the launcher preview: { model (NCM JSON), texture, thumb } (data URLs).
 * Saved to the shared texture cache by hash, so the game (which uses the same hashes) needs no new download.
 */
async function fetchStoreCosmetic(itemId) {
  const catalog = await fetchStoreCatalog();
  const item = catalog.items.find((entry) => entry.id === itemId);
  if (!item || item.kind !== 'cosmetic' || !item.modelUrl || !item.textureUrl) throw new Error('That cosmetic does not exist.');
  return loadCosmeticAsset(item);
}

/** Only Native's own texture store is fetched for admin previews. */
function isNativeTextureUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const root = new URL(apiRoot());
    return url.origin === root.origin && url.pathname.startsWith('/csl/textures/');
  } catch { return false; }
}

/** Model + texture (+ thumbnail) of an admin-listed cosmetic, hidden ones included. */
async function fetchAdminCosmetic(item = {}) {
  const entry = { id: String(item.id || ''), slot: String(item.slot || ''), modelUrl: item.modelUrl, textureUrl: item.textureUrl, stillUrl: item.stillUrl || null };
  if (!entry.id || !isNativeTextureUrl(entry.modelUrl) || !isNativeTextureUrl(entry.textureUrl)) throw new Error('That cosmetic does not exist.');
  if (entry.stillUrl && !isNativeTextureUrl(entry.stillUrl)) entry.stillUrl = null;
  return loadCosmeticAsset(entry);
}

async function loadCosmeticAsset(item) {
  const itemId = item.id;
  const key = `${item.modelUrl}|${item.textureUrl}|${item.stillUrl}`;
  const hit = cosmeticCache.get(itemId);
  if (hit && hit.key === key) return hit.value;
  const [model, texture, thumb] = await Promise.all([
    textureCache.fetchCached(item.modelUrl, { maxBytes: 1024 * 1024, timeoutMs: 20_000 }), // same caps as the API and the mod
    textureCache.fetchCached(item.textureUrl, { maxBytes: 2 * 1024 * 1024, timeoutMs: 20_000 }),
    // items without their own thumbnail use the texture sheet as stillUrl: that's not a picture of the piece
    item.stillUrl && item.stillUrl !== item.textureUrl ? textureCache.fetchCached(item.stillUrl, { maxBytes: 5 * 1024 * 1024, timeoutMs: 20_000 }).catch(() => null) : null
  ]);
  if (!model || !texture) throw new Error('Couldn’t download that cosmetic.');
  const value = {
    id: item.id,
    slot: item.slot,
    model: JSON.parse(model.toString('utf8')),
    texture: `data:image/png;base64,${texture.toString('base64')}`,
    thumb: thumb ? `data:image/png;base64,${thumb.toString('base64')}` : null
  };
  if (cosmeticCache.size > 150) cosmeticCache.delete(cosmeticCache.keys().next().value);
  cosmeticCache.set(itemId, { key, value });
  return value;
}

/**
 * Warm every store cape/cosmetic in the background (shared disk cache + memory) so the Store and
 * Locker open instantly. Runs a few downloads at a time, never throws, and skips what's already warm.
 */
let prefetchTimer = null;
let prefetchRunning = false;
function scheduleStorePrefetch(delay = 1500) {
  if (prefetchTimer || prefetchRunning) return;
  prefetchTimer = setTimeout(() => { prefetchTimer = null; prefetchStoreAssets().catch(() => {}); }, delay);
  prefetchTimer.unref?.();
}
async function prefetchStoreAssets() {
  if (prefetchRunning) return;
  prefetchRunning = true;
  try {
    const items = (catalogCache.data?.items || []).slice();
    const queue = items.filter((item) => (item.kind === 'cosmetic' ? item.modelUrl && item.textureUrl : item.stripUrl || item.stillUrl));
    const worker = async () => {
      while (queue.length) {
        const item = queue.shift();
        try {
          if (item.kind === 'cosmetic') await fetchStoreCosmetic(item.id);
          else await fetchStoreStrip(item.id);
        } catch { /* best-effort */ }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  } finally {
    prefetchRunning = false;
  }
}

/**
 * Wear a 3D cosmetic (hat, glasses, back item, shoes) on the signed-in Native account, or with itemId null take
 * `slot` off. Cosmetics live on the server only (no local mirror): returns { wearing, owned }.
 */
async function wearStoreCosmetic(account, itemId, slot, side = null) {
  const native = resolveBillingAccount(account);
  requireStoreAccount(native);
  const response = await fetch(`${apiRoot()}/v1/store/equip`, {
    method: 'POST',
    headers: storeHeaders(native),
    body: JSON.stringify(itemId ? { itemId, ...(side ? { side } : {}) } : { slot, itemId: null, ...(side ? { side } : {}) }),
    signal: AbortSignal.timeout(15_000)
  });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok || body.ok === false) throw new Error(body.error || `The store couldn’t do that (HTTP ${response.status}).`);
  return { wearing: body.wearing || {}, sides: body.sides || null, owned: Array.isArray(body.owned) ? body.owned : null };
}

/** Recolours a dyeable cosmetic of the account's locker (color null = the item's own colour). */
async function dyeStoreCosmetic(account, itemId, color) {
  const native = resolveBillingAccount(account);
  requireStoreAccount(native);
  const response = await fetch(`${apiRoot()}/v1/store/dye`, {
    method: 'POST',
    headers: storeHeaders(native),
    body: JSON.stringify({ itemId, color: color || null }),
    signal: AbortSignal.timeout(15_000)
  });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok || body.ok === false) throw new Error(body.error || `The store couldn’t dye that (HTTP ${response.status}).`);
  return { dyes: body.dyes && typeof body.dyes === 'object' ? body.dyes : {} };
}

/** A dyeable cosmetic's texture in one colour, as a data URL (cached on disk like every texture). */
async function fetchDyedTexture(itemId, color) {
  const hex = String(color || '').replace(/^#/, '').toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) throw new Error('Pick a colour like #ff8800.');
  const catalog = await fetchStoreCatalog();
  const item = catalog.items.find((entry) => entry.id === itemId);
  if (!item || !item.dyeable || !item.dyeUrl) throw new Error('That cosmetic can’t be dyed.');
  const png = await textureCache.fetchCached(`${item.dyeUrl}${hex}`, { maxBytes: 2 * 1024 * 1024, timeoutMs: 20_000 });
  if (!png) throw new Error('Couldn’t load that colour.');
  return { texture: `data:image/png;base64,${png.toString('base64')}` };
}

/** Wear a Native Store cloak on a premium account (or take it off). Its Mojang skin stays. */
async function equipPremiumStoreItem(account, itemId) {
  const native = resolveBillingAccount(account);
  requireStoreAccount(native);
  const response = await fetch(`${apiRoot()}/v1/store/equip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...storeHeaders(native) },
    body: JSON.stringify({ itemId: itemId || null }),
    signal: AbortSignal.timeout(15_000)
  });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok || body.ok === false) throw new Error(body.error || `The store couldn’t equip that (HTTP ${response.status}).`);
  return { premiumEquipped: body.equipped || null, equipped: body.equipped || null, owned: Array.isArray(body.owned) ? body.owned : null };
}

/** Equip (or, with itemId null, remove) a store cloak on the signed-in Native account, then mirror it locally. */
async function equipStoreItem(account, itemId) {
  if (!account?.token || isMicrosoftAccount(account) || isLocalOnlyAccount(account)) {
    throw new Error('Sign in with a Native account to use store items.');
  }
  if (!isOnline()) throw new Error('You’re offline. Connect to the internet to change your cape.');
  const response = await fetch(`${apiRoot()}/v1/store/equip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${account.token}`, 'X-Native-Token': account.token },
    body: JSON.stringify({ itemId: itemId || null }),
    signal: AbortSignal.timeout(15_000)
  });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok || body.ok === false) throw new Error(body.error || `The store couldn’t equip that (HTTP ${response.status}).`);

  if (!itemId) {
    const metadata = loadMetadata(account);
    metadata.activeCape = null;
    metadata.lastModifiedAt = Date.now();
    metadata.lastSyncedAt = Date.now();
    saveMetadata(account, metadata);
    return publicState(account);
  }
  // The server now holds the animation: pull it into the local locker.
  const metadata = loadMetadata(account);
  metadata.lastModifiedAt = 0;
  saveMetadata(account, metadata);
  return (await pullRemoteWardrobe(account, { authoritative: true })) || publicState(account);
}

function storeHeaders(account) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${account.token}`, 'X-Native-Token': account.token };
}

function requireStoreAccount(account) {
  if (!account?.token || isMicrosoftAccount(account) || isLocalOnlyAccount(account)) {
    throw new Error('Sign in with a Native account to use store items.');
  }
  if (!isOnline()) throw new Error('You’re offline. Connect to the internet to use the store.');
}

/** `{ equipped, owned: [{ id, acquiredAt }] }` for the signed-in Native account. */
async function fetchStoreMe(account) {
  requireStoreAccount(account);
  const response = await fetch(`${apiRoot()}/v1/store/me`, { headers: storeHeaders(account), signal: AbortSignal.timeout(10_000) });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok || body.ok === false) throw new Error(body.error || `Couldn’t load your capes (HTTP ${response.status}).`);
  return { equipped: body.equipped || null, premiumEquipped: body.premiumEquipped || body.equipped || null, wearing: body.wearing || {}, sides: body.sides || {}, owned: Array.isArray(body.owned) ? body.owned : [], dyes: body.dyes && typeof body.dyes === 'object' ? body.dyes : {}, wishlist: Array.isArray(body.wishlist) ? body.wishlist : [], prefs: body.prefs || null };
}
async function toggleStoreWish(account, itemId, on) {
  requireStoreAccount(account);
  const response = await fetch(`${apiRoot()}/v1/store/wishlist`, { method: 'POST', headers: storeHeaders(account), body: JSON.stringify({ itemId, on: Boolean(on) }), signal: AbortSignal.timeout(10_000) });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok || body.ok === false) throw new Error(body.error || `Couldn’t update your wishlist (HTTP ${response.status}).`);
  return { wishlist: Array.isArray(body.wishlist) ? body.wishlist : [] };
}
async function setStorePrefs(account, prefs) {
  requireStoreAccount(account);
  const response = await fetch(`${apiRoot()}/v1/store/prefs`, { method: 'POST', headers: storeHeaders(account), body: JSON.stringify(prefs || {}), signal: AbortSignal.timeout(10_000) });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok || body.ok === false) throw new Error(body.error || `Couldn’t save that (HTTP ${response.status}).`);
  return { prefs: body.prefs || null };
}

/** A premium account connected to Native (or its linked identity) uses the Native session stored in main. */
function resolveBillingAccount(account) {
  if (account?.token && account?.type === 'native') return account;
  const id = account?.linkedFrom || (account?.type === 'microsoft' ? account.id : null);
  if (!id) return account;
  try {
    const auth = require('./auth');
    const stored = (auth.readAccounts(deps.app.getPath('userData')).accounts || []).find((a) => a.id === id);
    return auth.linkedIdentity(stored) || account;
  } catch { return account; }
}

/** Calls a billing endpoint with the account's session. */
async function billingRequest(account, pathname, { method = 'GET', body = null } = {}) {
  requireStoreAccount(account);
  const response = await fetch(`${apiRoot()}${pathname}`, {
    method,
    headers: storeHeaders(account),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000)
  });
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `Billing request failed (HTTP ${response.status}).`);
  return payload;
}

/** Only ever hand Paddle / Native pages to the system browser. */
function openBillingPage(url) {
  let parsed = null;
  try { parsed = new URL(String(url || '')); } catch { return false; }
  const host = parsed.hostname.toLowerCase();
  const allowed = parsed.protocol === 'https:' && (host === 'nativelaunch.xyz' || host.endsWith('.nativelaunch.xyz') || host.endsWith('.paddle.com'));
  if (!allowed) return false;
  shell.openExternal(parsed.toString());
  return true;
}

/** Adds a store item to (or, with remove, takes it out of) the account's locker. */
async function claimStoreItem(account, itemId, { remove = false } = {}) {
  requireStoreAccount(account);
  const response = await fetch(`${apiRoot()}/v1/store/${remove ? 'unclaim' : 'claim'}`, {
    method: 'POST',
    headers: storeHeaders(account),
    body: JSON.stringify({ itemId }),
    signal: AbortSignal.timeout(15_000)
  });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok || body.ok === false) throw new Error(body.error || `The store couldn’t do that (HTTP ${response.status}).`);
  let state = null;
  if (remove && body.profile) {
    const metadata = loadMetadata(account);
    metadata.lastModifiedAt = 0;
    saveMetadata(account, metadata);
    state = (await pullRemoteWardrobe(account, { authoritative: true })) || publicState(account);
  }
  return { owned: body.owned || [], equipped: body.equipped || null, wearing: body.wearing || null, state };
}

async function pullRemoteWardrobe(account, { authoritative = false } = {}) {
  if (!account?.name || account.name === 'guest') return null;
  // The Native server resolves wardrobes by username: never pull another
  // account's cosmetics into a Microsoft profile that happens to share it.
  if (isMicrosoftAccount(account) || isLocalOnlyAccount(account)) return null;
  if (!isOnline()) return null;
  const username = cleanName(account.name, 'Player');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`${apiRoot()}/csl/${encodeURIComponent(username)}.json`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const remote = await res.json();
    if (!remote) return null;

    const metadata = loadMetadata(account);
    let changed = false;

    // One-time clean-up: earlier versions starred every skin pulled from the
    // website/cloud. Un-star those once (a marker file keeps later stars intact).
    try {
      const marker = path.join(accountDir(account), '.sync-star-fixed');
      if (!fs.existsSync(marker)) {
        const syncedName = `${username}'s Skin`;
        for (const it of metadata.items) {
          if (it.kind === 'skin' && it.favorite && it.name === syncedName) { it.favorite = false; changed = true; }
        }
        fs.mkdirSync(accountDir(account), { recursive: true });
        writeFileAtomic(marker, '1');
      }
    } catch {}

    // 1. Remote Skin
    const remoteSkinUrl = remote.skin || remote.skins?.default || remote.skins?.slim;
    if (remoteSkinUrl) {
      const hashMatch = remoteSkinUrl.match(/\/textures\/([a-f0-9]{64})/i);
      const remoteHash = hashMatch ? hashMatch[1].toLowerCase() : null;
      const currentActiveSkin = activeItem(metadata, 'skin');
      let needsDownload = true;
      const autoName = `${username}'s Skin`;
      const remoteSkinName = typeof remote.skinName === 'string' && remote.skinName.trim() ? cleanName(remote.skinName, 'Skin') : null;
      // Use the name the player gave the skin (kept on the server), not the generic one.
      const adoptName = (it) => {
        if (it && remoteSkinName && it.name !== remoteSkinName) { it.name = remoteSkinName; changed = true; }
      };

      if (currentActiveSkin) {
        try {
          const currentBuf = fs.readFileSync(itemPath(account, currentActiveSkin.file));
          const currentHash = crypto.createHash('sha256').update(currentBuf).digest('hex').toLowerCase();
          if (remoteHash && currentHash === remoteHash) {
            needsDownload = false;
            adoptName(currentActiveSkin);
          }
        } catch {}
      }

      if (needsDownload) {
        try {
          const sCtrl = new AbortController();
          const sTimeout = setTimeout(() => sCtrl.abort(), 8000);
          const sRes = await fetch(remoteSkinUrl, { signal: sCtrl.signal });
          clearTimeout(sTimeout);
          if (sRes.ok) {
            const buf = Buffer.from(await sRes.arrayBuffer());
            if (buf.length > 24) {
              const model = remote.model === 'slim' ? 'slim' : 'classic';
              let existingItem = null;
              for (const it of metadata.items) {
                if (it.kind === 'skin') {
                  try {
                    const b = fs.readFileSync(itemPath(account, it.file));
                    if (crypto.createHash('sha256').update(b).digest('hex').toLowerCase() === (remoteHash || '')) {
                      existingItem = it;
                      break;
                    }
                  } catch {}
                }
              }

              if (existingItem) {
                adoptName(existingItem);
                metadata.activeSkin = existingItem.id;
                metadata.model = model;
                changed = true;
              } else {
                const id = crypto.randomUUID();
                const file = `skin-${id.slice(0, 8)}.png`;
                fs.mkdirSync(accountDir(account), { recursive: true });
                writeFileAtomic(itemPath(account, file), buf);
                const item = {
                  id,
                  kind: 'skin',
                  file,
                  name: remoteSkinName || autoName,
                  model,
                  createdAt: Date.now(),
                  favorite: false
                };
                metadata.items.unshift(item);
                metadata.activeSkin = id;
                metadata.model = model;
                changed = true;
              }
            }
          }
        } catch (err) {
          console.warn('Failed to download remote skin:', err?.message || err);
        }
      }
    }

    // 2. Remote Cape. An animated cape arrives as `capeAnimation` (the whole frame strip) next to the
    // normal first-frame `cape`, which is also what older launchers and vanilla clients use.
    const remoteCapeUrl = remote.cape || remote.capes?.default;
    const remoteSpec = remote.capeAnimation?.url ? normalizeAnim(remote.capeAnimation) : null;
    const sha = (value) => crypto.createHash('sha256').update(value).digest('hex').toLowerCase();
    const hashOf = (url) => (String(url || '').match(/\/textures\/([a-f0-9]{64})/i) || [])[1]?.toLowerCase() || null;
    const readItemFile = (file) => { try { return fs.readFileSync(itemPath(account, file)); } catch { return null; } };
    // Store textures are content-addressed: reuse (and fill) the shared cache the mod reads too.
    const download = (url, limit, ms) => textureCache.fetchCached(url, { maxBytes: limit, timeoutMs: ms });

    if (authoritative && !remoteSpec && !remoteCapeUrl && metadata.activeCape) {
      // The cloud copy has no cape any more (taken off on the website / another device).
      metadata.activeCape = null;
      changed = true;
    }

    if (remoteSpec) {
      const stripHash = hashOf(remote.capeAnimation.url);
      const sameStrip = stripHash
        ? metadata.items.find((it) => it.kind === 'cape' && it.anim && (readItemFile(it.file) ? sha(readItemFile(it.file)) === stripHash : false))
        : null;
      if (sameStrip) {
        if (metadata.activeCape !== sameStrip.id || sameStrip.anim.fps !== remoteSpec.fps || sameStrip.anim.frames !== remoteSpec.frames) {
          sameStrip.anim = remoteSpec;
          metadata.activeCape = sameStrip.id;
          changed = true;
        }
        if (remote.capeStore && sameStrip.storeId !== remote.capeStore) { sameStrip.storeId = String(remote.capeStore).slice(0, 64); changed = true; }
      } else {
        try {
          const [strip, still] = await Promise.all([
            download(remote.capeAnimation.url, MAX_ANIM_BYTES, 25_000),
            remoteCapeUrl ? download(remoteCapeUrl, MAX_PNG_BYTES, 8000) : null
          ]);
          if (strip && still) {
            validateAnimatedCape(strip, still, remoteSpec);
            const id = crypto.randomUUID();
            const file = `cape-${id.slice(0, 8)}.png`;
            const stillFile = `cape-${id.slice(0, 8)}.still.png`;
            fs.mkdirSync(accountDir(account), { recursive: true });
            writeFileAtomic(itemPath(account, file), strip);
            writeFileAtomic(itemPath(account, stillFile), still);
            metadata.items.unshift({
              id,
              kind: 'cape',
              file,
              stillFile,
              anim: remoteSpec,
              ...(remote.capeStore ? { storeId: String(remote.capeStore).slice(0, 64) } : {}),
              name: cleanName(await storeCapeName(remote.capeStore), `${username}'s Animated Cape`),
              model: 'classic',
              createdAt: Date.now(),
              favorite: false
            });
            metadata.activeCape = id;
            changed = true;
          }
        } catch (err) {
          console.warn('Failed to download remote animated cape:', err?.message || err);
        }
      }
    } else if (remoteCapeUrl) {
      const remoteHash = hashOf(remoteCapeUrl);
      const currentActiveCape = activeItem(metadata, 'cape');
      let needsDownload = true;

      if (currentActiveCape) {
        // An animated cape's normal cape texture is its first frame.
        const currentBuf = readItemFile(currentActiveCape.anim ? currentActiveCape.stillFile : currentActiveCape.file);
        if (currentBuf && remoteHash && sha(currentBuf) === remoteHash && !currentActiveCape.anim) needsDownload = false;
      }

      if (needsDownload) {
        try {
          const buf = await download(remoteCapeUrl, MAX_PNG_BYTES, 8000);
          if (buf) {
            const bufHash = sha(buf);
            const official = getOfficialCapeByHash(bufHash);
            const capeName = official ? official.name : `${username}'s Cape`;

            let existingItem = null;
            for (const it of metadata.items) {
              if (it.kind === 'cape' && !it.anim) {
                if (official && it.name === official.name) {
                  existingItem = it;
                  break;
                }
                const b = readItemFile(it.file);
                if (b && sha(b) === bufHash) {
                  existingItem = it;
                  break;
                }
              }
            }

            if (existingItem) {
              writeFileAtomic(itemPath(account, existingItem.file), buf);
              metadata.activeCape = existingItem.id;
              changed = true;
            } else {
              const id = crypto.randomUUID();
              const file = `cape-${id.slice(0, 8)}.png`;
              fs.mkdirSync(accountDir(account), { recursive: true });
              writeFileAtomic(itemPath(account, file), buf);
              metadata.items.unshift({
                id,
                kind: 'cape',
                file,
                name: capeName,
                model: 'classic',
                createdAt: Date.now(),
                favorite: false
              });
              metadata.activeCape = id;
              changed = true;
            }
          }
        } catch (err) {
          console.warn('Failed to download remote cape:', err?.message || err);
        }
      }
    }

    if (remote.updatedAt) {
      metadata.lastSyncedAt = Date.parse(remote.updatedAt) || Date.now();
    }

    if (changed) {
      saveMetadata(account, metadata);
    }
    return publicState(account);
  } catch {
    return null;
  }
}

/**
 * Live refresh: the Native server says this account's locker changed (website, another PC, a store
 * equip). Pulls only when the cloud copy is newer than both our last sync and our own edits, so a change
 * we just made is never overwritten by the echo of an older one.
 */
async function refreshFromCloud(account) {
  if (!account?.name || account.name === 'guest') return { ok: false };
  if (isMicrosoftAccount(account) || isLocalOnlyAccount(account) || !isOnline()) return { ok: false };
  const metadata = loadMetadata(account);
  let remoteTime = 0;
  try {
    const response = await fetch(`${apiRoot()}/csl/${encodeURIComponent(cleanName(account.name, 'Player'))}.json`, { signal: AbortSignal.timeout(5000) });
    if (response.status === 404) return { ok: true, pulled: false };
    if (!response.ok) return { ok: false };
    remoteTime = Date.parse((await response.json())?.updatedAt) || 0;
  } catch {
    return { ok: false };
  }
  if (!(remoteTime > (Number(metadata.lastSyncedAt) || 0) && remoteTime > (Number(metadata.lastModifiedAt) || 0))) return { ok: true, pulled: false };
  const state = await pullRemoteWardrobe(account, { authoritative: true });
  return { ok: true, pulled: Boolean(state), state };
}

async function syncWardrobe(account) {
  if (!account?.name || account.name === 'guest') return { ok: false };
  if (isLocalOnlyAccount(account)) return { ok: false, localOnly: true, state: publicState(account) };
  if (isMicrosoftAccount(account)) return { ok: false };
  // Offline: the on-disk locker is the source of truth. Callers re-sync when the
  // connection comes back, so nothing is lost.
  if (!isOnline()) return { ok: false, offline: true, state: publicState(account) };
  const username = cleanName(account.name, 'Player');
  let metadata = loadMetadata(account);

  // If local has no active skin and no active cape, pull from remote first!
  const hasLocalActive = Boolean(metadata.activeSkin || metadata.activeCape);
  if (!hasLocalActive) {
    const pulled = await pullRemoteWardrobe(account);
    if (pulled?.active?.hasSkin || pulled?.active?.hasCape) {
      return { ok: true, pulled: true, state: pulled };
    }
  }

  // Check remote timestamp to see if another device updated remote more recently
  try {
    const checkCtrl = new AbortController();
    const checkTimeout = setTimeout(() => checkCtrl.abort(), 4000);
    const checkRes = await fetch(`${apiRoot()}/csl/${encodeURIComponent(username)}.json`, { signal: checkCtrl.signal });
    clearTimeout(checkTimeout);
    if (checkRes.ok) {
      const remoteData = await checkRes.json();
      const remoteTime = Date.parse(remoteData?.updatedAt) || 0;
      const localSyncedTime = Number(metadata.lastSyncedAt) || 0;
      const localModifiedTime = Number(metadata.lastModifiedAt) || 0;

      // If remote was updated more recently than our last sync AND more recently than our local modifications
      if (remoteTime > localSyncedTime && remoteTime > localModifiedTime) {
        const pulled = await pullRemoteWardrobe(account);
        if (pulled) return { ok: true, pulled: true, state: pulled };
      }
    }
  } catch {}

  // Otherwise, push local outfit to the server
  const { skin, skinName, cape, capeAnim } = readActiveBuffers(account);
  metadata = loadMetadata(account);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let response;
  let rotatedKey = null;
  try {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${metadata.syncKey}`
    };
    // Replace a guessable legacy key with a random one on the next upload.
    if (isLegacySyncKey(account, metadata.syncKey)) {
      rotatedKey = newSyncKey();
      headers['X-Native-Rotate-Key'] = rotatedKey;
    }
    if (account?.token) {
      headers['X-Native-Token'] = account.token;
    }
    response = await fetch(`${apiRoot()}/v1/wardrobe`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        username: account.name,
        model: metadata.model,
        skin: skin ? skin.toString('base64') : null,
        ...(skin ? { skinName } : {}),
        cape: cape ? cape.toString('base64') : null,
        ...(capeAnim ? { capeAnim: { strip: capeAnim.strip.toString('base64'), frames: capeAnim.frames, fps: capeAnim.fps } } : {})
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json())?.error || ''; } catch {}
    throw new Error(detail || `Wardrobe sync failed (HTTP ${response.status})`);
  }

  metadata.lastSyncedAt = Date.now();
  if (rotatedKey) metadata.syncKey = rotatedKey;
  saveMetadata(account, metadata);
  const resData = await response.json();
  return { ...resData, ok: true, state: publicState(account) };
}

function syncWardrobeInBackground(account) {
  // Wardrobe editing is offline-first. Publish when a connection is available,
  // but never make a local selection wait for the network.
  void syncWardrobe(account).catch(() => {});
}

function normalizeOfficialProfile(profile) {
  if (!profile) return profile;
  const capes = (profile.capes || []).map(cape => {
    let alias = cape.alias || cape.name || '';
    if (!alias && cape.id) {
      alias = cape.id.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
    return {
      ...cape,
      alias: alias || 'Official Cape',
      url: cape.url ? cape.url.replace(/^http:\/\//, 'https://') : cape.url
    };
  });
  const skins = (profile.skins || []).map(skin => ({
    ...skin,
    url: skin.url ? skin.url.replace(/^http:\/\//, 'https://') : skin.url
  }));
  return { ...profile, capes, skins };
}

async function minecraftRequest(account, pathname, options = {}, { forceRefresh = false } = {}) {
  const accountId = typeof account === 'string' ? account : account?.id;
  const token = await deps.auth?.getMinecraftAccessToken?.(accountId, { forceRefresh });
  if (!token) {
    const err = new Error('Your Microsoft session expired. Sign in again to manage official cosmetics.');
    err.code = 'AUTH_EXPIRED';
    throw err;
  }
  const response = await fetch(`https://api.minecraftservices.com${pathname}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json())?.errorMessage || ''; } catch {}
    const err = new Error(detail || `Minecraft profile request failed (HTTP ${response.status})`);
    err.status = response.status;
    if (response.status === 401 || response.status === 403) err.code = 'AUTH_EXPIRED';
    else if (response.status === 402) err.code = 'NO_ENTITLEMENT';
    else if (response.status === 404) err.code = 'NO_PROFILE';
    throw err;
  }
  if (response.status === 204) return null;
  return response.json();
}

/**
 * Fetch the official Minecraft profile (skins + capes owned by the account).
 * Tries the cached profile from MSMC first, then api.minecraftservices.com,
 * and falls back to Mojang session server if required.
 */
function officialProfileCacheFile(account) {
  const id = String(typeof account === 'string' ? account : (account?.id || account?.uuid || account?.name || 'guest')).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(cacheDir(), `official-${id || 'player'}.json`);
}

function readOfficialProfileCache(account) {
  try {
    const parsed = JSON.parse(fs.readFileSync(officialProfileCacheFile(account), 'utf8'));
    return parsed && (parsed.capes || parsed.skins) ? { ...parsed, cached: true } : null;
  } catch { return null; }
}

function writeOfficialProfileCache(account, profile) {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(officialProfileCacheFile(account), JSON.stringify(profile));
  } catch {}
}

/** Cached copy first when offline, fresh copy (and cache refresh) when online. */
async function officialProfile(account, options = {}) {
  if (!isOnline()) {
    const cached = readOfficialProfileCache(account);
    if (cached) return cached;
  }
  try {
    const fresh = await fetchOfficialProfile(account, options);
    if (fresh?.partial) {
      // a public-profile fallback lists only the worn cape: keep the full list we saved before
      const cached = readOfficialProfileCache(account);
      if (cached && !cached.partial && (cached.capes || []).length > (fresh.capes || []).length) {
        const worn = fresh.capes?.[0]?.url;
        const capes = cached.capes.map((cape) => ({ ...cape, state: worn && cape.url === worn ? 'ACTIVE' : 'INACTIVE' }));
        return { ...cached, capes, cached: true };
      }
      return fresh;
    }
    if (fresh) writeOfficialProfileCache(account, fresh);
    return fresh;
  } catch (error) {
    const cached = readOfficialProfileCache(account);
    if (cached) return cached;
    throw error;
  }
}

async function fetchOfficialProfile(account, { forceRefresh = false } = {}) {
  const accountId = typeof account === 'string' ? account : account?.id;
  const isMicrosoft = account?.type === 'microsoft' || account?.isMicrosoft;

  // 1. For Microsoft accounts, query the official Minecraft services profile API directly.
  // This endpoint returns ALL owned capes (both ACTIVE and INACTIVE) and skins.
  if (isMicrosoft || !deps.auth?.isOffline?.(accountId)) {
    try {
      const res = await minecraftRequest(account, '/minecraft/profile', {}, { forceRefresh });
      if (res && (res.capes || res.skins)) {
        return normalizeOfficialProfile(res);
      }
    } catch (error) {
      if (!forceRefresh && (error?.code === 'AUTH_EXPIRED' || error?.status === 401)) {
        try {
          const refreshed = await minecraftRequest(account, '/minecraft/profile', {}, { forceRefresh: true });
          if (refreshed && (refreshed.capes || refreshed.skins)) {
            return normalizeOfficialProfile(refreshed);
          }
        } catch {}
      }
    }
  }

  // 2. Fallback to cached profile from MSMC if services API is unreachable
  try {
    const cached = await deps.auth?.getMinecraftProfile?.(accountId);
    if (cached?.capes?.length || cached?.skins?.length) {
      return normalizeOfficialProfile(cached);
    }
  } catch {}

  // 3. Fallback to Mojang session server by UUID (or username lookup)
  let rawUuid = account?.uuid || (typeof account === 'string' && account.length > 20 ? account : null);
  let cleanUuid = rawUuid ? String(rawUuid).replace(/-/g, '') : '';

  if (!cleanUuid && account?.name && account.name !== 'guest') {
    try {
      const mojangRes = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(account.name)}`);
      if (mojangRes.ok) {
        const udata = await mojangRes.json();
        if (udata?.id) cleanUuid = udata.id;
      }
    } catch {}
  }

  if (cleanUuid) {
    try {
      const sessionRes = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${cleanUuid}`);
      if (sessionRes.ok) {
        const data = await sessionRes.json();
        const texturesProp = data?.properties?.find(p => p.name === 'textures');
        if (texturesProp?.value) {
          const parsed = JSON.parse(Buffer.from(texturesProp.value, 'base64').toString('utf8'));
          const capes = [];
          if (parsed?.textures?.CAPE?.url) {
            const capeUrl = parsed.textures.CAPE.url.replace(/^http:\/\//, 'https://');
            let known = getOfficialCapeByHash(capeUrl.split('/').pop());
            if (!known) {
              try {
                const img = await fetch(capeUrl, { signal: AbortSignal.timeout(6000) });
                if (img.ok) known = getOfficialCapeByHash(crypto.createHash('sha256').update(Buffer.from(await img.arrayBuffer())).digest('hex'));
              } catch {}
            }
            capes.push({
              id: 'official-session-cape',
              state: 'ACTIVE',
              url: capeUrl,
              alias: known?.name || 'Minecraft cape'
            });
          }
          return {
            id: data.id,
            name: data.name,
            // the public profile only shows the cape being worn, not every cape the account owns
            partial: true,
            skins: parsed?.textures?.SKIN ? [{
              id: 'official-skin',
              state: 'ACTIVE',
              url: parsed.textures.SKIN.url.replace(/^http:\/\//, 'https://'),
              variant: parsed.textures.SKIN.metadata?.model === 'slim' ? 'SLIM' : 'CLASSIC'
            }] : [],
            capes
          };
        }
      }
    } catch {}
  }

  throw new Error('Could not fetch official Minecraft cosmetics. Please check your connection or sign in again.');
}

async function applyOfficialSkin(account, id) {
  const metadata = loadMetadata(account);
  const item = id ? findItem(metadata, id) : activeItem(metadata, 'skin');
  if (!item?.file) throw new Error('Pick a skin from your locker before publishing it.');
  const filePath = itemPath(account, item.file);
  const form = new FormData();
  form.append('variant', item.model === 'slim' ? 'SLIM' : 'CLASSIC');
  form.append('file', new Blob([fs.readFileSync(filePath)], { type: 'image/png' }), `${item.name || 'skin'}.png`);
  // Uploading a skin file is a multipart POST (PUT only exists on the old Mojang API and fails).
  await minecraftRequest(account, '/minecraft/profile/skins', { method: 'POST', body: form });
  // Avatars read the cached texture: replace it so they show the new skin straight away.
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    writeFileAtomic(skinCacheFile(account), fs.readFileSync(filePath));
  } catch {}
  return officialProfile(account, { forceRefresh: true });
}

async function activateOfficialCape(account, capeId) {
  if (!capeId) {
    await minecraftRequest(account, '/minecraft/profile/capes/active', { method: 'DELETE' });
  } else {
    await minecraftRequest(account, '/minecraft/profile/capes/active', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capeId })
    });
  }
  return officialProfile(account, { forceRefresh: true });
}

/** Save the active (or given) skin/cape PNG somewhere the user chooses. */
async function exportItem(account, id = null) {
  const metadata = loadMetadata(account);
  const item = id ? findItem(metadata, id) : activeItem(metadata, 'skin');
  if (!item?.file) throw new Error('Nothing to export yet — upload a skin first.');
  const result = await dialog.showSaveDialog({
    title: item.kind === 'cape' ? 'Save cape' : 'Save skin',
    defaultPath: `${String(item.name || item.kind).replace(/[^A-Za-z0-9 _-]/g, '')}.png`,
    filters: [{ name: 'PNG texture', extensions: ['png'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  fs.copyFileSync(itemPath(account, item.file), result.filePath);
  return { ok: true, path: result.filePath, name: item.name };
}

// Bump when the install logic changes so existing instances re-resolve the jar.
const CSL_TRACKER_SCHEMA = 2;
const CSL_SITE_NAME = 'Native Client Wardrobe';

function removeStrayLoaders(modsDir, jars, keep) {
  for (const jar of jars) {
    if (jar === keep) continue;
    try { fs.rmSync(path.join(modsDir, jar), { force: true }); } catch {}
  }
}

/**
 * CustomSkinLoader asks each site in its load list in order and stops at the
 * first one that knows the player. Its defaults put Mojang ahead of LocalSkin,
 * so an offline/Native name that also exists on Mojang (or a stale profile on
 * any site) wins over the outfit picked in the Locker. Keep the order:
 *   1. LocalSkin   – the active Locker outfit, written right before launch
 *   2. Native API  – everyone else's Native outfit
 *   3. whatever CSL had (Mojang, OptiFine capes, …)
 * On the very first run CSL has no config yet; the ExtraList entry adds the
 * Native API and the next launch settles the full order.
 */
function configureSkinLoader(cslDir, model) {
  const configPath = path.join(cslDir, 'CustomSkinLoader.json');
  const extraDir = path.join(cslDir, 'ExtraList');
  const root = `${apiRoot()}/csl/`;
  const apiSite = { name: CSL_SITE_NAME, type: 'CustomSkinAPI', root };
  const localSite = {
    name: 'LocalSkin',
    type: 'Legacy',
    checkPNG: false,
    skin: 'LocalSkin/skins/{USERNAME}.png',
    model: model === 'slim' ? 'slim' : 'default',
    cape: 'LocalSkin/capes/{USERNAME}.png',
    elytra: 'LocalSkin/elytras/{USERNAME}.png'
  };
  const isOurApi = (site) => String(site?.type || '').toLowerCase() === 'customskinapi' &&
    (site?.name === CSL_SITE_NAME || site?.name === 'Native Client Wardrobe' || /nativelaunch\.xyz\/csl\/?$/i.test(String(site?.root || '')) || String(site?.root || '') === root);

  let config = null;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}

  if (config && typeof config === 'object' && Array.isArray(config.loadlist)) {
    const existingLocal = config.loadlist.find((site) => site?.name === 'LocalSkin');
    const rest = config.loadlist.filter((site) => site && site.name !== 'LocalSkin' && !isOurApi(site));
    config.loadlist = [{ ...(existingLocal || {}), ...localSite }, apiSite, ...rest];
    writeFileAtomic(configPath, JSON.stringify(config, null, 2));
    for (const file of ['NativeWardrobe.json', 'NoctraWardrobe.json']) {
      fs.rmSync(path.join(extraDir, file), { force: true });
    }
    return { managed: true };
  }

  const payload = JSON.stringify(apiSite, null, 2);
  writeFileAtomic(path.join(extraDir, 'NativeWardrobe.json'), payload);
  fs.rmSync(path.join(extraDir, 'NoctraWardrobe.json'), { force: true });
  return { managed: false };
}

/**
 * Prepare an instance's CustomSkinLoader folder:
 *  - the active skin/cape as LocalSkin textures,
 *  - an ExtraList entry pointing at the Native wardrobe API so other players
 *    (and other machines) resolve the same textures over the network,
 *  - the CustomSkinLoader mod itself, pinned to the instance's MC version and loader.
 */
async function prepareFabricInstance(instance, account, onState = () => {}) {
  if (!instance?.id) return { installed: false };
  const gameDir = path.join(deps.app.getPath('userData'), 'minecraft', 'instances', String(instance.id));
  const modsDir = path.join(gameDir, 'mods');
  const cslDir = path.join(gameDir, 'CustomSkinLoader');
  const { metadata, skin, cape } = account ? readActiveBuffers(account) : { metadata: emptyMetadata(), skin: null, cape: null };
  const username = String(account?.name || 'Player').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 16) || 'Player';

  const localSkin = path.join(cslDir, 'LocalSkin', 'skins', `${username}.png`);
  const localCape = path.join(cslDir, 'LocalSkin', 'capes', `${username}.png`);
  if (skin) writeFileAtomic(localSkin, skin);
  else fs.rmSync(localSkin, { force: true });
  if (cape) writeFileAtomic(localCape, cape);
  else fs.rmSync(localCape, { force: true });

  configureSkinLoader(cslDir, metadata.model);

  const trackerPath = path.join(cslDir, '.native-loader.json');
  const legacyTrackerPath = path.join(cslDir, '.noctra-loader.json');
  let tracker = {};
  try {
    const activeTracker = fs.existsSync(trackerPath) ? trackerPath : (fs.existsSync(legacyTrackerPath) ? legacyTrackerPath : trackerPath);
    tracker = JSON.parse(fs.readFileSync(activeTracker, 'utf8'));
  } catch {}

  const mcVersion = String(instance.version || instance.mc_version || '');
  const loaderName = String(instance.loader || instance.mc_loader || 'Fabric').toLowerCase();
  const modLoader = loaderName.includes('forge')
    ? (loaderName.includes('neo') ? 'neoforge' : 'forge')
    : loaderName.includes('quilt')
      ? 'quilt'
      : loaderName.includes('legacy')
        ? 'legacy-fabric'
        : 'fabric';

  const trackedPath = tracker.filename ? path.join(modsDir, path.basename(tracker.filename)) : null;
  const strayJars = () => (fs.existsSync(modsDir) ? fs.readdirSync(modsDir) : [])
    .filter((f) => /customskinloader/i.test(f) && f.toLowerCase().endsWith('.jar'));
  // Switching loaders (Fabric -> Forge, …) must swap the CustomSkinLoader build too.
  if (tracker.mcVersion === mcVersion && (tracker.loader || 'fabric') === modLoader && tracker.schema === CSL_TRACKER_SCHEMA && trackedPath && fs.existsSync(trackedPath)) {
    removeStrayLoaders(modsDir, strayJars(), path.basename(trackedPath));
    return { installed: true, filename: path.basename(trackedPath), model: metadata.model };
  }

  try {
    onState('Downloading CustomSkinLoader mod…');
    let versions = [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);

    try {
      const params = new URLSearchParams({
        loaders: JSON.stringify([modLoader]),
        game_versions: JSON.stringify([mcVersion])
      });
      const response = await fetch(`https://api.modrinth.com/v2/project/idMHQ4n2/version?${params}`, { signal: controller.signal });
      if (response.ok) {
        versions = await response.json();
      }
    } catch {}

    // Fallback: if no builds matched the exact version tag, fetch the latest loader release (Universal build).
    // Legacy Fabric targets old game versions, where a "latest" build would not load.
    if (!versions?.length && modLoader !== 'legacy-fabric') {
      try {
        const params = new URLSearchParams({
          loaders: JSON.stringify([modLoader])
        });
        const response = await fetch(`https://api.modrinth.com/v2/project/idMHQ4n2/version?${params}`, { signal: controller.signal });
        if (response.ok) {
          versions = await response.json();
        }
      } catch {}
    }
    clearTimeout(timeout);

    const file = versions?.[0]?.files?.find((entry) => entry.primary) || versions?.[0]?.files?.[0];
    if (!file?.url || !file?.filename) throw new Error('No compatible CustomSkinLoader build was found.');

    const target = path.join(modsDir, path.basename(file.filename));
    const expected = { sha1: file.hashes?.sha1 || null, size: file.size || null };
    if (!(await artifactMatches(target, expected))) {
      fs.mkdirSync(modsDir, { recursive: true });
      await downloadFile(file.url, target, {
        retries: 3,
        expectedHashes: expected.sha1 ? { sha1: expected.sha1 } : {}
      });
    }

    // Exactly one CustomSkinLoader: an older or loader-specific copy left in
    // mods/ would either fail to patch this version or fight the new one.
    removeStrayLoaders(modsDir, strayJars(), path.basename(target));
    writeFileAtomic(trackerPath, JSON.stringify({ schema: CSL_TRACKER_SCHEMA, filename: path.basename(target), version: versions[0].version_number, mcVersion, loader: modLoader }, null, 2));
    if (fs.existsSync(legacyTrackerPath)) fs.rmSync(legacyTrackerPath, { force: true });
    return { installed: true, filename: path.basename(target), model: metadata.model };
  } catch (error) {
    // A wardrobe integration failure must never stop the game itself. Reuse a
    // previously installed copy when possible and expose the reason in logs.
    return {
      installed: Boolean(trackedPath && fs.existsSync(trackedPath)) || strayJars().length > 0,
      warning: error.message,
      model: metadata.model
    };
  }
}

/**
 * Drops the CustomSkinLoader copy this launcher installed (tracked by
 * `.noctra-loader.json`) once the Native Client mod takes over skins. A copy the
 * player added by hand is left alone.
 */
function removeSkinLoader(instance) {
  if (!instance?.id) return { removed: false };
  const gameDir = path.join(deps.app.getPath('userData'), 'minecraft', 'instances', String(instance.id));
  const cslDir = path.join(gameDir, 'CustomSkinLoader');
  const modsDir = path.join(gameDir, 'mods');
  let removed = false;
  for (const name of ['.noctra-loader.json', '.native-loader.json']) {
    const trackerPath = path.join(cslDir, name);
    let tracker = null;
    try { tracker = JSON.parse(fs.readFileSync(trackerPath, 'utf8')); } catch { continue; }
    if (tracker?.filename) {
      const jar = path.join(modsDir, path.basename(String(tracker.filename)));
      try { if (fs.existsSync(jar)) { fs.rmSync(jar, { force: true }); removed = true; } } catch {}
    }
    try { fs.rmSync(trackerPath, { force: true }); } catch {}
  }
  return { removed };
}

async function artifactMatches(filePath, { sha1, size }) {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size === 0 || (size && stat.size !== size)) return false;
    if (!sha1) return true;
    const hash = crypto.createHash('sha1');
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
    return hash.digest('hex').toLowerCase() === String(sha1).toLowerCase();
  } catch { return false; }
}

/* ── IPC ─────────────────────────────────────────────────────── */

function init(dependencies, ipcMain) {
  deps = dependencies;
  try { textureCache.init(deps.app.getPath('userData')); } catch { /* cache is optional */ }
  /* Pull the store catalogue and every cape/cosmetic in the background once the launcher is up. */
  setTimeout(() => { fetchStoreCatalog().catch(() => {}); }, 2500).unref?.();
  /* A premium account playing as its linked Native identity sends that identity
     without a token (the renderer never sees it); act with the Native session
     stored on the Microsoft account in main. */
  const resolveLinked = (acc) => {
    if (!acc || typeof acc !== 'object' || acc.token || !acc.linkedFrom || acc.type !== 'native') return acc;
    try {
      const auth = require('./auth');
      const stored = (auth.readAccounts(deps.app.getPath('userData')).accounts || []).find((a) => a.id === acc.linkedFrom);
      const identity = auth.linkedIdentity(stored);
      return identity && identity.id === acc.id ? { ...acc, ...identity } : acc;
    } catch { return acc; }
  };
  const resolvePayload = (payload) => (payload && typeof payload === 'object' && payload.account && typeof payload.account === 'object'
    ? { ...payload, account: resolveLinked(payload.account) }
    : resolveLinked(payload));
  const ipc = { handle: (channel, fn) => ipcMain.handle(channel, (event, payload, ...rest) => fn(event, resolvePayload(payload), ...rest)) };
  const profileResult = (operation) => async (...args) => {
    try { return { ok: true, profile: await operation(...args) }; }
    catch (error) {
      return {
        ok: false,
        error: String(error?.message || error),
        code: error?.code || null,
        status: error?.status || null
      };
    }
  };

  ipc.handle('wardrobe:get', (_event, account) => publicState(account));
  // Lightweight skin/cape resolver for avatar UIs (the account switcher list,
  // onboarding, etc.). Local accounts (Native/offline) aren't on mc-heads, so
  // their real texture lives in the wardrobe: return the active skin, warming
  // the on-disk cache from the Native server first when nothing is active yet.
  ipc.handle('wardrobe:avatar', async (_event, account) => {
    let state = publicState(account);
    if (!state.active.skinUrl && account?.name && account.name !== 'guest') {
      try { await warmSkinCache(account); } catch {}
      state = publicState(account);
    }
    return {
      skinUrl: state.active.skinUrl || null,
      capeUrl: state.active.capeUrl || null,
      model: state.active.model || 'classic'
    };
  });
  // The current official Mojang skin of a Microsoft account (public session
  // server, no token). mc-heads caches UUID lookups and can serve a stale
  // Steve, so avatar UIs crop the real texture instead.
  ipc.handle('wardrobe:officialSkin', async (_event, account) => officialSkin(account));
  ipc.handle('wardrobe:pull', (_event, account) => pullRemoteWardrobe(account));
  ipc.handle('wardrobe:upload', (_event, payload) => {
    const state = addItemFromBase64(payload.account, payload);
    syncWardrobeInBackground(payload.account);
    return state;
  });
  ipc.handle('wardrobe:choose', async (_event, payload) => {
    const state = await chooseTexture(payload.account, payload.kind, { model: payload.model });
    syncWardrobeInBackground(payload.account);
    return state;
  });
  ipc.handle('wardrobe:apply', (_event, { account, id }) => {
    const state = applyItem(account, id);
    syncWardrobeInBackground(account);
    return state;
  });
  ipc.handle('wardrobe:clearActive', (_event, { account, kind }) => {
    const state = clearActive(account, kind);
    syncWardrobeInBackground(account);
    return state;
  });
  ipc.handle('wardrobe:favorite', (_event, { account, id, favorite }) => setFavorite(account, id, favorite));
  ipc.handle('wardrobe:rename', (_event, { account, id, name }) => {
    const state = renameItem(account, id, name);
    syncWardrobeInBackground(account);
    return state;
  });
  ipc.handle('wardrobe:remove', (_event, { account, id }) => {
    const state = removeItem(account, id);
    syncWardrobeInBackground(account);
    return state;
  });
  ipc.handle('wardrobe:setModel', (_event, payload) => {
    // Accepts both the new { account, model } and the legacy { account, slot, model }.
    const state = setModel(payload.account, payload.model);
    syncWardrobeInBackground(payload.account);
    return state;
  });
  ipc.handle('wardrobe:export', (_event, { account, id }) => exportItem(account, id));
  ipc.handle('wardrobe:sync', (_event, account) => syncWardrobe(account));
  ipc.handle('wardrobe:refresh', (_event, account) => refreshFromCloud(account));
  ipc.handle('store:catalog', async (_event, options) => {
    try { return { ok: true, ...(await fetchStoreCatalog(options || {})) }; } catch (error) { return { ok: false, error: error.message }; }
  });
  ipc.handle('store:strip', async (_event, itemId) => {
    try { return { ok: true, url: await fetchStoreStrip(String(itemId || '')) }; } catch (error) { return { ok: false, error: error.message }; }
  });
  ipc.handle('admin:cosmeticAsset', async (_event, item) => {
    try { return { ok: true, ...(await fetchAdminCosmetic(item || {})) }; } catch (error) { return { ok: false, error: error.message }; }
  });
  ipc.handle('store:cosmetic', async (_event, itemId) => {
    try { return { ok: true, ...(await fetchStoreCosmetic(String(itemId || ''))) }; } catch (error) { return { ok: false, error: error.message }; }
  });
  ipc.handle('store:wish', async (_event, { account, itemId, on }) => {
    try { return { ok: true, ...(await toggleStoreWish(resolveBillingAccount(account), String(itemId || ''), on)) }; } catch (error) { return { ok: false, error: error.message }; }
  });
  ipc.handle('store:prefs', async (_event, { account, prefs }) => {
    try { return { ok: true, ...(await setStorePrefs(resolveBillingAccount(account), prefs)) }; } catch (error) { return { ok: false, error: error.message }; }
  });
  ipc.handle('store:dye', async (_event, { account, itemId, color }) => {
    try { return { ok: true, ...(await dyeStoreCosmetic(account, String(itemId || ''), color ? String(color) : null)) }; } catch (error) { return { ok: false, error: error.message }; }
  });
  ipc.handle('store:dyeTexture', async (_event, { itemId, color }) => {
    try { return { ok: true, ...(await fetchDyedTexture(String(itemId || ''), String(color || ''))) }; } catch (error) { return { ok: false, error: error.message }; }
  });
  ipc.handle('store:wear', async (_event, { account, itemId, slot, side }) => {
    try { return { ok: true, ...(await wearStoreCosmetic(account, itemId ? String(itemId) : null, String(slot || ''), side === 'left' || side === 'right' ? side : null)) }; } catch (error) { return { ok: false, error: error.message }; }
  });
  ipc.handle('store:me', async (_event, account) => {
    try { return { ok: true, ...(await fetchStoreMe(resolveBillingAccount(account))) }; } catch (error) { return { ok: false, error: error.message }; }
  });
  ipc.handle('store:claim', async (_event, { account, itemId }) => {
    try { return { ok: true, ...(await claimStoreItem(resolveBillingAccount(account), String(itemId || ''))) }; } catch (error) { return { ok: false, error: error.message }; }
  });
  ipc.handle('store:unclaim', async (_event, { account, itemId }) => {
    try { return { ok: true, ...(await claimStoreItem(resolveBillingAccount(account), String(itemId || ''), { remove: true })) }; } catch (error) { return { ok: false, error: error.message }; }
  });
  ipc.handle('billing:config', async () => {
    try {
      const response = await fetch(`${apiRoot()}/v1/billing/config`, { signal: AbortSignal.timeout(10_000) });
      const payload = await response.json();
      return { ok: true, ...payload };
    } catch (error) { return { ok: false, enabled: false, error: error.message }; }
  });
  ipc.handle('billing:me', async (_event, account) => {
    try { return { ok: true, ...(await billingRequest(resolveBillingAccount(account), '/v1/billing/me')) }; } catch (error) { return { ok: false, error: error.message }; }
  });
  ipc.handle('billing:checkout', async (_event, { account, kind, itemId, plan }) => {
    try {
      const payload = await billingRequest(resolveBillingAccount(account), '/v1/billing/checkout', { method: 'POST', body: { kind, itemId, plan } });
      if (!openBillingPage(payload.url)) throw new Error('Couldn’t open the checkout page.');
      return { ok: true, transactionId: payload.transactionId };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipc.handle('billing:portal', async (_event, account) => {
    try {
      const payload = await billingRequest(resolveBillingAccount(account), '/v1/billing/portal', { method: 'POST', body: {} });
      if (!openBillingPage(payload.url)) throw new Error('Couldn’t open billing.');
      return { ok: true };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipc.handle('store:redeem', async (_event, { account, code }) => {
    try { return { ok: true, ...(await billingRequest(resolveBillingAccount(account), '/v1/store/redeem', { method: 'POST', body: { code: String(code || '') } })) }; } catch (error) { return { ok: false, error: error.message }; }
  });
  ipc.handle('store:equip', async (_event, { account, itemId, target }) => {
    if (target === 'premium' || isMicrosoftAccount(account)) {
      try { return { ok: true, ...(await equipPremiumStoreItem(account, itemId)) }; } catch (error) { return { ok: false, error: error.message }; }
    }
    try { return { ok: true, state: await equipStoreItem(account, itemId) }; } catch (error) { return { ok: false, error: error.message }; }
  });
  ipc.handle('wardrobe:officialProfile', profileResult((_event, account) => officialProfile(account)));
  ipc.handle('wardrobe:reauthOfficialProfile', profileResult(async (_event, account) => {
    return officialProfile(account, { forceRefresh: true });
  }));
  ipc.handle('wardrobe:applyOfficialSkin', profileResult((_event, { account, id }) => applyOfficialSkin(account, id)));
  ipc.handle('wardrobe:activateOfficialCape', profileResult((_event, { account, capeId }) => activateOfficialCape(account, capeId)));
}

module.exports = {
  init,
  warmTextureCache,
  localLook,
  publicState,
  pngInfo,
  pngInfoBuffer,
  validateAnimatedCape,
  fetchStoreCatalog,
  addItemFromBase64,
  applyItem,
  clearActive,
  removeItem,
  setFavorite,
  setModel,
  exportItem,
  prepareFabricInstance,
  removeSkinLoader,
  configureSkinLoader,
  migrateLegacy,
  pullRemoteWardrobe,
  refreshFromCloud,
  syncWardrobe,
  warmSkinCache,
  deterministicSyncKey,
  isLegacySyncKey,
  newSyncKey,
  OFFICIAL_CAPES,
  API_ROOT
};
