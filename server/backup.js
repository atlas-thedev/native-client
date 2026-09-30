// Nightly consistent SQLite snapshot (VACUUM INTO works while the server is live). Keeps the newest 14.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const outDir = process.env.NOCTRA_BACKUP_DIR || path.join(process.env.HOME, 'noctra-backups');
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `noctra-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
const db = new DatabaseSync(path.join(process.env.NOCTRA_DATA_DIR || path.join(root, 'data'), 'noctra.db'));
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
db.close();
const old = fs.readdirSync(outDir).filter((n) => /^noctra-.*\.db$/.test(n)).sort().reverse().slice(14);
for (const n of old) fs.unlinkSync(path.join(outDir, n));
console.log('backup written', file, 'pruned', old.length);
