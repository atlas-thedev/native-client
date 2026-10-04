'use strict';
// Pre-rename deployments set NOCTRA_* variables and keep a `noctra.db` file. Both keep working:
// a NOCTRA_X that is set while NATIVE_X is not is copied over, and the existing database file is
// reused if it is still called noctra.db. New installs only ever see the NATIVE_* / native.db names.
const fs = require('node:fs');
const path = require('node:path');

for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith('NOCTRA_')) continue;
  const next = `NATIVE_${key.slice('NOCTRA_'.length)}`;
  if (process.env[next] === undefined) process.env[next] = value;
}

/** `<dir>/native.db`, unless only the pre-rename `<dir>/noctra.db` exists. */
function resolveDbPath(dir) {
  const current = path.join(dir, 'native.db');
  const legacy = path.join(dir, 'noctra.db');
  return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current;
}

module.exports = { resolveDbPath };
