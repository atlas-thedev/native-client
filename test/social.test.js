const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Ensure unique isolated data directory for social test
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'noctra-social-test-'));
process.env.NATIVE_SKIN_DATA = DATA_DIR;

const authDb = require('../server/db');
const { listen } = require('../server/server');

test('social db: creates users, manages friend requests, friendships, and presence', () => {
  // Create two Native users
  const userA = authDb.createUser({
    email: 'player_a@test.local',
    username: 'PlayerA',
    password: 'password123',
    model: 'classic'
  });
  const sessionA = authDb.createSession(userA.id);

  const userB = authDb.createUser({
    email: 'player_b@test.local',
    username: 'PlayerB',
    password: 'password123',
    model: 'slim'
  });
  const sessionB = authDb.createSession(userB.id);

  assert.ok(userA.id);
  assert.ok(userB.id);

  // Initial friends should be empty
  assert.equal(authDb.getFriends(userA.id).length, 0);
  assert.equal(authDb.getFriends(userB.id).length, 0);

  // User A sends friend request to User B
  const reqRes = authDb.sendFriendRequest(userA.id, 'PlayerB');
  assert.ok(reqRes.ok);
  assert.ok(reqRes.id);

  // Check requests
  const reqsA = authDb.getFriendRequests(userA.id);
  assert.equal(reqsA.sent.length, 1);
  assert.equal(reqsA.received.length, 0);
  assert.equal(reqsA.sent[0].name, 'PlayerB');

  const reqsB = authDb.getFriendRequests(userB.id);
  assert.equal(reqsB.received.length, 1);
  assert.equal(reqsB.sent.length, 0);
  assert.equal(reqsB.received[0].name, 'PlayerA');

  // User B accepts request
  const acceptRes = authDb.respondFriendRequest(reqRes.id, userB.id, 'accept');
  assert.equal(acceptRes.action, 'accepted');

  // Both are now friends
  const friendsA = authDb.getFriends(userA.id);
  const friendsB = authDb.getFriends(userB.id);
  assert.equal(friendsA.length, 1);
  assert.equal(friendsB.length, 1);
  assert.equal(friendsA[0].name, 'PlayerB');
  assert.equal(friendsB[0].name, 'PlayerA');

  // Presence updates
  authDb.updatePresence(userB.id, {
    status: 'in-game',
    activity: 'In-game: Hypixel ⚡',
    serverAddress: 'mc.hypixel.net:25565'
  });

  const refreshedFriendsA = authDb.getFriends(userA.id);
  assert.equal(refreshedFriendsA[0].status, 'in-game');
  assert.equal(refreshedFriendsA[0].activity, 'In-game: Hypixel ⚡');
  assert.equal(refreshedFriendsA[0].serverAddress, 'mc.hypixel.net:25565');

  // Nickname, Best Friend, Pinned, and Muted
  authDb.updateFriendAttributes(userA.id, userB.id, {
    nickname: 'B-Boy',
    isBestFriend: true,
    pinned: true,
    muted: true
  });
  const updatedFriendsA = authDb.getFriends(userA.id);
  assert.equal(updatedFriendsA[0].nickname, 'B-Boy');
  assert.equal(updatedFriendsA[0].isBestFriend, true);
  assert.equal(updatedFriendsA[0].pinned, true);
  assert.equal(updatedFriendsA[0].muted, true);

  // Chat Messaging
  const msg1 = authDb.sendMessage(userA.id, userB.id, 'Hey Player B!');
  assert.ok(msg1.id);
  assert.equal(msg1.content, 'Hey Player B!');

  const msg2 = authDb.sendMessage(userB.id, userA.id, 'Hey! Ready for bedwars?');
  assert.ok(msg2.id);

  // Reply message
  const msg3 = authDb.sendMessage(userA.id, userB.id, 'Sounds great!', { replyTo: msg2.id });
  assert.ok(msg3.id);
  assert.ok(msg3.reply);
  assert.equal(msg3.reply.id, msg2.id);
  assert.equal(msg3.reply.content, 'Hey! Ready for bedwars?');

  // Retrieve message history
  const history = authDb.getMessages(userA.id, userB.id);
  assert.equal(history.messages.length, 3);
  assert.equal(history.messages[0].content, 'Hey Player B!');
  assert.equal(history.messages[1].content, 'Hey! Ready for bedwars?');
  assert.equal(history.messages[2].reply.id, msg2.id);

  // Unfriend
  authDb.removeFriend(userA.id, userB.id);
  assert.equal(authDb.getFriends(userA.id).length, 0);
  assert.equal(authDb.getFriends(userB.id).length, 0);
});

