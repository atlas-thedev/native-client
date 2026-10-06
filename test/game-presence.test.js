const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gamePresence = require('../electron/gamePresence');

test('maps the mod presence file to Relay presence', () => {
  assert.deepStrictEqual(gamePresence.toPresence({ v: 1, state: 'multiplayer', label: 'Hypixel', address: 'mc.hypixel.net', online: 4, max: 9 }), {
    status: 'in-game', activity: 'In-game: Hypixel', serverAddress: 'mc.hypixel.net', server: { address: 'mc.hypixel.net', label: 'Hypixel' }
  });
  // Private / LAN servers: no address, so no Join button.
  const lan = gamePresence.toPresence({ v: 1, state: 'multiplayer', label: 'a server' });
  assert.strictEqual(lan.activity, 'In-game: Multiplayer');
  assert.strictEqual(lan.serverAddress, null);
  assert.strictEqual(gamePresence.toPresence({ v: 1, state: 'singleplayer', world: 'W' }).activity, 'In-game: Singleplayer');
  assert.strictEqual(gamePresence.toPresence({ v: 1, state: 'menus' }).serverAddress, null);
  assert.strictEqual(gamePresence.toPresence({ v: 1, state: 'multiplayer', label: 'x', address: 'bad address<script>' }).serverAddress, null);
  assert.strictEqual(gamePresence.toPresence({ v: 2, state: 'menus' }), null);
  assert.strictEqual(gamePresence.toPresence(null), null);
});

test('watches the file and ignores leftovers from an earlier session', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-'));
  const file = gamePresence.presenceFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const since = Date.now();
  fs.writeFileSync(file, JSON.stringify({ v: 1, state: 'multiplayer', label: 'Old', address: 'old.example.com', updatedAt: since - 60_000 }));
  const seen = [];
  const watcher = gamePresence.watch(dir, { since, onPresence: (presence) => seen.push(presence) });
  watcher.poll();
  assert.strictEqual(seen.length, 0);
  assert.strictEqual(watcher.isActive(), false);
  fs.writeFileSync(file, JSON.stringify({ v: 1, state: 'multiplayer', label: 'Hypixel', address: 'mc.hypixel.net', updatedAt: Date.now() }));
  watcher.poll();
  watcher.poll(); // unchanged: no duplicate
  fs.writeFileSync(file, JSON.stringify({ v: 1, state: 'menus', updatedAt: Date.now() }));
  watcher.poll();
  watcher.stop();
  assert.deepStrictEqual(seen.map((p) => p.activity), ['In-game: Hypixel', 'In-game: Menus']);
  assert.strictEqual(watcher.isActive(), true);
  gamePresence.clear(dir);
  assert.strictEqual(fs.existsSync(file), false);
});
