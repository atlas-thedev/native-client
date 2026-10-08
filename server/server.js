const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const db = require('./db');
const events = require('./social-events');
const { handleRelayRoutes } = require('./relay-routes');
const { sendVerificationCodeEmail, sendPasswordResetEmail, sendEmail } = require('./mailer');
const media = require('./media');
const modRoutes = require('./mod-routes');
const capes = require('./capes');
const storeRoutes = require('./store-routes');
const cosmetics = require('./cosmetics');
const billing = require('./billing');
const domains = require('./domains');
const siteRoutes = require('./site-routes');
const betaRoutes = require('./beta-routes');

/**
 * Native Backend & API Server
 * Handles:
 *  - Authentication & Account management (/v1/auth/*)
 *  - Real-time Social Network: Friends, Requests, Direct Messages, Presence (/v1/social/*)
 *    Realtime transport is Server-Sent Events at GET /v1/social/stream; the
 *    polling endpoints remain as a fallback only.
 *  - Wardrobe Sync & CustomSkinLoader API (/v1/wardrobe, /csl/*, /textures/*)
 */

const PORT = media.PORT;
const DATA_DIR = media.DATA_DIR;
const profilesDir = path.join(DATA_DIR, 'profiles');
const texturesDir = path.join(DATA_DIR, 'textures');
const mediaDir = media.MEDIA_DIR;
const rateBuckets = new Map();
const TRUST_PROXY = /^(1|true|yes)$/i.test(String(process.env.NATIVE_TRUST_PROXY || ''));
const MESSAGE_LIMIT = db.MESSAGE_LIMIT || 2000;

function mimeTypeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.svg': return 'image/svg+xml';
    case '.mp3': return 'audio/mpeg';
    case '.ogg': return 'audio/ogg';
    case '.webm': return 'audio/webm';
    case '.wav': return 'audio/wav';
    case '.mp4': return 'video/mp4';
    case '.txt':
    case '.log': return 'text/plain';
    case '.zip': return 'application/zip';
    default: return 'application/octet-stream';
  }
}

function send(res, status, value, headers = {}) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  res.writeHead(status, {
    'Content-Type': Buffer.isBuffer(value) ? 'image/png' : 'application/json; charset=utf-8',
    'Content-Length': body.length,
    // API responses are per-user; only routes that opt in may be cached.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(body);
}

/* ── Names ─────────────────────────────────────────────────────────────── */

/** One-time website sign-in links (code -> { userId, expiresAt }). */
const webLinks = new Map();
const webLinkTimer = setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of webLinks) if (entry.expiresAt < now) webLinks.delete(code);
}, 30_000);
if (webLinkTimer.unref) webLinkTimer.unref();

const MOJANG_NAME_URL = process.env.NATIVE_MOJANG_NAME_URL || 'https://api.mojang.com/users/profiles/minecraft/';
const premiumNameCache = new Map(); // lower name -> { premium, at }

// Local test runs only: fixed email codes and no Mojang lookups. Never in production.
const TEST_MODE = process.env.NATIVE_TEST_MODE === '1' && process.env.NODE_ENV !== 'production';
const newCode = () => (TEST_MODE ? '123456' : crypto.randomInt(100000, 1000000).toString());

/**
 * True when a real (premium) Minecraft account uses this name. Premium names
 * are reserved for their owners, so email sign-ups can't take them. Fails
 * closed: if Mojang can't be reached the caller refuses the name.
 */
const MOJANG_MIRROR_URL = process.env.NATIVE_MOJANG_MIRROR_URL === undefined ? 'https://api.minetools.eu/uuid/' : process.env.NATIVE_MOJANG_MIRROR_URL;
/** true/false from Mojang, or null when Mojang can't answer. */
async function mojangNameTaken(key) {
  const response = await fetch(`${MOJANG_NAME_URL}${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(6_000), headers: { Accept: 'application/json' } });
  if (response.status === 200) return true;
  if (response.status === 204 || response.status === 404) return false;
  return null;
}
/** The same answer through a public mirror (minetools): { id } when taken, { id: null, status: 'ERR' } when not. */
async function mirrorNameTaken(key) {
  if (!MOJANG_MIRROR_URL) return null;
  const response = await fetch(`${MOJANG_MIRROR_URL}${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(6_000), headers: { Accept: 'application/json' } });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  if (!body || typeof body !== 'object') return null;
  if (typeof body.id === 'string' && /^[a-f0-9]{32}$/i.test(body.id.replace(/-/g, ''))) return true;
  if (body.id === null && body.status === 'ERR') return false;
  return null;
}

async function isPremiumName(name) {
  const key = String(name || '').toLowerCase();
  if (db.getUserByMinecraftName(key)) return true;
  if (TEST_MODE) return /^premium_/i.test(key);
  const cached = premiumNameCache.get(key);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.premium;
  let premium = await mojangNameTaken(key).catch(() => null);
  // Mojang blocks some hosting IPs: ask a public mirror of the same lookup before giving up
  if (premium === null) premium = await mirrorNameTaken(key).catch(() => null);
  if (premium === null) throw Object.assign(new Error('We couldn’t check that name with Minecraft right now. Try again in a moment.'), { status: 503 });
  premiumNameCache.set(key, { premium, at: Date.now() });
  return premium;
}

/** Wardrobe profiles are stored by name: move one along with a rename. */
function moveProfile(from, to) {
  const source = profilePath(from);
  if (!fs.existsSync(source)) return;
  try {
    const doc = JSON.parse(fs.readFileSync(source, 'utf8'));
    doc.username = to;
    atomicWrite(profilePath(to), JSON.stringify(doc, null, 2));
    if (profilePath(to) !== source) fs.unlinkSync(source);
  } catch (error) { console.warn('[Native] profile move failed:', error.message); }
}

function announceRename(userId, from, to, reason) {
  try { events.publish([...new Set([userId, ...db.getFriendIds(userId)])], 'friends:changed', { userId, renamed: { from, to } }); } catch {}
  try { events.publish(userId, 'account:renamed', { from, to, reason }); } catch {}
}

/**
 * Makes `name` free for its premium owner: whoever else holds it on Native is
 * renamed to Name_1234 and emailed. `exceptId` is the owner's own account.
 */
