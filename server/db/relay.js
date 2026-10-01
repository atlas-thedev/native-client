const crypto = require('crypto');

/**
 * Relay group chats, replies and message editing.
 *
 * Roles are Discord-shaped: exactly one `owner`, any number of `admin`s, and
 * `member`s. Every permission check compares role rank, so an admin can never
 * act on the owner or on another admin, and only the owner can delete the room
 * or hand ownership over.
 */

const MESSAGE_LIMIT = 2000;
const MAX_MEMBERS = 50;
const NAME_MAX = 32;
const DESCRIPTION_MAX = 200;
const ROLES = ['owner', 'admin', 'member'];

const rank = (role) => (role === 'owner' ? 3 : role === 'admin' ? 2 : 1);
const uid = (prefix) => `${prefix}-${crypto.randomBytes(8).toString('hex')}`;

function cleanName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Group name is required.');
  return name.slice(0, NAME_MAX);
}

function cleanDescription(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, DESCRIPTION_MAX) : null;
}

/** Group images always come back from /v1/social/upload, never a raw data URL. */
function cleanIcon(value) {
  if (value == null || value === '') return null;
  const url = String(value).trim();
  if (url.length > 600) throw new Error('Group image URL is too long.');
  // Only images uploaded through Noctra; never arbitrary third-party URLs.
  return require('../media').normalizeIconUrl(url);
}

function membership(db, groupId, userId) {
  return db.prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId) || null;
}

function requireMember(db, groupId, userId) {
  const row = membership(db, groupId, userId);
  if (!row) throw new Error('You are not a member of this group.');
  return row;
}

function requireAdmin(db, groupId, userId) {
  const row = requireMember(db, groupId, userId);
  if (rank(row.role) < 2) throw new Error('Only group admins can do that.');
  return row;
}

function requireOwner(db, groupId, userId) {
  const row = requireMember(db, groupId, userId);
  if (row.role !== 'owner') throw new Error('Only the group owner can do that.');
  return row;
}

function memberIds(db, groupId) {
  return db.prepare('SELECT user_id AS id FROM group_members WHERE group_id = ?').all(groupId).map((r) => r.id);
}

function areFriends(db, userId, friendId) {
  return Boolean(db.prepare('SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?').get(userId, friendId));
}

function isBlockedPair(db, a, b) {
  return Boolean(db.prepare(
    'SELECT 1 FROM blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)'
  ).get(a, b, b, a));
}

// ── Messages ───────────────────────────────────────────────────────────────

const GROUP_MESSAGE_SELECT = `
  SELECT
    gm.id,
    gm.group_id AS groupId,
    gm.sender_id AS senderId,
    author.username AS senderName,
    gm.content,
    gm.media_url AS mediaUrl,
    gm.media_name AS mediaName,
    gm.media_kind AS mediaKind,
    gm.is_media AS isMedia,
    gm.reply_to AS replyTo,
    gm.system_kind AS systemKind,
    gm.edited_at AS editedAt,
    gm.deleted_at AS deletedAt,
    gm.created_at AS createdAt,
    (SELECT json_group_array(json_object('userId', r.user_id, 'reaction', r.reaction))
     FROM group_message_reactions r WHERE r.message_id = gm.id) AS reactionsJson,
    parent.sender_id AS replySenderId,
    parentAuthor.username AS replySenderName,
    parent.content AS replyContent,
    parent.media_name AS replyMediaName,
    parent.media_url AS replyMediaUrl,
    parent.deleted_at AS replyDeletedAt
  FROM group_messages gm
  JOIN users author ON author.id = gm.sender_id
  LEFT JOIN group_messages parent ON parent.id = gm.reply_to
  LEFT JOIN users parentAuthor ON parentAuthor.id = parent.sender_id
`;

