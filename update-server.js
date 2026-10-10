#!/usr/bin/env node
/**
 * Native Client — local update server
 * Serves the release/ directory so electron-updater can check for and
 * download new builds.  Run this wherever your built artifacts live:
 *
 *   node update-server.js              # default port 8800, this machine only
 *   PORT=9000 node update-server.js
 *   HOST=0.0.0.0 node update-server.js # share it on the network
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8800', 10);
// Loopback by default: exposing the release folder to the whole network is opt-in.
const HOST = process.env.HOST || '127.0.0.1';
const SERVE_DIR = path.resolve(__dirname, 'release');

const MIME = {
  '.yml':     'text/yaml',
  '.yaml':    'text/yaml',
  '.zip':     'application/zip',
  '.exe':     'application/octet-stream',
  '.AppImage':'application/octet-stream',
  '.deb':     'application/octet-stream',
  '.7z':      'application/x-7z-compressed',
  '.blockmap':'application/octet-stream',
};

/**
 * Parses a single "bytes=start-end" / "bytes=start-" / "bytes=-suffix" range.
 * Returns { start, end }, 'unsatisfiable', or null (ignore the header and send the whole file).
 */
function parseRange(header, total) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match || (match[1] === '' && match[2] === '')) return null; // malformed or multi-range: ignore
  let start;
  let end;
  if (match[1] === '') {
    const suffix = parseInt(match[2], 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable';
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = parseInt(match[1], 10);
    end = match[2] === '' ? total - 1 : Math.min(parseInt(match[2], 10), total - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= total || start > end) return 'unsatisfiable';
  return { start, end };
}

const server = http.createServer((req, res) => {
  // strip query string
  const urlPath = req.url.split('?')[0];
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    // "%E0%A4%A" and friends used to throw and kill the whole server.
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Bad request');
  }
  if (decoded.includes('\0')) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Bad request');
  }
  const filePath = path.join(SERVE_DIR, decoded);

  // prevent path traversal outside SERVE_DIR
  if (!filePath.startsWith(SERVE_DIR + path.sep) && filePath !== SERVE_DIR) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';

    // support Range requests (needed for large file downloads)
    const total = stat.size;
    const range = req.headers['range'] ? parseRange(req.headers['range'], total) : null;

    const send = (stream) => {
      stream.on('error', () => { res.destroy(); });
      stream.pipe(res);
    };

    if (range === 'unsatisfiable') {
      res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Accept-Ranges': 'bytes' });
      return res.end();
    }
    if (range) {
      const { start, end } = range;
      res.writeHead(206, {
        'Content-Type': contentType,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      send(fs.createReadStream(filePath, { start, end }));
    } else {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': total,
        'Accept-Ranges': 'bytes',
      });
      send(fs.createReadStream(filePath));
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Update server running at http://${HOST}:${PORT}`);
  console.log(`Serving files from: ${SERVE_DIR}`);
});
