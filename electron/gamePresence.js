const fs = require('node:fs');
const path = require('node:path');

/**
 * Relay presence straight from the game.
 *
 * The Native mod writes `<gameDir>/.native/presence.json` whenever what the player is doing
 * changes (menus, a singleplayer world, a server, Realms). The launcher turns it into the
 * status friends see ("In-game: Hypixel", the Join button, the green dot). Unlike the game
 * log, it also notices leaving a server, and chat can't fake it.
 */

const POLL_MS = 1500;

function presenceFile(gameDir) {
  return path.join(gameDir, '.native', 'presence.json');
}

/** mod file -> { status, activity, serverAddress, server } or null when unusable */
function toPresence(data) {
  if (!data || typeof data !== 'object' || data.v !== 1) return null;
  const clean = (value, max = 48) => String(value ?? '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, max);
  switch (data.state) {
    case 'multiplayer': {
      const label = clean(data.label) || 'Multiplayer';
      const address = typeof data.address === 'string' && /^[a-z0-9.:[\]-]{3,260}$/i.test(data.address) ? data.address : null;
      return {
        status: 'in-game',
        activity: `In-game: ${label === 'a server' ? 'Multiplayer' : label}`,
        serverAddress: address,
        server: address ? { address, label } : null
      };
    }
    case 'singleplayer':
      return { status: 'in-game', activity: 'In-game: Singleplayer', serverAddress: null, server: null };
    case 'realms':
      return { status: 'in-game', activity: 'In-game: Realms', serverAddress: null, server: null };
    case 'menus':
      return { status: 'in-game', activity: 'In-game: Menus', serverAddress: null, server: null };
    default:
      return null;
  }
}

/**
 * Polls the mod's file. `onPresence` gets each new presence; `isActive()` reports whether
 * the mod has written one this session (then the game-log guesses are ignored).
 */
function watch(gameDir, { since = Date.now(), onPresence = () => {} } = {}) {
  const file = presenceFile(gameDir);
  let lastBody = null;
  let active = false;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    let body;
    try { body = fs.readFileSync(file, 'utf8'); } catch { return; }
    if (body === lastBody) return;
    lastBody = body;
    let data;
    try { data = JSON.parse(body); } catch { return; }
    // A file left over from an earlier session says nothing about this one.
    if (!(Number(data?.updatedAt) >= since - 5000)) return;
    const presence = toPresence(data);
    if (!presence) return;
    active = true;
    try { onPresence(presence, data); } catch { /* a listener error must not stop the watcher */ }
  };
  const timer = setInterval(tick, POLL_MS);
  timer.unref?.();
  return {
    isActive: () => active,
    poll: tick,
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}

function clear(gameDir) {
  try { fs.rmSync(presenceFile(gameDir), { force: true }); } catch { /* already gone */ }
}

module.exports = { watch, clear, toPresence, presenceFile, POLL_MS };