const DIRECT_MESSAGE_SELECT = `
  SELECT
    m.id,
    m.sender_id AS senderId,
    m.receiver_id AS receiverId,
    m.content,
    m.media_url AS mediaUrl,
    m.media_name AS mediaName,
    m.media_kind AS mediaKind,
    m.is_media AS isMedia,
    m.is_read AS isRead,
    m.reply_to AS replyTo,
    m.edited_at AS editedAt,
    m.deleted_at AS deletedAt,
    m.created_at AS createdAt,
    (SELECT json_group_array(json_object('userId', r.user_id, 'reaction', r.reaction))
     FROM message_reactions r WHERE r.message_id = m.id) AS reactionsJson,
    parent.sender_id AS replySenderId,
    parentAuthor.username AS replySenderName,
    parent.content AS replyContent,
    parent.media_name AS replyMediaName,
    parent.media_url AS replyMediaUrl,
    parent.deleted_at AS replyDeletedAt
  FROM messages m
  LEFT JOIN messages parent ON parent.id = m.reply_to
  LEFT JOIN users parentAuthor ON parentAuthor.id = parent.sender_id
`;

/** Collapse the flat SQL row into the shape the renderer consumes. */
function mapMessageRow(row) {
  let reactions = [];
  if (row.reactionsJson) {
    try { reactions = JSON.parse(row.reactionsJson) || []; } catch {}
  }

  const reply = row.replyTo
    ? {
      id: row.replyTo,
      senderId: row.replySenderId || null,
      senderName: row.replySenderName || null,
      content: row.replyDeletedAt ? '' : (row.replyContent || ''),
      mediaName: row.replyDeletedAt ? null : (row.replyMediaName || null),
      mediaUrl: row.replyDeletedAt ? null : (row.replyMediaUrl || null),
      deleted: Boolean(row.replyDeletedAt)
    }
    : null;

  const deleted = Boolean(row.deletedAt);

  const message = {
    ...row,
    content: deleted ? '' : row.content,
    mediaUrl: deleted ? null : row.mediaUrl,
    mediaName: deleted ? null : row.mediaName,
    isMedia: deleted ? false : Boolean(row.isMedia),
    isDeleted: deleted,
    isSystem: Boolean(row.systemKind),
    reactions: deleted ? [] : reactions.filter((item) => item && item.reaction),
    reply
  };

  delete message.reactionsJson;
  delete message.replySenderId;
  delete message.replySenderName;
  delete message.replyContent;
  delete message.replyMediaName;
  delete message.replyMediaUrl;
  delete message.replyDeletedAt;
  return message;
}

