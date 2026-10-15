'use strict';
/**
 * Play sessions, timed in the main process.
 *
 * The launcher knows exactly when the game process starts and exits, so the clock lives here and
 * does not depend on the window being open, reloaded or closed mid-game.
 *
 *   begin(instanceId)   the game is up: start the clock and keep a heartbeat on disk
 *   end({ crashed })    the game is gone: bank the session in the queue
 *
 * Finished sessions wait in <userData>/playtime-queue.json until the renderer has applied them to
 * the instance AND saved instances.json (it then calls ack). A session therefore survives the window
 * closing, the app quitting, or a crash at any moment. A game that was still being timed when the
 * launcher died is credited up to its last heartbeat the next time the launcher starts.
 */
const fs = require('fs');
const path = require('path');
const safeFile = require('./safeFile');

/** Same limits the instance page uses (src/features/instances/playtimeStats.js). */
const MIN_SESSION_SECS = 10;
const MAX_SESSION_SECS = 24 * 60 * 60;
const HEARTBEAT_MS = 15_000;
const QUEUE_LIMIT = 200;

let deps = null;
let active = null; // { instanceId, startedAt }
let timer = null;

const userData = () => deps.app.getPath('userData');
const queueFile = () => path.join(userData(), 'playtime-queue.json');
const activeFile = () => path.join(userData(), 'playtime-active.json');

function readQueue() {
  const { value } = safeFile.readJsonDetailed(queueFile(), null);
  return Array.isArray(value?.sessions) ? value.sessions : [];
}

function writeQueue(sessions) {
  try { safeFile.writeJsonAtomic(queueFile(), { sessions: sessions.slice(-QUEUE_LIMIT) }, { backup: false }); } catch { /* retried on the next session */ }
}

function persistActive() {
  if (!active) return;
  try { safeFile.writeJsonAtomic(activeFile(), { ...active, seenAt: Date.now() }, { backup: false }); } catch { /* best effort */ }
}

function clearActive() {
  clearInterval(timer);
  timer = null;
  active = null;
  try { fs.rmSync(activeFile(), { force: true }); } catch { /* already gone */ }
}

function enqueue(session) {
  const secs = Math.min(MAX_SESSION_SECS, Math.round((session.endedAt - session.startedAt) / 1000));
  if (!session.instanceId || !(secs >= MIN_SESSION_SECS)) return null;
  const entry = {
    id: `${session.instanceId}:${session.startedAt}`,
    instanceId: session.instanceId,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    secs,
    crashed: Boolean(session.crashed),
    recovered: Boolean(session.recovered)
  };
  const queue = readQueue().filter((item) => item.id !== entry.id);
  queue.push(entry);
  writeQueue(queue);
  return entry;
}

function notify() {
  const win = deps?.getWin?.();
  if (win && !win.isDestroyed()) win.webContents.send('playtime:session');
}

/** The game process is running: start timing it. */
function begin(instanceId, startedAt = Date.now()) {
  if (!deps || !instanceId) return;
  if (active) end({ crashed: true });
  active = { instanceId, startedAt };
  persistActive();
  timer = setInterval(persistActive, HEARTBEAT_MS);
  timer.unref?.();
}

/** The game process is gone (or the launcher is quitting): bank the session. */
function end({ crashed = false, endedAt = Date.now(), recovered = false } = {}) {
  if (!active) return null;
  const session = { ...active, endedAt: Math.max(active.startedAt, endedAt), crashed, recovered };
  clearActive();
  const entry = enqueue(session);
  if (entry) notify();
  return entry;
}

/** A previous run died while a game was being timed: credit it up to the last heartbeat. */
function recover() {
  const { value } = safeFile.readJsonDetailed(activeFile(), null);
  try { fs.rmSync(activeFile(), { force: true }); } catch { /* already gone */ }
  if (!value?.instanceId || !value?.startedAt) return;
  enqueue({
    instanceId: value.instanceId,
    startedAt: Number(value.startedAt),
    endedAt: Number(value.seenAt) || Number(value.startedAt),
    crashed: true,
    recovered: true
  });
}

function init(dependencies, ipcMain) {
  deps = dependencies;
  recover();
  ipcMain.handle('playtime:drain', () => readQueue());
  ipcMain.handle('playtime:active', () => (active ? { ...active, elapsed: Math.max(0, Math.round((Date.now() - active.startedAt) / 1000)) } : null));
  ipcMain.handle('playtime:ack', (_event, ids) => {
    const done = new Set(Array.isArray(ids) ? ids.map(String) : []);
    if (!done.size) return false;
    writeQueue(readQueue().filter((item) => !done.has(item.id)));
    return true;
  });
}

module.exports = { init, begin, end, recover, _internals: { MIN_SESSION_SECS, MAX_SESSION_SECS } };
