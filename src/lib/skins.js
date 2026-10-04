/* ============================================================
   Native — player renders

   Only rendered head/avatar images are used. The raw skin PNG is
   never shown, so the UI can't flash a flat texture before the
   rendered image arrives.
   ============================================================ */

export const SKIN_SERVICE = 'https://mc-heads.net';
export const FALLBACK_SKIN = 'MHF_Steve';

export const SKIN_RENDER_SIZES = { avatar: 128, head: 128 };
const KIND_PATHS = { avatar: '/avatar/', head: '/head/' };

export function normalizeKind(kind) {
  return kind === 'head' ? 'head' : 'avatar';
}

/**
 * True for accounts whose identity is generated locally (Native/offline). Their
 * UUIDs and usernames aren't premium Mojang accounts, so the public renderer
 * returns Steve — their real texture must come from the wardrobe instead.
 */
export function isLocalIdentity(account) {
  const rawId = account?.id;
  const rawUuid = account?.uuid;
  return account?.type === 'native'
    || account?.type === 'offline'
    || String(rawId || '').startsWith('native-')
    || String(rawId || '').startsWith('offline-')
    || String(rawUuid || '').startsWith('native-')
    || String(rawUuid || '').startsWith('offline-');
}

/**
 * Resolve an account to the identifier understood by the public skin renderer.
 * Microsoft UUIDs are authoritative. Native/offline UUIDs are generated locally,
 * so their skins come from wardrobe; the public renderer returns Steve/Alex.
 */
export function skinIdentifier(account, uuid, name) {
  const localIdentity = isLocalIdentity(account)
    || String(uuid || '').startsWith('native-')
    || String(uuid || '').startsWith('offline-');

  if (localIdentity) {
    return account?.model === 'slim' ? 'MHF_Alex' : FALLBACK_SKIN;
  }

  const rawUuid = account?.uuid || uuid;
  const rawName = account?.name || name;
  const rawId = account?.id;

  let raw = FALLBACK_SKIN;
  if (rawUuid && rawUuid !== 'guest' && !String(rawUuid).startsWith('offline-') && !String(rawUuid).startsWith('native-') && !String(rawUuid).startsWith('native-')) {
    raw = rawUuid;
  } else if (rawName && rawName !== 'guest') {
    raw = rawName;
  } else if (rawId && rawId !== 'guest' && !String(rawId).startsWith('offline-') && !String(rawId).startsWith('native-') && !String(rawId).startsWith('native-')) {
    raw = rawId;
  }

  const value = String(raw).trim();
  if (!value || value === 'guest') return FALLBACK_SKIN;
  return value.replace(/-/g, '');
}

export const accountIdentifier = skinIdentifier;

export function skinRenderUrl(kind, identifier, size) {
  const safeKind = normalizeKind(kind);
  const path = KIND_PATHS[safeKind];
  const pixels = Number(size) > 0 ? Math.round(Number(size)) : SKIN_RENDER_SIZES[safeKind];
  const id = encodeURIComponent(identifier || FALLBACK_SKIN);
  return SKIN_SERVICE + path + id + '/' + pixels;
}

export function fallbackSkinFor(kind = 'avatar', size) {
  return skinRenderUrl(kind, FALLBACK_SKIN, size);
}

const readyUrls = new Set();
const failedUrls = new Set();
const pending = new Map();

export function isAvatarReady(url) {
  return Boolean(url) && readyUrls.has(url);
}

export function didAvatarFail(url) {
  return Boolean(url) && failedUrls.has(url);
}

export function preloadAvatar(url) {
  if (!url) return Promise.resolve(false);
  if (readyUrls.has(url)) return Promise.resolve(true);
  if (failedUrls.has(url)) return Promise.resolve(false);
  if (pending.has(url)) return pending.get(url);

  const task = new Promise((resolve) => {
    if (typeof Image === 'undefined') { resolve(false); return; }
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => { readyUrls.add(url); resolve(true); };
    image.onerror = () => { failedUrls.add(url); resolve(false); };
    image.src = url;
  }).finally(() => pending.delete(url));

  pending.set(url, task);
  return task;
}

