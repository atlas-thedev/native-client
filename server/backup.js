// Nightly consistent SQLite snapshot (VACUUM INTO works while the server is live). Keeps the newest 14.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const outDir = process.env.NOCTRA_BACKUP_DIR || path.join(process.env.HOME, 'noctra-backups');
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `noctra-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
// Same lookup as server/db/index.js, so the backup always copies the database the server really uses.
const dataDir = path.resolve(process.env.NOCTRA_DATA_DIR || process.env.NATIVE_SKIN_DATA || path.join(root, 'data'));
const dbPath = process.env.NOCTRA_DB_PATH || path.join(dataDir, 'noctra.db');
if (!fs.existsSync(dbPath)) {
  console.error('backup skipped: no database at', dbPath);
  process.exit(1);
}
const db = new DatabaseSync(dbPath);
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
db.close();
const old = fs.readdirSync(outDir).filter((n) => /^noctra-.*\.db$/.test(n)).sort().reverse().slice(14);
for (const n of old) fs.unlinkSync(path.join(outDir, n));
console.log('backup written', file, 'pruned', old.length);
