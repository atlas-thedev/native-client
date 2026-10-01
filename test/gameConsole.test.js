const test = require('node:test');
const assert = require('node:assert/strict');
const gameConsole = require('../electron/gameConsole');

const { parseText, redact, sessions } = gameConsole._internals;

test('console parser tags levels, stack traces and launcher lines', () => {
  const lines = parseText([
    '[12:00:01] [main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.15.0',
    '[12:00:02] [main/WARN]: Reference map could not be read',
    '[12:00:03] [Render thread/ERROR]: Failed to load model',
    'java.lang.NoClassDefFoundError: org/example/Missing',
    '\tat org.example.Mod.init(Mod.java:10)',
    'Caused by: java.lang.ClassNotFoundException: org.example.Missing',
    '\t... 5 more',
    '[12:00:04] [Render thread/INFO] [mixin/]: back to normal',
    'plain println from a mod',
    '[MCLC]: Attempting to download assets',
    '2013-05-01 12:00:00 [SEVERE] legacy failure',
    '[12:00:05 WARN]: short header'
  ].join('\n'));
  assert.deepEqual(lines.map((l) => l.lv), ['info', 'warn', 'severe', 'severe', 'severe', 'severe', 'severe', 'info', 'info', 'info', 'severe', 'warn']);
  assert.equal(lines[9].src, 'launcher');
  assert.equal(lines[3].mk, 'crash');
  assert.equal(lines[5].mk, 'crash');
  assert.equal(lines[0].th, 'main');
});

test('console marks missing dependencies and crash report headers', () => {
  const lines = parseText([
    "\t - Mod 'Iris' (iris) 1.6.4 requires any version of fabric-api, which is missing!",
    '---- Minecraft Crash Report ----',
    'Description: Initializing game',
    '[12:00:00] [main/ERROR]: Missing or unsupported mandatory dependencies:'
  ].join('\n'));
  assert.equal(lines[0].mk, 'dep');
  assert.equal(lines[1].mk, 'crash');
  assert.equal(lines[1].lv, 'severe');
  assert.equal(lines[2].lv, 'severe', 'crash report body stays severe');
  assert.equal(lines[3].mk, 'dep');
});

test('console reads log4j XML events', () => {
  const lines = parseText([
    '<log4j:Event logger="net.minecraft.client.Minecraft" timestamp="1700000000000" level="WARN" thread="Render thread">',
    '  <log4j:Message><![CDATA[Hello & goodbye]]></log4j:Message>',
    '</log4j:Event>'
  ].join('\n'));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].lv, 'warn');
  assert.match(lines[0].text, /\[Render thread\/WARN\]: Hello & goodbye$/);
});

test('console never keeps access tokens', () => {
  const text = redact('[MCLC]: Launching with arguments --username Bob --accessToken eyJabc.def.ghi --xuid 123 --uuid u');
  assert.doesNotMatch(text, /eyJabc|def\.ghi|123/);
  assert.match(text, /--uuid u/);
  assert.match(redact('(Session ID is token:abcdefghijklmnopqrstuvwxyz:uuid)'), /Session ID is ••••••••/);
});

test('console session splits chunks into lines and closes with an exit note', () => {
  gameConsole.begin({ id: 'test-inst', name: 'Test', version: '1.20.1', loader: 'fabric' });
  gameConsole.pushGame('[12:00:00] [main/INFO]: hel', 'stdout', 'test-inst');
  gameConsole.pushGame('lo\n[12:00:01] [main/WARN]: second\n', 'stdout', 'test-inst');
  gameConsole.pushGame('Exception in thread "main" java.lang.RuntimeException: x\n', 'stderr', 'test-inst');
  gameConsole.pushLauncher('Preparing game', 'test-inst');
  gameConsole.end('test-inst', { code: 1 });
  const data = gameConsole.get('test-inst');
  assert.equal(data.running, false);
  assert.deepEqual(data.lines.map((l) => l.text.replace(/^\[\d\d:\d\d:\d\d\] /, '')), [
    '[main/INFO]: hello',
    '[main/WARN]: second',
    'Exception in thread "main" java.lang.RuntimeException: x',
    '[Noctra] Preparing game',
    '[Noctra] Minecraft exited with code 1'
  ]);
  assert.deepEqual(data.lines.map((l) => l.n), [1, 2, 3, 4, 5]);
  assert.equal(data.counts.severe, 1);
  assert.equal(data.counts.launcher, 2);
  assert.equal(gameConsole.isActive('test-inst'), false);
  sessions.delete('test-inst');
});

test('console ring buffer keeps the newest lines and correct counts', () => {
  gameConsole.begin({ id: 'ring', name: 'Ring' });
  const chunk = Array.from({ length: 20500 }, (_, i) => `[12:00:00] [main/${i < 600 ? 'WARN' : 'INFO'}]: line ${i}`).join('\n');
  gameConsole.pushGame(`${chunk}\n`, 'stdout', 'ring');
  const data = gameConsole.get('ring');
  assert.equal(data.lines.length, 20000);
  assert.equal(data.dropped, 500);
  assert.equal(data.counts.warn, 100);
  assert.match(data.lines[data.lines.length - 1].text, /line 20499$/);
  gameConsole.end('ring', { killed: true });
  assert.match(gameConsole.get('ring').lines.at(-1).text, /stopped from the launcher/);
  sessions.delete('ring');
});

test('stopping without a running game is a no-op', () => {
  const { stopGame } = require('../electron/launcher')._internals;
  assert.deepEqual(stopGame({ force: true }), { ok: false, reason: 'not-running' });
});