async function freeNameFor(name, exceptId) {
  const holder = db.getUserByUsername(name);
  if (!holder || holder.id === exceptId) return null;
  const isFree = (candidate) => !db.getUserByUsername(candidate) && !db.getUserByMinecraftName(candidate);
  let next = null;
  for (let attempt = 0; attempt < 40 && !next; attempt += 1) {
    const candidate = `${String(name).slice(0, 11)}_${crypto.randomInt(1000, 10000)}`;
    if (isFree(candidate)) next = candidate;
  }
  if (!next) throw new Error('Could not free that name.');
  db.renameUser(holder.id, next);
  moveProfile(holder.username, next);
  try { modRoutes.noteRename([{ from: holder.username, to: next }]); } catch {}
  announceRename(holder.id, holder.username, next, 'premium-owner');
  if (holder.email) {
    const text = `Hi ${next},\n\nThe name "${holder.username}" belongs to a premium Minecraft account, and its owner has signed in to Native. Your Native account was renamed to "${next}". Your friends, chats and cloaks are unchanged.\n\nSign in with your email from now on.\n\n— Native`;
    sendEmail({ to: holder.email, subject: 'Your Native name was changed', text, html: text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>') }).catch(() => {});
  }
  return { id: holder.id, from: holder.username, to: next };
}

function usernameOf(value) {
  const name = String(value || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new Error('Invalid Minecraft username.');
  return name;
}

function pngBuffer(value) {
  if (value == null || value === '') return null;
  const raw = String(value).replace(/^data:image\/png;base64,/i, '');
  const data = Buffer.from(raw, 'base64');
  if (data.length <= 24 || data.length > 5 * 1024 * 1024) throw new Error('Invalid PNG size.');
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid PNG texture.');
  return data;
}

function atomicWrite(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, data);
  fs.renameSync(temporary, filePath);
}

const capeAllowed = (hash, profile = null, user = null) => storeRoutes.capeAllowed(hash, profile, user);
const shownCape = (profile) => (profile?.cape && capeAllowed(profile.cape, profile) ? profile.cape : null);

function textureHash(buffer) {
  if (!buffer) return null;
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const target = path.join(texturesDir, hash);
  if (!fs.existsSync(target)) atomicWrite(target, buffer);
  return hash;
}

const { isSlimSkinPng } = require('./skin-model');
/** True when the stored skin texture is unambiguously slim (its unused slim arm columns are empty). */
function skinLooksSlim(hash) {
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) return false;
  try { return isSlimSkinPng(fs.readFileSync(path.join(texturesDir, hash))); } catch { return false; }
}

function profilePath(username) {
  return path.join(profilesDir, `${username.toLowerCase()}.json`);
}

function readProfile(username) {
  try { return JSON.parse(fs.readFileSync(profilePath(username), 'utf8')); } catch { return null; }
}

/**
 * Persists a wardrobe profile and tells everyone who cares, immediately:
 * the Native mod (skin stream), the owner's other devices and friends (social stream).
 */
function saveProfile(profile, req, owner) {
  atomicWrite(profilePath(profile.username), JSON.stringify(profile, null, 2));
  try { modRoutes.noteProfile(profile); } catch {}
  try {
    const user = owner || db.getUserByUsername(profile.username);
    if (user) {
      const origin = originOf(req);
      const payload = {
        userId: user.id,
        name: profile.username,
        model: profile.model === 'slim' ? 'slim' : 'default',
        skinUrl: profile.skin ? `${origin}/csl/textures/${profile.skin}` : null,
        capeUrl: shownCape(profile) ? `${origin}/csl/textures/${profile.cape}` : null,
        capeAnimation: (() => {
          const anim = storeRoutes.animationFor(profile);
          return anim ? { url: `${origin}/csl/textures/${anim.strip}`, frames: anim.frames, fps: anim.fps } : null;
        })(),
        capeStore: profile.capeStore || null,
        wearing: storeRoutes.wearingOf(profile),
        sides: (profile && profile.cosmeticSides) || {},
        cosmetics: cosmetics.documentRefs(profile, storeRoutes.findItem, `${origin}/csl/textures/`, storeRoutes.dyedTexture),
        updatedAt: profile.updatedAt
      };
      events.publish(db.getFriendIds(user.id), 'skin:updated', payload);
      events.publish(user.id, 'wardrobe:changed', payload);
    }
  } catch {}
  return profile;
}

/**
 * Fixed-window rate limiter. `hit` counts an attempt, `blocked` only checks.
 * Buckets are pruned so the map cannot grow without bound.
 */
function bucketFor(name, key, windowMs) {
  const id = `${name}:${key}`;
  const now = Date.now();
  let item = rateBuckets.get(id);
  if (!item || now - item.start > windowMs) {
    item = { start: now, count: 0, windowMs };
    rateBuckets.set(id, item);
  }
  return item;
}

function hit(name, key, limit, windowMs) {
  const item = bucketFor(name, key, windowMs);
  item.count += 1;
  return item.count <= limit;
}

function blocked(name, key, limit, windowMs) {
  return bucketFor(name, key, windowMs).count >= limit;
}

function allowed(ip) {
  return hit('global', ip, 240, 60_000);
}

// A launcher that vanished without closing its stream (sleep, crash, dropped Wi-Fi) stops
// heartbeating: tell its friends it went offline instead of leaving a stale green dot.
const presenceSweep = setInterval(() => {
  try {
    const live = (userId) => events.isConnected(userId) || events.isModConnected(userId);
    for (const row of db.expireStalePresence(Date.now() - db.PRESENCE_TTL_MS, live)) {
      events.publish(db.getFriendIds(row.userId), 'presence', { userId: row.userId, status: 'offline', activity: null, serverAddress: null, lastSeen: row.lastSeen });
    }
  } catch { /* best-effort */ }
}, 15_000);
if (presenceSweep.unref) presenceSweep.unref();

const pruneTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, item] of rateBuckets) {
    if (now - item.start > item.windowMs) rateBuckets.delete(id);
  }
}, 60_000);
if (pruneTimer.unref) pruneTimer.unref();

/**
 * The caller's address. Client-supplied headers are only trusted when the
 * request came from the local reverse proxy (nginx sets X-Real-IP from its
 * Cloudflare-aware real_ip config), never straight from the internet.
 */
const SITE_KEY = String(process.env.NATIVE_SITE_KEY || '');

/**
 * The Native website proxies sign-in requests, so every visitor would share the
 * website host's IP. When NATIVE_SITE_KEY is set, a request carrying the same key
 * in X-Native-Site-Key may name the real visitor in X-Native-Client-IP.
 */
function siteForwardedIp(req) {
  if (!SITE_KEY) return null;
  const key = String(req.headers['x-native-site-key'] || req.headers['x-noctra-site-key'] || '');
  const a = Buffer.from(key);
  const b = Buffer.from(SITE_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const ip = String(req.headers['x-native-client-ip'] || '').trim();
  return /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? ip : null;
}

function clientIp(req) {
  const forwarded = siteForwardedIp(req);
  if (forwarded) return forwarded;
  const peer = String(req.socket?.remoteAddress || '');
  const fromProxy = TRUST_PROXY || peer === '::1' || peer.startsWith('127.') || peer.startsWith('::ffff:127.');
  if (fromProxy) {
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real && /^[0-9a-fA-F:.]{2,45}$/.test(real)) return real;
  }
  return peer || 'unknown';
}

function tooMany(res, seconds = 60, message = 'Too many requests. Please try again shortly.') {
  return send(res, 429, { ok: false, error: message }, { 'Retry-After': String(Math.max(1, Math.ceil(seconds))) });
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 36 * 1024 * 1024) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Public origin for generated URLs (shared with the relay routes). */
const originOf = media.originOf;

const textureUrl = (origin, hash) => (hash ? `${origin}/csl/textures/${hash}` : null);

/** Attach the player's published skin texture so the UI never calls a third party. */
function withSkin(entry, origin) {
  const profile = entry && entry.name ? readProfile(entry.name) : null;
  return {
    ...entry,
    skinUrl: (profile && profile.skin) ? `${origin}/csl/textures/${profile.skin}` : null,
    model: (profile && profile.model) || entry.model || 'classic'
  };
}

/** CustomSkinLoader's CustomSkinAPI document. */
function customSkinProfile(profile, origin) {
  const skin = textureUrl(origin, profile.skin);
  const cape = textureUrl(origin, shownCape(profile));
  const slim = profile.model === 'slim';

  const skins = {};
  if (skin) {
    if (slim) skins.slim = skin;
    else skins.default = skin;
  }

  const capeMap = {};
  if (cape) capeMap.default = cape;

  const document = {
    username: profile.username,
    model: profile.model || 'default',
    skins,
    capes: capeMap,
    skin,
    cape,
    ...(profile.skinName && skin ? { skinName: profile.skinName } : {}),
    updatedAt: profile.updatedAt
  };
  // Animated capes: `cape` above is the first frame (a normal cape for anything
  // that cannot animate); clients that can animate read the whole strip here.
  // Only Native store capes animate; anything else is shown as its still first frame.
  const anim = storeRoutes.animationFor(profile);
  if (anim) {
    document.capeAnimation = {
      url: textureUrl(origin, anim.strip),
      frames: anim.frames,
      fps: anim.fps
    };
  }
  if (profile.capeStore) document.capeStore = profile.capeStore;
  // 3D cosmetics (hats, glasses, back items, shoes): NCM model + texture per slot
  const worn = cosmetics.documentRefs(profile, storeRoutes.findItem, `${origin}/csl/textures/`, storeRoutes.dyedTexture);
  if (worn.length) document.cosmetics = worn;
  return document;
}

const MINECRAFT_PROFILE_URL = process.env.NATIVE_MC_PROFILE_URL || 'https://api.minecraftservices.com/minecraft/profile';

/**
 * Proves premium ownership: asks Minecraft Services who owns this access
 * token. Returns { uuid, name } or throws an Error carrying an HTTP status.
 */
