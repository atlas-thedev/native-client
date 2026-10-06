const BADGE_IDS = new Set(['developer', 'early_supporter', 'bug_hunter', 'staff', 'verified', 'plus', 'super_beta_tester']);
const TABLES = [
  'users',
  'sessions',
  'friends',
  'friend_requests',
  'messages',
  'groups',
  'group_members',
  'group_messages'
];

function parseBadges(value) {
  let parsed = [];
  try { parsed = JSON.parse(value || '[]'); } catch {}
  return Array.isArray(parsed) ? [...new Set(parsed.filter((badge) => BADGE_IDS.has(badge)))] : [];
}

function getOverview(db) {
  const tables = TABLES.map((name) => ({
    name,
    rows: Number(db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get()?.count || 0)
  }));
  const count = (name) => tables.find((table) => table.name === name)?.rows || 0;
  const pageCount = Number(db.prepare('PRAGMA page_count').get()?.page_count || 0);
  const pageSize = Number(db.prepare('PRAGMA page_size').get()?.page_size || 0);
  const journalMode = String(db.prepare('PRAGMA journal_mode').get()?.journal_mode || 'unknown').toUpperCase();
  const now = Date.now();
  const activeSessions = Number(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE expires_at > ?').get(now)?.count || 0);
  const onlineUsers = Number(db.prepare("SELECT COUNT(*) AS count FROM presence WHERE last_seen >= ? AND status != 'offline'").get(now - 120_000)?.count || 0);

  const admins = Number(db.prepare('SELECT COUNT(*) AS count FROM users WHERE is_admin = 1').get()?.count || 0);
  const newThisWeek = Number(db.prepare('SELECT COUNT(*) AS count FROM users WHERE created_at >= ?').get(now - 7 * 86_400_000)?.count || 0);

  return {
    users: count('users'),
    admins,
    newThisWeek,
    recentUsers: recentUsers(db, 6),
    activeSessions,
    onlineUsers,
    messages: count('messages') + count('group_messages'),
    groups: count('groups'),
    friendships: Math.floor(count('friends') / 2),
    database: {
      engine: 'SQLite',
      journalMode,
      sizeBytes: pageCount * pageSize,
      tables,
      checkedAt: now
    }
  };
}

function listUsers(db, { query = '', page = 1, pageSize = 50 } = {}) {
  const normalizedQuery = String(query || '').trim().slice(0, 80);
  const safePageSize = Math.max(10, Math.min(100, Number(pageSize) || 50));
  const requestedPage = Math.max(1, Number(page) || 1);
  const match = `%${normalizedQuery}%`;
  const where = normalizedQuery
    ? 'WHERE lower(u.username) LIKE lower(?) OR lower(u.email) LIKE lower(?) OR lower(u.id) LIKE lower(?)'
    : '';
  const params = normalizedQuery ? [match, match, match] : [];
  const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM users u ${where}`).get(...params)?.count || 0);
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const safePage = Math.min(requestedPage, totalPages);
  const offset = (safePage - 1) * safePageSize;

  const rows = db.prepare(`
    SELECT
      u.id, u.email, u.username, u.uuid, u.model, u.badges, u.is_admin, u.created_at, u.auth_type,
      p.status, p.last_seen,
      (SELECT COUNT(*) FROM friends f WHERE f.user_id = u.id) AS friend_count,
      (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id OR m.receiver_id = u.id) AS message_count,
      (SELECT COUNT(*) FROM group_members gm WHERE gm.user_id = u.id) AS group_count
    FROM users u
    LEFT JOIN presence p ON p.user_id = u.id
    ${where}
    ORDER BY u.is_admin DESC, u.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, safePageSize, offset);

  return {
    users: rows.map((row) => ({
      id: row.id,
      email: row.email,
      username: row.username,
      uuid: row.uuid,
      model: row.model || 'classic',
      badges: parseBadges(row.badges),
      isAdmin: Boolean(row.is_admin),
      authType: row.auth_type || 'native',
      createdAt: row.created_at,
      status: row.last_seen >= Date.now() - 120_000 && row.status !== 'offline' ? (row.status || 'online') : 'offline',
      lastSeen: row.last_seen || null,
      friendCount: Number(row.friend_count || 0),
      messageCount: Number(row.message_count || 0),
      groupCount: Number(row.group_count || 0)
    })),
    page: safePage,
    pageSize: safePageSize,
    total,
    totalPages
  };
}

