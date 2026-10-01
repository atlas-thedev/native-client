const test = require('node:test');
const assert = require('node:assert/strict');
const { _internals } = require('../electron/launcher');

const { classifyExit, GAME_CRASH_MARKER } = _internals;

test('non-zero exit is a crash', () => {
  const v = classifyExit({ code: 1, signal: null });
  assert.equal(v.crashed, true);
  assert.match(v.detail, /exit code 1/);
});

test('clean exit after playing is not a crash', () => {
  assert.equal(classifyExit({ code: 0, signal: null, startedAgo: 600000, sawOutput: true }).crashed, false);
});

test('a crash report or marker wins over a zero exit code', () => {
  assert.equal(classifyExit({ code: 0, signal: null, hasCrashRecord: true }).crashed, true);
  assert.equal(classifyExit({ code: 0, signal: null, crashSeen: true }).crashed, true);
});

test('closing right after launch without any output is a failed start', () => {
  assert.equal(classifyExit({ code: 0, signal: null, startedAgo: 1200, sawOutput: false }).crashed, true);
});

test('killing the game from the launcher is not a crash', () => {
  assert.equal(classifyExit({ code: null, signal: 'SIGTERM' }).crashed, false);
});

test('a hard signal is a crash', () => {
  assert.equal(classifyExit({ code: null, signal: 'SIGSEGV' }).crashed, true);
});

test('crash markers are recognised', () => {
  assert.ok(GAME_CRASH_MARKER.test('[Render thread/ERROR]: #@!@# Game crashed! Crash report saved to: #@!@# C:/x.txt'));
  assert.ok(GAME_CRASH_MARKER.test('---- Minecraft Crash Report ----'));
  assert.ok(!GAME_CRASH_MARKER.test('[main/INFO]: Setting user: Steve'));
});