export function preloadAccountAvatars(accounts = [], size = 64) {
  accounts.forEach((account) => preloadAvatar(skinRenderUrl('avatar', skinIdentifier(account), size)));
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

/**
 * skinview3d returns `void` when the texture is already decoded (canvas/image)
 * and a Promise when it still needs to fetch a URL. Normalize both forms so
 * callers can use one reliable async path without mistaking a successful
 * synchronous load for a failure.
 */
export function loadSkinTexture(viewer, source, model) {
  try {
    return Promise.resolve(viewer.loadSkin(source, { model }));
  } catch (error) {
    return Promise.reject(error);
  }
}

export function isSlimArmTexture(context) {
  // Check the unused areas in a slim skin texture:
  // In a slim skin (3px arm width):
  // Right Arm:
  //   (54, 20, 2, 12) - unused right arm back strip
  //   (50, 16, 2, 4)  - unused right arm top/bottom strip
  // Left Arm:
  //   (46, 52, 2, 12) - unused left arm back strip
  //   (42, 48, 2, 4)  - unused left arm top/bottom strip
  const checkArea = (x, y, w, h) => {
    try {
      const { data } = context.getImageData(x, y, w, h);
      let transparentCount = 0;
      let blackCount = 0;
      let whiteCount = 0;
      const totalPixels = w * h;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        if (a < 128) {
          transparentCount += 1;
        } else if (r === 0 && g === 0 && b === 0) {
          blackCount += 1;
        } else if (r === 255 && g === 255 && b === 255) {
          whiteCount += 1;
        }
      }
      return transparentCount > 0 || blackCount === totalPixels || whiteCount === totalPixels;
    } catch {
      return false;
    }
  };

  return (
    checkArea(54, 20, 2, 12) ||
    checkArea(46, 52, 2, 12) ||
    checkArea(50, 16, 2, 4) ||
    checkArea(42, 48, 2, 4)
  );
}

/**
 * Sanitize arm textures so that unused 4th-pixel strips never render as black lines.
 * Clones adjacent sleeve column across unused boundary to prevent pitch-black lines on arm backs.
 */
export function sanitizeSkinArms(canvas) {
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context || canvas.width !== 64 || canvas.height !== 64) return;

    const isSlim = isSlimArmTexture(context);

    const patchStrip = (sourceX, targetStartX, targetWidth, startY, height) => {
      const sourceData = context.getImageData(sourceX, startY, 1, height);
      for (let w = 0; w < targetWidth; w++) {
        context.putImageData(sourceData, targetStartX + w, startY);
      }
    };

    if (isSlim) {
      // Patch right arm back unused strip (x=54..55, y=20..31) with column x=53
      patchStrip(53, 54, 2, 20, 12);
      // Patch right arm top unused strip (x=50..51, y=16..19) with column x=49
      patchStrip(49, 50, 2, 16, 4);

      // Patch left arm back unused strip (x=46..47, y=52..63) with column x=45
      patchStrip(45, 46, 2, 52, 12);
      // Patch left arm top unused strip (x=42..43, y=48..51) with column x=41
      patchStrip(41, 42, 2, 48, 4);
    }
  } catch {
    /* ignore */
  }
}

export function detectSkinModel(dataUrl) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || !dataUrl) { resolve('classic'); return; }
    const image = new Image();
    image.onload = () => {
      try {
        if (image.naturalWidth !== 64 || image.naturalHeight !== 64) { resolve('classic'); return; }
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        resolve(isSlimArmTexture(context) ? 'slim' : 'classic');
      } catch { resolve('classic'); }
    };
    image.onerror = () => resolve('classic');
    image.src = dataUrl;
  });
}