function setUserBadge(db, userId, badgeId, granted) {
  const badge = String(badgeId || '').trim();
  if (!BADGE_IDS.has(badge)) throw new Error('Unknown badge.');
  const user = db.prepare('SELECT id, username, badges FROM users WHERE id = ?').get(String(userId || '').trim());
  if (!user) throw new Error('User not found.');
  const next = new Set(parseBadges(user.badges));
  if (granted) next.add(badge);
  else next.delete(badge);
  const badges = [...next];
  db.prepare('UPDATE users SET badges = ? WHERE id = ?').run(JSON.stringify(badges), user.id);
  return { id: user.id, username: user.username, badges };
}

function getUserDetail(db, userId) {
  const now = Date.now();
  const row = db.prepare(`
    SELECT
      u.id, u.email, u.username, u.uuid, u.model, u.badges, u.is_admin, u.created_at,
      p.status, p.last_seen,
      (SELECT COUNT(*) FROM friends f WHERE f.user_id = u.id) AS friend_count,
      (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id OR m.receiver_id = u.id) AS message_count,
      (SELECT COUNT(*) FROM group_members gm WHERE gm.user_id = u.id) AS group_count,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS session_count,
      (SELECT MAX(created_at) FROM sessions s WHERE s.user_id = u.id) AS last_sign_in
    FROM users u
    LEFT JOIN presence p ON p.user_id = u.id
    WHERE u.id = ?
  `).get(now, String(userId || '').trim());
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    uuid: row.uuid,
    model: row.model || 'classic',
    badges: parseBadges(row.badges),
    isAdmin: Boolean(row.is_admin),
    createdAt: row.created_at,
    status: row.last_seen >= now - 120_000 && row.status !== 'offline' ? (row.status || 'online') : 'offline',
    lastSeen: row.last_seen || null,
    lastSignIn: row.last_sign_in || null,
    friendCount: Number(row.friend_count || 0),
    messageCount: Number(row.message_count || 0),
    groupCount: Number(row.group_count || 0),
    sessionCount: Number(row.session_count || 0)
  };
}

function setUserAdmin(db, userId, isAdmin) {
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(String(userId || '').trim());
  if (!user) throw new Error('User not found.');
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, user.id);
  return { id: user.id, username: user.username, isAdmin: Boolean(isAdmin) };
}

function revokeUserSessions(db, userId) {
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(String(userId || '').trim());
  if (!user) throw new Error('User not found.');
  const result = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  return { id: user.id, username: user.username, revoked: Number(result.changes || 0) };
}

function recentUsers(db, limit = 6) {
  const now = Date.now();
  return db.prepare(`
    SELECT u.id, u.username, u.is_admin, u.created_at, p.status, p.last_seen
    FROM users u LEFT JOIN presence p ON p.user_id = u.id
    ORDER BY u.created_at DESC LIMIT ?
  `).all(limit).map((row) => ({
    id: row.id,
    username: row.username,
    isAdmin: Boolean(row.is_admin),
    createdAt: row.created_at,
    status: row.last_seen >= now - 120_000 && row.status !== 'offline' ? (row.status || 'online') : 'offline'
  }));
}

module.exports = { BADGE_IDS, getOverview, listUsers, setUserBadge, parseBadges, getUserDetail, setUserAdmin, revokeUserSessions, recentUsers };
