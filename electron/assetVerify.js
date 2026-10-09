/*
 * Gentle asset verification for minecraft-launcher-core.
 *
 * MCLC checks every game asset (~4 000 files) with `Promise.all`, so it opens and SHA-1 hashes all of
 * them at the same time. On laptops (especially HDDs / slow SSDs) that saturates the disk and CPU and
 * the whole PC lags while "Verifying assets".
 *
 * This patches `Handler.prototype.checkSum` so that:
 *  - only a few files are hashed at once (a small queue instead of thousands in parallel), and
 *  - a file whose size + modified time match a previous successful check is trusted without being
 *    read again (cache stored in userData/asset-verify-cache.json). Changed or corrupt files still
 *    get re-hashed and re-downloaded by MCLC as before.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const LIMIT = Math.max(2, Math.min(4, Math.floor((os.cpus()?.length || 4) / 2)));
let active = 0;
const waiting = [];

function runLimited(task) {
  return new Promise((resolve, reject) => {
    const start = () => {
      active += 1;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          const next = waiting.shift();
          // yield to the event loop between files so the app (and the PC) stays responsive
          if (next) setImmediate(next);
        });
    };
    if (active < LIMIT) start();
    else waiting.push(start);
  });
}

let cacheFile = null;
let cache = null;
let saveTimer = null;

function loadCache() {
  if (cache) return cache;
  cache = {};
  try {
    const { app } = require('electron');
    cacheFile = path.join(app.getPath('userData'), 'asset-verify-cache.json');
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (raw && typeof raw === 'object') cache = raw;
  } catch { /* first run or unreadable cache: start empty */ }
  return cache;
}

function saveSoon() {
  if (!cacheFile || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(cacheFile, JSON.stringify(cache), () => {});
  }, 3000);
}

function sha1(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function verify(hash, file) {
  const known = loadCache();
  let stat;
  try { stat = await fs.promises.stat(file); } catch { return false; }
  const stamp = `${stat.size}:${Math.floor(stat.mtimeMs)}`;
  const key = path.resolve(file);
  if (known[key] && known[key].s === stamp && known[key].h === hash) return true;
  const sum = await runLimited(() => sha1(file));
  const ok = sum === hash;
  if (ok) known[key] = { s: stamp, h: hash };
  else delete known[key];
  saveSoon();
  return ok;
}

function install() {
  let Handler;
  try { Handler = require('minecraft-launcher-core/components/handler'); } catch { return; }
  if (!Handler || !Handler.prototype || Handler.prototype.__nativeGentleCheck) return;
  Handler.prototype.checkSum = function checkSum(hash, file) {
    return verify(hash, file).catch((err) => {
      try { this.client.emit('debug', `[Native]: Failed to check file hash due to ${err}`); } catch {}
      return false;
    });
  };
  Handler.prototype.__nativeGentleCheck = true;
}

install();

module.exports = { install };
