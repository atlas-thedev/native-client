const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/features/shell/relayNotifications.js');
const state = { selfId: 'me', friends: [{ id: 'f1', name: 'Alex', nickname: 'Al', muted: false }, { id: 'f2', name: 'Quiet', muted: true }] };

test('a friend\'s DM notifies with their nickname and text', async () => {
  const { describeRelayEvent } = await load();
  const note = describeRelayEvent({ type: 'message:new', message: { senderId: 'f1', content: 'hello' } }, state);
  assert.equal(note.title, 'Al');
  assert.equal(note.body, 'hello');
  assert.equal(note.threadId, 'f1');
});

test('your own messages never notify', async () => {
  const { describeRelayEvent } = await load();
  assert.equal(describeRelayEvent({ type: 'message:new', message: { senderId: 'me', content: 'x' } }, state), null);
  assert.equal(describeRelayEvent({ type: 'group:message', data: { groupId: 'g', message: { senderId: 'me', content: 'x' } } }, state), null);
});

test('GIFs and attachments get readable text', async () => {
  const { describeRelayEvent } = await load();
  assert.equal(describeRelayEvent({ type: 'message:new', message: { senderId: 'f1', content: '', mediaName: 'GG.gif' } }, state).body, 'Sent a GIF');
  assert.equal(describeRelayEvent({ type: 'message:new', message: { senderId: 'f1', content: '', mediaName: 'a.png' } }, state).body, 'Sent an attachment');
});

test('group messages use the group as title and skip system notices', async () => {
  const { describeRelayEvent } = await load();
  const note = describeRelayEvent({ type: 'group:message', data: { groupId: 'g1', groupName: 'SMP', message: { senderId: 'f1', senderName: 'Alex', content: 'iron?' } } }, state);
  assert.deepEqual([note.title, note.body, note.threadId, note.kind], ['SMP', 'Alex: iron?', 'g1', 'group']);
  assert.equal(describeRelayEvent({ type: 'group:message', data: { groupId: 'g1', message: { senderId: 'f1', isSystem: true, content: 'joined' } } }, state), null);
});

test('friend requests, acceptances (both event shapes) and group invites notify', async () => {
  const { describeRelayEvent } = await load();
  assert.equal(describeRelayEvent({ type: 'request:changed', actorId: 'x', actorName: 'Bob', action: 'sent' }, state).title, 'New friend request');
  assert.equal(describeRelayEvent({ type: 'request:changed', actorId: 'x', actorName: 'Bob', action: 'accepted' }, state).title, 'Friend request accepted');
  assert.equal(describeRelayEvent({ type: 'friends:changed', actorId: 'x', actorName: 'Bob', action: 'accepted' }, state).title, 'Friend request accepted');
  assert.equal(describeRelayEvent({ type: 'request:changed', actorId: 'me', action: 'sent' }, state), null);
  assert.equal(describeRelayEvent({ type: 'request:changed', actorId: 'x', action: 'declined' }, state), null);
  assert.equal(describeRelayEvent({ type: 'group:created', group: { id: 'g', name: 'New', ownerId: 'x' } }, state).kind, 'group-added');
  assert.equal(describeRelayEvent({ type: 'group:created', group: { id: 'g', name: 'Mine', ownerId: 'me' } }, state), null);
});

test('muted threads and the thread you are looking at stay quiet', async () => {
  const { describeRelayEvent, shouldSurface } = await load();
  const muted = describeRelayEvent({ type: 'message:new', message: { senderId: 'f2', content: 'psst' } }, state);
  assert.equal(shouldSurface(muted, {}), false);
  const note = describeRelayEvent({ type: 'message:new', message: { senderId: 'f1', content: 'hi' } }, state);
  assert.equal(shouldSurface(note, {}), true);
  assert.equal(shouldSurface(note, { viewing: true }), false);
  assert.equal(shouldSurface(note, { mutedIds: { f1: true } }), false);
  assert.equal(shouldSurface(note, { mutedIds: { f1: false } }), true);
});

test('notification preferences default on and persist', async () => {
  const { readNotifyPrefs, writeNotifyPrefs } = await load();
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.deepEqual(readNotifyPrefs(storage), { desktop: true, sound: true });
  writeNotifyPrefs({ sound: false }, storage);
  assert.equal(readNotifyPrefs(storage).sound, false);
  assert.equal(readNotifyPrefs(storage).desktop, true);
});
