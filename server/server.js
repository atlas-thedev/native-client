const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const db = require('./db');
const events = require('./social-events');
const { handleRelayRoutes } = require('./relay-routes');
const { sendVerificationCodeEmail } = require('./mailer');

/**
 * Noctra Backend & API Server
 * Handles:
 *  - Authentication & Account management (/v1/auth/*)
 *  - Real-time Social Network: Friends, Requests, Direct Messages, Presence (/v1/social/*)
 *    Realtime transport is Server-Sent Events at GET /v1/social/stream; the
 *    polling endpoints remain as a fallback only.
 *  - Wardrobe Sync & CustomSkinLoader API (/v1/wardrobe, /csl/*, /textures/*)
 */

const PORT = Number(process.env.PORT || process.env.NATIVE_SKIN_PORT || 3418);
const DATA_DIR = path.resolve(
  process.env.NOCTRA_DATA_DIR ||
  process.env.NATIVE_SKIN_DATA ||
  path.join(__dirname, 'data')
);
const PUBLIC_URL = (process.env.NATIVE_SKIN_PUBLIC_URL || '').replace(/\/+$/, '');
const profilesDir = path.join(DATA_DIR, 'profiles');
const texturesDir = path.join(DATA_DIR, 'textures');
const mediaDir = path.join(DATA_DIR, 'media');
const rateBuckets = new Map();
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
    'Cache-Control': status === 200 ? 'public, max-age=90' : 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(body);
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

function getBoostedOnlineUsers(realCount = 0, date = new Date()) {
  const baseTimestamp = 1788220800000; // 2026-09-01T00:00:00Z
  const elapsedMs = Math.max(0, date.getTime() - baseTimestamp);
  const dayMs = 86400000;
  const wholeDays = Math.floor(elapsedMs / dayMs);
  const dayProgress = (elapsedMs % dayMs) / dayMs;

  let accumulatedDaysBoost = 0;
  for (let d = 0; d < wholeDays; d++) {
    const dailyRate = 104 + ((d * 13 + 7) % 17); // generates rates from 104 to 120 per day
    accumulatedDaysBoost += dailyRate;
  }

  const todayRate = 104 + ((wholeDays * 13 + 7) % 17);
  const todayGrowth = Math.floor(dayProgress * todayRate);
  const baseCount = 10482;

  // Diurnal curve (±280 users wave based on time of day)
  const hourOfDay = date.getUTCHours() + (date.getUTCMinutes() / 60);
  const timeOfDayWave = Math.round(280 * Math.sin(((hourOfDay - 8) / 24) * 2 * Math.PI));

  // Micro-fluctuation (±15 users) updated every 5 minutes so it feels alive
  const fiveMinSlot = Math.floor(date.getTime() / (5 * 60 * 1000));
  const microJitter = ((fiveMinSlot * 31 + 11) % 31) - 15;

  const total = baseCount + accumulatedDaysBoost + todayGrowth + timeOfDayWave + microJitter + Number(realCount || 0);
  return Math.max(10000, total);
}

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

function allowed(ip) {
  const now = Date.now();
  const item = rateBuckets.get(ip) || { start: now, count: 0 };
  if (now - item.start > 60_000) { item.start = now; item.count = 0; }
  item.count += 1;
  rateBuckets.set(ip, item);
  return item.count <= 240;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 36 * 1024 * 1024) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Public origin for texture URLs: explicit override, then proxy headers. */
function originOf(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

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
  const cape = textureUrl(origin, profile.cape);
  const slim = profile.model === 'slim';

  const skins = {};
  if (skin) {
    if (slim) skins.slim = skin;
    else skins.default = skin;
  }

  const capes = {};
  if (cape) capes.default = cape;

  return {
    username: profile.username,
    model: profile.model || 'default',
    skins,
    capes,
    skin,
    cape,
    updatedAt: profile.updatedAt
  };
}

