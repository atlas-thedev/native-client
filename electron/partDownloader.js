'use strict';
/**
 * Resumable, parallel, part-based downloader for launcher updates.
 *
 * The file is split into fixed-size parts that are fetched with HTTP Range
 * requests (several at once) and written straight into `<dest>.partial` at their
 * offsets. Which parts are finished is saved in `<dest>.parts.json` after every
 * part, so a cancelled, crashed or offline download continues where it stopped
 * (even after a restart). The finished file is checked against its sha512
 * before it is moved into place; a mismatch throws away the parts and starts over.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PART_SIZE = 4 * 1024 * 1024;
const STATE_VERSION = 1;

class DownloadCancelled extends Error {
  constructor() { super('Download cancelled'); this.cancelled = true; }
}

async function readState(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; }
}

async function writeState(file, state) {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state));
  await fsp.rename(tmp, file);
}

async function sha512File(file) {
  const hash = crypto.createHash('sha512');
  await new Promise((resolve, reject) => {
    fs.createReadStream(file).on('data', (c) => hash.update(c)).on('error', reject).on('end', resolve);
  });
  return hash.digest('base64');
}

/** `{ total, done, parts }` of a saved download, or null. Cheap: never touches the data. */
async function inspect(dest) {
  const state = await readState(`${dest}.parts.json`);
  if (!state || state.v !== STATE_VERSION) return null;
  const done = state.done.reduce((n, d) => n + (d ? 1 : 0), 0);
  return { url: state.url, size: state.size, sha512: state.sha512, parts: state.done.length, doneParts: done };
}

/**
 * @param {object} o
 * @param {string} o.url        file URL (redirects are followed)
 * @param {string} o.dest       final path
 * @param {number} o.size       expected size in bytes
 * @param {string} o.sha512     expected base64 sha512
 * @param {number} [o.connections=4]  parallel parts (read again for every part, so it can change live)
 * @param {() => number} [o.getConnections]
 * @param {(p) => void} [o.onProgress]
 * @param {{ cancelled: boolean }} [o.signal]  set `.cancelled = true` to stop (parts are kept)
 * @param {typeof fetch} [o.fetch]
 * @returns {Promise<{ path: string, resumed: boolean }>}
 */