test('social api: rejects unauthenticated requests and handles social endpoints with Native token', async () => {
  const server = await listen(0);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. Unauthenticated request to /v1/social/friends returns 401
    const unauthRes = await fetch(`${base}/v1/social/friends`);
    assert.equal(unauthRes.status, 401);
    const unauthJson = await unauthRes.json();
    assert.equal(unauthJson.ok, false);

    // 2. Create user and get token
    const user = authDb.createUser({
      email: 'social_api_test@test.local',
      username: 'SocialTester',
      password: 'password123'
    });
    const session = authDb.createSession(user.id);

    // 3. Authenticated request succeeds
    const authRes = await fetch(`${base}/v1/social/friends`, {
      headers: { Authorization: `Bearer ${session.token}` }
    });
    assert.equal(authRes.status, 200);
    const authJson = await authRes.json();
    assert.equal(authJson.ok, true);
    assert.ok(Array.isArray(authJson.friends));

    const statsRes = await fetch(`${base}/v1/social/stats`, {
      headers: { Authorization: `Bearer ${session.token}` }
    });
    assert.equal(statsRes.status, 200);
    const statsJson = await statsRes.json();
    assert.equal(statsJson.ok, true);
    assert.equal(Number.isInteger(statsJson.onlineUsers), true);
    assert.ok(statsJson.onlineUsers >= 0);

    // 4. Update presence
    const presenceRes = await fetch(`${base}/v1/social/presence`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.token}`
      },
      body: JSON.stringify({
        status: 'in-game',
        activity: 'In-game: Donut SMP ✓',
        serverAddress: 'donut.smp:25565'
      })
    });
    assert.equal(presenceRes.status, 200);
    const presenceJson = await presenceRes.json();
    assert.equal(presenceJson.ok, true);
  } finally {
    server.close();
  }
});

test('server detection: correctly detects multiplayer connect, singleplayer, and disconnect logs', () => {
  const gameLog = require('../electron/gameLog');
  const classify = gameLog.createLogClassifier();
  const detect = (line) => gameLog.presenceFromLine(classify(line));

  assert.deepEqual(detect('[18:42:10] [Render thread/INFO]: Connecting to mc.hypixel.net, 25565'),
    { kind: 'server', host: 'mc.hypixel.net', port: '25565' });
  assert.equal(gameLog.formatServerActivity('mc.hypixel.net'), 'Hypixel');
  assert.equal(gameLog.formatServerActivity('donutsmp.net'), 'Donut SMP');
  assert.equal(gameLog.formatServerActivity('evilhypixel.net.example.com'), 'Example');
  assert.equal(gameLog.formatServerActivity('localhost'), 'Local Server');
  assert.deepEqual(detect('[19:20:00] [Render thread/INFO]: Starting integrated server...'), { kind: 'singleplayer' });
  assert.deepEqual(detect('[19:35:12] [Render thread/INFO]: Disconnecting from mc.hypixel.net, 25565'), { kind: 'menus' });
  assert.equal(detect('[19:36:00] [Render thread/INFO]: [System] [CHAT] Connecting to fake.net, 25565'), null);
});