async function verifyMinecraftToken(rawToken) {
  const minecraftToken = String(rawToken || '').trim();
  if (minecraftToken.length < 40 || minecraftToken.length > 4096) {
    throw Object.assign(new Error('A valid Microsoft Minecraft session is required.'), { status: 400 });
  }
  let response;
  try {
    response = await fetch(MINECRAFT_PROFILE_URL, {
      headers: { Authorization: `Bearer ${minecraftToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000)
    });
  } catch {
    throw Object.assign(new Error('Minecraft could not verify this account right now. Try again.'), { status: 502 });
  }
  if (!response.ok) {
    throw Object.assign(new Error('This Microsoft session does not own Minecraft or has expired.'), { status: 401 });
  }
  const profile = await response.json().catch(() => null);
  const uuid = String(profile?.id || '').replace(/-/g, '').toLowerCase();
  const name = String(profile?.name || '').trim();
  if (!/^[a-f0-9]{32}$/.test(uuid) || !/^[A-Za-z0-9_]{3,16}$/.test(name)) {
    throw Object.assign(new Error('Microsoft returned an invalid Minecraft profile.'), { status: 502 });
  }
  return { uuid, name };
}

function nativeAccountPayload(user, token) {
  return {
    id: user.id,
    name: user.username,
    email: user.email,
    uuid: user.uuid,
    type: 'native',
    authType: user.auth_type || 'native',
    model: user.model,
    token
  };
}

async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const ip = clientIp(req);
    if (!allowed(ip)) return tooMany(res, 60);

    if (req.method === 'OPTIONS') {
      const requestOrigin = String(req.headers.origin || '');
      const allowedOrigin = process.env.NATIVE_CORS_ORIGIN || (/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(requestOrigin) ? requestOrigin : 'null');
      return send(res, 204, '', {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Vary': 'Origin',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Native-Token',
        'Access-Control-Max-Age': '600'
      });
    }

    try {
      const handled = await handleRelayRoutes(req, res);
      if (handled) return;
    } catch (relayError) {
      if (!res.headersSent) {
        return send(res, 500, { ok: false, error: relayError.message || 'Relay route failed.' });
      }
      return;
    }

    try {
      if (await modRoutes.handleModRoutes(req, res, { ip, send, hit, tooMany })) return;
    } catch (modError) {
      if (!res.headersSent) return send(res, 500, { ok: false, error: 'Mod route failed.' });
      return;
    }

    try {
      siteRoutes.setHooks({
        findItem: storeRoutes.findItem,
        allItems: storeRoutes.allItems,
        storeTexture: textureHash,
        itemView: (id, textureBase) => storeRoutes.pollItem(id, textureBase),
        grant: (userId, itemId, source) => billing.grantItem(userId, itemId, source),
        setPrices: storeRoutes.setPrices,
        onGrant: (user, item) => events.publish(user.id, 'wardrobe:changed', { userId: user.id, name: user.username, capeStore: readProfile(user.username)?.capeStore || null, owned: true })
      });
      storeRoutes.ensureCatalog(textureHash);
      siteRoutes.dropAutoBetaBadges();
      if (await siteRoutes.handleSiteRoutes(req, res, { ip, send, hit, tooMany, readJson, originOf })) return;
      betaRoutes.setHooks({
        settings: siteRoutes.settings,
        findItem: storeRoutes.findItem,
        publish: (userId) => {
          const target = db.getUserById(userId);
          if (!target) return;
          events.publish(target.id, 'wardrobe:changed', { userId: target.id, name: target.username, capeStore: readProfile(target.username)?.capeStore || null, owned: true });
          events.publish([...new Set([target.id, ...db.getFriendIds(target.id)])], 'friends:changed', { actorId: target.id, userId: target.id, badgesChanged: true });
        }
      });
      if (await betaRoutes.handleBetaRoutes(req, res, { ip, send, hit, tooMany, readJson })) return;
    } catch (siteError) {
      console.error('[Native Site]', siteError);
      if (!res.headersSent) return send(res, 500, { ok: false, error: 'Site route failed.' });
      return;
    }

    try {
      if (await domains.handleDomainRoutes(req, res, { send, readJson })) return;
    } catch (domainError) {
      console.error('[Native Domains]', domainError);
      if (!res.headersSent) return send(res, 500, { ok: false, error: 'Domain route failed.' });
      return;
    }

    try {
      billing.setHooks({ readProfile, saveProfile, findItem: storeRoutes.findItem, allItems: storeRoutes.allItems, findBundle: storeRoutes.findBundle, quoteBundle: storeRoutes.quoteBundle, bundleOnSale: storeRoutes.bundleOnSale });
      if (await billing.handleBillingRoutes(req, res, { ip, send, hit, tooMany, readJson, findItem: storeRoutes.findItem })) return;
    } catch (billingError) {
      console.error('[Native Billing]', billingError);
      if (!res.headersSent) return send(res, 500, { ok: false, error: 'Billing route failed.' });
      return;
    }

    try {
      if (await storeRoutes.handleStoreRoutes(req, res, {
        ip, send, hit, tooMany, readJson, readProfile, saveProfile, originOf,
        storeTexture: textureHash,
        profileDocument: (profile, request) => customSkinProfile(profile, originOf(request))
      })) return;
    } catch (storeError) {
      if (!res.headersSent) return send(res, 500, { ok: false, error: 'Store route failed.' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, {
        ok: true,
        service: 'native-server',
        api: 3,
        providers: ['customskinapi', 'auth', 'social', 'realtime'],
        liveConnections: events.connectionCount()
      });
    }

    // CustomSkinLoader profile document
    const profileMatch = url.pathname.match(/^\/csl\/([A-Za-z0-9_]{3,16})(?:\.json)?$/);
    if (req.method === 'GET' && profileMatch) {
      const profile = readProfile(profileMatch[1]);
      if (!profile) return send(res, 404, { error: 'Profile not found.' });
      const etag = `W/"${profile.updatedAt || 'static'}"`;
      if (req.headers['if-none-match'] === etag) return send(res, 304, '', { ETag: etag });
      return send(res, 200, customSkinProfile(profile, originOf(req)), { ETag: etag, 'Cache-Control': 'public, max-age=60', 'Access-Control-Allow-Origin': '*' });
    }

    // Texture delivery. CustomSkinLoader builds texture URLs as
    // root + "textures/" + value, and our profile values are already absolute
    // URLs, so it asks for /csl/textures/https://…/csl/textures/<hash> (or with
    // the double slash merged by nginx). Older clients read those values as
    // URLs, so keep them and accept the nested form: the hash is what counts.
    const textureMatch = url.pathname.match(/^\/(?:csl\/)?textures\/(?:.*\/)?([a-f0-9]{64})(?:\.png)?$/);
    if (req.method === 'GET' && textureMatch) {
      const target = path.join(texturesDir, textureMatch[1]);
      if (!fs.existsSync(target)) return send(res, 404, { error: 'Texture not found.' });
      return send(res, 200, fs.readFileSync(target), {
        'Cache-Control': 'public, max-age=31536000, immutable',
        ETag: `"${textureMatch[1]}"`,
        'Access-Control-Allow-Origin': '*'
      });
    }

    // Avatar lookup. Native never proxies to third-party skin hosts: if the
    // player has not published a skin the client falls back to its bundled
    // Steve texture instead.
    const avatarMatch = url.pathname.match(/^\/(?:csl\/)?avatar\/([A-Za-z0-9_]{3,16})$/i);
    if (req.method === 'GET' && avatarMatch) {
      const profile = readProfile(avatarMatch[1]);
      if (profile?.skin) {
        return send(res, 302, '', { Location: `/csl/textures/${profile.skin}`, 'Access-Control-Allow-Origin': '*' });
      }
      return send(res, 404, { error: 'Avatar not found.' });
    }

    // Social Media delivery (preserves full resolution)
    const mediaMatch = url.pathname.match(/^\/v1\/social\/media\/([a-zA-Z0-9_.\-]+)$/);
    if (req.method === 'GET' && mediaMatch) {
      const target = path.join(mediaDir, path.basename(mediaMatch[1]));
      if (!fs.existsSync(target)) return send(res, 404, { error: 'Media not found.' });
      const stat = fs.statSync(target);
      const mime = mimeTypeFor(target);
      const inline = /^(?:image\/(?:png|jpeg|gif|webp)|audio\/|video\/)/.test(mime);
      res.writeHead(200, {
        'Content-Type': mime === 'image/svg+xml' ? 'application/octet-stream' : mime,
        'Content-Length': stat.size,
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Content-Disposition': inline ? 'inline' : 'attachment',
        'Access-Control-Allow-Origin': '*'
      });
      return fs.createReadStream(target).pipe(res);
    }

    // Wardrobe publication. Only a signed-in Native account can publish, and only
    // under its own name. Offline launcher accounts never reach this (local only).
    // Premium and merged accounts keep their real Mojang skin: only the cloak is published.
    if (req.method === 'POST' && url.pathname === '/v1/wardrobe') {
      const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      const nativeToken = String(req.headers['x-native-token'] || req.headers['x-noctra-token'] || '').trim();
      const sessionUser = db.getUserBySession(nativeToken || bearer);
      if (!sessionUser) return send(res, 401, { ok: false, error: 'Sign in to your Native account to save your look.' });
      if (!hit('wardrobe', sessionUser.id, 60, 10 * 60_000)) return tooMany(res, 600);
      const body = await readJson(req);
      if (body.username && String(body.username).toLowerCase() !== sessionUser.username.toLowerCase()) {
        return send(res, 403, { ok: false, error: 'You can only change your own look.' });
      }
      const username = sessionUser.username;
      const existing = readProfile(username);
      const premiumSkin = sessionUser.auth_type === 'premium' || sessionUser.auth_type === 'merged';
      const skin = premiumSkin
        ? null
        : body.skin !== undefined ? (body.skin ? textureHash(pngBuffer(body.skin)) : null) : (existing?.skin ?? null);
      let cape = existing?.cape ?? null;
      let capeRefused = false;
      if (body.cape !== undefined) {
        const capeBuffer = body.cape ? pngBuffer(body.cape) : null;
        const capeHash = capeBuffer ? crypto.createHash('sha256').update(capeBuffer).digest('hex') : null;
        if (capeAllowed(capeHash, existing, sessionUser)) cape = capeHash ? textureHash(capeBuffer) : null;
        else { capeRefused = true; cape = capeAllowed(cape, existing, sessionUser) ? cape : null; }
      }
      let capeAnim = existing?.capeAnim ?? null;
      let capeStore = existing?.capeStore ?? null;
      let animationRefused = false;
      // Older launchers re-send the (static) first frame on every sync. Only a
      // genuinely different cloak, or an explicit capeAnim field, drops the animation.
      const capeChanged = cape !== (existing?.cape ?? null);
      if (body.capeAnim !== undefined || capeChanged) {
        capeStore = null;
        capeAnim = null;
      }
      if (body.capeAnim) {
        try {
          const strip = capes.pngFromBase64(body.capeAnim.strip);
          const still = body.cape ? pngBuffer(body.cape) : null;
          if (!strip || !still) throw new Error('An animated cloak needs its frame strip and its first frame.');
          capes.validateAnimation({ strip, still, frames: body.capeAnim.frames, fps: body.capeAnim.fps });
          const stripHash = crypto.createHash('sha256').update(strip).digest('hex');
          const storeId = storeRoutes.authorizeAnimation({ stripHash, user: sessionUser, existing });
          const item = storeId ? storeRoutes.findItem(storeId) : null;
          if (item && item.still === cape) {
            capeAnim = { strip: item.strip, frames: item.frames, fps: item.fps };
            capeStore = item.id;
          } else {
            animationRefused = true;
          }
        } catch (error) {
          return send(res, 400, { ok: false, error: error.message || 'Invalid animated cloak.' });
        }
      }
      if (cape && !capeStore && !capeAnim) {
        // a static store cape sent as a PNG: remember it as worn through the store
        const item = storeRoutes.staticStoreCape(cape, sessionUser);
        if (item) capeStore = item.id;
      }
      if (!cape) { capeAnim = null; capeStore = null; }
      const cleanSkinName = (value) => String(value ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 32) || null;
      const skinName = !skin ? null
        : body.skinName !== undefined ? cleanSkinName(body.skinName)
        : (skin === (existing?.skin ?? null) ? (existing?.skinName ?? null) : null);
      const profile = {
        username,
        // a slim skin saved as classic would show black/cut arms everywhere: trust the pixels
        model: body.model === 'slim' || skinLooksSlim(skin) ? 'slim' : 'default',
        skin,
        ...(skinName ? { skinName } : {}),
        cape,
        ...(capeAnim ? { capeAnim } : {}),
        ...(capeStore ? { capeStore } : {}),
        // 3D cosmetics are only changed through the store (POST /v1/store/equip), never by a wardrobe sync
        ...(existing?.cosmetics && Object.keys(existing.cosmetics).length ? { cosmetics: existing.cosmetics } : {}),
        ...(existing?.cosmeticSides && Object.keys(existing.cosmeticSides).length ? { cosmeticSides: existing.cosmeticSides } : {}),
        ...(existing?.cosmeticDyes && Object.keys(existing.cosmeticDyes).length ? { cosmeticDyes: existing.cosmeticDyes } : {}),
        updatedAt: new Date().toISOString()
      };
      saveProfile(profile, req, sessionUser);
      return send(res, 200, {
        ok: true,
        username,
        model: profile.model,
        skins: profile.skin ? [profile.skin] : [],
        capes: shownCape(profile) ? [profile.cape] : [],
        animated: Boolean(storeRoutes.animationFor(profile)),
        ...(capeRefused ? { notice: 'Only Native cloaks can be worn. Pick one from your locker.' } : animationRefused ? { notice: 'Animated cloaks come from the Native Store. Your cloak was saved as a still image.' } : {}),
        profile: customSkinProfile(profile, originOf(req))
      });
    }

    // ── Authentication APIs ─────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/v1/auth/register/send-code') {
      if (!hit('code-ip', ip, 6, 10 * 60_000)) return tooMany(res, 600, 'Too many verification emails. Please wait a few minutes.');
      const body = await readJson(req);
      const email = String(body.email || '').trim().toLowerCase();
      const rawUsername = String(body.username || '').trim();

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return send(res, 400, { ok: false, error: 'Please enter a valid email address.' });
      }
      if (rawUsername) {
        try { usernameOf(rawUsername); } catch {
          return send(res, 400, { ok: false, error: 'Username must be 3-16 letters, numbers, or underscores.' });
        }
        if (db.getUserByUsername(rawUsername)) {
          return send(res, 400, { ok: false, error: 'This Minecraft username is already registered.' });
        }
        try {
          if (await isPremiumName(rawUsername)) return send(res, 400, { ok: false, premiumName: true, error: 'This name belongs to a premium Minecraft account. Sign in with Microsoft to use it.' });
        } catch (err) {
          return send(res, err.status || 503, { ok: false, error: err.message });
        }
      }
      if (db.getUserByEmail(email)) {
        return send(res, 400, { ok: false, error: 'An account with this email already exists.' });
      }

      const cooldown = db.verificationCooldown(email);
      if (cooldown > 0) return tooMany(res, cooldown / 1000, 'A code was just sent. Please wait a moment before requesting another.');
      if (!hit('code-email', email, 5, 60 * 60_000)) return tooMany(res, 3600, 'Too many codes requested for this email. Try again later.');

      const code = newCode();
      db.saveVerificationCode(email, code);

      try {
        await sendVerificationCodeEmail(email, code, rawUsername);
      } catch (err) {
        console.error('Verification email error:', err);
        return send(res, 500, { ok: false, error: `Could not send verification email: ${err.message}` });
      }

      return send(res, 200, { ok: true, message: 'Verification code sent.' });
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/register/verify') {
      if (!hit('verify-ip', ip, 30, 10 * 60_000)) return tooMany(res, 600);
      const body = await readJson(req);
      const email = String(body.email || '').trim().toLowerCase();
      const code = String(body.code || '').trim();
      const username = usernameOf(body.username);
      const password = String(body.password || '');
      const model = body.model === 'slim' ? 'slim' : 'classic';

      if (!password || password.length < 6) {
        return send(res, 400, { ok: false, error: 'Password must be at least 6 characters long.' });
      }

      if (!db.checkVerificationCode(email, code)) {
        return send(res, 400, { ok: false, error: 'Invalid or expired verification code.' });
      }

      if (db.getUserByEmail(email)) {
        return send(res, 400, { ok: false, error: 'An account with this email already exists.' });
      }
      if (db.getUserByUsername(username)) {
        return send(res, 400, { ok: false, error: 'This Minecraft username is already taken.' });
      }
      try {
        if (await isPremiumName(username)) return send(res, 400, { ok: false, premiumName: true, error: 'This name belongs to a premium Minecraft account. Sign in with Microsoft to use it.' });
      } catch (err) {
        return send(res, err.status || 503, { ok: false, error: err.message });
      }

      const user = db.createUser({ email, username, password, model });
      db.clearVerificationCode(email);
      const session = db.createSession(user.id);

      return send(res, 200, {
        ok: true,
        token: session.token,
        account: {
          id: user.id,
          name: user.username,
          email: user.email,
          uuid: user.uuid,
          type: 'native',
          model: user.model,
          token: session.token
        }
      });
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/login') {
      const body = await readJson(req);
      const login = String(body.login || body.email || body.username || '').trim();
      const password = String(body.password || '');

      if (!login || !password) {
        return send(res, 400, { ok: false, error: 'Username/Email and password are required.' });
      }

      const loginKey = login.toLowerCase();
      if (!hit('login-ip', ip, 30, 15 * 60_000) || blocked('login-fail', loginKey, 10, 15 * 60_000)) {
        return tooMany(res, 900, 'Too many sign-in attempts. Please wait 15 minutes and try again.');
      }

      const user = db.getUserByLogin(login);
      if (user && user.auth_type === 'premium' && !user.password_hash) {
        return send(res, 401, { ok: false, premium: true, error: 'This is a Microsoft account. Sign in with Microsoft instead.' });
      }
      if (!user || !user.password_hash || !(await db.verifyPasswordAsync(password, user.password_hash, user.salt))) {
        hit('login-fail', loginKey, 10, 15 * 60_000);
        return send(res, 401, { ok: false, error: 'Invalid username/email or password.' });
      }

      const session = db.createSession(user.id);
      return send(res, 200, {
        ok: true,
        token: session.token,
        account: {
          id: user.id,
          name: user.username,
          email: user.email,
          uuid: user.uuid,
          type: 'native',
          model: user.model,
          token: session.token
        }
      });
    }

    // ── Premium sign-in ───────────────────────────────────────────────────
    // A real Minecraft account signs straight in. The first time we see its UUID
    // the account is created automatically (Minecraft name + UUID, no email).
    if (req.method === 'POST' && url.pathname === '/v1/auth/minecraft') {
      if (!hit('mc-login-ip', ip, 30, 10 * 60_000)) {
        return tooMany(res, 600, 'Too many sign-in attempts. Please wait a few minutes and try again.');
      }
      const body = await readJson(req);
      let profile;
      try {
        profile = await verifyMinecraftToken(body.minecraftAccessToken);
      } catch (error) {
        return send(res, error.status || 401, { ok: false, error: error.message });
      }
      let user = db.getUserByMinecraftUuid(profile.uuid);
      let created = false;
      try {
        if (!user) {
          await freeNameFor(profile.name, null);
          user = db.createPremiumUser(profile);
          created = true;
        } else if (user.username !== profile.name) {
          // Renamed on minecraft.net: follow it (whoever else holds the new name moves aside).
          const oldName = user.username;
          if (oldName.toLowerCase() !== profile.name.toLowerCase()) await freeNameFor(profile.name, user.id);
          db.renameUser(user.id, profile.name);
          moveProfile(oldName, profile.name);
          try { modRoutes.noteRename([{ from: oldName, to: profile.name }]); } catch {}
          announceRename(user.id, oldName, profile.name, 'minecraft');
          user = db.getUserById(user.id);
        }
      } catch (error) {
        console.error('[Native Auth] premium sign-in failed:', error);
        return send(res, 409, { ok: false, error: 'Could not set up your Native account. Try again in a moment.' });
      }
      db.refreshMinecraftName(user.id, profile.name);
      try { modRoutes.noteProfile(user.username); } catch {}
      const session = db.createSession(user.id, 'premium');
      return send(res, 200, {
        ok: true,
        created,
        token: session.token,
        expiresAt: session.expiresAt,
        account: nativeAccountPayload(user, session.token),
        profile: { uuid: profile.uuid, name: profile.name }
      });
    }

    // Ends this session on the server (signing out of the launcher or the website).
    if (req.method === 'POST' && url.pathname === '/v1/auth/logout') {
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      if (token) { try { db.deleteSession(token); } catch {} }
      return send(res, 200, { ok: true });
    }

    // One-time link that signs a launcher user into the website (60 s, single use).
    if (req.method === 'POST' && url.pathname === '/v1/auth/web-link') {
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      const authUser = db.getUserBySession(token);
      if (!authUser) return send(res, 401, { ok: false, error: 'Native account session required.' });
      if (!hit('web-link', authUser.id, 20, 10 * 60_000)) return tooMany(res, 600);
      const code = crypto.randomBytes(32).toString('base64url');
      webLinks.set(code, { userId: authUser.id, expiresAt: Date.now() + 60_000 });
      return send(res, 200, { ok: true, code, expiresAt: Date.now() + 60_000 });
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/web-link/redeem') {
      if (!hit('web-link-redeem', ip, 30, 10 * 60_000)) return tooMany(res, 600);
      const body = await readJson(req);
      const code = String(body.code || '');
      const entry = webLinks.get(code);
      webLinks.delete(code);
      if (!entry || entry.expiresAt < Date.now()) {
        return send(res, 400, { ok: false, error: 'This sign-in link has expired. Open the website from the launcher again.' });
      }
      const user = db.getUserById(entry.userId);
      if (!user) return send(res, 400, { ok: false, error: 'This sign-in link has expired.' });
      const session = db.createSession(user.id, 'web');
      return send(res, 200, { ok: true, token: session.token, account: nativeAccountPayload(user, session.token) });
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/resend-code') {
      if (!hit('code-ip', ip, 6, 10 * 60_000)) return tooMany(res, 600, 'Too many verification emails. Please wait a few minutes.');
      const body = await readJson(req);
      const email = String(body.email || '').trim().toLowerCase();
      const username = String(body.username || '').trim();

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return send(res, 400, { ok: false, error: 'Please enter a valid email address.' });
      }
      // Only re-send for a sign-up that is actually in progress.
      if (!db.getVerificationCode(email) || db.getUserByEmail(email)) {
        return send(res, 400, { ok: false, error: 'No sign-up is waiting for this email. Please start again.' });
      }
      const cooldown = db.verificationCooldown(email);
      if (cooldown > 0) return tooMany(res, cooldown / 1000, 'A code was just sent. Please wait a moment before requesting another.');
      if (!hit('code-email', email, 5, 60 * 60_000)) return tooMany(res, 3600, 'Too many codes requested for this email. Try again later.');

      const code = newCode();
      db.saveVerificationCode(email, code);

      try {
        await sendVerificationCodeEmail(email, code, username);
      } catch (err) {
        return send(res, 500, { ok: false, error: `Could not send verification email: ${err.message}` });
      }

      return send(res, 200, { ok: true, message: 'New code sent.' });
    }

    // ── Password reset (email code) ─────────────────────────────────────
    // /forgot never reveals whether an address has an account: it always
    // answers the same way. /reset needs the emailed code, and on success
    // ends every existing session for the account.
    if (req.method === 'POST' && url.pathname === '/v1/auth/password/forgot') {
      if (!hit('reset-ip', ip, 6, 10 * 60_000)) return tooMany(res, 600, 'Too many reset requests. Please wait a few minutes.');
      const body = await readJson(req);
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return send(res, 400, { ok: false, error: 'Please enter a valid email address.' });
      }
      if (!hit('reset-email', email, 5, 60 * 60_000)) return tooMany(res, 3600, 'Too many reset codes requested for this email. Try again later.');

      const generic = { ok: true, message: 'If an account exists for that email, a reset code has been sent.' };
      const user = db.getUserByEmail(email);
      if (!user || db.passwordResetCooldown(email) > 0) return send(res, 200, generic);

      const code = newCode();
      db.savePasswordReset(email, code);
      try {
        await sendPasswordResetEmail(email, code, user.username);
      } catch (err) {
        console.error('Password reset email error:', err);
        db.clearPasswordReset(email);
      }
      return send(res, 200, generic);
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/password/reset') {
      if (!hit('reset-verify-ip', ip, 30, 10 * 60_000)) return tooMany(res, 600);
      const body = await readJson(req);
      const email = String(body.email || '').trim().toLowerCase();
      const code = String(body.code || '').trim();
      const password = String(body.password || '');

      if (!password || password.length < 6) {
        return send(res, 400, { ok: false, error: 'Password must be at least 6 characters long.' });
      }
      if (password.length > 256) {
        return send(res, 400, { ok: false, error: 'Password is too long.' });
      }
      const user = email ? db.getUserByEmail(email) : null;
      if (!user || !db.checkPasswordResetCode(email, code)) {
        return send(res, 400, { ok: false, error: 'Invalid or expired reset code.' });
      }

      db.setUserPassword(user.id, password);
      db.clearPasswordReset(email);
      // Earlier failed sign-ins must not lock the owner out of the new password.
      rateBuckets.delete(`login-fail:${email}`);
      rateBuckets.delete(`login-fail:${String(user.username).toLowerCase()}`);
      return send(res, 200, { ok: true, message: 'Password updated. You can now sign in.' });
    }

    if (req.method === 'GET' && url.pathname === '/v1/auth/backup') {
      const supplied = String(req.headers['x-native-backup-token'] || req.headers['x-noctra-backup-token'] || '').trim();
      const expected = String(process.env.NATIVE_BACKUP_TOKEN || '').trim();
      const valid = supplied && expected && supplied.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
      if (!valid) {
        return send(res, expected ? 401 : 404, { ok: false, error: expected ? 'Backup authorization required.' : 'Not found.' });
      }
      const backup = db.backupDatabase();
      const data = fs.readFileSync(backup.path);
      return send(res, 200, data, {
        'Content-Type': 'application/x-sqlite3',
        'Content-Disposition': `attachment; filename="${backup.filename}"`
      });
    }

    // ── Account: Minecraft status and merging ─────────────────────────────
    if (req.method === 'GET' && url.pathname === '/v1/account/minecraft') {
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      const authUser = db.getUserBySession(token);
      if (!authUser) return send(res, 401, { ok: false, error: 'Native account session required.' });
      return send(res, 200, {
        ok: true,
        profile: db.getMinecraftLink(authUser.id),
        account: { id: authUser.id, name: authUser.username, type: authUser.auth_type || 'native' }
      }, { 'Cache-Control': 'no-store' });
    }

    /**
     * Merge a premium account (the caller's premium session) with a Native email
     * account (its login + password). The email account survives with the
     * Minecraft name and UUID, and gets everything the premium account owned.
     * One-way. Every older sign-in of both accounts ends.
     */
    if (req.method === 'POST' && url.pathname === '/v1/account/merge') {
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      const premiumUser = db.getUserBySession(token);
      if (!premiumUser) return send(res, 401, { ok: false, error: 'Sign in with Microsoft first.' });
      if (premiumUser.auth_type !== 'premium') {
        return send(res, 409, { ok: false, error: premiumUser.auth_type === 'merged' ? 'This account is already merged.' : 'Merging starts from a Microsoft account.' });
      }
      if (!hit('merge', premiumUser.id, 10, 60 * 60_000)) return tooMany(res, 3600);
      const body = await readJson(req);
      const login = String(body.login || '').trim();
      const password = String(body.password || '');
      const loginKey = login.toLowerCase();
      if (!login || !password) return send(res, 400, { ok: false, error: 'Enter your Native email or username and password.' });
      if (blocked('login-fail', loginKey, 10, 15 * 60_000)) return tooMany(res, 900, 'Too many sign-in attempts. Please wait 15 minutes and try again.');
      const nativeUser = db.getUserByLogin(login);
      if (!nativeUser || !nativeUser.password_hash || !(await db.verifyPasswordAsync(password, nativeUser.password_hash, nativeUser.salt))) {
        hit('login-fail', loginKey, 10, 15 * 60_000);
        return send(res, 401, { ok: false, error: 'Invalid username/email or password.' });
      }
      if (nativeUser.auth_type !== 'native') return send(res, 409, { ok: false, error: 'That Native account is already merged with a Microsoft account.' });
      let result;
      try {
        result = db.mergePremiumInto(premiumUser.id, nativeUser.id);
      } catch (error) {
        console.error('[Native Merge]', error);
        return send(res, 409, { ok: false, error: error.message || 'Could not merge the accounts.' });
      }
      const merged = result.user;
      // Wardrobe: keep the email account's cloak, drop its Native skin (the Mojang skin is used).
      const nativeProfile = readProfile(result.from.native);
      const premiumProfile = readProfile(result.from.premium);
      const base = nativeProfile || premiumProfile || { username: merged.username, model: 'default', skin: null, cape: null };
      try { fs.rmSync(profilePath(result.from.native), { force: true }); } catch {}
      try { fs.rmSync(profilePath(result.from.premium), { force: true }); } catch {}
      const wornFrom = (nativeProfile && nativeProfile.cosmetics) ? nativeProfile : (premiumProfile && premiumProfile.cosmetics) ? premiumProfile : null;
      const wornCosmetics = wornFrom ? wornFrom.cosmetics : null;
      // the hand sides and the dye colours travel with the cosmetics they belong to
      const wornSides = wornFrom && wornFrom.cosmeticSides && Object.keys(wornFrom.cosmeticSides).length ? wornFrom.cosmeticSides : null;
      saveProfile({
        ...(base.cape ? base : (premiumProfile || base)),
        ...(wornCosmetics ? { cosmetics: wornCosmetics } : {}),
        cosmeticSides: wornSides || undefined,
        cosmeticDyes: (wornFrom && wornFrom.cosmeticDyes) || undefined,
        username: merged.username,
        skin: null,
        skinName: undefined,
        authHash: null,
        updatedAt: new Date().toISOString()
      }, req, merged);
      try { modRoutes.noteRename([{ from: result.from.native, to: merged.username }]); } catch {}
      try { billing.syncPlus?.(merged.id); } catch {}
      events.publish([...new Set([merged.id, ...db.getFriendIds(merged.id)])], 'friends:changed', { userId: merged.id, renamed: { from: result.from.native, to: merged.username } });
      const session = db.createSession(merged.id, 'premium');
      return send(res, 200, { ok: true, token: session.token, account: nativeAccountPayload(merged, session.token) }, { 'Cache-Control': 'no-store' });
    }

    // ── Admin APIs (session + database role required) ─────────────────────
    if (url.pathname.startsWith('/v1/admin/')) {
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      const authUser = db.getUserBySession(token);
      if (!authUser) {
        return send(res, 401, { ok: false, error: 'Native account session required.' });
      }
      const isAdmin = Boolean(authUser.is_admin);

      // Any authenticated client may ask whether its own session is an admin
      // session. All database reads and mutations below still require the role.
      if (req.method === 'GET' && url.pathname === '/v1/admin/status') {
        return send(res, 200, { ok: true, isAdmin }, { 'Cache-Control': 'no-store' });
      }
      if (!isAdmin) {
        return send(res, 403, { ok: false, error: 'Administrator access required.' });
      }

      if (req.method === 'GET' && url.pathname === '/v1/admin/overview') {
        return send(res, 200, { ok: true, overview: db.getAdminOverview() }, { 'Cache-Control': 'no-store' });
      }

      if (req.method === 'GET' && url.pathname === '/v1/admin/users') {
        const result = db.listAdminUsers({
          query: url.searchParams.get('query') || '',
          page: url.searchParams.get('page') || 1,
          pageSize: url.searchParams.get('pageSize') || 50
        });
        return send(res, 200, { ok: true, ...result }, { 'Cache-Control': 'no-store' });
      }

      const badgeMatch = url.pathname.match(/^\/v1\/admin\/users\/([^/]+)\/badges$/);
      if (req.method === 'POST' && badgeMatch) {
        const body = await readJson(req);
        if (typeof body.granted !== 'boolean') {
          return send(res, 400, { ok: false, error: 'Badge state must be a boolean.' });
        }
        const result = db.setUserBadge(decodeURIComponent(badgeMatch[1]), body.badge, body.granted);
        events.publish([...new Set([result.id, ...db.getFriendIds(result.id)])], 'friends:changed', {
          actorId: authUser.id,
          userId: result.id,
          badgesChanged: true
        });
        return send(res, 200, { ok: true, user: result }, { 'Cache-Control': 'no-store' });
      }

      const adminMatch = url.pathname.match(/^\/v1\/admin\/users\/([^/]+)\/admin$/);
      if (req.method === 'POST' && adminMatch) {
        const body = await readJson(req);
        if (typeof body.isAdmin !== 'boolean') {
          return send(res, 400, { ok: false, error: 'Admin state must be a boolean.' });
        }
        const targetId = decodeURIComponent(adminMatch[1]);
        if (targetId === authUser.id && !body.isAdmin) {
          return send(res, 400, { ok: false, error: 'You can’t remove your own admin access.' });
        }
        try {
          const result = db.setUserAdmin(targetId, body.isAdmin);
          return send(res, 200, { ok: true, user: result }, { 'Cache-Control': 'no-store' });
        } catch (error) {
          return send(res, 404, { ok: false, error: error.message || 'User not found.' });
        }
      }

      const sessionsMatch = url.pathname.match(/^\/v1\/admin\/users\/([^/]+)\/sessions\/revoke$/);
      if (req.method === 'POST' && sessionsMatch) {
        const targetId = decodeURIComponent(sessionsMatch[1]);
        if (targetId === authUser.id) {
          return send(res, 400, { ok: false, error: 'Sign yourself out from Settings instead.' });
        }
        try {
          const result = db.revokeUserSessions(targetId);
          return send(res, 200, { ok: true, ...result }, { 'Cache-Control': 'no-store' });
        } catch (error) {
          return send(res, 404, { ok: false, error: error.message || 'User not found.' });
        }
      }

      return send(res, 404, { ok: false, error: 'Admin endpoint not found.' });
    }

    // ── Native Social APIs (Native authenticated users only) ─────────────
    if (url.pathname.startsWith('/v1/social/')) {
      const authHeader = req.headers.authorization || '';
      const headerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (req.method === 'GET' && url.pathname === '/v1/social/stats') {
        const realCount = events.connectedUserCount();
        return send(res, 200, {
          ok: true,
          onlineUsers: realCount,
          realOnlineUsers: realCount,
          updatedAt: Date.now()
        }, { 'Cache-Control': 'no-store' });
      }

      // EventSource cannot set headers, so the stream also accepts ?token=
      const token = headerToken || String(url.searchParams.get('token') || '').trim();
      const authUser = db.getUserBySession(token);
      if (!authUser) {
        return send(res, 401, { ok: false, error: 'Unauthorized. Native account session required.' });
      }
      const origin = originOf(req);

      // ── Realtime event stream ──────────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/v1/social/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          'Access-Control-Allow-Origin': '*'
        });
        if (res.flushHeaders) res.flushHeaders();
        if (req.socket && req.socket.setNoDelay) req.socket.setNoDelay(true);
        if (req.socket && req.socket.setTimeout) req.socket.setTimeout(0);

        const unsubscribe = events.subscribe(authUser.id, res);

        // Coming online is itself a realtime event for every friend.
        try {
          db.updatePresence(authUser.id, { status: 'online', activity: 'In Launcher', serverAddress: null });
          events.publish(db.getFriendIds(authUser.id), 'presence', {
            userId: authUser.id,
            status: 'online',
            activity: 'In Launcher',
            serverAddress: null
          });
        } catch {}

        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          unsubscribe();
          // Another window/device of the same account (or its game) may still be connected.
          if (events.isConnected(authUser.id) || events.isModConnected(authUser.id)) return;
          try {
            db.updatePresence(authUser.id, { status: 'offline', activity: null, serverAddress: null });
          } catch {}
          try {
            events.publish(db.getFriendIds(authUser.id), 'presence', {
              userId: authUser.id,
              status: 'offline',
              activity: null,
              serverAddress: null,
              lastSeen: Date.now()
            });
          } catch {}
        };
        req.on('close', close);
        req.on('error', close);
        return undefined;
      }

      if (req.method === 'GET' && url.pathname === '/v1/social/friends') {
        const friends = db.getFriends(authUser.id).map((f) => withSkin(f, origin));
        return send(res, 200, { ok: true, friends, serverTime: Date.now() }, { 'Cache-Control': 'no-store' });
      }

      if (req.method === 'GET' && /^\/v1\/social\/friends\/[^/]+\/mutual$/.test(url.pathname)) {
        const otherId = decodeURIComponent(url.pathname.split('/')[4] || '').trim();
        if (!otherId) return send(res, 400, { ok: false, error: 'Friend ID required' });
        const mutual = db.getMutualFriends(authUser.id, otherId).map((f) => withSkin(f, origin));
        return send(res, 200, { ok: true, mutual, count: mutual.length }, { 'Cache-Control': 'no-store' });
      }

      if (req.method === 'GET' && url.pathname === '/v1/social/requests') {
        const reqs = db.getFriendRequests(authUser.id);
        return send(res, 200, {
          ok: true,
          requests: {
            received: (reqs.received || []).map((r) => withSkin(r, origin)),
            sent: (reqs.sent || []).map((r) => withSkin(r, origin))
          }
        }, { 'Cache-Control': 'no-store' });
      }

      // Every conversation preloaded in one round trip.
      if (req.method === 'GET' && url.pathname === '/v1/social/conversations') {
        const perFriend = Number(url.searchParams.get('perFriend') || 40);
        const conversations = db.getConversations(authUser.id, perFriend);
        return send(res, 200, { ok: true, conversations, serverTime: Date.now() }, { 'Cache-Control': 'no-store' });
      }

      // Polling fallback used only while the stream is disconnected.
      if (req.method === 'GET' && url.pathname === '/v1/social/updates') {
        const since = Number(url.searchParams.get('since') || 0);
        return send(res, 200, { ok: true, ...db.getUpdatesSince(authUser.id, since) }, { 'Cache-Control': 'no-store' });
      }

      if (req.method === 'GET' && url.pathname === '/v1/social/blocked') {
        const blocked = db.listBlocked(authUser.id).map((b) => withSkin(b, origin));
        return send(res, 200, { ok: true, blocked }, { 'Cache-Control': 'no-store' });
      }

      if (req.method === 'POST' && url.pathname === '/v1/social/typing') {
        const body = await readJson(req);
        const friendId = String(body.friendId || '').trim();
        if (friendId) events.setTyping(authUser.id, friendId, Boolean(body.isTyping));
        return send(res, 200, { ok: true }, { 'Cache-Control': 'no-store' });
      }

      if (req.method === 'POST' && url.pathname === '/v1/social/read') {
        const body = await readJson(req);
        const friendId = String(body.friendId || '').trim();
        if (!friendId) return send(res, 400, { ok: false, error: 'Friend ID required' });
        const result = db.markMessagesRead(authUser.id, friendId);
        if (result.messageIds.length) {
          events.publish(friendId, 'message:read', { readerId: authUser.id, messageIds: result.messageIds });
        }
        return send(res, 200, { ok: true, ...result }, { 'Cache-Control': 'no-store' });
      }

      if (req.method === 'POST' && url.pathname === '/v1/social/upload') {
        if (!hit('upload-user', authUser.id, 60, 10 * 60_000)) return tooMany(res, 600, 'Too many uploads. Please wait a few minutes.');
        const body = await readJson(req);
        const rawData = body.data || body.dataUrl || body.base64;
        const originalName = String(body.name || body.filename || 'attachment.png').trim();
        if (!rawData) {
          return send(res, 400, { ok: false, error: 'No file data received.' });
        }
        const dataMatch = String(rawData).match(/^data:([^;,]+);base64,/i);
        const declaredMime = dataMatch?.[1]?.toLowerCase() || '';
        const allowedMedia = new Map([
          ['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/gif', '.gif'],
          ['image/webp', '.webp'], ['audio/mpeg', '.mp3'], ['audio/ogg', '.ogg'],
          ['audio/webm', '.webm'], ['audio/wav', '.wav'], ['video/mp4', '.mp4'],
          ['text/plain', '.txt'], ['application/zip', '.zip']
        ]);
        if (!declaredMime || !allowedMedia.has(declaredMime)) {
          return send(res, 400, { ok: false, error: 'Unsupported attachment type.' });
        }
        const cleanBase64 = String(rawData).replace(/^data:[^;]+;base64,/i, '');
        const buffer = Buffer.from(cleanBase64, 'base64');
        if (buffer.length === 0 || buffer.length > 25 * 1024 * 1024) {
          return send(res, 400, { ok: false, error: 'File size must be between 1 byte and 25MB.' });
        }

        const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
        const ext = allowedMedia.get(declaredMime);
        const filename = `${hash}${ext}`;
        const targetPath = path.join(mediaDir, filename);

        if (!fs.existsSync(targetPath)) {
          atomicWrite(targetPath, buffer);
        }

        return send(res, 200, {
          ok: true,
          url: `${origin}/v1/social/media/${filename}`,
          name: originalName,
          size: buffer.length
        }, { 'Cache-Control': 'no-store' });
      }

      if (req.method === 'POST' && url.pathname === '/v1/social/requests/send') {
        const body = await readJson(req);
        const targetUsername = String(body.username || body.targetUsername || '').trim();
        try {
          const result = db.sendFriendRequest(authUser.id, targetUsername);
          const participants = result.participants || [];
          events.publish(participants, result.mutual ? 'friends:changed' : 'request:changed', {
            actorId: authUser.id,
            actorName: authUser.username,
            receiverId: result.receiverId,
            requestId: result.id,
            action: result.mutual ? 'accepted' : 'sent'
          });
          return send(res, 200, { ok: true, ...result }, { 'Cache-Control': 'no-store' });
        } catch (err) {
          return send(res, 400, { ok: false, error: err.message });
        }
      }

      if (req.method === 'POST' && url.pathname === '/v1/social/requests/respond') {
        const body = await readJson(req);
        const requestId = String(body.requestId || '').trim();
        const action = String(body.action || '').trim().toLowerCase();
        try {
          const result = db.respondFriendRequest(requestId, authUser.id, action);
          events.publish(result.participants || [], 'request:changed', {
            actorId: authUser.id,
            actorName: authUser.username,
            senderId: result.senderId,
            receiverId: result.receiverId,
            action: result.action
          });
          if (result.action === 'accepted') {
            events.publish(result.participants || [], 'friends:changed', { actorId: authUser.id });
          }
          return send(res, 200, result, { 'Cache-Control': 'no-store' });
        } catch (err) {
          return send(res, 400, { ok: false, error: err.message });
        }
      }

      if (url.pathname.startsWith('/v1/social/messages/')) {
        const subPath = url.pathname.slice('/v1/social/messages/'.length);

        // React to message: POST /v1/social/messages/:messageId/react
        const reactMatch = subPath.match(/^([a-zA-Z0-9_\-]+)\/react$/);
        if (req.method === 'POST' && reactMatch) {
          const messageId = reactMatch[1];
          const body = await readJson(req);
          try {
            const result = db.setMessageReaction(messageId, authUser.id, body.reaction);
            events.publish(result.participants || [], 'message:reaction', {
              messageId,
              reactions: result.reactions,
              actorId: authUser.id
            });
            return send(res, 200, result, { 'Cache-Control': 'no-store' });
          } catch (err) {
            return send(res, 400, { ok: false, error: err.message });
          }
        }

        const friendId = decodeURIComponent(subPath).trim();
        if (!friendId) return send(res, 400, { ok: false, error: 'Friend ID required' });

        if (req.method === 'GET') {
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)));
          const beforeParam = url.searchParams.get('before');
          const before = beforeParam ? Number(beforeParam) : null;
          const markRead = url.searchParams.get('markRead') !== '0' && !before;
          const page = db.getMessages(authUser.id, friendId, { limit, before, markRead });
          if (markRead) {
            events.publish(friendId, 'message:read', { readerId: authUser.id, messageIds: null });
          }
          return send(res, 200, { ok: true, ...page }, { 'Cache-Control': 'no-store' });
        }

        if (req.method === 'POST') {
          const body = await readJson(req);
          const content = String(body.content || '').trim();
          if (content.length > MESSAGE_LIMIT) {
            return send(res, 400, { ok: false, error: `Message is too long (maximum ${MESSAGE_LIMIT} characters).` });
          }
          try {
            const message = db.sendMessage(authUser.id, friendId, content, {
              ...media.normalizeAttachment(body, origin),
              replyTo: body.replyTo || null
            });
            events.setTyping(authUser.id, friendId, false);
            events.publish([friendId, authUser.id], 'message:new', { message });
            return send(res, 200, { ok: true, message }, { 'Cache-Control': 'no-store' });
          } catch (err) {
            return send(res, 400, { ok: false, error: err.message });
          }
        }
      }

      if (req.method === 'POST' && url.pathname === '/v1/social/presence') {
        const body = await readJson(req);
        const next = {
          status: body.status || 'online',
          activity: body.activity || 'In Launcher',
          serverAddress: body.serverAddress || null
        };
        const previous = db.getPresence(authUser.id);
        db.updatePresence(authUser.id, next);

        const changed = !previous ||
          previous.status !== next.status ||
          (previous.activity || null) !== (next.activity || null) ||
          (previous.server_address || null) !== (next.serverAddress || null) ||
          (Date.now() - (previous.last_seen || 0)) > db.PRESENCE_TTL_MS;

        if (changed) {
          events.publish(db.getFriendIds(authUser.id), 'presence', { userId: authUser.id, ...next, lastSeen: Date.now() });
        }
        return send(res, 200, { ok: true }, { 'Cache-Control': 'no-store' });
      }

      if (req.method === 'POST' && url.pathname === '/v1/social/friends/update') {
        const body = await readJson(req);
        const friendId = String(body.friendId || '').trim();
        try {
          db.updateFriendAttributes(authUser.id, friendId, {
            isBestFriend: body.isBestFriend,
            nickname: body.nickname,
            pinned: body.pinned,
            muted: body.muted
          });
        } catch (err) {
          return send(res, 400, { ok: false, error: err.message });
        }
        events.publish(authUser.id, 'friends:changed', { actorId: authUser.id, friendId });
        return send(res, 200, { ok: true }, { 'Cache-Control': 'no-store' });
      }

      if (req.method === 'DELETE' && url.pathname.startsWith('/v1/social/friends/')) {
        const friendId = decodeURIComponent(url.pathname.slice('/v1/social/friends/'.length)).trim();
        const result = db.removeFriend(authUser.id, friendId);
        events.publish(result.participants || [], 'friends:changed', { actorId: authUser.id, friendId });
        return send(res, 200, { ok: true }, { 'Cache-Control': 'no-store' });
      }

      if (req.method === 'POST' && url.pathname === '/v1/social/block') {
        const body = await readJson(req);
        const targetId = String(body.targetId || '').trim();
        if (!targetId) return send(res, 400, { ok: false, error: 'Target ID required' });
        const result = db.blockUser(authUser.id, targetId);
        events.publish(result.participants || [], 'friends:changed', { actorId: authUser.id, friendId: targetId, blocked: true });
        return send(res, 200, { ok: true }, { 'Cache-Control': 'no-store' });
      }

      if (req.method === 'POST' && url.pathname === '/v1/social/unblock') {
        const body = await readJson(req);
        const targetId = String(body.targetId || body.blockedId || '').trim();
        if (!targetId) return send(res, 400, { ok: false, error: 'Target ID required' });
        db.unblockUser(authUser.id, targetId);
        events.publish(authUser.id, 'blocks:changed', { actorId: authUser.id, targetId });
        return send(res, 200, { ok: true }, { 'Cache-Control': 'no-store' });
      }

      if (req.method === 'GET' && url.pathname === '/v1/social/search') {
        const q = String(url.searchParams.get('q') || '').trim();
        const results = db.searchUsers(q, authUser.id).map((u) => withSkin(u, origin));
        return send(res, 200, { ok: true, results }, { 'Cache-Control': 'no-store' });
      }

      return send(res, 404, { ok: false, error: 'Social endpoint not found' });
    }

    return send(res, 404, { error: 'Not found.' });
  } catch (error) {
    if (res.headersSent) {
      try { res.end(); } catch {}
      return undefined;
    }
    const status = Number(error && error.status) || 400;
    return send(res, status, { ok: false, error: error.message || 'Invalid request.' });
  }
}

/**
 * Timeouts: headersTimeout/requestTimeout only bound how long a client may
 * take to *send* its request (slowloris protection); they never cut off a
 * long-lived SSE response, which is controlled by keepAliveTimeout/socket
 * timeouts and is disabled per-connection in the stream route.
 */
function applyTimeouts(server) {
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 5 * 60_000;
  server.timeout = 0;
  return server;
}

function createServer() {
  storeRoutes.setTextureReader((hash) => (/^[a-f0-9]{64}$/.test(String(hash)) ? fs.readFileSync(path.join(texturesDir, hash)) : null));
  try { storeRoutes.ensureCatalog(textureHash); } catch (error) { console.warn('[Native Store] catalogue failed to load:', error.message); }
  return applyTimeouts(http.createServer(handler));
}

function listen(port = PORT, host = '127.0.0.1') {
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.mkdirSync(texturesDir, { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  const server = createServer();
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}

if (require.main === module) {
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.mkdirSync(texturesDir, { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  createServer().listen(PORT, '127.0.0.1', () =>
    console.log(`Native Server listening on 127.0.0.1:${PORT}`)
  );
}

module.exports = {
  createServer,
  applyTimeouts,
  clientIp,
  handler,
  listen,
  usernameOf,
  pngBuffer,
  customSkinProfile,
  originOf,
  textureHash,
  DATA_DIR,
  PORT
};
