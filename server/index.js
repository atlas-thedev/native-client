const path = require('path');
const fs = require('fs');

// Ensure environment variables from .env are loaded first
const envCandidates = [
  path.join(__dirname, '.env'),
  path.join(__dirname, '..', '.env'),
  path.join(process.cwd(), '.env')
];
for (const envPath of envCandidates) {
  if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
    break;
  }
}

const server = require('./server');
const db = require('./db');

const PORT = Number(process.env.PORT || process.env.NATIVE_SKIN_PORT || 3418);
const HOST = process.env.HOST || '127.0.0.1';

// server.handler applies the rate limiter first, then the relay routes, then
// the rest of the API, so every endpoint is rate limited.
const handler = server.handler;
const createServer = server.createServer;

for (const dir of ['profiles', 'textures', 'media']) {
  fs.mkdirSync(path.join(server.DATA_DIR, dir), { recursive: true });
}

const instance = createServer();
instance.listen(PORT, HOST, () => {
  console.log(`[Native Server] Online and listening on http://${HOST}:${PORT}`);
  console.log(`[Native DB] SQLite database active at ${db.DB_PATH}`);
});

function shutdown(signal) {
  console.log(`[Native Server] ${signal} received. Closing database and shutting down...`);
  db.closeDb();
  process.exit(0);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

module.exports = { server: instance, createServer, handler, db };