async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown';
    if (!allowed(ip)) return send(res, 429, { error: 'Too many requests.' }, { 'Retry-After': '60' });

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
      return send(res, 200, customSkinProfile(profile, originOf(req)), { ETag: etag, 'Access-Control-Allow-Origin': '*' });
    }

    // Texture delivery
    const textureMatch = url.pathname.match(/^\/(?:csl\/)?textures\/([a-f0-9]{64})$/);
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
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=31536000, immutable',
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

      // 1. Session token check
      const checkSessionToken = (noctraToken && noctraToken.length >= 32) ? noctraToken : (token.startsWith('noc_') ? token : null);
      if (checkSessionToken) {
        try {
          const sessionUser = db.getUserBySession(checkSessionToken);
          if (sessionUser && sessionUser.username.toLowerCase() === username.toLowerCase()) {
            authorized = true;
          }
        } catch {}
      }

      // 2. Check if registered
      let registeredUser = null;
      try { registeredUser = db.getUserByUsername(username); } catch {}

      // 3. Match existing profile authHash
      if (!authorized && existing?.authHash) {
        try {
          if (crypto.timingSafeEqual(Buffer.from(existing.authHash, 'hex'), Buffer.from(authHash, 'hex'))) {
            authorized = true;
          }
        } catch {}
      }

      // 4. Deterministic key check for offline / unregistered usernames
      if (!authorized && !registeredUser) {
        const expectedKey = crypto.createHash('sha256').update(`noctra-wardrobe-v2:${username.toLowerCase()}`).digest('hex').slice(0, 48);
        const expectedHash = crypto.createHash('sha256').update(expectedKey).digest('hex');
        if (authHash === expectedHash) {
          authorized = true;
        }
      }

      // 5. If no existing profile and either authorized or not registered
      if (!authorized && !existing && !registeredUser) {
        authorized = true;
      }

      if (!authorized) {
        return send(res, 403, { error: 'This wardrobe belongs to another key.' });
      }

      const skin = body.skin !== undefined ? (body.skin ? textureHash(pngBuffer(body.skin)) : null) : (existing?.skin ?? null);
      const cape = body.cape !== undefined ? (body.cape ? textureHash(pngBuffer(body.cape)) : null) : (existing?.cape ?? null);
      const profile = {
        username,
        model: body.model === 'slim' ? 'slim' : 'default',
        skin,
        cape,
        authHash: authorized && authHash ? authHash : (existing?.authHash || authHash),
        updatedAt: new Date().toISOString()
      };
      atomicWrite(profilePath(username), JSON.stringify(profile, null, 2));

      // Tell friends to re-render the avatar immediately.
      try {
        const owner = db.getUserByUsername(username);
        if (owner) {
          events.publish(db.getFriendIds(owner.id), 'skin:updated', {
            userId: owner.id,
            name: username,
            skinUrl: profile.skin ? `${originOf(req)}/csl/textures/${profile.skin}` : null
          });
        }
      } catch {}

      return send(res, 200, {
        ok: true,
        username,
        model: profile.model,
        skins: profile.skin ? [profile.skin] : [],
        capes: profile.cape ? [profile.cape] : [],
        profile: customSkinProfile(profile, originOf(req))
      });
    }

    // ── Authentication APIs ─────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/v1/auth/register/send-code') {
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

      const code = crypto.randomInt(100000, 1000000).toString();
      db.saveVerificationCode(email, code);

      try {
        await sendVerificationCodeEmail(email, code, rawUsername);
      } catch (err) {
        console.error('SendGrid email error:', err);
        return send(res, 500, { ok: false, error: `Could not send verification email: ${err.message}` });
      }

      return send(res, 200, { ok: true, message: 'Verification code sent.' });
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/register/verify') {
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

      const user = db.getUserByLogin(login);
      if (!user || !db.verifyPassword(password, user.password_hash, user.salt)) {
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

    if (req.method === 'POST' && url.pathname === '/v1/auth/resend-code') {
      const body = await readJson(req);
      const email = String(body.email || '').trim().toLowerCase();
      const username = String(body.username || '').trim();

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return send(res, 400, { ok: false, error: 'Please enter a valid email address.' });
      }

      const code = crypto.randomInt(100000, 1000000).toString();
      db.saveVerificationCode(email, code);

      try {
        await sendVerificationCodeEmail(email, code, username);
      } catch (err) {
        return send(res, 500, { ok: false, error: `Could not send verification email: ${err.message}` });
      }

      return send(res, 200, { ok: true, message: 'New code sent.' });
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
        return send(res, 200, { ok: true, profile: null }, { 'Cache-Control': 'no-store' });
      }

      if (req.method === 'POST') {
        const body = await readJson(req);
        const minecraftToken = String(body.minecraftAccessToken || '').trim();
        if (minecraftToken.length < 40 || minecraftToken.length > 4096) {
          return send(res, 400, { ok: false, error: 'A valid Microsoft Minecraft session is required.' });
        }

        let profileResponse;
        try {
          profileResponse = await fetch('https://api.minecraftservices.com/minecraft/profile', {
            headers: { Authorization: `Bearer ${minecraftToken}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(12_000)
          });
        } catch {
          return send(res, 502, { ok: false, error: 'Minecraft could not verify this account right now. Try again.' });
        }
        if (!profileResponse.ok) {
          return send(res, 401, { ok: false, error: 'This Microsoft session does not own Minecraft or has expired.' });
        }

        const minecraftProfile = await profileResponse.json();
        try {
          const profile = db.linkMinecraftAccount(authUser.id, {
            uuid: minecraftProfile.id,
            name: minecraftProfile.name
          });
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
        return send(res, 200, {
          ok: true,
          onlineUsers: getBoostedOnlineUsers(realCount),
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
          // Another window/device of the same account may still be connected.
          if (events.isConnected(authUser.id)) return;
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
          fs.writeFileSync(targetPath, buffer);
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
          const mediaUrl = body.mediaUrl || body.media_url || null;
          const mediaName = body.mediaName || body.media_name || null;
          const mediaKind = body.mediaKind || body.media_kind || null;
          const isMedia = body.isMedia ?? body.is_media ?? Boolean(mediaUrl);
          if (content.length > MESSAGE_LIMIT) {
            return send(res, 400, { ok: false, error: `Message is too long (maximum ${MESSAGE_LIMIT} characters).` });
          }
          try {
            const message = db.sendMessage(authUser.id, friendId, content, {
              mediaUrl,
              mediaName,
              mediaKind,
              isMedia: isMedia ? 1 : 0,
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
    return send(res, 400, { error: error.message || 'Invalid request.' });
  }
}

function createServer() {
  const server = http.createServer(handler);
  // SSE connections must never be culled by the default keep-alive timeout.
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  return server;
}

function listen(port = PORT, host = '0.0.0.0') {
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
