#!/usr/bin/env node
//
// Print a version without touching any files. Used by release.bat for the preview.
//
//   node scripts/next-version.js            # current version
//   node scripts/next-version.js patch      # 3.10.0 -> 3.10.1
//   node scripts/next-version.js minor      # 3.10.0 -> 3.11.0
//   node scripts/next-version.js major      # 3.10.0 -> 4.0.0

const fs = require('fs');
const path = require('path');

const kind = process.argv[2] || 'none';
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version);
if (!m) {
  console.error(`package.json version "${pkg.version}" is not x.y.z`);
  process.exit(1);
}
let [major, minor, patch] = m.slice(1).map(Number);
if (kind === 'major') [major, minor, patch] = [major + 1, 0, 0];
else if (kind === 'minor') [minor, patch] = [minor + 1, 0];
else if (kind === 'patch') patch += 1;
console.log(`${major}.${minor}.${patch}`);
