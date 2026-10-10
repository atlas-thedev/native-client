const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Crash-safe JSON persistence for the launcher's own state files
 * (accounts.json, instances.json, social caches).
 *
 *  - Writes go to a temp file that is fsync'd and renamed over the target, so
 *    a crash or power cut leaves either the old or the new file, never half.
 *  - The previous good copy is kept as <file>.bak (written the same safe way).
 *  - A file that exists but can't be parsed is never treated as "empty": we
 *    fall back to the .bak copy, and the unreadable file is moved aside
 *    (<file>.corrupt-<time>) so a later save cannot overwrite the user's data.
 *  - A file that exists but can't be opened right now (locked by antivirus,
 *    sync tools...) is reported as 'unreadable', so callers can refuse to save
 *    over it.
 */

function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(fd, data);
    try { fs.fsyncSync(fd); } catch { /* not supported everywhere */ }
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    // Windows can refuse to replace a file another process has open.
    try {
      fs.copyFileSync(temporary, file);
      fs.rmSync(temporary, { force: true });
    } catch {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  }
}

const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

function writeJsonAtomic(file, value, { backup = true } = {}) {
  const text = JSON.stringify(value, null, 2);
  if (backup) {
    try {
      const current = fs.readFileSync(file, 'utf8');
      JSON.parse(stripBom(current));
      // Atomic too: a crash mid-write must not leave a half .bak as the only fallback.
      if (current !== text) writeFileAtomic(`${file}.bak`, current);
    } catch { /* no good current copy to keep */ }
  }
  writeFileAtomic(file, text);
}

/**
 * Returns { value, status } where status is 'ok', 'missing', 'restored'
 * (read from .bak), 'unreadable' (the file exists but could not be opened;
 * value is the .bak copy or the fallback) or 'corrupt' (nothing readable;
 * fallback returned).
 */
function readJsonDetailed(file, fallback = null) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      const restored = readBackup(file);
      return restored ? { value: restored, status: 'restored' } : { value: fallback, status: 'missing' };
    }
    // EBUSY/EPERM etc: the data is there, we just can't read it right now.
    const restored = readBackup(file);
    return { value: restored || fallback, status: 'unreadable' };
  }
  try {
    return { value: JSON.parse(stripBom(raw)), status: 'ok' };
  } catch {
    quarantine(file);
    const restored = readBackup(file);
    if (restored) {
      try { writeFileAtomic(file, JSON.stringify(restored, null, 2)); } catch {}
      return { value: restored, status: 'restored' };
    }
    return { value: fallback, status: 'corrupt' };
  }
}

function readJson(file, fallback = null) {
  return readJsonDetailed(file, fallback).value;
}

function readBackup(file) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(`${file}.bak`, 'utf8')));
  } catch {
    return null;
  }
}

function quarantine(file) {
  try {
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch { /* best effort */ }
}

module.exports = { writeFileAtomic, writeJsonAtomic, readJson, readJsonDetailed };