function insertSystemMessage(db, groupId, actorId, systemKind, content) {
  const id = uid('gmsg');
  const createdAt = Date.now();
  db.prepare(`
    INSERT INTO group_messages (id, group_id, sender_id, content, system_kind, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, groupId, actorId, content, systemKind, createdAt);
  return db.prepare(`${GROUP_MESSAGE_SELECT} WHERE gm.id = ?`).get(id);
}

function systemMessage(db, groupId, actorId, systemKind, content) {
  return mapMessageRow(insertSystemMessage(db, groupId, actorId, systemKind, content));
}

// ── Group reads ────────────────────────────────────────────────────────────

function getGroupMembers(db, groupId) {
  return db.prepare(`
    SELECT
      gm.user_id AS id,
      u.username AS name,
      u.uuid,
      u.model,
      gm.role,
      gm.joined_at AS joinedAt,
      gm.invited_by AS invitedBy,
      p.status AS rawStatus,
      p.activity,
      p.server_address AS serverAddress,
      p.last_seen AS lastSeen
    FROM group_members gm
    JOIN users u ON u.id = gm.user_id
    LEFT JOIN presence p ON p.user_id = gm.user_id
    WHERE gm.group_id = ?
    ORDER BY
      CASE gm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
      LOWER(u.username) ASC
  `).all(groupId).map((row) => {
    const online = Boolean(row.lastSeen && row.lastSeen >= Date.now() - 120_000 && row.rawStatus !== 'offline');
    return {
      id: row.id,
      name: row.name,
      uuid: row.uuid,
      model: row.model || 'classic',
      role: row.role,
      joinedAt: row.joinedAt,
      invitedBy: row.invitedBy || null,
      status: online ? (row.rawStatus || 'online') : 'offline',
      activity: online ? (row.activity || 'In Launcher') : null,
      serverAddress: online ? row.serverAddress : null,
      lastSeen: row.lastSeen || row.joinedAt
    };
  });
}

function summarize(db, userId, row) {
  const self = membership(db, row.id, userId);
  const lastRead = self?.last_read_at || 0;

  const last = db.prepare(`
    SELECT gm.id, gm.sender_id AS senderId, u.username AS senderName, gm.content,
           gm.media_name AS mediaName, gm.is_media AS isMedia, gm.system_kind AS systemKind,
           gm.deleted_at AS deletedAt, gm.created_at AS createdAt
    FROM group_messages gm
    JOIN users u ON u.id = gm.sender_id
    WHERE gm.group_id = ?
    ORDER BY gm.created_at DESC, gm.rowid DESC
    LIMIT 1
  `).get(row.id) || null;

  const unread = db.prepare(`
    SELECT COUNT(*) AS total FROM group_messages
    WHERE group_id = ? AND sender_id != ? AND created_at > ? AND system_kind IS NULL AND deleted_at IS NULL
  `).get(row.id, userId, lastRead)?.total || 0;

  return {
    id: row.id,
    kind: 'group',
    name: row.name,
    description: row.description || null,
    iconUrl: row.icon_url || null,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    role: self?.role || 'member',
    pinned: Boolean(self?.pinned),
    muted: Boolean(self?.muted),
    lastReadAt: lastRead,
    unreadCount: Number(unread),
    members: getGroupMembers(db, row.id),
    memberCount: db.prepare('SELECT COUNT(*) AS total FROM group_members WHERE group_id = ?').get(row.id)?.total || 0,
    lastMessage: last
      ? {
        id: last.id,
        senderId: last.senderId,
        senderName: last.senderName,
        content: last.deletedAt ? 'Message deleted' : (last.content || last.mediaName || 'Sent attachment'),
        isMedia: Boolean(last.isMedia),
        isSystem: Boolean(last.systemKind),
        createdAt: last.createdAt
      }
      : null
  };
}

function getGroups(db, userId) {
  const rows = db.prepare(`
    SELECT g.* FROM groups g
    JOIN group_members gm ON gm.group_id = g.id
    WHERE gm.user_id = ?
  `).all(userId);

  return rows
    .map((row) => summarize(db, userId, row))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const aTime = a.lastMessage?.createdAt || a.createdAt;
      const bTime = b.lastMessage?.createdAt || b.createdAt;
      return bTime - aTime;
    });
}

function getGroup(db, userId, groupId) {
  requireMember(db, groupId, userId);
  const row = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!row) throw new Error('Group not found.');
  return summarize(db, userId, row);
}

function getGroupMessages(db, userId, groupId, { limit = 50, before = null } = {}) {
  requireMember(db, groupId, userId);
  const capped = Math.min(200, Math.max(1, Number(limit) || 50));

  const rows = db.prepare(`
    ${GROUP_MESSAGE_SELECT}
    WHERE gm.group_id = ? AND (? IS NULL OR gm.created_at < ?)
    ORDER BY gm.created_at DESC, gm.rowid DESC
    LIMIT ?
  `).all(groupId, before, before, capped + 1);

  const hasMore = rows.length > capped;
  const window = hasMore ? rows.slice(0, capped) : rows;
  return {
    groupId,
    messages: window.reverse().map(mapMessageRow),
    hasMore,
    oldestTime: window.length ? window[0].createdAt : null
  };
}

// ── Group writes ───────────────────────────────────────────────────────────

function createGroup(db, ownerId, { name, iconUrl = null, description = null, memberIds: invitees = [] } = {}) {
  const groupName = cleanName(name);
  const icon = cleanIcon(iconUrl);
  const about = cleanDescription(description);

  const unique = [...new Set((invitees || []).map((id) => String(id)).filter((id) => id && id !== ownerId))];
  if (unique.length + 1 > MAX_MEMBERS) throw new Error(`Groups are limited to ${MAX_MEMBERS} members.`);

  for (const id of unique) {
    if (!areFriends(db, ownerId, id)) throw new Error('You can only add players on your friends list.');
    if (isBlockedPair(db, ownerId, id)) throw new Error('Cannot add a blocked player.');
  }

  const id = uid('grp');
  const createdAt = Date.now();

  db.prepare(`
    INSERT INTO groups (id, name, description, icon_url, owner_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, groupName, about, icon, ownerId, createdAt, createdAt);

  const addMember = db.prepare(`
    INSERT INTO group_members (group_id, user_id, role, invited_by, last_read_at, joined_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(group_id, user_id) DO NOTHING
  `);
  addMember.run(id, ownerId, 'owner', null, createdAt, createdAt);
  for (const memberId of unique) addMember.run(id, memberId, 'member', ownerId, 0, createdAt);

  const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(ownerId);
  systemMessage(db, id, ownerId, 'group_created', `${owner?.username || 'Someone'} created the group`);
  if (unique.length) {
    const names = db.prepare(`SELECT username FROM users WHERE id IN (${unique.map(() => '?').join(',')})`)
      .all(...unique).map((row) => row.username);
    systemMessage(db, id, ownerId, 'member_added', `${owner?.username || 'Someone'} added ${names.join(', ')}`);
  }

  return { group: getGroup(db, ownerId, id), participants: memberIds(db, id) };
}

function updateGroup(db, userId, groupId, { name, iconUrl, description } = {}) {
  requireAdmin(db, groupId, userId);
  const actor = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
  const current = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!current) throw new Error('Group not found.');

  const notices = [];

  if (typeof name !== 'undefined') {
    const nextName = cleanName(name);
    if (nextName !== current.name) {
      db.prepare('UPDATE groups SET name = ?, updated_at = ? WHERE id = ?').run(nextName, Date.now(), groupId);
      notices.push(systemMessage(db, groupId, userId, 'name_changed', `${actor?.username || 'Someone'} renamed the group to ${nextName}`));
    }
  }

  if (typeof iconUrl !== 'undefined') {
    const nextIcon = cleanIcon(iconUrl);
    if ((nextIcon || null) !== (current.icon_url || null)) {
      db.prepare('UPDATE groups SET icon_url = ?, updated_at = ? WHERE id = ?').run(nextIcon, Date.now(), groupId);
      notices.push(systemMessage(db, groupId, userId, 'icon_changed', nextIcon
        ? `${actor?.username || 'Someone'} changed the group image`
        : `${actor?.username || 'Someone'} removed the group image`));
    }
  }

  if (typeof description !== 'undefined') {
    const nextAbout = cleanDescription(description);
    if ((nextAbout || null) !== (current.description || null)) {
      db.prepare('UPDATE groups SET description = ?, updated_at = ? WHERE id = ?').run(nextAbout, Date.now(), groupId);
    }
  }

  return { group: getGroup(db, userId, groupId), participants: memberIds(db, groupId), notices };
}

