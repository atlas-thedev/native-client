const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const db = require('./db');
const events = require('./social-events');
const { handleRelayRoutes } = require('./relay-routes');
const { sendVerificationCodeEmail, sendPasswordResetEmail } = require('./mailer');
const media = require('./media');
const modRoutes = require('./mod-routes');
const capes = require('./capes');
const storeRoutes = require('./store-routes');

/**
 * Noctra Backend & API Server
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
const TRUST_PROXY = /^(1|true|yes)$/i.test(String(process.env.NOCTRA_TRUST_PROXY || ''));
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

/**
 * Organic, time-aware player counter simulation:
 * - Natural 24-hour diurnal curve (peak around afternoon/evening, trough at late night/morning).
 * - Smooth random-walk drift (+/- 1-2 players every 10-15s) so numbers fluctuate gradually
 *   like genuine human sessions rather than jumping erratically.
 * - Adds actual real-time connected players on top.
 */
let simulatedOnline = null;
let lastDriftAt = 0;

// Reference launch epoch for automatic daily growth (October 1, 2026 UTC)
const LAUNCH_EPOCH = new Date(process.env.NOCTRA_LAUNCH_DATE || '2026-10-01T00:00:00Z').getTime();

function getDynamicOnlineCount(realUsers = 0) {
  const boostEnabled = process.env.NOCTRA_BOOST_ENABLED !== 'false';
  if (!boostEnabled) return realUsers;

  const now = new Date();
  const nowMs = now.getTime();

  // Automatic daily growth: increases by ~50 players every 24 hours that pass
  const daysElapsed = Math.max(0, (nowMs - LAUNCH_EPOCH) / 86_400_000);
  const dailyGrowthRate = Number(process.env.NOCTRA_DAILY_GROWTH) || 50;
  const growthBonus = Math.floor(daysElapsed * dailyGrowthRate);

  // Baseline range: late night valley to evening peak (+ daily growth bonus)
  const baseMin = (Number(process.env.NOCTRA_BOOST_MIN) || 140) + growthBonus;
  const baseMax = (Number(process.env.NOCTRA_BOOST_MAX) || 420) + growthBonus;

  // Fractional UTC hour of the day (0.00 .. 23.99)
  const hour = now.getUTCHours() + now.getUTCMinutes() / 60;

  // Diurnal curve: peak at ~18:30 UTC (EU/Asia gaming peak), lowest at ~05:00 UTC
  const diurnalFactor = (Math.cos(((hour - 18.5) * 2 * Math.PI) / 24) + 1) / 2; // 0.0 to 1.0
  const targetBase = Math.round(baseMin + (baseMax - baseMin) * diurnalFactor);

  if (simulatedOnline === null) {
    const initialJitter = Math.floor(Math.random() * 9) - 4;
    simulatedOnline = Math.max(baseMin, targetBase + initialJitter);
    lastDriftAt = nowMs;
  } else {
    const elapsed = nowMs - lastDriftAt;
    if (elapsed >= 10_000) {
      lastDriftAt = nowMs;
      const difference = targetBase - simulatedOnline;

      const rand = Math.random();
      if (Math.abs(difference) > 8 && rand < 0.70) {
        simulatedOnline += (difference > 0 ? (Math.random() < 0.7 ? 2 : 1) : (Math.random() < 0.7 ? -2 : -1));
      } else if (rand < 0.40) {
        simulatedOnline += (difference > 0 ? 1 : -1);
      } else if (rand < 0.75) {
        simulatedOnline += (Math.random() < 0.5 ? 1 : -1);
      }

      const floorLimit = Math.floor(baseMin * 0.85);
      const ceilLimit = Math.ceil(baseMax * 1.15);
      simulatedOnline = Math.max(floorLimit, Math.min(ceilLimit, simulatedOnline));
    }
  }

  return simulatedOnline + (Number(realUsers) || 0);
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

const capeAllowed = (hash, profile = null) => storeRoutes.capeAllowed(hash, profile);
const shownCape = (profile) => (profile?.cape && capeAllowed(profile.cape, profile) ? profile.cape : null);

function textureHash(buffer) {
  if (!buffer) return null;
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const target = path.join(texturesDir, hash);
  if (!fs.existsSync(target)) atomicWrite(target, buffer);
  return hash;
}

function profilePath(username) {
  return path.join(profilesDir, `${username.toLowerCase()}.json`);
}

function readProfile(username) {
  try { return JSON.parse(fs.readFileSync(profilePath(username), 'utf8')); } catch { return null; }
}

/**
 * Persists a wardrobe profile and tells everyone who cares, immediately:
 * the Noctra mod (skin stream), the owner's other devices and friends (social stream).
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
const SITE_KEY = String(process.env.NOCTRA_SITE_KEY || '');

/**
 * The Noctra website proxies sign-in requests, so every visitor would share the
 * website host's IP. When NOCTRA_SITE_KEY is set, a request carrying the same key
 * in X-Noctra-Site-Key may name the real visitor in X-Noctra-Client-IP.
 */
function siteForwardedIp(req) {
  if (!SITE_KEY) return null;
  const key = String(req.headers['x-noctra-site-key'] || '');
  const a = Buffer.from(key);
  const b = Buffer.from(SITE_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const ip = String(req.headers['x-noctra-client-ip'] || '').trim();
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
  // Only Noctra store capes animate; anything else is shown as its still first frame.
  const anim = storeRoutes.animationFor(profile);
  if (anim) {
    document.capeAnimation = {
      url: textureUrl(origin, anim.strip),
      frames: anim.frames,
      fps: anim.fps
    };
  }
  if (profile.capeStore) document.capeStore = profile.capeStore;
  return document;
}

const MINECRAFT_PROFILE_URL = process.env.NOCTRA_MC_PROFILE_URL || 'https://api.minecraftservices.com/minecraft/profile';

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

function noctraAccountPayload(user, token) {
  return {
    id: user.id,
    name: user.username,
    email: user.email,
    uuid: user.uuid,
    type: 'noctra',
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
      const allowedOrigin = process.env.NOCTRA_CORS_ORIGIN || (/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(requestOrigin) ? requestOrigin : 'null');
      return send(res, 204, '', {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Vary': 'Origin',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Noctra-Token',
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
        service: 'noctra-server',
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

    // Avatar lookup. Noctra never proxies to third-party skin hosts: if the
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

    // Wardrobe publication
    if (req.method === 'POST' && url.pathname === '/v1/wardrobe') {
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const noctraToken = String(req.headers['x-noctra-token'] || '');
      if (token.length < 32 && (!noctraToken || noctraToken.length < 32)) {
        return send(res, 401, { error: 'Missing wardrobe key.' });
      }
      const body = await readJson(req);
      const username = usernameOf(body.username);
      const existing = readProfile(username);
      const authHash = crypto.createHash('sha256').update(token || noctraToken).digest('hex');

      let authorized = false;
      let sessionAuthorized = false;

      // 1. Session token check
      const checkSessionToken = (noctraToken && noctraToken.length >= 32) ? noctraToken : (token.startsWith('noc_') ? token : null);
      if (checkSessionToken) {
        try {
          const sessionUser = db.getUserBySession(checkSessionToken);
          if (sessionUser && sessionUser.username.toLowerCase() === username.toLowerCase()) {
            authorized = true;
            sessionAuthorized = true;
          }
        } catch {}
      }

      // 2. Registered Noctra names can only be published with that account's session.
      let registeredUser = null;
      try { registeredUser = db.getUserByUsername(username); } catch {}

      // 3. Unregistered names: the key that first claimed the profile owns it.
      // (The old deterministic sha256("noctra-wardrobe-v2:<name>") key was
      // computable by anyone and is no longer accepted on its own.)
      if (!authorized && !registeredUser && existing?.authHash) {
        try {
          if (crypto.timingSafeEqual(Buffer.from(existing.authHash, 'hex'), Buffer.from(authHash, 'hex'))) {
            authorized = true;
          }
        } catch {}
      }

      // 4. Unclaimed, unregistered name: first publisher claims it.
      if (!authorized && !existing && !registeredUser) {
        authorized = true;
      }

      if (!authorized) {
        return send(res, 403, { error: registeredUser ? 'Sign in to this Noctra account to change its wardrobe.' : 'This wardrobe belongs to another key.' });
      }

      // Clients replace a legacy (guessable) key with a random one.
      const rotateKey = String(req.headers['x-noctra-rotate-key'] || '');
      let nextAuthHash = authHash;
      if (rotateKey.length >= 32 && rotateKey.length <= 256) {
        nextAuthHash = crypto.createHash('sha256').update(rotateKey).digest('hex');
      } else if (sessionAuthorized && existing?.authHash) {
        nextAuthHash = existing.authHash;
      }

      const skin = body.skin !== undefined ? (body.skin ? textureHash(pngBuffer(body.skin)) : null) : (existing?.skin ?? null);
      let cape = existing?.cape ?? null;
      let capeRefused = false;
      if (body.cape !== undefined) {
        const capeBuffer = body.cape ? pngBuffer(body.cape) : null;
        const capeHash = capeBuffer ? crypto.createHash('sha256').update(capeBuffer).digest('hex') : null;
        if (capeAllowed(capeHash, existing)) cape = capeHash ? textureHash(capeBuffer) : null;
        else { capeRefused = true; cape = capeAllowed(cape, existing) ? cape : null; }
      }
      let capeAnim = existing?.capeAnim ?? null;
      let capeStore = existing?.capeStore ?? null;
      let animationRefused = false;
      // Older launchers re-send the (static) first frame on every sync. Only a
      // genuinely different cape, or an explicit capeAnim field, drops the animation.
      const capeChanged = cape !== (existing?.cape ?? null);
      if (body.capeAnim !== undefined || capeChanged) {
        capeStore = null;
        capeAnim = null;
      }
      if (body.capeAnim) {
        // Animated cape: `cape` is the first frame, capeAnim.strip the whole strip.
        try {
          const strip = capes.pngFromBase64(body.capeAnim.strip);
          const still = body.cape ? pngBuffer(body.cape) : null;
          if (!strip || !still) throw new Error('An animated cape needs its frame strip and its first frame.');
          const described = capes.validateAnimation({ strip, still, frames: body.capeAnim.frames, fps: body.capeAnim.fps });
          // Animated capes are Noctra store capes only: the strip must be a store item this
          // account owns. Anything else keeps its still first frame as a normal cape.
          const stripHash = crypto.createHash('sha256').update(strip).digest('hex');
          let sessionUser = null;
          if (sessionAuthorized) { try { sessionUser = db.getUserByUsername(username); } catch {} }
          const storeId = storeRoutes.authorizeAnimation({ stripHash, user: sessionUser, existing });
          const item = storeId ? storeRoutes.findItem(storeId) : null;
          if (item && item.still === cape) {
            capeAnim = { strip: item.strip, frames: item.frames, fps: item.fps };
            capeStore = item.id;
          } else {
            animationRefused = true;
          }
        } catch (error) {
          return send(res, 400, { ok: false, error: error.message || 'Invalid animated cape.' });
        }
      }
      if (!cape) { capeAnim = null; capeStore = null; }
      // The name the player gave this skin in their locker, so every device shows the same one.
      const cleanSkinName = (value) => String(value ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 32) || null;
      const skinName = !skin ? null
        : body.skinName !== undefined ? cleanSkinName(body.skinName)
        : (skin === (existing?.skin ?? null) ? (existing?.skinName ?? null) : null);
      const profile = {
        username,
        model: body.model === 'slim' ? 'slim' : 'default',
        skin,
        ...(skinName ? { skinName } : {}),
        cape,
        ...(capeAnim ? { capeAnim } : {}),
        ...(capeStore ? { capeStore } : {}),
        authHash: nextAuthHash,
        updatedAt: new Date().toISOString()
      };
      saveProfile(profile, req);

      return send(res, 200, {
        ok: true,
        username,
        model: profile.model,
        skins: profile.skin ? [profile.skin] : [],
        capes: shownCape(profile) ? [profile.cape] : [],
        animated: Boolean(storeRoutes.animationFor(profile)),
        ...(capeRefused ? { notice: 'Only Noctra capes can be worn. Pick one from your locker.' } : animationRefused ? { notice: 'Animated capes come from the Noctra Store. Your cape was saved as a still image.' } : {}),
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
      }
      if (db.getUserByEmail(email)) {
        return send(res, 400, { ok: false, error: 'An account with this email already exists.' });
      }

      const cooldown = db.verificationCooldown(email);
      if (cooldown > 0) return tooMany(res, cooldown / 1000, 'A code was just sent. Please wait a moment before requesting another.');
      if (!hit('code-email', email, 5, 60 * 60_000)) return tooMany(res, 3600, 'Too many codes requested for this email. Try again later.');

      const code = crypto.randomInt(100000, 1000000).toString();
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
          type: 'noctra',
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
      if (!user || !(await db.verifyPasswordAsync(password, user.password_hash, user.salt))) {
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
          type: 'noctra',
          model: user.model,
          token: session.token
        }
      });
    }

    // ── Premium sign-in: a Minecraft session for a linked premium account
    //    signs straight into its Noctra account (no password on this device).
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
      const user = db.getUserByMinecraftUuid(profile.uuid);
      if (!user) {
        return send(res, 404, {
          ok: false,
          code: 'not_linked',
          error: 'This premium account is not connected to a Noctra account yet.',
          profile
        });
      }
      db.refreshMinecraftName(user.id, profile.name);
      const session = db.createSession(user.id);
      return send(res, 200, {
        ok: true,
        token: session.token,
        account: noctraAccountPayload(user, session.token),
        profile: { uuid: profile.uuid, name: profile.name }
      });
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

      const code = crypto.randomInt(100000, 1000000).toString();
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

      const code = crypto.randomInt(100000, 1000000).toString();
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
      const supplied = String(req.headers['x-noctra-backup-token'] || '').trim();
      const expected = String(process.env.NOCTRA_BACKUP_TOKEN || '').trim();
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

    // ── Premium Minecraft link (Noctra session + Microsoft proof) ────────
    if (url.pathname === '/v1/account/minecraft') {
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      const authUser = db.getUserBySession(token);
      if (!authUser) {
        return send(res, 401, { ok: false, error: 'Noctra account session required.' });
      }

      if (req.method === 'GET') {
        return send(res, 200, { ok: true, profile: db.getMinecraftLink(authUser.id) }, { 'Cache-Control': 'no-store' });
      }

      if (req.method === 'DELETE') {
        db.unlinkMinecraftAccount(authUser.id);
        try { modRoutes.noteProfile(authUser.username); } catch {}
        return send(res, 200, { ok: true, profile: null }, { 'Cache-Control': 'no-store' });
      }

      if (req.method === 'POST') {
        const body = await readJson(req);
        let minecraftProfile;
        try {
          minecraftProfile = await verifyMinecraftToken(body.minecraftAccessToken);
        } catch (error) {
          return send(res, error.status || 401, { ok: false, error: error.message });
        }
        try {
          const profile = db.linkMinecraftAccount(authUser.id, {
            uuid: minecraftProfile.uuid,
            name: minecraftProfile.name
          });
          try { modRoutes.noteProfile(authUser.username); } catch {}
          return send(res, 200, { ok: true, profile }, { 'Cache-Control': 'no-store' });
        } catch (error) {
          return send(res, 409, { ok: false, error: error.message });
        }
      }

      return send(res, 405, { ok: false, error: 'Method not allowed.' });
    }

    // ── Admin APIs (session + database role required) ─────────────────────
    if (url.pathname.startsWith('/v1/admin/')) {
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      const authUser = db.getUserBySession(token);
      if (!authUser) {
        return send(res, 401, { ok: false, error: 'Noctra account session required.' });
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

      return send(res, 404, { ok: false, error: 'Admin endpoint not found.' });
    }

    // ── Noctra Social APIs (Noctra authenticated users only) ─────────────
    if (url.pathname.startsWith('/v1/social/')) {
      const authHeader = req.headers.authorization || '';
      const headerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (req.method === 'GET' && url.pathname === '/v1/social/stats') {
        const realCount = events.connectedUserCount();
        const displayCount = getDynamicOnlineCount(realCount);
        return send(res, 200, {
          ok: true,
          onlineUsers: displayCount,
          realOnlineUsers: realCount,
          updatedAt: Date.now()
        }, { 'Cache-Control': 'no-store' });
      }

      // EventSource cannot set headers, so the stream also accepts ?token=
      const token = headerToken || String(url.searchParams.get('token') || '').trim();
      const authUser = db.getUserBySession(token);
      if (!authUser) {
        return send(res, 401, { ok: false, error: 'Unauthorized. Noctra account session required.' });
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
              serverAddress: null
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
          (Date.now() - (previous.last_seen || 0)) > 120_000;

        if (changed) {
          events.publish(db.getFriendIds(authUser.id), 'presence', { userId: authUser.id, ...next });
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
  try { storeRoutes.ensureCatalog(textureHash); } catch (error) { console.warn('[Noctra Store] catalogue failed to load:', error.message); }
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
    console.log(`Noctra Server listening on 127.0.0.1:${PORT}`)
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
