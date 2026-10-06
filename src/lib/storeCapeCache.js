import { firstFrameDataUrl, loadStripImage } from './animatedCape.js';

/**
 * Store cloak textures for the 3D preview, loaded once per item and kept for the whole session.
 * `still` is a normal cape texture (data URL, so the viewer never waits on the network) and
 * `strip` the whole animation for animated cloaks. The launcher's main process has usually warmed the
 * download already, so this resolves almost instantly.
 */
const ready = new Map(); // item id -> { key, still, strip }
const pending = new Map(); // item id -> Promise

const keyOf = (item) => `${item.stripUrl || ''}|${item.stillUrl || ''}`;

export const peekStoreCape = (item) => {
  const hit = item && ready.get(item.id);
  return hit && hit.key === keyOf(item) ? hit : null;
};

export function loadStoreCape(item) {
  if (!item?.id) return Promise.resolve(null);
  const hit = peekStoreCape(item);
  if (hit) return Promise.resolve(hit);
  if (pending.has(item.id)) return pending.get(item.id);
  const key = keyOf(item);
  const job = (async () => {
    try {
      const res = await window.native?.store?.strip?.(item.id);
      if (!res?.ok || !res.url) return null;
      let value;
      if (item.animated && item.stripUrl) {
        const image = await loadStripImage(res.url);
        value = { key, still: firstFrameDataUrl(image, item.frames || 1), strip: res.url };
      } else {
        value = { key, still: res.url, strip: null };
      }
      ready.set(item.id, value);
      return value;
    } catch {
      return null;
    } finally {
      pending.delete(item.id);
    }
  })();
  pending.set(item.id, job);
  return job;
}