function addMembers(db, userId, groupId, userIds = []) {
  requireAdmin(db, groupId, userId);
  const actor = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
  const existing = new Set(memberIds(db, groupId));
  const incoming = [...new Set((userIds || []).map(String).filter(Boolean))].filter((id) => !existing.has(id));
  if (!incoming.length) throw new Error('Those players are already in this group.');
  if (existing.size + incoming.length > MAX_MEMBERS) throw new Error(`Groups are limited to ${MAX_MEMBERS} members.`);

  const added = [];
  const insert = db.prepare(`
    INSERT INTO group_members (group_id, user_id, role, invited_by, last_read_at, joined_at)
    VALUES (?, ?, 'member', ?, 0, ?)
    ON CONFLICT(group_id, user_id) DO NOTHING
  `);

  for (const id of incoming) {
    if (!areFriends(db, userId, id)) throw new Error('You can only add players on your friends list.');
    if (isBlockedPair(db, userId, id)) throw new Error('Cannot add a blocked player.');
    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(id);
    if (!user) continue;
    insert.run(groupId, id, userId, Date.now());
    added.push(user.username);
  }

  const notice = added.length
    ? systemMessage(db, groupId, userId, 'member_added', `${actor?.username || 'Someone'} added ${added.join(', ')}`)
    : null;

  return { group: getGroup(db, userId, groupId), participants: memberIds(db, groupId), notice };
}

