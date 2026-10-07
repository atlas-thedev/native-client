#!/usr/bin/env node
//
// Bump the version in package.json. Runs before every packaged build so each
// artifact gets a unique version (GitHub rejects re-uploads to an existing tag).
//
//   node scripts/bump-version.js          # 0.1.0 -> 0.1.1
//   node scripts/bump-version.js minor    # 0.1.0 -> 0.2.0
//   node scripts/bump-version.js major    # 0.1.0 -> 1.0.0
//   node scripts/bump-version.js beta     # 4.2.11 -> 4.2.12-beta.1 (beta testers only)
//
// Set NO_BUMP=1 to skip, e.g. when rebuilding a version that failed to upload.

const fs = require('fs');
const path = require('path');
const { nextVersion } = require('./next-version');

const release = process.argv[2] || 'patch';
if (!['major', 'minor', 'patch', 'beta'].includes(release)) {
  console.error(`error: expected major|minor|patch|beta, got "${release}"`);
  process.exit(1);
}

const file = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));

if (process.env.NO_BUMP) {
  console.log(`version -> ${pkg.version} (NO_BUMP set, not bumping)`);
  process.exit(0);
}

let next;
try {
  next = nextVersion(pkg.version, release);
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}

const previous = pkg.version;
pkg.version = next;
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');

console.log(`bumped version ${previous} -> ${pkg.version}`);
