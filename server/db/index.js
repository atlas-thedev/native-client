const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const { initSchema } = require('./schema');
const usersMod = require('./users');
const socialMod = require('./social');
const relayMod = require('./relay');
const adminMod = require('./admin');

const DATA_DIR = path.resolve(
  process.env.NOCTRA_DATA_DIR ||
  process.env.NATIVE_SKIN_DATA ||
  path.join(__dirname, '..', 'data')
);
const DB_PATH = process.env.NOCTRA_DB_PATH || path.join(DATA_DIR, 'noctra.db');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

let dbInstance = null;

function migrateLegacyDbIfPresent() {
  if (fs.existsSync(DB_PATH)) return;

  const legacyPaths = [
    path.join(__dirname, '..', '..', 'skin-server', 'data', 'noctra_auth.db'),
    path.join(DATA_DIR, 'noctra_auth.db')
  ];

  for (const legacyPath of legacyPaths) {
    if (fs.existsSync(legacyPath)) {
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.copyFileSync(legacyPath, DB_PATH);
        // Also copy WAL / SHM files if they exist
        if (fs.existsSync(`${legacyPath}-wal`)) fs.copyFileSync(`${legacyPath}-wal`, `${DB_PATH}-wal`);
        if (fs.existsSync(`${legacyPath}-shm`)) fs.copyFileSync(`${legacyPath}-shm`, `${DB_PATH}-shm`);
        console.log(`[Noctra DB] Successfully migrated database from legacy path: ${legacyPath} -> ${DB_PATH}`);
        break;
      } catch (err) {
        console.error(`[Noctra DB] Failed to migrate legacy DB from ${legacyPath}:`, err);
      }
    }
  }
}

function getDb() {
  if (!dbInstance) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });

    migrateLegacyDbIfPresent();

    dbInstance = new DatabaseSync(DB_PATH);
    initSchema(dbInstance);
  }
  return dbInstance;
}

function closeDb() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {}
    dbInstance = null;
  }
}

function backupDatabase() {
  getDb();
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(BACKUPS_DIR, `noctra_${timestamp}.db`);
  fs.copyFileSync(DB_PATH, backupFile);
  return {
    path: backupFile,
    filename: path.basename(backupFile),
    size: fs.statSync(backupFile).size,
    dbPath: DB_PATH
  };
}

