'use strict';
/**
 * Launcher ad cards (Home, Feather-style).
 *
 * The backend lists live ads at /v1/site/ads. Each banner image is downloaded once into
 * <userData>/ads/media/<sha256(url)>.<ext> and reused from disk every launch after that; a new
 * image link means a new file, so changing an ad on the server is the only thing that causes
 * a download. The last feed is saved too, so ads still show (from disk) while offline.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const API = String(process.env.NATIVE_WARDROBE_API || 'https://api.playnative.fun').replace(/\/+$/, '');
const FEED_TTL = 10 * 60_000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

let deps = null;
let memo = { at: 0, ads: null };
let inflight = null;

const root = () => path.join(deps.app.getPath('userData'), 'ads');
const mediaDir = () => path.join(root(), 'media');
const feedFile = () => path.join(root(), 'feed.json');
const keyOf = (url) => crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, 40);
const isHttps = (value) => /^https:\/\//i.test(String(value || ''));

const SERVER_ADDR = /^[a-z0-9.-]+(:\d{2,5})?$/i;
/** Up to two buttons: open an https link, or join a Minecraft server. */
function buttonsOf(ad) {
  const list = Array.isArray(ad.buttons) ? ad.buttons : (ad.cta ? [{ label: ad.cta, action: 'url', value: ad.url }] : []);
  return list.slice(0, 2).map((b) => ({
    label: String((b && b.label) || '').slice(0, 20),
    action: b && b.action === 'server' ? 'server' : 'url',
    value: String((b && b.value) || '').slice(0, 500)
  })).filter((b) => b.label && (b.action === 'server' ? SERVER_ADDR.test(b.value) : isHttps(b.value)));
}

function sanitize(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((ad) => ad && typeof ad.id === 'string' && isHttps(ad.image) && isHttps(ad.url))
    .slice(0, 50)
    .map((ad) => ({
      id: ad.id.slice(0, 40),
      title: String(ad.title || '').slice(0, 60),
      body: String(ad.body || '').slice(0, 140),
      image: ad.image,
      url: ad.url,
      cta: String(ad.cta || '').slice(0, 20),
      tag: String(ad.tag || '').slice(0, 20),
      buttons: buttonsOf(ad),
      player: ad.player === true
    }));
}

async function readFeed() {
  try { return sanitize(JSON.parse(await fsp.readFile(feedFile(), 'utf8')).ads); } catch { return null; }
}

async function findCached(url) {
  const key = keyOf(url);
  for (const ext of Object.values(TYPES)) {
    const file = path.join(mediaDir(), `${key}.${ext}`);
    try { const stat = await fsp.stat(file); if (stat.size > 0) return { file, ext }; } catch { /* not this one */ }
  }
  return null;
}

/** Downloads a banner once; afterwards the copy on disk is used. */
async function ensureImage(url) {
  const hit = await findCached(url);
  if (hit) return hit;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'NativeClient-Ads' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ext = TYPES[String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()];
    if (!ext) throw new Error('not an image');
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('bad size');
    await fsp.mkdir(mediaDir(), { recursive: true });
    const file = path.join(mediaDir(), `${keyOf(url)}.${ext}`);
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, bytes);
    await fsp.rename(tmp, file);
    return { file, ext };
  } finally {
    clearTimeout(timer);
  }
}

/** Removes banners that no ad uses anymore. */
async function prune(ads) {
  const keep = new Set([...ads.map((ad) => keyOf(ad.image)), 'player']);
  let names = [];
  try { names = await fsp.readdir(mediaDir()); } catch { return; }
  await Promise.all(names
    .filter((name) => !keep.has(name.split('.')[0]))
    .map((name) => fsp.rm(path.join(mediaDir(), name), { force: true }).catch(() => {})));
}

