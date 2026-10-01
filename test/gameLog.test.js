const test = require('node:test');
const assert = require('node:assert/strict');
const gameLog = require('../electron/gameLog');

function run(lines) {
  const classify = gameLog.createLogClassifier();
  const out = [];
  const reader = gameLog.createLineReader((line) => out.push(classify(line)));
  reader(lines.join('\n') + '\n');
  return out;
}

test('chat lines never count as crash markers', () => {
  const entries = run([
    '[12:00:00] [Render thread/INFO]: [System] [CHAT] <griefer> Minecraft ran into a problem',
    '[12:00:01] [Render thread/INFO]: [CHAT] ---- Minecraft Crash Report ----',
    '---- Minecraft Crash Report ----'
  ]);
  assert.equal(entries.filter(gameLog.isCrashLine).length, 0, 'continuation of a chat line is still chat');
});

test('real crash markers are still detected', () => {
  const entries = run([
    '[12:00:00] [Render thread/INFO]: Setting user: Steve',
    '[12:00:05] [Render thread/ERROR]: #@!@# Game crashed! Crash report saved to: #@!@# C:/x.txt',
    '---- Minecraft Crash Report ----'
  ]);
  assert.equal(entries.filter(gameLog.isCrashLine).length, 2);
});

test('lines split across chunks are re-assembled', () => {
  const classify = gameLog.createLogClassifier();
  const hits = [];
  const reader = gameLog.createLineReader((line) => { if (gameLog.isCrashLine(classify(line))) hits.push(line); });
  reader('[12:00:05] [Render thread/ERROR]: #@!@# Game cr');
  reader('ashed! Crash report saved\n');
  assert.equal(hits.length, 1);
});

test('presence ignores chat and needs an anchored log message', () => {
  const [spoof, real, sp, menus] = run([
    '[12:00:00] [Render thread/INFO]: [CHAT] <bob> Connecting to evil.example, 25565',
    '[12:00:00] [Render thread/INFO]: Connecting to mc.hypixel.net, 25565',
    '[12:00:00] [Server thread/INFO]: Starting integrated server',
    '[12:00:00] [Render thread/INFO]: Disconnecting from server'
  ]);
  assert.equal(gameLog.presenceFromLine(spoof), null);
  assert.deepEqual(gameLog.presenceFromLine(real), { kind: 'server', host: 'mc.hypixel.net', port: '25565' });
  assert.deepEqual(gameLog.presenceFromLine(sp), { kind: 'singleplayer' });
  assert.deepEqual(gameLog.presenceFromLine(menus), { kind: 'menus' });
  const [adv] = run(['[12:00:00] [Render thread/INFO]: Loaded 1234 advancements']);
  assert.equal(gameLog.presenceFromLine(adv), null, 'joining a server must not read as Singleplayer');
});

test('server labels match whole domains only and contain no emoji', () => {
  assert.equal(gameLog.formatServerActivity('mc.hypixel.net'), 'Hypixel');
  assert.equal(gameLog.formatServerActivity('play.donutsmp.net'), 'Donut SMP');
  assert.equal(gameLog.formatServerActivity('archive.example.org'), 'Example');
  assert.equal(gameLog.formatServerActivity('pvpland.net'), 'Pvpland');
  assert.equal(gameLog.formatServerActivity('localhost'), 'Local Server');
  assert.equal(gameLog.formatServerActivity('51.2.3.4'), 'Multiplayer');
});
