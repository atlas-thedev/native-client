const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { dialog } = require('electron');
const { downloadFile, writeFileAtomic } = require('./download');
const safeFile = require('./safeFile');

/**
 * Locker / wardrobe storage (main process).
 *
 * Every skin and cape the player uploads is kept as a library item in
 * `{userData}/wardrobe/{accountKey}/`. One skin and one cape are *active*; the
 * active pair is what CustomSkinLoader renders in game and what gets published
 * to the Noctra wardrobe API (api.nativelaunch.xyz, see skin-server/).
 *
 * Older profiles stored three fixed "slots" (skin + cape + model each). Those
 * are migrated on read: every filled slot becomes a library item and the
 * selected slot becomes the active outfit.
 */

const API_ROOT = 'https://api.nativelaunch.xyz';

/**
 * The wardrobe API usually runs on Noctra Cloud (scripts/api.nativelaunch.xyz.nginx
 * proxies it to skin-server/server.js on port 3418). Set NATIVE_WARDROBE_API to
 * point a build at a self-hosted instance, e.g. http://127.0.0.1:3418 for the
 * server started by `npm run skin-server`.
 */
const apiRoot = () => String(process.env.NATIVE_WARDROBE_API || API_ROOT).replace(/\/+$/, '');
const SLOT_COUNT = 3; // legacy wardrobe.json
const ITEM_LIMIT = 60;
const MAX_PNG_BYTES = 5 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

let deps = null;

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

function normalizeItem(raw, fallbackId) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind === 'cape' ? 'cape' : raw.kind === 'skin' ? 'skin' : null;
  if (!kind) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId,
    kind,
    file: String(raw.file || ''),
    name: cleanName(raw.name, kind === 'cape' ? 'Cape' : 'Skin'),
    model: normalizeModel(raw.model),
    createdAt: Number(raw.createdAt) || Date.now(),
    favorite: Boolean(raw.favorite)
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

function pngInfoBuffer(buffer, label = 'PNG') {
  if (!buffer || buffer.length <= 24) throw new Error(`The selected ${label} is too small.`);
  if (buffer.length > MAX_PNG_BYTES) throw new Error('Choose a PNG smaller than 5 MB.');
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`The selected file is not a valid ${label}.`);
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096) throw new Error('The PNG dimensions are not supported.');
  return { width, height, size: buffer.length };
}

function pngInfo(filePath) {
  const buffer = fs.readFileSync(filePath);
  const info = pngInfoBuffer(buffer);
  return { ...info, buffer };
}

function decodeBase64Texture(value) {
  const raw = String(value || '').replace(/^data:image\/png;base64,/i, '');
  if (!raw) throw new Error('No texture data was received.');
  const buffer = Buffer.from(raw, 'base64');
  pngInfoBuffer(buffer);
  return buffer;
}

function dataUrl(account, file) {
  try {
    return `data:image/png;base64,${fs.readFileSync(itemPath(account, file)).toString('base64')}`;
  } catch {
    return null;
  }
}

/* ── public state ────────────────────────────────────────────── */

function publicItem(account, item, metadata) {
  return {
    id: item.id,
    kind: item.kind,
    name: item.name,
    model: item.model,
    createdAt: item.createdAt,
    favorite: item.favorite,
    ageDays: Math.max(0, Math.floor((Date.now() - item.createdAt) / 86_400_000)),
    active: (item.kind === 'skin' ? metadata.activeSkin : metadata.activeCape) === item.id,
    url: dataUrl(account, item.file)
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
// Skin cache files are keyed per identity. A Microsoft account and a Noctra
// account can share a username, so a bare `<username>.png` let one account
// show the other's skin.
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
  if (warmingSkins.has(username)) return warmingSkins.get(username);

  const task = (async () => {
    fs.mkdirSync(cacheDir(), { recursive: true });

    // 1. Try Noctra wardrobe server first (local accounts only — the server
    // looks skins up by username, which would hand a Microsoft account the
    // skin of a Noctra account with the same name).
    if (!isMicrosoftAccount(account)) try {
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
      skin,
      cape
    }
  };
}

/* ── mutations ───────────────────────────────────────────────── */

function storeItem(account, kind, buffer, { name, model, favorite = false } = {}) {
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
    }
  }

  saveMetadata(account, metadata);
  return publicState(account);
}

function addItemFromBase64(account, { kind, dataUrl: value, name, model }) {
  if (!account?.id) throw new Error('Sign in to use the locker.');
  if (kind !== 'skin' && kind !== 'cape') throw new Error('Invalid locker item.');
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
  return publicState(account);
}

/* ── sync + in-game integration ──────────────────────────────── */