async function download(o) {
  const doFetch = o.fetch || globalThis.fetch;
  const size = Number(o.size);
  if (!(size > 0)) throw new Error('Unknown update size');
  const partSize = o.partSize || PART_SIZE;
  const statePath = `${o.dest}.parts.json`;
  const partialPath = `${o.dest}.partial`;
  const signal = o.signal || { cancelled: false };
  await fsp.mkdir(path.dirname(o.dest), { recursive: true });

  // already finished earlier?
  try {
    const st = await fsp.stat(o.dest);
    if (st.size === size && await sha512File(o.dest) === o.sha512) return { path: o.dest, resumed: true };
  } catch {}

  const count = Math.ceil(size / partSize);
  let state = await readState(statePath);
  const sameFile = state && state.v === STATE_VERSION && state.size === size && state.sha512 === o.sha512
    && state.partSize === partSize && Array.isArray(state.done) && state.done.length === count;
  let partialOk = false;
  try { partialOk = (await fsp.stat(partialPath)).size === size; } catch {}
  if (!sameFile || !partialOk) {
    state = { v: STATE_VERSION, url: o.url, size, sha512: o.sha512, partSize, done: new Array(count).fill(0) };
    const fh = await fsp.open(partialPath, 'w');
    await fh.truncate(size);
    await fh.close();
    await writeState(statePath, state);
  }
  const resumed = state.done.some(Boolean);

  const fh = await fsp.open(partialPath, 'r+');
  let transferred = state.done.reduce((n, d, i) => n + (d ? partLength(i) : 0), 0);
  const startTransferred = transferred;
  const startedAt = Date.now();
  const samples = [];
  let saving = Promise.resolve();
  let rangeUnsupported = false;

  function partLength(i) { return Math.min(partSize, size - i * partSize); }

  function report() {
    const now = Date.now();
    samples.push([now, transferred]);
    while (samples.length > 2 && now - samples[0][0] > 5000) samples.shift();
    const [t0, b0] = samples[0];
    const bytesPerSecond = now > t0 ? ((transferred - b0) * 1000) / (now - t0)
      : ((transferred - startTransferred) * 1000) / Math.max(1, now - startedAt);
    o.onProgress?.({
      transferred, total: size, percent: (transferred / size) * 100, bytesPerSecond: Math.max(0, bytesPerSecond),
      parts: count, doneParts: state.done.reduce((n, d) => n + (d ? 1 : 0), 0), resumed,
      map: state.done.slice()
    });
  }

  async function fetchPart(i) {
    const start = i * partSize;
    const end = start + partLength(i) - 1;
    for (let attempt = 0; ; attempt += 1) {
      if (signal.cancelled) throw new DownloadCancelled();
      let got = 0;
      try {
        const res = await doFetch(o.url, { headers: { Range: `bytes=${start}-${end}`, 'User-Agent': 'NativeClient-Updater' }, redirect: 'follow' });
        if (res.status === 200 && !(start === 0 && end === size - 1)) { rangeUnsupported = true; res.body?.cancel?.(); throw new Error('Server does not support ranges'); }
        if (res.status !== 206 && res.status !== 200) { res.body?.cancel?.(); throw new Error(`HTTP ${res.status}`); }
        const reader = res.body.getReader();
        let pos = start;
        for (;;) {
          if (signal.cancelled) { reader.cancel().catch(() => {}); throw new DownloadCancelled(); }
          const { done, value } = await reader.read();
          if (done) break;
          if (pos + value.length > end + 1) throw new Error('Server sent too much data');
          await fh.write(value, 0, value.length, pos);
          pos += value.length; got += value.length; transferred += value.length;
          report();
        }
        if (pos !== end + 1) throw new Error('Part ended early');
        state.done[i] = 1;
        saving = saving.then(() => writeState(statePath, state)).catch(() => {});
        await saving;
        report();
        return;
      } catch (err) {
        transferred -= got;
        if (err.cancelled || rangeUnsupported || attempt >= 5) throw err;
        await new Promise((r) => setTimeout(r, Math.min(15000, 800 * 2 ** attempt)));
      }
    }
  }

  try {
    report();
    const queue = state.done.map((d, i) => (d ? -1 : i)).filter((i) => i >= 0);
    let failure = null;
    let active = 0;
    await new Promise((resolve) => {
      const pump = () => {
        if (failure && active === 0) return resolve();
        if (!queue.length && active === 0) return resolve();
        const limit = Math.max(1, Math.min(8, Number(o.getConnections?.() ?? o.connections ?? 4) || 1));
        while (!failure && queue.length && active < limit) {
          const i = queue.shift();
          active += 1;
          fetchPart(i).catch((err) => { failure = failure || err; }).finally(() => { active -= 1; pump(); });
        }
        if (!failure && queue.length && active >= limit) {
          // connection limit may rise later (e.g. the game closed); keep pumping
          const t = setTimeout(pump, 2000); t.unref?.();
        }
      };
      pump();
    });
    if (failure) throw failure;
  } finally {
    await saving;
    await fh.close();
  }

  if (await sha512File(partialPath) !== o.sha512) {
    await Promise.all([fsp.rm(partialPath, { force: true }), fsp.rm(statePath, { force: true })]);
    throw new Error('The update failed verification and will be downloaded again.');
  }
  await fsp.rm(o.dest, { force: true });
  await fsp.rename(partialPath, o.dest);
  await fsp.rm(statePath, { force: true });
  return { path: o.dest, resumed };
}

module.exports = { download, inspect, sha512File, DownloadCancelled, PART_SIZE };
