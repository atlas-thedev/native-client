const fs = require('fs');
const path = require('path');

/**
 * Server join history recorded live from the game log while Native runs the
 * game. Complements the log-file scan in instance.js, which can miss joins
 * once Minecraft rotates or prunes old logs.
 */

const MAX_ENTRIES = 50;

function historyFile() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'play-history.json');
}

function readServers() {
  try {
    const data = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
    return Array.isArray(data?.servers) ? data.servers : [];
  } catch {
    return [];
  }
}

function recordServer({ address, instanceId = null, instanceName = null, connectedAt = Date.now() }) {
  if (!address) return;
  try {
    const servers = [
      { address: String(address), instanceId, instanceName, connectedAt },
      ...readServers()
    ].slice(0, MAX_ENTRIES);
    const file = historyFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ servers }, null, 2));
    fs.renameSync(temp, file);
  } catch {
    // History is a convenience; never let it break a running game.
  }
}

module.exports = { readServers, recordServer };
