#!/usr/bin/env node
/**
 * Native Client — local update server
 * Serves the release/ directory so electron-updater can check for and
 * download new builds.  Run this wherever your built artifacts live:
 *
 *   node update-server.js              # default port 8800
 *   PORT=9000 node update-server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8800', 10);
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

const server = http.createServer((req, res) => {
  // strip query string
  const urlPath = req.url.split('?')[0];
  const filePath = path.join(SERVE_DIR, decodeURIComponent(urlPath));

  // prevent path traversal outside SERVE_DIR
  if (!filePath.startsWith(SERVE_DIR + path.sep) && filePath !== SERVE_DIR) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found: ' + urlPath);
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';

    // support Range requests (needed for large file downloads)
    const total = stat.size;
    const rangeHeader = req.headers['range'];

    if (rangeHeader) {
      const [, rangeStr] = rangeHeader.split('=');
      const [startStr, endStr] = rangeStr.split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : total - 1;

      res.writeHead(206, {
        'Content-Type': contentType,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': total,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Update server running at http://0.0.0.0:${PORT}`);
  console.log(`Serving files from: ${SERVE_DIR}`);
});
