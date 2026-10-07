#!/usr/bin/env node
//
// Print a version without touching any files. Used by release.bat for the preview.
//
//   node scripts/next-version.js            # current version
//   node scripts/next-version.js patch      # 3.10.0 -> 3.10.1   (4.3.0-beta.2 -> 4.3.0)
//   node scripts/next-version.js minor      # 3.10.0 -> 3.11.0
//   node scripts/next-version.js major      # 3.10.0 -> 4.0.0
//   node scripts/next-version.js beta       # 4.2.11 -> 4.2.12-beta.1, 4.2.12-beta.1 -> 4.2.12-beta.2
//
// Beta builds (x.y.z-beta.N) are published as GitHub pre-releases and only reach
// beta testers. Releasing patch/minor/major from a beta finishes that version.

const fs = require('fs');
const path = require('path');

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/;

function nextVersion(current, kind = 'none') {
  const m = VERSION_RE.exec(String(current));
  if (!m) throw new Error(`version "${current}" is not x.y.z or x.y.z-beta.N`);
  let [major, minor, patch] = m.slice(1, 4).map(Number);
  const beta = m[4] === undefined ? null : Number(m[4]);
  const core = () => `${major}.${minor}.${patch}`;
  switch (kind) {
    case 'none':
      return String(current);
    case 'beta':
      if (beta !== null) return `${core()}-beta.${beta + 1}`;
      patch += 1;
      return `${core()}-beta.1`;
    case 'patch':
      if (beta !== null) return core(); // finish the beta'd version
      patch += 1;
      return core();
    case 'minor':
      if (beta !== null && patch === 0) return core();
      [minor, patch] = [minor + 1, 0];
      return core();
    case 'major':
      if (beta !== null && minor === 0 && patch === 0) return core();
      [major, minor, patch] = [major + 1, 0, 0];
      return core();
    default:
      throw new Error(`expected none|patch|minor|major|beta, got "${kind}"`);
  }
}

module.exports = { nextVersion, VERSION_RE };

if (require.main === module) {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  try {
    console.log(nextVersion(pkg.version, process.argv[2] || 'none'));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