async function withImages(ads) {
  const out = [];
  for (const ad of ads) {
    try {
      const { file, ext } = await ensureImage(ad.image);
      const bytes = await fsp.readFile(file);
      out.push({ ...ad, image: `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${bytes.toString('base64')}` });
    } catch {
      // No copy yet and the download failed: skip this ad rather than show a broken card.
    }
  }
  return out;
}

async function fetchFeed() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(`${API}/v1/site/ads`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const ads = sanitize(body?.ads);
    await fsp.mkdir(root(), { recursive: true });
    await fsp.writeFile(feedFile(), JSON.stringify({ ads, savedAt: Date.now() }));
    return ads;
  } finally {
    clearTimeout(timer);
  }
}

async function refresh() {
  if (inflight) return inflight;
  inflight = (async () => {
    let ads;
    let online = true;
    try { ads = await fetchFeed(); } catch { online = false; ads = (await readFeed()) || []; }
    const ready = await withImages(ads);
    if (online) prune(ads).catch(() => {});
    memo = { at: Date.now(), ads: ready };
    return { ok: true, ads: ready, offline: !online };
  })().finally(() => { inflight = null; });
  return inflight;
}

/**
 * Ads with their banners as data URLs. The first call of a session answers straight from disk
 * (saved feed + downloaded banners) and refreshes in the background, so Home never waits on
 * the network for an ad it has already shown before.
 */
async function list({ force = false } = {}) {
  if (force) return refresh();
  if (memo.ads && Date.now() - memo.at < FEED_TTL) return { ok: true, ads: memo.ads, cached: true };
  if (!memo.ads) {
    const saved = await readFeed();
    if (saved && saved.length) {
      const cached = [];
      for (const ad of saved) if (await findCached(ad.image)) cached.push(ad);
      if (cached.length === saved.length) {
        const ready = await withImages(cached);
        memo = { at: 0, ads: ready }; // at 0: still refresh below
        refresh().catch(() => {});
        return { ok: true, ads: ready, cached: true };
      }
    }
  }
  return refresh();
}

const playerFile = () => path.join(mediaDir(), 'player.png');

/** The picture of the player's own skin (drawn by Home) - the in-game title screen uses it too. */
async function savePlayer(dataUrl) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match || match[1].length > 4 * 1024 * 1024) return { ok: false };
  const bytes = Buffer.from(match[1], 'base64');
  try { if ((await fsp.readFile(playerFile())).equals(bytes)) return { ok: true }; } catch { /* first time */ }
  await fsp.mkdir(mediaDir(), { recursive: true });
  const tmp = `${playerFile()}.tmp`;
  await fsp.writeFile(tmp, bytes);
  await fsp.rename(tmp, playerFile());
  return { ok: true };
}

/**
 * <game dir>/.native/ads.json for the Native mod: the same ads, pointing at the banners already on
 * disk (and the player picture), so the title screen shows them without downloading anything.
 */
async function writeForGame(gameDir) {
  if (!deps || !gameDir) return false;
  const feed = (await readFeed()) || [];
  const ads = [];
  for (const ad of feed) {
    const hit = await findCached(ad.image);
    if (hit) ads.push({ ...ad, image: undefined, file: hit.file });
  }
  let player = null;
  try { if ((await fsp.stat(playerFile())).size > 0) player = playerFile(); } catch { /* none yet */ }
  const dir = path.join(gameDir, '.native');
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, 'ads.json.tmp');
  await fsp.writeFile(tmp, JSON.stringify({ v: 1, savedAt: Date.now(), player, ads }));
  await fsp.rename(tmp, path.join(dir, 'ads.json'));
  return true;
}

function init(nextDeps, ipcMain) {
  deps = nextDeps;
  ipcMain.handle('ads:list', (_event, options) => list(options || {}));
  ipcMain.handle('ads:savePlayer', (_event, dataUrl) => savePlayer(dataUrl).catch(() => ({ ok: false })));
}

module.exports = { init, list, sanitize, keyOf, savePlayer, writeForGame };
