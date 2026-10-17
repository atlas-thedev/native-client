'use strict';
/**
 * Native Voice: private calls ring, a decline ends the caller's side too, hanging up stops the ringing, and the
 * UDP relay forwards audio between two sessions (same packet format the Fabric mod speaks).
 */
process.env.NATIVE_VOICE_PORT = String(36000 + Math.floor(Math.random() * 1000));
process.env.NATIVE_VOICE_RING_MS = '300';
process.env.NATIVE_VOICE_HOST = '127.0.0.1';
process.env.NATIVE_DATA_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'native-voice-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const db = require('../server/db');
const events = require('../server/social-events');
const voice = require('../server/voice');

const { sessions, rooms, ringing, join, decline, removeSession } = voice._internals;
test.after(() => { voice.stop(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

db.areFriends = () => true;
const alice = { id: '1', username: 'Alice' };
const bob = { id: '2', username: 'Bob' };

/** Fake mod event stream for one user: collects the frames written to it. */
function listen(userId) {
  const got = [];
  const res = {
    write(chunk) {
      const m = /^event: (.+)\ndata: (.+)\n\n$/s.exec(String(chunk));
      if (m) got.push({ type: m[1], ...JSON.parse(m[2]) });
    }
  };
  events.subscribeMod(userId, res);
  return got;
}

const ofType = (list, type) => list.filter((e) => e.type === type);

function reset() {
  for (const sid of [...sessions.keys()]) removeSession(sid, 'test');
  assert.equal(ringing.size, 0);
  assert.equal(rooms.size, 0);
}

test('a private call rings the friend, and declining ends the caller side too', () => {
  reset();
  const forAlice = listen('1');
  const forBob = listen('2');
  const call = join(alice, { room: 'dm:2', ign: 'AliceIGN' });
  const ring = ofType(forBob, 'voice:ring');
  assert.equal(ring.length, 1);
  assert.equal(ring[0].room, 'dm:1:2');
  assert.equal(ring[0].from.userId, '1');
  assert.equal(ring[0].from.name, 'AliceIGN');
  assert.equal(ofType(forAlice, 'voice:ring').length, 0, 'the caller is not rung');

  const result = decline(bob, { room: 'dm:1' });
  assert.deepEqual(result, { declined: true });
  assert.equal(sessions.has(call.sid), false, 'the caller session is gone');
  assert.equal(ringing.size, 0);

  const declined = ofType(forAlice, 'voice:declined');
  assert.equal(declined.length, 1);
  assert.equal(declined[0].reason, 'declined');
  assert.equal(declined[0].by.userId, '2');
  assert.equal(declined[0].by.name, 'Bob');
  const end = ofType(forBob, 'voice:ring-end');
  assert.equal(end.at(-1).reason, 'declined');
  // the room's roster tells everyone the caller left because of the decline
  const left = ofType(forAlice, 'voice:state').find((e) => e.left && e.left.reason === 'declined');
  assert.ok(left);
});

test('hanging up before anyone answers stops the ringing', () => {
  reset();
  const forBob = listen('2');
  const before = forBob.length;
  const call = join(alice, { room: 'dm:2' });
  assert.equal(ofType(forBob.slice(before), 'voice:ring').length, 1);
  removeSession(call.sid, 'left');
  const end = ofType(forBob.slice(before), 'voice:ring-end');
  assert.equal(end.length, 1);
  assert.equal(end[0].reason, 'cancelled');
  assert.equal(ringing.size, 0);
});

test('answering ends the ring and a later decline does nothing', () => {
  reset();
  const forBob = listen('2');
  const before = forBob.length;
  join(alice, { room: 'dm:2' });
  join(bob, { room: 'dm:1' });
  const end = ofType(forBob.slice(before), 'voice:ring-end');
  assert.equal(end.at(-1).reason, 'answered');
  assert.deepEqual(decline(bob, { room: 'dm:1' }), { declined: false });
  assert.equal(rooms.get('dm:1:2').size, 2, 'the call is untouched');
});

test('nobody answering ends the call for the caller', async () => {
  reset();
  const forAlice = listen('1');
  const forBob = listen('2');
  const a = forAlice.length;
  const b = forBob.length;
  const call = join(alice, { room: 'dm:2' });
  await sleep(450);
  assert.equal(sessions.has(call.sid), false);
  const declined = ofType(forAlice.slice(a), 'voice:declined');
  assert.equal(declined.length, 1);
  assert.equal(declined[0].reason, 'no-answer');
  assert.equal(ofType(forBob.slice(b), 'voice:ring-end').at(-1).reason, 'no-answer');
  assert.equal(ringing.size, 0);
});

test('only the called friend can decline, and only while it rings', () => {
  reset();
  join(alice, { room: 'dm:2' });
  assert.deepEqual(decline(alice, { room: 'dm:2' }), { declined: false }, 'the caller cannot decline their own call');
  assert.deepEqual(decline({ id: '2', username: 'Bob' }, { room: 'dm:1' }), { declined: true });
  assert.deepEqual(decline(bob, { room: 'dm:1' }), { declined: false }, 'already over');
});

test('when one side of a private call leaves, the other is taken out of it too', () => {
  reset();
  const forAlice = listen('1');
  const forBob = listen('2');
  const a = forAlice.length;
  const b = forBob.length;
  const callA = join(alice, { room: 'dm:2' });
  const callB = join(bob, { room: 'dm:1' });
  removeSession(callA.sid, 'left'); // Alice hangs up
  assert.equal(sessions.has(callB.sid), false, 'Bob is no longer sitting in the call alone');
  assert.equal(rooms.size, 0);
  const ended = ofType(forBob.slice(b), 'voice:ended');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].room, 'dm:1:2');
  assert.equal(ended[0].by.userId, '1');
  assert.equal(ofType(forAlice.slice(a), 'voice:ended').length, 0, 'the one who hung up is not told they were ended');
  // the same in the other direction, and a dropped connection (timeout) counts too
  const c2 = join(alice, { room: 'dm:2' });
  const d2 = join(bob, { room: 'dm:1' });
  removeSession(d2.sid, 'timeout');
  assert.equal(sessions.has(c2.sid), false);
});

test('re-joining a call and a call nobody answered yet are not ended by that', () => {
  reset();
  const first = join(alice, { room: 'dm:2' });
  const second = join(bob, { room: 'dm:1' });
  // Bob reconnects: his old session is replaced ("switched"), Alice must stay in the call
  const again = join(bob, { room: 'dm:1' });
  assert.equal(sessions.has(second.sid), false);
  assert.equal(sessions.has(first.sid), true, 'Alice was not ended by Bob\'s re-join');
  assert.equal(sessions.has(again.sid), true);
  reset();
  // still ringing: the caller alone in the room is waiting, not "left alone"
  const waiting = join(alice, { room: 'dm:2' });
  assert.equal(sessions.has(waiting.sid), true);
  assert.equal(ringing.size, 1);
});

test('there are no proximity rooms: voice is Relay calls only', () => {
  reset();
  assert.throws(() => join(alice, { room: 'srv:mc.example.net' }), (error) => error.status === 410);
  assert.equal(sessions.size, 0);
});

test('group calls never ring', () => {
  reset();
  db.groupMemberIds = () => ['1', '2', '3'];
  const forBob = listen('2');
  const before = forBob.length;
  join(alice, { room: 'g:abc' });
  assert.equal(ofType(forBob.slice(before), 'voice:ring').length, 0);
  assert.equal(ringing.size, 0);
  // a group call carries on when a member leaves
  const g1 = join(alice, { room: 'g:abc' });
  const g2 = join(bob, { room: 'g:abc' });
  removeSession(g1.sid, 'left');
  assert.equal(sessions.has(g2.sid), true, 'a group call is not ended by one member leaving');
});

// ── the UDP relay, speaking the mod's packet format ─────────────────────────

function seal(s, key, type, seq, plain) {
  const head = Buffer.alloc(10);
  head[0] = 0x4e;
  head[1] = type;
  head.writeUInt32BE(s >>> 0, 2);
  head.writeUInt32BE(seq, 6);
  const n = Buffer.alloc(12);
  n.writeUInt32BE(s >>> 0, 0);
  n.writeUInt32BE(seq, 4);
  n.writeUInt32BE(0, 8);
  const c = crypto.createCipheriv('aes-128-gcm', key, n);
  c.setAAD(head);
  return Buffer.concat([head, c.update(plain), c.final(), c.getAuthTag()]);
}

function open(sid, key, msg) {
  const n = Buffer.alloc(12);
  n.writeUInt32BE(sid >>> 0, 0);
  n.writeUInt32BE(msg.readUInt32BE(6), 4);
  n.writeUInt32BE(1, 8);
  const d = crypto.createDecipheriv('aes-128-gcm', key, n);
  d.setAAD(msg.subarray(0, 10));
  d.setAuthTag(msg.subarray(msg.length - 16));
  return Buffer.concat([d.update(msg.subarray(10, msg.length - 16)), d.final()]);
}

test('the relay forwards one friend\'s voice to the other, encrypted for each', async () => {
  reset();
  voice.start();
  await sleep(100);
  const a = join(alice, { room: 'dm:2' });
  const b = join(bob, { room: 'dm:1' });
  const port = Number(process.env.NATIVE_VOICE_PORT);
  const sockA = dgram.createSocket('udp4');
  const sockB = dgram.createSocket('udp4');
  const inbox = [];
  sockB.on('message', (m) => inbox.push(m));
  await new Promise((r) => sockA.bind(0, '127.0.0.1', r));
  await new Promise((r) => sockB.bind(0, '127.0.0.1', r));
  const ping = Buffer.alloc(8);
  // B announces itself (the mod pings right after joining), then A talks
  sockB.send(seal(b.sid, b.key, 2, 1, ping), port, '127.0.0.1');
  await sleep(100);
  const opus = Buffer.from('fake-opus-frame');
  sockA.send(seal(a.sid, a.key, 1, 1, Buffer.concat([Buffer.from([0]), opus])), port, '127.0.0.1');
  await sleep(200);
  const audio = inbox.filter((m) => m[1] === 1);
  assert.equal(audio.length, 1, 'B received A\'s audio');
  const plain = open(b.sid, b.key, audio[0]);
  assert.equal(plain.readUInt32BE(0) >>> 0, a.sid >>> 0, 'tagged with the speaker');
  assert.equal(plain[4], 0);
  assert.equal(plain.readUInt32BE(5), 1, 'the speaker\'s sequence number');
  assert.deepEqual(plain.subarray(9), opus);
  sockA.close();
  sockB.close();
  reset();
});
