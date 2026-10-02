const crypto = require('crypto');

const MESSAGE_LIMIT = 2000;

function updatePresence(db, userId, { status = 'online', activity = 'In Launcher', serverAddress = null } = {}) {
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO presence (user_id, status, activity, server_address, last_seen)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      status = excluded.status,
      activity = excluded.activity,
      server_address = excluded.server_address,
      last_seen = excluded.last_seen
  `);
  stmt.run(userId, String(status), activity ? String(activity) : null, serverAddress ? String(serverAddress) : null, now);
  return { ok: true, status: String(status), activity: activity || null, serverAddress: serverAddress || null, lastSeen: now };
}

function getPresence(db, userId) {
  return db.prepare('SELECT * FROM presence WHERE user_id = ?').get(userId) || null;
}

/** Ids of everyone who has `userId` in their friends list (event fan-out). */
function getFriendIds(db, userId) {
  return db.prepare('SELECT friend_id AS id FROM friends WHERE user_id = ?').all(userId).map((row) => row.id);
}

function areFriends(db, userId, friendId) {
  return Boolean(db.prepare('SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?').get(userId, friendId));
}

function isBlockedPair(db, a, b) {
  return Boolean(db.prepare(
    'SELECT 1 FROM blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)'
  ).get(a, b, b, a));
}

function getFriends(db, userId) {
  const now = Date.now();
  const activeThreshold = now - 120_000; // presence goes stale after 120s

  const stmt = db.prepare(`
    SELECT
      f.friend_id AS id,
      u.username AS name,
      u.uuid,
      u.model,
      u.badges,
      u.created_at AS memberSince,
      f.is_best_friend AS isBestFriend,
      f.nickname,
      f.pinned,
      f.muted,
      f.created_at AS friendsSince,
      p.status AS rawStatus,
      p.activity,
      p.server_address AS serverAddress,
      p.last_seen AS lastSeen,
      (
        SELECT COUNT(*) FROM messages m
        WHERE m.sender_id = f.friend_id AND m.receiver_id = f.user_id AND m.is_read = 0
      ) AS unreadCount,
      (
        SELECT COALESCE(NULLIF(content, ''), media_name, 'Sent attachment') FROM messages m
        WHERE (m.sender_id = f.friend_id AND m.receiver_id = f.user_id)
           OR (m.sender_id = f.user_id AND m.receiver_id = f.friend_id)
        ORDER BY m.created_at DESC LIMIT 1
      ) AS lastMessageContent,
      (
        SELECT created_at FROM messages m
        WHERE (m.sender_id = f.friend_id AND m.receiver_id = f.user_id)
           OR (m.sender_id = f.user_id AND m.receiver_id = f.friend_id)
        ORDER BY m.created_at DESC LIMIT 1
      ) AS lastMessageTime,
      (
        SELECT sender_id FROM messages m
        WHERE (m.sender_id = f.friend_id AND m.receiver_id = f.user_id)
           OR (m.sender_id = f.user_id AND m.receiver_id = f.friend_id)
        ORDER BY m.created_at DESC LIMIT 1
      ) AS lastMessageSenderId,
      (
        SELECT is_media FROM messages m
        WHERE (m.sender_id = f.friend_id AND m.receiver_id = f.user_id)
           OR (m.sender_id = f.user_id AND m.receiver_id = f.friend_id)
        ORDER BY m.created_at DESC LIMIT 1
      ) AS lastMessageIsMedia
    FROM friends f
    JOIN users u ON f.friend_id = u.id
    LEFT JOIN presence p ON u.id = p.user_id
    WHERE f.user_id = ?
    ORDER BY f.is_best_friend DESC, u.username ASC
  `);

  const rows = stmt.all(userId);
  return rows.map((r) => {
    const isOnline = Boolean(r.lastSeen && r.lastSeen >= activeThreshold && r.rawStatus !== 'offline');
    return {
      id: r.id,
      name: r.name,
      uuid: r.uuid,
      model: r.model || 'classic',
      badges: (() => {
        let b = [];
        try { b = JSON.parse(r.badges || '[]'); } catch {}
        if (String(r.name || '').toLowerCase() === 'ohllama') {
          if (!b.includes('developer')) b.push('developer');
          if (!b.includes('early_supporter')) b.push('early_supporter');
          if (!b.includes('bug_hunter')) b.push('bug_hunter');
        }
        return b;
      })(),
      // Every Noctra account completes email verification at signup, so a row
      // in `users` is exactly what the verified badge represents.
      isVerified: true,
      memberSince: r.memberSince || null,
      isBestFriend: Boolean(r.isBestFriend),
      nickname: r.nickname || null,
      pinned: Boolean(r.pinned),
      muted: Boolean(r.muted),
      friendsSince: r.friendsSince,
      status: isOnline ? (r.rawStatus || 'online') : 'offline',
      activity: isOnline ? (r.activity || 'In Launcher') : null,
      serverAddress: isOnline ? r.serverAddress : null,
      lastSeen: r.lastSeen || r.friendsSince,
      unreadCount: Number(r.unreadCount || 0),
      lastMessageContent: r.lastMessageContent || null,
      lastMessageTime: r.lastMessageTime || null,
      lastMessageSenderId: r.lastMessageSenderId || null,
      lastMessageIsMedia: Boolean(r.lastMessageIsMedia)
    };
  });
}

function getFriendRequests(db, userId) {
  const receivedStmt = db.prepare(`
    SELECT r.id, r.sender_id AS userId, u.username AS name, u.uuid, u.model, r.created_at AS createdAt
    FROM friend_requests r
    JOIN users u ON r.sender_id = u.id
    WHERE r.receiver_id = ? AND r.status = 'pending'
    ORDER BY r.created_at DESC
  `);

  const sentStmt = db.prepare(`
    SELECT r.id, r.receiver_id AS userId, u.username AS name, u.uuid, u.model, r.created_at AS createdAt
    FROM friend_requests r
    JOIN users u ON r.receiver_id = u.id
    WHERE r.sender_id = ? AND r.status = 'pending'
    ORDER BY r.created_at DESC
  `);

  return {
    received: receivedStmt.all(userId).map((row) => ({ ...row, isVerified: true })),
    sent: sentStmt.all(userId).map((row) => ({ ...row, isVerified: true }))
  };
}

function sendFriendRequest(db, senderId, targetUsername, getUserByUsernameFn) {
  const target = getUserByUsernameFn(db, targetUsername);
  if (!target) throw new Error('User not found. Check the username and try again.');
  if (target.id === senderId) throw new Error('You cannot add yourself as a friend.');

  if (areFriends(db, senderId, target.id)) {
    throw new Error('You are already friends with this player.');
  }
  if (isBlockedPair(db, senderId, target.id)) {
    throw new Error('Cannot send friend request.');
  }

  const pendingCheck = db.prepare(`
    SELECT id, sender_id, status FROM friend_requests
    WHERE ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
      AND status = 'pending'
  `).get(senderId, target.id, target.id, senderId);

  if (pendingCheck) {
    if (pendingCheck.sender_id === senderId) {
      throw new Error('A friend request has already been sent to this player.');
    }
    // Reverse request already exists: accept it immediately (mutual add).
    return { ...respondFriendRequest(db, pendingCheck.id, senderId, 'accept'), mutual: true };
  }

  const id = `freq-${crypto.randomBytes(8).toString('hex')}`;
  const now = Date.now();
  db.prepare(`
    INSERT INTO friend_requests (id, sender_id, receiver_id, status, created_at)
    VALUES (?, ?, ?, 'pending', ?)
  `).run(id, senderId, target.id, now);

  return {
    ok: true,
    id,
    senderId,
    receiverId: target.id,
    participants: [senderId, target.id],
    target: { id: target.id, name: target.username, uuid: target.uuid }
  };
}

function respondFriendRequest(db, requestId, userId, action) {
  const now = Date.now();
  const req = db.prepare('SELECT * FROM friend_requests WHERE id = ?').get(requestId);
  if (!req) throw new Error('Friend request not found.');

  const participants = [req.sender_id, req.receiver_id];

  if (action === 'accept') {
    if (req.receiver_id !== userId) throw new Error('Unauthorized to accept this request.');
    db.prepare("UPDATE friend_requests SET status = 'accepted' WHERE id = ?").run(requestId);

    const insertFriend = db.prepare(`
      INSERT INTO friends (user_id, friend_id, is_best_friend, nickname, created_at)
      VALUES (?, ?, 0, NULL, ?)
      ON CONFLICT(user_id, friend_id) DO NOTHING
    `);
    insertFriend.run(req.receiver_id, req.sender_id, now);
    insertFriend.run(req.sender_id, req.receiver_id, now);
    return { ok: true, action: 'accepted', participants, senderId: req.sender_id, receiverId: req.receiver_id };
  }

  if (action === 'decline') {
    if (req.receiver_id !== userId) throw new Error('Unauthorized to decline this request.');
    db.prepare("UPDATE friend_requests SET status = 'declined' WHERE id = ?").run(requestId);
    return { ok: true, action: 'declined', participants, senderId: req.sender_id, receiverId: req.receiver_id };
  }

  if (action === 'cancel') {
    if (req.sender_id !== userId) throw new Error('Unauthorized to cancel this request.');
    db.prepare("UPDATE friend_requests SET status = 'cancelled' WHERE id = ?").run(requestId);
    return { ok: true, action: 'cancelled', participants, senderId: req.sender_id, receiverId: req.receiver_id };
  }

  throw new Error(`Invalid action: ${action}`);
}

function removeFriend(db, userId, friendId) {
  db.prepare('DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)')
    .run(userId, friendId, friendId, userId);
  return { ok: true, participants: [userId, friendId] };
}

function updateFriendAttributes(db, userId, friendId, { isBestFriend, nickname, pinned, muted } = {}) {
  if (!areFriends(db, userId, friendId)) throw new Error('This player is not on your friends list.');
  if (typeof pinned === 'boolean') {
    db.prepare('UPDATE friends SET pinned = ? WHERE user_id = ? AND friend_id = ?')
      .run(pinned ? 1 : 0, userId, friendId);
  }
  if (typeof muted === 'boolean') {
    db.prepare('UPDATE friends SET muted = ? WHERE user_id = ? AND friend_id = ?')
      .run(muted ? 1 : 0, userId, friendId);
  }
  if (typeof isBestFriend === 'boolean') {
    db.prepare('UPDATE friends SET is_best_friend = ? WHERE user_id = ? AND friend_id = ?')
      .run(isBestFriend ? 1 : 0, userId, friendId);
  }
  if (typeof nickname !== 'undefined') {
    const clean = nickname ? String(nickname).trim().slice(0, 28) : null;
    db.prepare('UPDATE friends SET nickname = ? WHERE user_id = ? AND friend_id = ?')
      .run(clean || null, userId, friendId);
  }
  return { ok: true };
}

function blockUser(db, userId, blockedId) {
  const now = Date.now();
  removeFriend(db, userId, blockedId);
  db.prepare(`
    UPDATE friend_requests SET status = 'declined'
    WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
  `).run(userId, blockedId, blockedId, userId);

  db.prepare(`
    INSERT INTO blocks (user_id, blocked_id, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, blocked_id) DO NOTHING
  `).run(userId, blockedId, now);
  return { ok: true, participants: [userId, blockedId] };
}

function unblockUser(db, userId, blockedId) {
  db.prepare('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?').run(userId, blockedId);
  return { ok: true, participants: [userId, blockedId] };
}

function listBlocked(db, userId) {
  return db.prepare(`
    SELECT b.blocked_id AS id, u.username AS name, u.uuid, u.model, b.created_at AS blockedAt
    FROM blocks b
    JOIN users u ON b.blocked_id = u.id
    WHERE b.user_id = ?
    ORDER BY b.created_at DESC
  `).all(userId);
}

/**
 * Collapse the flat SQL row into the renderer shape, including the quoted
 * parent message, edit marker and tombstone state.
 */
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
    isRead: Number(row.isRead || 0),
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

const MESSAGE_SELECT = `
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

/** Mark every unread message from `friendId` as read. Returns affected ids. */
function markMessagesRead(db, userId, friendId) {
  const unread = db.prepare(
    'SELECT id FROM messages WHERE sender_id = ? AND receiver_id = ? AND is_read = 0'
  ).all(friendId, userId).map((row) => row.id);

  if (unread.length) {
    db.prepare('UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0')
      .run(friendId, userId);
  }
  return { ok: true, messageIds: unread, friendId, readerId: userId };
}

/**
 * Newest-first window of a conversation, returned in ascending order.
 * Pass `before` (a createdAt timestamp) to page backwards through history.
 */
function getMessages(db, userId, friendId, options = {}) {
  const legacyLimit = typeof options === 'number' ? options : undefined;
  const { limit = legacyLimit || 50, before = null, markRead = true } = typeof options === 'number' ? {} : options;
  const capped = Math.min(200, Math.max(1, Number(limit) || 50));

  if (markRead) markMessagesRead(db, userId, friendId);

  const rows = db.prepare(`
    ${MESSAGE_SELECT}
    WHERE ((m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?))
      AND (? IS NULL OR m.created_at < ?)
    ORDER BY m.created_at DESC, m.rowid DESC
    LIMIT ?
  `).all(userId, friendId, friendId, userId, before, before, capped + 1);

  const hasMore = rows.length > capped;
  const window = hasMore ? rows.slice(0, capped) : rows;
  return {
    messages: window.reverse().map(mapMessageRow),
    hasMore,
    oldestTime: window.length ? window[0].createdAt : null
  };
}

/**
 * Preload the tail of *every* conversation in a single round trip so the Relay
 * inbox can render all threads instantly instead of one-at-a-time on click.
 */
function getConversations(db, userId, perFriend = 40) {
  const capped = Math.min(100, Math.max(5, Number(perFriend) || 40));
  const friendIds = getFriendIds(db, userId);
  const conversations = {};

  for (const friendId of friendIds) {
    const rows = db.prepare(`
      ${MESSAGE_SELECT}
      WHERE (m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?)
      ORDER BY m.created_at DESC, m.rowid DESC
      LIMIT ?
    `).all(userId, friendId, friendId, userId, capped + 1);

    const hasMore = rows.length > capped;
    const window = hasMore ? rows.slice(0, capped) : rows;
    conversations[friendId] = {
      messages: window.reverse().map(mapMessageRow),
      hasMore,
      oldestTime: window.length ? window[0].createdAt : null
    };
  }

  return conversations;
}

/** Delta feed used as the polling fallback when the event stream is down. */
function getUpdatesSince(db, userId, since = 0) {
  const cursor = Number(since) || 0;
  const rows = db.prepare(`
    ${MESSAGE_SELECT}
    WHERE (m.sender_id = ? OR m.receiver_id = ?) AND m.created_at > ?
    ORDER BY m.created_at ASC, m.rowid ASC
    LIMIT 300
  `).all(userId, userId, cursor);

  const messages = rows.map(mapMessageRow);
  return {
    messages,
    cursor: messages.length ? messages[messages.length - 1].createdAt : cursor,
    serverTime: Date.now()
  };
}

function sendMessage(db, senderId, receiverId, content, { mediaUrl = null, mediaName = null, mediaKind = null, isMedia = 0, replyTo = null } = {}) {
  const clean = String(content || '').trim();
  if (!clean && !mediaUrl) throw new Error('Message content or media attachment cannot be empty.');
  if (clean.length > MESSAGE_LIMIT) throw new Error(`Message is too long (maximum ${MESSAGE_LIMIT} characters).`);
  if (isBlockedPair(db, senderId, receiverId)) throw new Error('Cannot send message to this player.');
  if (!areFriends(db, senderId, receiverId)) throw new Error('You can only message players on your friends list.');

  let parentId = null;
  if (replyTo) {
    const parent = db.prepare('SELECT id, sender_id, receiver_id FROM messages WHERE id = ?').get(String(replyTo));
    const inThread = parent &&
      [parent.sender_id, parent.receiver_id].sort().join(':') === [senderId, receiverId].sort().join(':');
    if (!inThread) throw new Error('Cannot reply to that message.');
    parentId = parent.id;
  }

  const id = `msg-${crypto.randomBytes(8).toString('hex')}`;
  const now = Date.now();
  db.prepare(`
    INSERT INTO messages (id, sender_id, receiver_id, content, media_url, media_name, media_kind, is_media, is_read, reply_to, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(id, senderId, receiverId, clean, mediaUrl, mediaName, mediaKind, isMedia ? 1 : 0, parentId, now);

  return mapMessageRow(db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id));
}

function setMessageReaction(db, messageId, userId, reaction) {
  const clean = reaction ? String(reaction).trim().slice(0, 12) : null;
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (!msg) throw new Error('Message not found.');
  if (msg.sender_id !== userId && msg.receiver_id !== userId) {
    throw new Error('Unauthorized to react to this message.');
  }

  if (clean) {
    const existing = db.prepare(
      'SELECT 1 FROM message_reactions WHERE message_id = ? AND user_id = ? AND reaction = ?'
    ).get(messageId, userId, clean);

    if (existing) {
      // Same emoji twice is a toggle-off, exactly like Discord.
      db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND reaction = ?')
        .run(messageId, userId, clean);
    } else {
      db.prepare(`
        INSERT INTO message_reactions (message_id, user_id, reaction, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(message_id, user_id, reaction) DO NOTHING
      `).run(messageId, userId, clean, Date.now());
    }
  } else {
    db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?').run(messageId, userId);
  }

  const rows = db.prepare('SELECT user_id AS userId, reaction FROM message_reactions WHERE message_id = ?').all(messageId);
  return {
    ok: true,
    id: messageId,
    reactions: rows,
    participants: [msg.sender_id, msg.receiver_id]
  };
}

function searchUsers(db, query, excludeUserId) {
  const clean = String(query || '').trim();
  if (!clean || clean.length < 2) return [];
  return db.prepare(`
    SELECT u.id, u.username AS name, u.uuid, u.model
    FROM users u
    WHERE u.username LIKE ?
      AND u.id != ?
      AND NOT EXISTS (
        SELECT 1 FROM blocks b
        WHERE (b.user_id = ? AND b.blocked_id = u.id) OR (b.user_id = u.id AND b.blocked_id = ?)
      )
    LIMIT 10
  `).all(`%${clean}%`, excludeUserId, excludeUserId, excludeUserId);
}

/** Friends that both `userId` and `otherId` share. */
function getMutualFriends(db, userId, otherId) {
  return db.prepare(`
    SELECT u.id AS id, u.username AS name, u.uuid, u.model
    FROM friends a
    JOIN friends b ON b.friend_id = a.friend_id AND b.user_id = ?
    JOIN users u ON u.id = a.friend_id
    WHERE a.user_id = ? AND a.friend_id NOT IN (?, ?)
      AND NOT EXISTS (SELECT 1 FROM blocks bl WHERE (bl.user_id = ? AND bl.blocked_id = u.id) OR (bl.user_id = u.id AND bl.blocked_id = ?))
    ORDER BY u.username COLLATE NOCASE
  `).all(otherId, userId, userId, otherId, userId, userId);
}

module.exports = {
  getMutualFriends,
  MESSAGE_LIMIT,
  updatePresence,
  getPresence,
  getFriends,
  getFriendIds,
  areFriends,
  getFriendRequests,
  sendFriendRequest,
  respondFriendRequest,
  removeFriend,
  updateFriendAttributes,
  blockUser,
  unblockUser,
  listBlocked,
  getMessages,
  getConversations,
  getUpdatesSince,
  markMessagesRead,
  sendMessage,
  setMessageReaction,
  searchUsers
};