function removeMember(db, userId, groupId, targetId) {
  const self = requireAdmin(db, groupId, userId);
  const target = requireMember(db, groupId, targetId);
  if (targetId === userId) throw new Error('Use leave group instead.');
  if (rank(target.role) >= rank(self.role)) throw new Error('You cannot remove someone with an equal or higher role.');

  const actor = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
  const removed = db.prepare('SELECT username FROM users WHERE id = ?').get(targetId);
  const participantsBefore = memberIds(db, groupId);

  db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(groupId, targetId);
  const notice = systemMessage(db, groupId, userId, 'member_removed', `${actor?.username || 'Someone'} removed ${removed?.username || 'a member'}`);

  return { group: getGroup(db, userId, groupId), participants: participantsBefore, removedId: targetId, notice };
}

function setMemberRole(db, userId, groupId, targetId, role) {
  if (!ROLES.includes(role)) throw new Error('Unknown role.');
  const self = requireMember(db, groupId, userId);
  const target = requireMember(db, groupId, targetId);
  const actor = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
  const subject = db.prepare('SELECT username FROM users WHERE id = ?').get(targetId);

  if (role === 'owner') {
    requireOwner(db, groupId, userId);
    db.prepare("UPDATE group_members SET role = 'admin' WHERE group_id = ? AND user_id = ?").run(groupId, userId);
    db.prepare("UPDATE group_members SET role = 'owner' WHERE group_id = ? AND user_id = ?").run(groupId, targetId);
    db.prepare('UPDATE groups SET owner_id = ?, updated_at = ? WHERE id = ?').run(targetId, Date.now(), groupId);
  } else {
    if (self.role !== 'owner') throw new Error('Only the group owner can change roles.');
    if (target.role === 'owner') throw new Error('Transfer ownership before changing the owner role.');
    db.prepare('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?').run(role, groupId, targetId);
  }

  const label = role === 'owner' ? 'the new owner' : role === 'admin' ? 'an admin' : 'a member';
  const notice = systemMessage(db, groupId, userId, 'role_changed', `${actor?.username || 'Someone'} made ${subject?.username || 'a member'} ${label}`);

  return { group: getGroup(db, userId, groupId), participants: memberIds(db, groupId), notice };
}

function leaveGroup(db, userId, groupId) {
  const group = db.prepare('SELECT owner_id FROM groups WHERE id = ?').get(groupId);
  if (!group) return { deleted: true, groupId, participants: [userId] };
  const self = membership(db, groupId, userId);
  if (!self) return { deleted: false, groupId, participants: [userId] };
  const actor = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
  const participantsBefore = memberIds(db, groupId);

  // The owner leaving promotes the longest-standing admin, then member.
  if (self.role === 'owner') {
    const heir = db.prepare(`
      SELECT user_id AS id FROM group_members
      WHERE group_id = ? AND user_id != ?
      ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, joined_at ASC
      LIMIT 1
    `).get(groupId, userId);

    if (!heir) {
      db.prepare('DELETE FROM groups WHERE id = ?').run(groupId);
      return { deleted: true, groupId, participants: participantsBefore };
    }

    db.prepare("UPDATE group_members SET role = 'owner' WHERE group_id = ? AND user_id = ?").run(groupId, heir.id);
    db.prepare('UPDATE groups SET owner_id = ?, updated_at = ? WHERE id = ?').run(heir.id, Date.now(), groupId);
  }

  db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(groupId, userId);
  const notice = systemMessage(db, groupId, userId, 'member_left', `${actor?.username || 'Someone'} left the group`);

  return { deleted: false, groupId, participants: participantsBefore, notice };
}

