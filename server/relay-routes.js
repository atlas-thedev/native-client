const db = require('./db');
const events = require('./social-events');
const media = require('./media');

/**
 * Relay group + reply API.
 *
 * Mounted in front of the existing request handler (see index.js) so the
 * original social endpoints keep working untouched. Everything here lives
 * under /v1/social/relay/ and speaks the same session-token auth as the rest
 * of the social API, including the ?token= fallback EventSource needs.
 */


function send(res, status, value, headers = {}) {
  const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(body);
}

async function readJson(req, maxBytes = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function publish(userIds, type, payload) {
  try { events.publish(userIds, type, payload); } catch {}
}

/** Group state changed: everyone involved reloads the same summary. */
function broadcastGroup(participants, group, extra = {}) {
  publish(participants, 'group:updated', { group, ...extra });
}

function broadcastNotices(participants, groupId, notices = []) {
  for (const notice of notices.filter(Boolean)) {
    publish(participants, 'group:message', { groupId, message: notice });
  }
}

function setGroupTyping(groupId, userId, isTyping, participants) {
  publish(participants.filter((id) => id !== userId), 'group:typing', { groupId, userId, isTyping: Boolean(isTyping) });
}

/** What a game ticket may do here: list groups, read and send group / direct messages, read receipts, typing. */
function gameTicketAllowed(method, segments) {
  const [a, b, c, d] = segments;
  if (d !== undefined) return false;
  if (a === 'groups') {
    if (segments.length === 1) return method === 'GET';
    if (segments.length === 2) return method === 'GET';
    if (c === 'messages') return method === 'GET' || method === 'POST';
    if (c === 'read' || c === 'typing') return method === 'POST';
    return false;
  }
  if (a === 'dm' && b && c === 'messages') return method === 'GET' || method === 'POST';
  if (a === 'gifs' && segments.length === 1) return method === 'GET';
  if (a === 'upload' && segments.length === 1) return method === 'POST';
  return false;
}

// In-game uploads: images only (pasted screenshots / clipboard pictures).
const GAME_UPLOAD_TYPES = new Map([['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/gif', '.gif'], ['image/webp', '.webp']]);
const gameUploads = new Map(); // userId -> recent upload timestamps
function saveUpload(userId, body, origin) {
  const now = Date.now();
  const recent = (gameUploads.get(userId) || []).filter((at) => now - at < 10 * 60_000);
  if (recent.length >= 30) return { status: 429, value: { ok: false, error: 'Too many uploads. Please wait a few minutes.' } };
  const raw = String(body.data || body.dataUrl || body.base64 || '');
  const match = raw.match(/^data:([^;,]+);base64,/i);
  const mime = (match?.[1] || '').toLowerCase();
  if (!GAME_UPLOAD_TYPES.has(mime)) return { status: 400, value: { ok: false, error: 'Only images can be sent from the game.' } };
  const buffer = Buffer.from(raw.slice(match[0].length), 'base64');
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) return { status: 400, value: { ok: false, error: 'Images must be under 8MB.' } };
  const crypto = require('crypto');
  const fs = require('fs');
  const path = require('path');
  const filename = `${crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32)}${GAME_UPLOAD_TYPES.get(mime)}`;
  const target = path.join(media.MEDIA_DIR, filename);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(media.MEDIA_DIR, { recursive: true });
    const tmp = `${target}.${process.pid}.${now}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, target);
  }
  recent.push(now);
  gameUploads.set(userId, recent);
  if (gameUploads.size > 5000) gameUploads.clear();
  const name = media.cleanMediaName(body.name || body.filename) || `image${GAME_UPLOAD_TYPES.get(mime)}`;
  return { status: 200, value: { ok: true, url: `${origin}/v1/social/media/${filename}`, name, size: buffer.length, kind: 'image' } };
}

const gameWrites = new Map(); // userId -> recent POST timestamps
function gameWriteAllowed(userId, now = Date.now()) {
  const recent = (gameWrites.get(userId) || []).filter((at) => now - at < 10_000);
  if (recent.length >= 20) { gameWrites.set(userId, recent); return false; }
  recent.push(now);
  gameWrites.set(userId, recent);
  if (gameWrites.size > 5000) gameWrites.clear();
  return true;
}

/**
 * @returns {Promise<boolean>} true when the request was handled here.
 */
async function handleRelayRoutes(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/v1/social/relay')) return false;

  if (req.method === 'OPTIONS') {
    const requestOrigin = String(req.headers.origin || '');
    const allowedOrigin = process.env.NATIVE_CORS_ORIGIN || (/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(requestOrigin) ? requestOrigin : 'null');
    send(res, 204, '', {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Native-Token',
      'Access-Control-Max-Age': '600'
    });
    return true;
  }

  const headerToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const token = headerToken || String(url.searchParams.get('token') || '').trim();
  const rest = url.pathname.slice('/v1/social/relay'.length).replace(/^\/+/, '');
  let segments;
  try { segments = rest ? rest.split('/').map(decodeURIComponent) : []; } catch { segments = []; }

  let authUser = token ? db.getUserBySession(token) : null;
  // The in-game chat (Native mod) signs in with its game-only ticket and may only read and send messages.
  if (!authUser && token.startsWith('nmt1.') && gameTicketAllowed(req.method, segments)) {
    authUser = require('./mod-routes').userForTicket(token);
    if (authUser && req.method === 'POST' && !gameWriteAllowed(authUser.id)) {
      send(res, 429, { ok: false, error: 'Slow down a little.' }, { 'Retry-After': '10' });
      return true;
    }
  }
  if (!authUser) {
    send(res, 401, { ok: false, error: 'Unauthorized. Native account session required.' });
    return true;
  }
  const me = authUser.id;

  try {
    // ── Groups collection ────────────────────────────────────────────────
    // ── GIF search + image upload (launcher and in-game chat) ─────────────
    if (segments[0] === 'gifs' && segments.length === 1 && req.method === 'GET') {
      const result = await require('./gifs').searchGifs(url.searchParams.get('q') || '', {
        limit: url.searchParams.get('limit'),
        offset: url.searchParams.get('offset')
      });
      send(res, 200, result, { 'Cache-Control': 'private, max-age=300' });
      return true;
    }
    if (segments[0] === 'upload' && segments.length === 1 && req.method === 'POST') {
      const body = await readJson(req, 12 * 1024 * 1024);
      const out = saveUpload(me, body, media.originOf(req));
      send(res, out.status, out.value);
      return true;
    }

    if (segments[0] === 'groups' && segments.length === 1) {
      if (req.method === 'GET') {
        send(res, 200, { ok: true, groups: db.getGroups(me), serverTime: Date.now() });
        return true;
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        const { group, participants } = db.createGroup(me, {
          name: body.name,
          iconUrl: media.normalizeIconUrl(body.iconUrl, media.originOf(req)),
          description: body.description,
          memberIds: body.memberIds || body.members || []
        });
        publish(participants, 'group:created', { group });
        send(res, 200, { ok: true, group });
        return true;
      }
    }

    // ── Single group ─────────────────────────────────────────────────────
    if (segments[0] === 'groups' && segments.length >= 2) {
      const groupId = segments[1];
      const action = segments[2] || '';
      const sub = segments[3] || '';

      if (req.method === 'GET' && !action) {
        send(res, 200, { ok: true, group: db.getGroup(me, groupId) });
        return true;
      }

      if (req.method === 'GET' && action === 'messages') {
        const limit = Number(url.searchParams.get('limit') || 50);
        const beforeParam = url.searchParams.get('before');
        const page = db.getGroupMessages(me, groupId, {
          limit,
          before: beforeParam ? Number(beforeParam) : null
        });
        if (url.searchParams.get('markRead') !== '0' && !beforeParam) {
          const read = db.markGroupRead(me, groupId);
          publish(read.participants, 'group:read', { groupId, readerId: me, at: read.at });
        }
        send(res, 200, { ok: true, ...page });
        return true;
      }

      if (req.method === 'POST' && action === 'messages') {
        const body = await readJson(req);
        const { message, participants } = db.sendGroupMessage(me, groupId, body.content, {
          ...media.normalizeAttachment(body, media.originOf(req)),
          replyTo: body.replyTo || null
        });
        setGroupTyping(groupId, me, false, participants);
        const groupName = db.getGroup(me, groupId)?.name || 'Relay group';
        publish(participants, 'group:message', { groupId, groupName, message });
        send(res, 200, { ok: true, message });
        return true;
      }

      if (req.method === 'POST' && action === 'update') {
        const body = await readJson(req);
        const changes = { ...body };
        if (typeof body.iconUrl !== 'undefined') changes.iconUrl = media.normalizeIconUrl(body.iconUrl, media.originOf(req));
        const result = db.updateGroup(me, groupId, changes);
        broadcastGroup(result.participants, result.group);
        broadcastNotices(result.participants, groupId, result.notices);
        send(res, 200, { ok: true, group: result.group });
        return true;
      }

      if (req.method === 'POST' && action === 'members' && !sub) {
        const body = await readJson(req);
        const ids = body.userIds || body.memberIds || (body.userId ? [body.userId] : []);
        const result = db.addGroupMembers(me, groupId, ids);
        broadcastGroup(result.participants, result.group);
        broadcastNotices(result.participants, groupId, [result.notice]);
        publish(result.participants, 'group:created', { group: result.group });
        send(res, 200, { ok: true, group: result.group });
        return true;
      }

      if (req.method === 'POST' && action === 'members' && sub === 'remove') {
        const body = await readJson(req);
        const result = db.removeGroupMember(me, groupId, String(body.userId || ''));
        broadcastGroup(result.participants, result.group, { removedId: result.removedId });
        broadcastNotices(result.participants, groupId, [result.notice]);
        publish([result.removedId], 'group:removed', { groupId, by: me });
        send(res, 200, { ok: true, group: result.group });
        return true;
      }

      if (req.method === 'POST' && action === 'members' && sub === 'role') {
        const body = await readJson(req);
        const result = db.setGroupMemberRole(me, groupId, String(body.userId || ''), String(body.role || 'member'));
        broadcastGroup(result.participants, result.group);
        broadcastNotices(result.participants, groupId, [result.notice]);
        send(res, 200, { ok: true, group: result.group });
        return true;
      }

      if (req.method === 'POST' && action === 'leave') {
        const result = db.leaveGroup(me, groupId);
        if (result.deleted) {
          publish(result.participants, 'group:deleted', { groupId });
        } else {
          const remaining = db.groupMemberIds(groupId);
          broadcastNotices(remaining, groupId, [result.notice]);
          for (const memberId of remaining) {
            publish([memberId], 'group:updated', { group: db.getGroup(memberId, groupId) });
          }
          publish([me], 'group:removed', { groupId, by: me });
        }
        send(res, 200, { ok: true, groupId, deleted: Boolean(result.deleted) });
        return true;
      }

      if ((req.method === 'POST' && action === 'delete') || (req.method === 'DELETE' && !action)) {
        const result = db.deleteGroup(me, groupId);
        publish(result.participants, 'group:deleted', { groupId });
        send(res, 200, { ok: true, groupId });
        return true;
      }

      if (req.method === 'POST' && action === 'prefs') {
        const body = await readJson(req);
        const result = db.setGroupPrefs(me, groupId, { pinned: body.pinned, muted: body.muted });
        publish([me], 'group:updated', { group: result.group });
        send(res, 200, { ok: true, group: result.group });
        return true;
      }

      if (req.method === 'POST' && action === 'read') {
        const result = db.markGroupRead(me, groupId);
        publish(result.participants, 'group:read', { groupId, readerId: me, at: result.at });
        send(res, 200, { ok: true, at: result.at });
        return true;
      }

      if (req.method === 'POST' && action === 'typing') {
        const body = await readJson(req);
        setGroupTyping(groupId, me, Boolean(body.isTyping), db.groupMemberIds(groupId));
        send(res, 200, { ok: true });
        return true;
      }
    }

    // ── Group message actions ────────────────────────────────────────────
    if (segments[0] === 'messages' && segments.length === 3 && req.method === 'POST') {
      const messageId = segments[1];
      const action = segments[2];
      const body = await readJson(req);

      if (action === 'react') {
        const result = db.setGroupMessageReaction(messageId, me, body.reaction);
        publish(result.participants, 'group:message:reaction', {
          groupId: result.groupId,
          messageId,
          reactions: result.reactions,
          actorId: me
        });
        send(res, 200, result);
        return true;
      }

      if (action === 'edit') {
        const result = db.editGroupMessage(me, messageId, body.content);
        publish(result.participants, 'group:message:updated', { groupId: result.message.groupId, message: result.message });
        send(res, 200, { ok: true, message: result.message });
        return true;
      }

      if (action === 'delete') {
        const result = db.deleteGroupMessage(me, messageId);
        if (result.releasedMediaUrl) media.releaseMedia(result.releasedMediaUrl, db.isMediaReferenced);
        publish(result.participants, 'group:message:updated', { groupId: result.message.groupId, message: result.message });
        send(res, 200, { ok: true, message: result.message });
        return true;
      }
    }

    // ── Direct messages with replies ─────────────────────────────────────
    if (segments[0] === 'dm' && segments.length >= 2) {
      const friendId = segments[1];
      const action = segments[2] || '';

      if (req.method === 'GET' && action === 'messages') {
        const beforeParam = url.searchParams.get('before');
        const page = db.getDirectMessages(me, friendId, {
          limit: Number(url.searchParams.get('limit') || 50),
          before: beforeParam ? Number(beforeParam) : null,
          markRead: url.searchParams.get('markRead') !== '0' && !beforeParam
        });
        if (page.readIds?.length) {
          publish([friendId], 'message:read', { readerId: me, messageIds: page.readIds });
        }
        send(res, 200, { ok: true, ...page });
        return true;
      }

      if (req.method === 'POST' && action === 'messages') {
        const body = await readJson(req);
        const message = db.sendDirectMessage(me, friendId, body.content, {
          ...media.normalizeAttachment(body, media.originOf(req)),
          replyTo: body.replyTo || null
        });
        events.setTyping(me, friendId, false);
        publish([friendId, me], 'message:new', { message });
        send(res, 200, { ok: true, message });
        return true;
      }
    }

    // ── Direct message edit / delete ─────────────────────────────────────
    if (segments[0] === 'dm-messages' && segments.length === 3 && req.method === 'POST') {
      const messageId = segments[1];
      const action = segments[2];
      const body = await readJson(req);

      if (action === 'edit') {
        const result = db.editDirectMessage(me, messageId, body.content);
        publish(result.participants, 'message:updated', { message: result.message });
        send(res, 200, { ok: true, message: result.message });
        return true;
      }

      if (action === 'delete') {
        const result = db.deleteDirectMessage(me, messageId);
        if (result.releasedMediaUrl) media.releaseMedia(result.releasedMediaUrl, db.isMediaReferenced);
        publish(result.participants, 'message:updated', { message: result.message });
        send(res, 200, { ok: true, message: result.message });
        return true;
      }
    }

    send(res, 404, { ok: false, error: 'Relay endpoint not found' });
    return true;
  } catch (error) {
    if (!res.headersSent) {
      send(res, 400, { ok: false, error: error.message || 'Invalid request.' });
    } else {
      try { res.end(); } catch {}
    }
    return true;
  }
}

module.exports = { handleRelayRoutes, _internals: { gameTicketAllowed } };
