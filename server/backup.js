// Nightly consistent SQLite snapshot (VACUUM INTO works while the server is live). Keeps the newest 14.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { resolveDbPath } = require('./env');
const root = path.resolve(__dirname, '..');
const outDir = process.env.NATIVE_BACKUP_DIR || path.join(process.env.HOME, 'native-backups');
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `native-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
// Same lookup as server/db/index.js, so the backup always copies the database the server really uses.
const dataDir = path.resolve(process.env.NATIVE_DATA_DIR || process.env.NATIVE_SKIN_DATA || path.join(root, 'data'));
const dbPath = process.env.NATIVE_DB_PATH || resolveDbPath(dataDir);
if (!fs.existsSync(dbPath)) {
  console.error('backup skipped: no database at', dbPath);
  process.exit(1);
}
const db = new DatabaseSync(dbPath);
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
db.close();
const old = fs.readdirSync(outDir).filter((n) => /^native-.*\.db$/.test(n)).sort().reverse().slice(14);
for (const n of old) fs.unlinkSync(path.join(outDir, n));
console.log('backup written', file, 'pruned', old.length);
