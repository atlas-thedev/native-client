'use strict';
// Swaps the SignPath-signed NSIS installer into release/ and rebuilds its blockmap + latest.yml hashes.
// Usage: node scripts/finalize-signed-installer.js <signed-dir> <release-dir>
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');

const sha512 = (file) => crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');

async function main() {
  const [signedDir, releaseDir] = process.argv.slice(2);
  if (!signedDir || !releaseDir) throw new Error('Usage: finalize-signed-installer.js <signed-dir> <release-dir>');
  const feed = path.join(releaseDir, 'latest.yml');
  if (!fs.existsSync(feed)) throw new Error(`${feed} not found`);
  const signed = fs.readdirSync(signedDir).filter((f) => /^Native-Client-Setup-.*\.exe$/.test(f));
  if (signed.length !== 1) throw new Error(`Expected one signed installer in ${signedDir}, found ${signed.length}`);

  const name = signed[0];
  const target = path.join(releaseDir, name);
  const oldHash = sha512(target);
  const oldSize = fs.statSync(target).size;

  fs.copyFileSync(path.join(signedDir, name), target);
  const info = await buildBlockMap(target, 'gzip', `${target}.blockmap`);
  if (info.sha512 === oldHash) throw new Error('Signed installer is identical to the unsigned one');

  let yml = fs.readFileSync(feed, 'utf8');
  if (!yml.includes(oldHash)) throw new Error('latest.yml does not reference the unsigned installer hash');
  yml = yml.split(oldHash).join(info.sha512).split(`size: ${oldSize}`).join(`size: ${info.size}`);
  fs.writeFileSync(feed, yml);
  console.log(`Signed ${name}: size ${oldSize} -> ${info.size}, latest.yml + blockmap updated`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