module.exports = {
  getDb,
  closeDb,
  DATA_DIR,
  DB_PATH,
  BACKUPS_DIR,
  backupDatabase,
  MESSAGE_LIMIT: socialMod.MESSAGE_LIMIT,
  MAX_GROUP_MEMBERS: relayMod.MAX_MEMBERS,

  // Users & Auth
  generateOfflinePlayerUuid: usersMod.generateOfflinePlayerUuid,
  hashPassword: usersMod.hashPassword,
  verifyPassword: usersMod.verifyPassword,
  verifyPasswordAsync: usersMod.verifyPasswordAsync,
  adminEmails: usersMod.adminEmails,
  MAX_CODE_ATTEMPTS: usersMod.MAX_CODE_ATTEMPTS,
  getVerificationCode: (email) => usersMod.getVerificationCode(getDb(), email),
  verificationCooldown: (email) => usersMod.verificationCooldown(getDb(), email),
  saveVerificationCode: (email, code) => usersMod.saveVerificationCode(getDb(), email, code),
  checkVerificationCode: (email, code) => usersMod.checkVerificationCode(getDb(), email, code),
  clearVerificationCode: (email) => usersMod.clearVerificationCode(getDb(), email),
  savePasswordReset: (email, code) => usersMod.savePasswordReset(getDb(), email, code),
  passwordResetCooldown: (email) => usersMod.passwordResetCooldown(getDb(), email),
  checkPasswordResetCode: (email, code) => usersMod.checkPasswordResetCode(getDb(), email, code),
  clearPasswordReset: (email) => usersMod.clearPasswordReset(getDb(), email),
  setUserPassword: (userId, password) => usersMod.setUserPassword(getDb(), userId, password),
  getUserByEmail: (email) => usersMod.getUserByEmail(getDb(), email),
  getUserByUsername: (username) => usersMod.getUserByUsername(getDb(), username),
  getUserByLogin: (login) => usersMod.getUserByLogin(getDb(), login),
  createUser: (data) => usersMod.createUser(getDb(), data),
  createSession: (userId) => usersMod.createSession(getDb(), userId),
  getUserBySession: (token) => usersMod.getUserBySession(getDb(), token),
  getMinecraftLink: (userId) => usersMod.getMinecraftLink(getDb(), userId),
  linkMinecraftAccount: (userId, profile) => usersMod.linkMinecraftAccount(getDb(), userId, profile),
  unlinkMinecraftAccount: (userId) => usersMod.unlinkMinecraftAccount(getDb(), userId),
  getUserByMinecraftUuid: (uuid) => usersMod.getUserByMinecraftUuid(getDb(), uuid),
  refreshMinecraftName: (userId, name) => usersMod.refreshMinecraftName(getDb(), userId, name),
  deleteSession: (token) => usersMod.deleteSession(getDb(), token),

  // Server-protected administration (sanitized rows only)
  getAdminOverview: () => adminMod.getOverview(getDb()),
  listAdminUsers: (options) => adminMod.listUsers(getDb(), options),
  setUserBadge: (userId, badgeId, granted) => adminMod.setUserBadge(getDb(), userId, badgeId, granted),

  // Social & Presence
  updatePresence: (userId, data) => socialMod.updatePresence(getDb(), userId, data),
  getPresence: (userId) => socialMod.getPresence(getDb(), userId),
  getFriends: (userId) => socialMod.getFriends(getDb(), userId),
  getFriendIds: (userId) => socialMod.getFriendIds(getDb(), userId),
  areFriends: (userId, friendId) => socialMod.areFriends(getDb(), userId, friendId),
  getFriendRequests: (userId) => socialMod.getFriendRequests(getDb(), userId),
  sendFriendRequest: (senderId, targetUsername) => socialMod.sendFriendRequest(getDb(), senderId, targetUsername, usersMod.getUserByUsername),
  respondFriendRequest: (requestId, userId, action) => socialMod.respondFriendRequest(getDb(), requestId, userId, action),
  removeFriend: (userId, friendId) => socialMod.removeFriend(getDb(), userId, friendId),
  updateFriendAttributes: (userId, friendId, attrs) => socialMod.updateFriendAttributes(getDb(), userId, friendId, attrs),
  blockUser: (userId, blockedId) => socialMod.blockUser(getDb(), userId, blockedId),
  unblockUser: (userId, blockedId) => socialMod.unblockUser(getDb(), userId, blockedId),
  listBlocked: (userId) => socialMod.listBlocked(getDb(), userId),
  getMessages: (userId, friendId, options) => socialMod.getMessages(getDb(), userId, friendId, options),
  getConversations: (userId, perFriend) => socialMod.getConversations(getDb(), userId, perFriend),
  getUpdatesSince: (userId, since) => socialMod.getUpdatesSince(getDb(), userId, since),
  markMessagesRead: (userId, friendId) => socialMod.markMessagesRead(getDb(), userId, friendId),
  sendMessage: (senderId, receiverId, content, options) => socialMod.sendMessage(getDb(), senderId, receiverId, content, options),
  setMessageReaction: (messageId, userId, reaction) => socialMod.setMessageReaction(getDb(), messageId, userId, reaction),
  searchUsers: (query, excludeUserId) => socialMod.searchUsers(getDb(), query, excludeUserId),

  // Relay groups, replies and message editing
  getGroups: (userId) => relayMod.getGroups(getDb(), userId),
  getGroup: (userId, groupId) => relayMod.getGroup(getDb(), userId, groupId),
  getGroupMembers: (groupId) => relayMod.getGroupMembers(getDb(), groupId),
  getGroupMessages: (userId, groupId, options) => relayMod.getGroupMessages(getDb(), userId, groupId, options),
  createGroup: (ownerId, payload) => relayMod.createGroup(getDb(), ownerId, payload),
  updateGroup: (userId, groupId, payload) => relayMod.updateGroup(getDb(), userId, groupId, payload),
  addGroupMembers: (userId, groupId, userIds) => relayMod.addMembers(getDb(), userId, groupId, userIds),
  removeGroupMember: (userId, groupId, targetId) => relayMod.removeMember(getDb(), userId, groupId, targetId),
  setGroupMemberRole: (userId, groupId, targetId, role) => relayMod.setMemberRole(getDb(), userId, groupId, targetId, role),
  leaveGroup: (userId, groupId) => relayMod.leaveGroup(getDb(), userId, groupId),
  deleteGroup: (userId, groupId) => relayMod.deleteGroup(getDb(), userId, groupId),
  setGroupPrefs: (userId, groupId, prefs) => relayMod.setGroupPrefs(getDb(), userId, groupId, prefs),
  markGroupRead: (userId, groupId) => relayMod.markGroupRead(getDb(), userId, groupId),
  sendGroupMessage: (userId, groupId, content, options) => relayMod.sendGroupMessage(getDb(), userId, groupId, content, options),
  setGroupMessageReaction: (messageId, userId, reaction) => relayMod.setGroupMessageReaction(getDb(), messageId, userId, reaction),
  editGroupMessage: (userId, messageId, content) => relayMod.editGroupMessage(getDb(), userId, messageId, content),
  deleteGroupMessage: (userId, messageId) => relayMod.deleteGroupMessage(getDb(), userId, messageId),
  isMediaReferenced: (mediaUrlLike) => relayMod.isMediaReferenced(getDb(), mediaUrlLike),
  groupMemberIds: (groupId) => relayMod.memberIds(getDb(), groupId),
  getDirectMessages: (userId, friendId, options) => relayMod.getDirectMessages(getDb(), userId, friendId, options),
  sendDirectMessage: (senderId, receiverId, content, options) => relayMod.sendDirectMessage(getDb(), senderId, receiverId, content, options),
  editDirectMessage: (userId, messageId, content) => relayMod.editDirectMessage(getDb(), userId, messageId, content),
  deleteDirectMessage: (userId, messageId) => relayMod.deleteDirectMessage(getDb(), userId, messageId)
};
