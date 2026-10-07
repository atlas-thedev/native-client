'use strict';
/**
 * Differential launcher updates for Windows.
 *
 * electron-builder publishes `<installer>.exe.blockmap` next to every installer:
 * a gzipped list of content-defined blocks (checksum + size). Comparing the
 * blockmap of the installer we already have (the one that installed this
 * version, kept in the update cache) with the new one tells us which blocks are
 * unchanged: those are copied from the old file, and only the changed blocks
 * are fetched with HTTP Range requests. A typical release then downloads a few
 * MB instead of the whole ~100 MB installer.
 *
 * The rebuilt file is checked against the release sha512 before it is used; if
 * anything doesn't line up the caller falls back to the full download.
 */
const fsp = require('node:fs/promises');
const zlib = require('node:zlib');
const { sha512File, DownloadCancelled } = require('./partDownloader');

const CHUNK = 4 * 1024 * 1024; // max bytes per range request
const MERGE_GAP = 128 * 1024; // download small unchanged gaps instead of splitting requests
const COPY_BUF = 1024 * 1024;

class NotWorthIt extends Error {}

async function fetchBlockmap(url, doFetch) {
  const res = await doFetch(url, { headers: { 'User-Agent': 'NativeClient-Updater' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`Blockmap HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const raw = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;
  const map = JSON.parse(raw.toString('utf8'));
  const file = map?.files?.[0];
  if (!file || !Array.isArray(file.checksums) || !Array.isArray(file.sizes) || file.checksums.length !== file.sizes.length) {
    throw new Error('Unreadable blockmap');
  }
  return file;
}

/**
 * Segments of the new file, in order: `{ copy: true, at, from, len }` (bytes from the
 * old file at `from`) or `{ copy: false, at, len }` (download `at..at+len` of the new file).
 */
function plan(oldFile, newFile) {
  const old = new Map();
  let off = Number(oldFile.offset) || 0;
  oldFile.checksums.forEach((c, i) => {
    if (!old.has(c)) old.set(c, { at: off, size: oldFile.sizes[i] });
    off += oldFile.sizes[i];
  });

  const segs = [];
  let at = Number(newFile.offset) || 0;
  newFile.checksums.forEach((c, i) => {
    const size = newFile.sizes[i];
    const hit = old.get(c);
    const last = segs[segs.length - 1];
    if (hit && hit.size === size) {
      if (last?.copy && last.from + last.len === hit.at) last.len += size;
      else segs.push({ copy: true, at, from: hit.at, len: size });
    } else if (last && !last.copy) last.len += size;
    else segs.push({ copy: false, at, len: size });
    at += size;
  });

  // fold tiny unchanged gaps between two downloads into one request
  const merged = [];
  for (let i = 0; i < segs.length; i += 1) {
    const s = segs[i];
    const prev = merged[merged.length - 1];
    const next = segs[i + 1];
    if (s.copy && s.len < MERGE_GAP && prev && !prev.copy && next && !next.copy) {
      prev.len += s.len + next.len;
      i += 1;
    } else if (!s.copy && prev && !prev.copy) prev.len += s.len;
    else merged.push({ ...s });
  }
  return { segments: merged, size: at };
}

/**
 * @param {object} o
 * @param {string} o.url  new installer URL
 * @param {string} o.dest final path of the new installer
 * @param {number} o.size expected size
 * @param {string} o.sha512 expected base64 sha512
 * @param {string} o.baseFile installer of the version that is installed now
 * @param {string} o.oldBlockmapUrl blockmap of baseFile
 * @param {string} o.newBlockmapUrl blockmap of the new installer
 * @param {{ cancelled: boolean }} [o.signal]
 * @param {() => number} [o.getConnections]
 * @param {(p) => void} [o.onPlan]  called once with `{ downloadBytes, copyBytes }`
 * @param {(p) => void} [o.onProgress]
 * @param {typeof fetch} [o.fetch]
 */
async function download(o) {
  const doFetch = o.fetch || globalThis.fetch;
  const signal = o.signal || { cancelled: false };
  const size = Number(o.size);
  const [oldFile, newFile] = await Promise.all([fetchBlockmap(o.oldBlockmapUrl, doFetch), fetchBlockmap(o.newBlockmapUrl, doFetch)]);
  const oldSize = oldFile.sizes.reduce((n, s) => n + s, Number(oldFile.offset) || 0);
  const baseStat = await fsp.stat(o.baseFile);
  if (baseStat.size !== oldSize) throw new Error('The saved installer does not match its blockmap');

  const { segments, size: planned } = plan(oldFile, newFile);
  if (planned !== size) throw new Error('Blockmap size does not match the release');
  const downloadBytes = segments.filter((s) => !s.copy).reduce((n, s) => n + s.len, 0);
  const copyBytes = size - downloadBytes;
  if (downloadBytes > size * 0.75) throw new NotWorthIt('Most of the installer changed');
  o.onPlan?.({ downloadBytes, copyBytes });

  const work = `${o.dest}.diff`;
  const out = await fsp.open(work, 'w');
  const base = await fsp.open(o.baseFile, 'r');
  let transferred = 0;
  const startedAt = Date.now();
  const samples = [];
  const report = () => {
    const now = Date.now();
    samples.push([now, transferred]);
    while (samples.length > 2 && now - samples[0][0] > 5000) samples.shift();
    const [t0, b0] = samples[0];
    const bytesPerSecond = now > t0 ? ((transferred - b0) * 1000) / (now - t0) : (transferred * 1000) / Math.max(1, now - startedAt);
    o.onProgress?.({ transferred, total: downloadBytes, percent: downloadBytes ? (transferred / downloadBytes) * 100 : 100, bytesPerSecond: Math.max(0, bytesPerSecond) });
  };

  try {
    await out.truncate(size);
    // 1) reuse everything that didn't change
    const buf = Buffer.allocUnsafe(COPY_BUF);
    for (const s of segments) {
      if (!s.copy) continue;
      for (let done = 0; done < s.len;) {
        if (signal.cancelled) throw new DownloadCancelled();
        const n = Math.min(COPY_BUF, s.len - done);
        const { bytesRead } = await base.read(buf, 0, n, s.from + done);
        if (bytesRead !== n) throw new Error('The saved installer ended early');
        await out.write(buf, 0, n, s.at + done);
        done += n;
      }
    }

    // 2) fetch only the changed ranges, a few at once
    const jobs = [];
    for (const s of segments) {
      if (s.copy) continue;
      for (let p = 0; p < s.len; p += CHUNK) jobs.push({ start: s.at + p, end: s.at + Math.min(s.len, p + CHUNK) - 1 });
    }
    report();
    const fetchRange = async ({ start, end }) => {
      for (let attempt = 0; ; attempt += 1) {
        if (signal.cancelled) throw new DownloadCancelled();
        let got = 0;
        try {
          const res = await doFetch(o.url, { headers: { Range: `bytes=${start}-${end}`, 'User-Agent': 'NativeClient-Updater' }, redirect: 'follow' });
          if (res.status !== 206) { res.body?.cancel?.(); throw new Error(res.status === 200 ? 'Server does not support ranges' : `HTTP ${res.status}`); }
          const reader = res.body.getReader();
          let pos = start;
          for (;;) {
            if (signal.cancelled) { reader.cancel().catch(() => {}); throw new DownloadCancelled(); }
            const { done, value } = await reader.read();
            if (done) break;
            if (pos + value.length > end + 1) throw new Error('Server sent too much data');
            await out.write(value, 0, value.length, pos);
            pos += value.length; got += value.length; transferred += value.length;
            report();
          }
          if (pos !== end + 1) throw new Error('Range ended early');
          return;
        } catch (err) {
          transferred -= got;
          if (err.cancelled || /ranges/.test(err.message) || attempt >= 4) throw err;
          await new Promise((r) => setTimeout(r, Math.min(10000, 800 * 2 ** attempt)));
        }
      }
    };
    let failure = null;
    let next = 0;
    const lane = async () => {
      while (!failure && next < jobs.length) {
        const job = jobs[next++];
        await fetchRange(job).catch((err) => { failure = failure || err; });
      }
    };
    const lanes = Math.max(1, Math.min(6, Number(o.getConnections?.() ?? 4) || 1));
    await Promise.all(Array.from({ length: lanes }, lane));
    if (failure) throw failure;
  } catch (err) {
    await out.close().catch(() => {});
    await base.close().catch(() => {});
    await fsp.rm(work, { force: true });
    throw err;
  }
  await out.close();
  await base.close();

  if (await sha512File(work) !== o.sha512) {
    await fsp.rm(work, { force: true });
    throw new Error('The patched update failed verification');
  }
  await fsp.rm(o.dest, { force: true });
  await fsp.rename(work, o.dest);
  return { path: o.dest, downloadBytes, copyBytes };
}

module.exports = { download, plan, fetchBlockmap, NotWorthIt };
