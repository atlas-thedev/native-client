'use strict';
// Pre-rename setups may still define NOCTRA_* variables: copy each one to its NATIVE_* name
// when that is not set, so existing environments keep working.
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith('NOCTRA_')) continue;
  const next = `NATIVE_${key.slice('NOCTRA_'.length)}`;
  if (process.env[next] === undefined) process.env[next] = value;
}

// Hash game assets a few at a time (with a size/mtime cache) so verifying doesn't freeze the PC.
require('./assetVerify');