function readActiveBuffers(account) {
  const metadata = loadMetadata(account);
  const read = (item) => {
    if (!item) return null;
    try {
      return fs.readFileSync(itemPath(account, item.file));
    } catch {
      return null;
    }
  };
  return {
    metadata,
    skin: read(activeItem(metadata, 'skin')),
    cape: read(activeItem(metadata, 'cape'))
  };
}

async function pullRemoteWardrobe(account) {
  if (!account?.name || account.name === 'guest') return null;
  // The Noctra server resolves wardrobes by username: never pull another
  // account's cosmetics into a Microsoft profile that happens to share it.
  if (isMicrosoftAccount(account)) return null;
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

    // 1. Remote Skin
    const remoteSkinUrl = remote.skin || remote.skins?.default || remote.skins?.slim;
    if (remoteSkinUrl) {
      const hashMatch = remoteSkinUrl.match(/\/textures\/([a-f0-9]{64})/i);
      const remoteHash = hashMatch ? hashMatch[1].toLowerCase() : null;
      const currentActiveSkin = activeItem(metadata, 'skin');
      let needsDownload = true;

      if (currentActiveSkin) {
        try {
          const currentBuf = fs.readFileSync(itemPath(account, currentActiveSkin.file));
          const currentHash = crypto.createHash('sha256').update(currentBuf).digest('hex').toLowerCase();
          if (remoteHash && currentHash === remoteHash) {
            needsDownload = false;
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
                  name: `${username}'s Skin`,
                  model,
                  createdAt: Date.now(),
                  favorite: true
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

    // 2. Remote Cape
    const remoteCapeUrl = remote.cape || remote.capes?.default;
    if (remoteCapeUrl) {
      const hashMatch = remoteCapeUrl.match(/\/textures\/([a-f0-9]{64})/i);
      const remoteHash = hashMatch ? hashMatch[1].toLowerCase() : null;
      const currentActiveCape = activeItem(metadata, 'cape');
      let needsDownload = true;

      if (currentActiveCape) {
        try {
          const currentBuf = fs.readFileSync(itemPath(account, currentActiveCape.file));
          const currentHash = crypto.createHash('sha256').update(currentBuf).digest('hex').toLowerCase();
          if (remoteHash && currentHash === remoteHash) {
            needsDownload = false;
          }
        } catch {}
      }

      if (needsDownload) {
        try {
          const cCtrl = new AbortController();
          const cTimeout = setTimeout(() => cCtrl.abort(), 8000);
          const cRes = await fetch(remoteCapeUrl, { signal: cCtrl.signal });
          clearTimeout(cTimeout);
          if (cRes.ok) {
            const buf = Buffer.from(await cRes.arrayBuffer());
            if (buf.length > 24) {
              const bufHash = crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
              const official = getOfficialCapeByHash(bufHash);
              const capeName = official ? official.name : `${username}'s Cape`;

              let existingItem = null;
              for (const it of metadata.items) {
                if (it.kind === 'cape') {
                  if (official && it.name === official.name) {
                    existingItem = it;
                    break;
                  }
                  try {
                    const b = fs.readFileSync(itemPath(account, it.file));
                    if (crypto.createHash('sha256').update(b).digest('hex').toLowerCase() === bufHash) {
                      existingItem = it;
                      break;
                    }
                  } catch {}
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
                const item = {
                  id,
                  kind: 'cape',
                  file,
                  name: capeName,
                  model: 'classic',
                  createdAt: Date.now(),
                  favorite: false
                };
                metadata.items.unshift(item);
                metadata.activeCape = id;
                changed = true;
              }
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

async function syncWardrobe(account) {
  if (!account?.name || account.name === 'guest') return { ok: false };
  if (isMicrosoftAccount(account)) return { ok: false };
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
  const { skin, cape } = readActiveBuffers(account);
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
      headers['X-Noctra-Rotate-Key'] = rotatedKey;
    }
    if (account?.token) {
      headers['X-Noctra-Token'] = account.token;
    }
    response = await fetch(`${apiRoot()}/v1/wardrobe`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        username: account.name,
        model: metadata.model,
        skin: skin ? skin.toString('base64') : null,
        cape: cape ? cape.toString('base64') : null
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
async function officialProfile(account, { forceRefresh = false } = {}) {
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
            capes.push({
              id: 'official-session-cape',
              state: 'ACTIVE',
              url: parsed.textures.CAPE.url.replace(/^http:\/\//, 'https://'),
              alias: 'Minecraft cape'
            });
          }
          return {
            id: data.id,
            name: data.name,
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
  await minecraftRequest(account, '/minecraft/profile/skins', { method: 'PUT', body: form });
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
const CSL_SITE_NAME = 'Noctra Client Wardrobe';

function removeStrayLoaders(modsDir, jars, keep) {
  for (const jar of jars) {
    if (jar === keep) continue;
    try { fs.rmSync(path.join(modsDir, jar), { force: true }); } catch {}
  }
}

/**
 * CustomSkinLoader asks each site in its load list in order and stops at the
 * first one that knows the player. Its defaults put Mojang ahead of LocalSkin,
 * so an offline/Noctra name that also exists on Mojang (or a stale profile on
 * any site) wins over the outfit picked in the Locker. Keep the order:
 *   1. LocalSkin   – the active Locker outfit, written right before launch
 *   2. Noctra API  – everyone else's Noctra outfit
 *   3. whatever CSL had (Mojang, OptiFine capes, …)
 * On the very first run CSL has no config yet; the ExtraList entry adds the
 * Noctra API and the next launch settles the full order.
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
    for (const file of ['NoctraWardrobe.json', 'NativeWardrobe.json']) {
      fs.rmSync(path.join(extraDir, file), { force: true });
    }
    return { managed: true };
  }

  const payload = JSON.stringify(apiSite, null, 2);
  writeFileAtomic(path.join(extraDir, 'NoctraWardrobe.json'), payload);
  fs.rmSync(path.join(extraDir, 'NativeWardrobe.json'), { force: true });
  return { managed: false };
}

/**
 * Prepare an instance's CustomSkinLoader folder:
 *  - the active skin/cape as LocalSkin textures,
 *  - an ExtraList entry pointing at the Noctra wardrobe API so other players
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

  const trackerPath = path.join(cslDir, '.noctra-loader.json');
  const legacyTrackerPath = path.join(cslDir, '.native-loader.json');
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

  ipcMain.handle('wardrobe:get', (_event, account) => publicState(account));
  // Lightweight skin/cape resolver for avatar UIs (the account switcher list,
  // onboarding, etc.). Local accounts (Noctra/offline) aren't on mc-heads, so
  // their real texture lives in the wardrobe: return the active skin, warming
  // the on-disk cache from the Noctra server first when nothing is active yet.
  ipcMain.handle('wardrobe:avatar', async (_event, account) => {
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
  ipcMain.handle('wardrobe:pull', (_event, account) => pullRemoteWardrobe(account));
  ipcMain.handle('wardrobe:upload', (_event, payload) => {
    const state = addItemFromBase64(payload.account, payload);
    syncWardrobeInBackground(payload.account);
    return state;
  });
  ipcMain.handle('wardrobe:choose', async (_event, payload) => {
    const state = await chooseTexture(payload.account, payload.kind, { model: payload.model });
    syncWardrobeInBackground(payload.account);
    return state;
  });
  ipcMain.handle('wardrobe:apply', (_event, { account, id }) => {
    const state = applyItem(account, id);
    syncWardrobeInBackground(account);
    return state;
  });
  ipcMain.handle('wardrobe:clearActive', (_event, { account, kind }) => {
    const state = clearActive(account, kind);
    syncWardrobeInBackground(account);
    return state;
  });
  ipcMain.handle('wardrobe:favorite', (_event, { account, id, favorite }) => setFavorite(account, id, favorite));
  ipcMain.handle('wardrobe:rename', (_event, { account, id, name }) => renameItem(account, id, name));
  ipcMain.handle('wardrobe:remove', (_event, { account, id }) => {
    const state = removeItem(account, id);
    syncWardrobeInBackground(account);
    return state;
  });
  ipcMain.handle('wardrobe:setModel', (_event, payload) => {
    // Accepts both the new { account, model } and the legacy { account, slot, model }.
    const state = setModel(payload.account, payload.model);
    syncWardrobeInBackground(payload.account);
    return state;
  });
  ipcMain.handle('wardrobe:export', (_event, { account, id }) => exportItem(account, id));
  ipcMain.handle('wardrobe:sync', (_event, account) => syncWardrobe(account));
  ipcMain.handle('wardrobe:officialProfile', profileResult((_event, account) => officialProfile(account)));
  ipcMain.handle('wardrobe:reauthOfficialProfile', profileResult(async (_event, account) => {
    return officialProfile(account, { forceRefresh: true });
  }));
  ipcMain.handle('wardrobe:applyOfficialSkin', profileResult((_event, { account, id }) => applyOfficialSkin(account, id)));
  ipcMain.handle('wardrobe:activateOfficialCape', profileResult((_event, { account, capeId }) => activateOfficialCape(account, capeId)));
}

module.exports = {
  init,
  publicState,
  pngInfo,
  pngInfoBuffer,
  addItemFromBase64,
  applyItem,
  clearActive,
  removeItem,
  setFavorite,
  setModel,
  exportItem,
  prepareFabricInstance,
  configureSkinLoader,
  migrateLegacy,
  pullRemoteWardrobe,
  syncWardrobe,
  warmSkinCache,
  deterministicSyncKey,
  isLegacySyncKey,
  newSyncKey,
  OFFICIAL_CAPES,
  API_ROOT
};
