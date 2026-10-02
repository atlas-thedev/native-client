/**
 * Noctra Client Database Schema & Migration Engine
 * Uses Node.js native SQLite (DatabaseSync) with WAL mode, foreign keys,
 * and optimized compound indexes for instant queries.
 *
 * Relay data model
 * ----------------
 *   users ─┬─ friends / friend_requests / blocks / presence
 *          ├─ messages (direct) ── message_reactions
 *          └─ group_members ── groups ── group_messages ── group_message_reactions
 *
 * Direct and group messages are separate tables on purpose: a DM is always a
 * pair of user ids, while a group message needs a room, a role-aware author and
 * per-member read state. Both tables carry `reply_to` (self-referencing) so the
 * client can render replies identically in either surface.
 */

function initSchema(db) {
  // Performance and integrity pragmas
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA cache_size = -64000;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      uuid TEXT NOT NULL,
      model TEXT DEFAULT 'classic',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS verification_codes (
      email TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    -- Password reset codes. Only a salted hash of the 6-digit code is stored.
    CREATE TABLE IF NOT EXISTS password_resets (
      email TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS friends (
      user_id TEXT NOT NULL,
      friend_id TEXT NOT NULL,
      is_best_friend INTEGER DEFAULT 0,
      nickname TEXT DEFAULT NULL,
      pinned INTEGER DEFAULT 0,
      muted INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, friend_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS friend_requests (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      content TEXT NOT NULL,
      media_url TEXT DEFAULT NULL,
      media_name TEXT DEFAULT NULL,
      media_kind TEXT DEFAULT NULL,
      is_media INTEGER DEFAULT 0,
      is_read INTEGER DEFAULT 0,
      reply_to TEXT DEFAULT NULL,
      edited_at INTEGER DEFAULT NULL,
      deleted_at INTEGER DEFAULT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      reaction TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, user_id, reaction),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS presence (
      user_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      activity TEXT,
      server_address TEXT,
      last_seen INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS blocks (
      user_id TEXT NOT NULL,
      blocked_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, blocked_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- ── Relay group chats ────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT NULL,
      icon_url TEXT DEFAULT NULL,
      owner_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      invited_by TEXT DEFAULT NULL,
      pinned INTEGER DEFAULT 0,
      muted INTEGER DEFAULT 0,
      last_read_at INTEGER DEFAULT 0,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (group_id, user_id),
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS group_messages (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      media_url TEXT DEFAULT NULL,
      media_name TEXT DEFAULT NULL,
      media_kind TEXT DEFAULT NULL,
      is_media INTEGER DEFAULT 0,
      reply_to TEXT DEFAULT NULL,
      system_kind TEXT DEFAULT NULL,
      edited_at INTEGER DEFAULT NULL,
      deleted_at INTEGER DEFAULT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (reply_to) REFERENCES group_messages(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS group_message_reactions (
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      reaction TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, user_id, reaction),
      FOREIGN KEY (message_id) REFERENCES group_messages(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Safe migrations for databases created by older builds (must run before indexes).
  const safeAddColumn = (table, columnDef) => {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
    } catch {}
  };
  safeAddColumn('messages', 'media_url TEXT DEFAULT NULL');
  safeAddColumn('messages', 'media_name TEXT DEFAULT NULL');
  safeAddColumn('messages', 'media_kind TEXT DEFAULT NULL');
  safeAddColumn('messages', 'is_media INTEGER DEFAULT 0');
  safeAddColumn('messages', 'edited_at INTEGER DEFAULT NULL');
  safeAddColumn('messages', 'reply_to TEXT DEFAULT NULL');
  safeAddColumn('messages', 'deleted_at INTEGER DEFAULT NULL');
  safeAddColumn('friends', 'pinned INTEGER DEFAULT 0');
  safeAddColumn('friends', 'muted INTEGER DEFAULT 0');
  safeAddColumn('group_members', 'pinned INTEGER DEFAULT 0');
  safeAddColumn('group_members', 'muted INTEGER DEFAULT 0');
  safeAddColumn('group_members', 'last_read_at INTEGER DEFAULT 0');
  safeAddColumn('group_members', 'invited_by TEXT DEFAULT NULL');
  safeAddColumn('group_messages', 'reply_to TEXT DEFAULT NULL');
  safeAddColumn('group_messages', 'system_kind TEXT DEFAULT NULL');
  safeAddColumn('group_messages', 'edited_at INTEGER DEFAULT NULL');
  safeAddColumn('group_messages', 'deleted_at INTEGER DEFAULT NULL');
  safeAddColumn('groups', 'description TEXT DEFAULT NULL');
  safeAddColumn('groups', 'icon_url TEXT DEFAULT NULL');
  safeAddColumn('groups', 'updated_at INTEGER DEFAULT 0');
  safeAddColumn('users', "badges TEXT DEFAULT '[]'");
  safeAddColumn('users', 'is_admin INTEGER NOT NULL DEFAULT 0');
  safeAddColumn('users', 'minecraft_uuid TEXT DEFAULT NULL');
  safeAddColumn('users', 'minecraft_username TEXT DEFAULT NULL');
  safeAddColumn('users', 'minecraft_linked_at INTEGER DEFAULT NULL');

  safeAddColumn('verification_codes', 'attempts INTEGER NOT NULL DEFAULT 0');

  // Admins are configured by verified email (NOCTRA_ADMIN_EMAILS), never by
  // username: a username can be registered by anyone once it is free.
  // Existing is_admin flags are kept as-is.
  try {
    const admins = String(process.env.NOCTRA_ADMIN_EMAILS || '')
      .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
    const grant = db.prepare('UPDATE users SET is_admin = 1 WHERE lower(email) = ?');
    for (const email of admins) grant.run(email);
  } catch {}

  // Query performance indexes (run after all columns exist)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_admin ON users(is_admin);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_minecraft_uuid
      ON users(minecraft_uuid) WHERE minecraft_uuid IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_id);
    CREATE INDEX IF NOT EXISTS idx_friends_friend ON friends(friend_id);
    CREATE INDEX IF NOT EXISTS idx_requests_receiver ON friend_requests(receiver_id, status);
    CREATE INDEX IF NOT EXISTS idx_requests_sender ON friend_requests(sender_id, status);
    CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, receiver_id);
    CREATE INDEX IF NOT EXISTS idx_messages_pair_created ON messages(sender_id, receiver_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(receiver_id, sender_id, is_read);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(reply_to);
    CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);
    CREATE INDEX IF NOT EXISTS idx_presence_user ON presence(user_id);
    CREATE INDEX IF NOT EXISTS idx_blocks_pair ON blocks(user_id, blocked_id);
    CREATE INDEX IF NOT EXISTS idx_groups_owner ON groups(owner_id);
    CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id, role);
    CREATE INDEX IF NOT EXISTS idx_group_messages_room ON group_messages(group_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_group_messages_sender ON group_messages(sender_id);
    CREATE INDEX IF NOT EXISTS idx_group_messages_reply ON group_messages(reply_to);
    CREATE INDEX IF NOT EXISTS idx_group_reactions_message ON group_message_reactions(message_id);
  `);

  // `messages.reaction` was the original single-reaction column. Reactions now
  // live in `message_reactions`; migrate any leftover values across once and
  // then stop reading the legacy column entirely.
  try {
    const columns = db.prepare('PRAGMA table_info(messages)').all();
    const hasLegacyReaction = columns.some((column) => column.name === 'reaction');
    if (hasLegacyReaction) {
      db.exec(`
        INSERT INTO message_reactions (message_id, user_id, reaction, created_at)
        SELECT m.id, m.sender_id, m.reaction, m.created_at
        FROM messages m
        WHERE m.reaction IS NOT NULL AND TRIM(m.reaction) != ''
        ON CONFLICT(message_id, user_id, reaction) DO NOTHING
      `);
      db.exec("UPDATE messages SET reaction = NULL WHERE reaction IS NOT NULL");
    }
  } catch {}

  // Every group needs exactly one owner. Older rows created before roles
  // existed are repaired here instead of failing at read time.
  try {
    db.exec(`
      UPDATE group_members
      SET role = 'owner'
      WHERE role NOT IN ('owner', 'admin', 'member') OR role IS NULL
    `);
    db.exec(`
      UPDATE group_members SET role = 'owner'
      WHERE (group_id, user_id) IN (SELECT id, owner_id FROM groups)
    `);
    db.exec("UPDATE groups SET updated_at = created_at WHERE updated_at IS NULL OR updated_at = 0");
  } catch {}
}

module.exports = {
  initSchema
};