function deleteGroup(db, userId, groupId) {
  const group = db.prepare('SELECT owner_id FROM groups WHERE id = ?').get(groupId);
  if (!group) return { ok: true, groupId, participants: [userId] };
  if (group.owner_id !== userId) throw new Error('Only the group owner can delete this group.');
  const participants = memberIds(db, groupId);
  db.prepare('DELETE FROM groups WHERE id = ?').run(groupId);
  return { ok: true, groupId, participants };
}

function setGroupPrefs(db, userId, groupId, { pinned, muted } = {}) {
  requireMember(db, groupId, userId);
  if (typeof pinned === 'boolean') {
    db.prepare('UPDATE group_members SET pinned = ? WHERE group_id = ? AND user_id = ?').run(pinned ? 1 : 0, groupId, userId);
  }
  if (typeof muted === 'boolean') {
    db.prepare('UPDATE group_members SET muted = ? WHERE group_id = ? AND user_id = ?').run(muted ? 1 : 0, groupId, userId);
  }
  return { ok: true, group: getGroup(db, userId, groupId) };
}

function markGroupRead(db, userId, groupId) {
  requireMember(db, groupId, userId);
  const at = Date.now();
  db.prepare('UPDATE group_members SET last_read_at = ? WHERE group_id = ? AND user_id = ?').run(at, groupId, userId);
  return { ok: true, groupId, readerId: userId, at, participants: memberIds(db, groupId) };
}

