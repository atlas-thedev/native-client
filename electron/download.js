const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { app } = require('electron');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const appVersion = app?.getVersion?.() || require('../package.json').version;
const DEFAULT_HEADERS = {
  'User-Agent': `NativeClient/${appVersion} (https://github.com/atlas-thedev/native-client)`
};

function retryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function httpError(label, status) {
  const error = new Error(`${label} failed (HTTP ${status})`);
  error.retryable = retryableStatus(status);
  return error;
}

async function fetchJson(url, { retries = 2, timeoutMs = 30000, headers } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { ...DEFAULT_HEADERS, ...headers },
        signal: controller.signal
      });
      if (!response.ok) throw httpError('Request', response.status);
      return await response.json();
    } catch (error) {
      lastError = error.name === 'AbortError' ? new Error('Request timed out') : error;
      const canRetry = error.retryable !== false && attempt < retries;
      if (!canRetry) throw lastError;
      await sleep(350 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function replaceFile(tempPath, targetPath) {
  try {
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
    fs.rmSync(targetPath, { force: true });
    fs.renameSync(tempPath, targetPath);
  }
}

function writeFileAtomic(targetPath, data) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tempPath, data);
    replaceFile(tempPath, targetPath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

async function downloadFile(
  urls,
  targetPath,
  { retries = 2, timeoutMs = 120000, expectedHashes = {}, onProgress = () => {} } = {}
) {
  const mirrors = Array.isArray(urls) ? urls.filter(Boolean) : [urls].filter(Boolean);
  if (mirrors.length === 0) throw new Error('No download URL was provided');

  const maxAttempts = Math.max(retries + 1, mirrors.length);
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const url = mirrors[attempt % mirrors.length];
    const tempPath = `${targetPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.part`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        headers: DEFAULT_HEADERS,
        redirect: 'follow',
        signal: controller.signal
      });
      if (!response.ok) throw httpError('Download', response.status);
      if (!response.body) throw new Error('Download returned no data');

      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const total = Number(response.headers.get('content-length')) || 0;
      const hashers = Object.fromEntries(
        Object.keys(expectedHashes)
          .filter((algorithm) => crypto.getHashes().includes(algorithm))
          .map((algorithm) => [algorithm, crypto.createHash(algorithm)])
      );
      let received = 0;
      let lastProgressAt = 0;

      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          for (const hasher of Object.values(hashers)) hasher.update(chunk);
          const now = Date.now();
          if (now - lastProgressAt >= 100 || (total && received >= total)) {
            lastProgressAt = now;
            onProgress({
              received,
              total,
              percent: total ? Math.min(100, Math.round((received / total) * 100)) : null,
              attempt: attempt + 1
            });
          }
          callback(null, chunk);
        }
      });

      await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(tempPath));

      for (const [algorithm, hasher] of Object.entries(hashers)) {
        const actual = hasher.digest('hex').toLowerCase();
        const expected = String(expectedHashes[algorithm]).toLowerCase();
        if (actual !== expected) {
          const error = new Error(`${algorithm.toUpperCase()} checksum mismatch`);
          error.retryable = true;
          throw error;
        }
      }

      replaceFile(tempPath, targetPath);
      return { received, total, url };
    } catch (error) {
      lastError = error.name === 'AbortError' ? new Error('Download timed out') : error;
      fs.rmSync(tempPath, { force: true });
      const canRetry = error.retryable !== false && attempt + 1 < maxAttempts;
      if (!canRetry) throw lastError;
      onProgress({ retrying: true, attempt: attempt + 2, received: 0, total: 0, percent: null });
      await sleep(500 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

module.exports = { downloadFile, fetchJson, writeFileAtomic };