function sendGroupMessage(db, userId, groupId, content, { mediaUrl = null, mediaName = null, mediaKind = null, isMedia = 0, replyTo = null } = {}) {
  requireMember(db, groupId, userId);
  const clean = String(content || '').trim();
  if (!clean && !mediaUrl) throw new Error('Message content or media attachment cannot be empty.');
  if (clean.length > MESSAGE_LIMIT) throw new Error(`Message is too long (maximum ${MESSAGE_LIMIT} characters).`);

  let parentId = null;
  if (replyTo) {
    const parent = db.prepare('SELECT id, group_id FROM group_messages WHERE id = ?').get(String(replyTo));
    if (!parent || parent.group_id !== groupId) throw new Error('Cannot reply to that message.');
    parentId = parent.id;
  }

  const id = uid('gmsg');
  const createdAt = Date.now();
  db.prepare(`
    INSERT INTO group_messages (id, group_id, sender_id, content, media_url, media_name, media_kind, is_media, reply_to, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, groupId, userId, clean, mediaUrl, mediaName, mediaKind, isMedia ? 1 : 0, parentId, createdAt);

  db.prepare('UPDATE group_members SET last_read_at = ? WHERE group_id = ? AND user_id = ?').run(createdAt, groupId, userId);

  return {
    message: mapMessageRow(db.prepare(`${GROUP_MESSAGE_SELECT} WHERE gm.id = ?`).get(id)),
    participants: memberIds(db, groupId)
  };
}

function setGroupMessageReaction(db, messageId, userId, reaction) {
  const clean = reaction ? String(reaction).trim().slice(0, 12) : null;
  const message = db.prepare('SELECT id, group_id FROM group_messages WHERE id = ?').get(messageId);
  if (!message) throw new Error('Message not found.');
  requireMember(db, message.group_id, userId);

  if (clean) {
    const existing = db.prepare(
      'SELECT 1 FROM group_message_reactions WHERE message_id = ? AND user_id = ? AND reaction = ?'
    ).get(messageId, userId, clean);

    if (existing) {
      db.prepare('DELETE FROM group_message_reactions WHERE message_id = ? AND user_id = ? AND reaction = ?')
        .run(messageId, userId, clean);
    } else {
      db.prepare(`
        INSERT INTO group_message_reactions (message_id, user_id, reaction, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(message_id, user_id, reaction) DO NOTHING
      `).run(messageId, userId, clean, Date.now());
    }
  } else {
    db.prepare('DELETE FROM group_message_reactions WHERE message_id = ? AND user_id = ?').run(messageId, userId);
  }

  return {
    ok: true,
    id: messageId,
    groupId: message.group_id,
    reactions: db.prepare('SELECT user_id AS userId, reaction FROM group_message_reactions WHERE message_id = ?').all(messageId),
    participants: memberIds(db, message.group_id)
  };
}

/** Authors edit their own text; authors and admins can delete. */
function editGroupMessage(db, userId, messageId, content) {
  const message = db.prepare('SELECT * FROM group_messages WHERE id = ?').get(messageId);
  if (!message) throw new Error('Message not found.');
  if (message.sender_id !== userId) throw new Error('You can only edit your own messages.');
  if (message.system_kind) throw new Error('System messages cannot be edited.');
  if (message.deleted_at) throw new Error('This message was deleted.');

  const clean = String(content || '').trim();
  if (!clean) throw new Error('Message cannot be empty.');
  if (clean.length > MESSAGE_LIMIT) throw new Error(`Message is too long (maximum ${MESSAGE_LIMIT} characters).`);

  db.prepare('UPDATE group_messages SET content = ?, edited_at = ? WHERE id = ?').run(clean, Date.now(), messageId);
  return {
    message: mapMessageRow(db.prepare(`${GROUP_MESSAGE_SELECT} WHERE gm.id = ?`).get(messageId)),
    participants: memberIds(db, message.group_id)
  };
}

function deleteGroupMessage(db, userId, messageId) {
  const message = db.prepare('SELECT * FROM group_messages WHERE id = ?').get(messageId);
  if (!message) throw new Error('Message not found.');
  const self = requireMember(db, message.group_id, userId);
  if (message.sender_id !== userId && rank(self.role) < 2) {
    throw new Error('Only the author or a group admin can delete this message.');
  }

  db.prepare('UPDATE group_messages SET deleted_at = ?, media_url = NULL, media_name = NULL WHERE id = ?').run(Date.now(), messageId);
  db.prepare('DELETE FROM group_message_reactions WHERE message_id = ?').run(messageId);
  return {
    message: mapMessageRow(db.prepare(`${GROUP_MESSAGE_SELECT} WHERE gm.id = ?`).get(messageId)),
    participants: memberIds(db, message.group_id),
    releasedMediaUrl: message.media_url || null
  };
}

// ── Direct messages with replies ───────────────────────────────────────────

function getDirectMessages(db, userId, friendId, { limit = 50, before = null, markRead = true } = {}) {
  const capped = Math.min(200, Math.max(1, Number(limit) || 50));

  let readIds = [];
  if (markRead) {
    readIds = db.prepare('SELECT id FROM messages WHERE sender_id = ? AND receiver_id = ? AND is_read = 0')
      .all(friendId, userId).map((row) => row.id);
    if (readIds.length) {
      db.prepare('UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0')
        .run(friendId, userId);
    }
  }

  const rows = db.prepare(`
    ${DIRECT_MESSAGE_SELECT}
    WHERE ((m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?))
      AND (? IS NULL OR m.created_at < ?)
    ORDER BY m.created_at DESC, m.rowid DESC
    LIMIT ?
  `).all(userId, friendId, friendId, userId, before, before, capped + 1);

  const hasMore = rows.length > capped;
  const window = hasMore ? rows.slice(0, capped) : rows;
  return {
    friendId,
    messages: window.reverse().map(mapMessageRow),
    hasMore,
    oldestTime: window.length ? window[0].createdAt : null,
    readIds
  };
}

function sendDirectMessage(db, senderId, receiverId, content, { mediaUrl = null, mediaName = null, mediaKind = null, isMedia = 0, replyTo = null } = {}) {
  const clean = String(content || '').trim();
  if (!clean && !mediaUrl) throw new Error('Message content or media attachment cannot be empty.');
  if (clean.length > MESSAGE_LIMIT) throw new Error(`Message is too long (maximum ${MESSAGE_LIMIT} characters).`);
  if (isBlockedPair(db, senderId, receiverId)) throw new Error('Cannot send message to this player.');
  if (!areFriends(db, senderId, receiverId)) throw new Error('You can only message players on your friends list.');

  let parentId = null;
  if (replyTo) {
    const parent = db.prepare('SELECT id, sender_id, receiver_id FROM messages WHERE id = ?').get(String(replyTo));
    const inThread = parent && [parent.sender_id, parent.receiver_id].sort().join(':') === [senderId, receiverId].sort().join(':');
    if (!inThread) throw new Error('Cannot reply to that message.');
    parentId = parent.id;
  }

  const id = uid('msg');
  const createdAt = Date.now();
  db.prepare(`
    INSERT INTO messages (id, sender_id, receiver_id, content, media_url, media_name, media_kind, is_media, is_read, reply_to, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(id, senderId, receiverId, clean, mediaUrl, mediaName, mediaKind, isMedia ? 1 : 0, parentId, createdAt);

  return mapMessageRow(db.prepare(`${DIRECT_MESSAGE_SELECT} WHERE m.id = ?`).get(id));
}

function editDirectMessage(db, userId, messageId, content) {
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (!message) throw new Error('Message not found.');
  if (message.sender_id !== userId) throw new Error('You can only edit your own messages.');
  if (message.deleted_at) throw new Error('This message was deleted.');

  const clean = String(content || '').trim();
  if (!clean) throw new Error('Message cannot be empty.');
  if (clean.length > MESSAGE_LIMIT) throw new Error(`Message is too long (maximum ${MESSAGE_LIMIT} characters).`);

  db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(clean, Date.now(), messageId);
  return {
    message: mapMessageRow(db.prepare(`${DIRECT_MESSAGE_SELECT} WHERE m.id = ?`).get(messageId)),
    participants: [message.sender_id, message.receiver_id]
  };
}

/** True while any message (direct or group) or group icon still points at this media file. */
function isMediaReferenced(db, filename) {
  const like = `%/v1/social/media/${String(filename)}`;
  const direct = db.prepare('SELECT 1 FROM messages WHERE media_url LIKE ? LIMIT 1').get(like);
  if (direct) return true;
  const group = db.prepare('SELECT 1 FROM group_messages WHERE media_url LIKE ? LIMIT 1').get(like);
  if (group) return true;
  try {
    if (db.prepare('SELECT 1 FROM groups WHERE icon_url LIKE ? LIMIT 1').get(like)) return true;
  } catch {}
  return false;
}

function deleteDirectMessage(db, userId, messageId) {
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (!message) throw new Error('Message not found.');
  if (message.sender_id !== userId) throw new Error('You can only delete your own messages.');

  db.prepare('UPDATE messages SET deleted_at = ?, media_url = NULL, media_name = NULL WHERE id = ?').run(Date.now(), messageId);
  db.prepare('DELETE FROM message_reactions WHERE message_id = ?').run(messageId);
  return {
    message: mapMessageRow(db.prepare(`${DIRECT_MESSAGE_SELECT} WHERE m.id = ?`).get(messageId)),
    participants: [message.sender_id, message.receiver_id],
    releasedMediaUrl: message.media_url || null
  };
}

module.exports = {
  isMediaReferenced,
  MESSAGE_LIMIT,
  MAX_MEMBERS,
  ROLES,
  memberIds,
  membership,
  getGroups,
  getGroup,
  getGroupMembers,
  getGroupMessages,
  createGroup,
  updateGroup,
  addMembers,
  removeMember,
  setMemberRole,
  leaveGroup,
  deleteGroup,
  setGroupPrefs,
  markGroupRead,
  sendGroupMessage,
  setGroupMessageReaction,
  editGroupMessage,
  deleteGroupMessage,
  getDirectMessages,
  sendDirectMessage,
  editDirectMessage,
  deleteDirectMessage
};
