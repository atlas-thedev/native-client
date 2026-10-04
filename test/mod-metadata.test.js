const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');
const { enrichFolder, readJarMetadata, CACHE_FILE } = require('../electron/modMetadata');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function makeJar(file, files) {
  const zip = new AdmZip();
  for (const [name, data] of Object.entries(files)) zip.addFile(name, Buffer.from(data));
  zip.writeZip(file);
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-meta-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('reads title, author and logo from a fabric jar', (t) => {
  const dir = fixture(t);
  const jar = path.join(dir, 'local.jar');
  makeJar(jar, {
    'fabric.mod.json': JSON.stringify({ id: 'local', name: 'Local Mod', version: '1.2.3', authors: ['Ada'], icon: 'assets/icon.png' }),
    'assets/icon.png': PNG
  });
  const meta = readJarMetadata(jar);
  assert.equal(meta.title, 'Local Mod');
  assert.equal(meta.author, 'Ada');
  assert.equal(meta.version, '1.2.3');
  assert.match(meta.iconUrl, /^data:image\/png;base64,/);
});

test('prefers Modrinth data by hash and caches it across renames', async (t) => {
  const dir = fixture(t);
  const jar = path.join(dir, 'sodium.jar');
  makeJar(jar, { 'fabric.mod.json': JSON.stringify({ id: 'x', name: 'From Jar' }) });
  const sha1 = crypto.createHash('sha1').update(fs.readFileSync(jar)).digest('hex');

  let calls = 0;
  const fetchImpl = async (url, options = {}) => {
    calls += 1;
    const body = (value) => ({ ok: true, json: async () => value });
    if (url.endsWith('/version_files')) return body({ [sha1]: { project_id: 'P1', version_number: '0.6.0' } });
    if (url.includes('/projects?')) return body([{ id: 'P1', title: 'Sodium', icon_url: 'https://cdn/sodium.png', team: 'T1' }]);
    if (url.includes('/teams?')) return body([[{ team_id: 'T1', role: 'Owner', user: { username: 'jellysquid' } }]]);
    throw new Error('unexpected ' + url);
  };

  const first = await enrichFolder(dir, { fetchImpl });
  assert.equal(first['sodium.jar'].title, 'Sodium');
  assert.equal(first['sodium.jar'].iconUrl, 'https://cdn/sodium.png');
  assert.equal(first['sodium.jar'].author, 'jellysquid');
  assert.equal(calls, 3);
  assert.ok(fs.existsSync(path.join(dir, CACHE_FILE)));

  // disabling renames the file; the hash is unchanged so no new lookups happen
  fs.renameSync(jar, `${jar}.disabled`);
  const second = await enrichFolder(dir, { fetchImpl });
  assert.equal(second['sodium.jar.disabled'].title, 'Sodium');
  assert.equal(calls, 3);
});

test('falls back to the jar when offline and does not cache the miss', async (t) => {
  const dir = fixture(t);
  makeJar(path.join(dir, 'a.jar'), { 'fabric.mod.json': JSON.stringify({ id: 'a', name: 'Offline Mod' }) });
  const offline = async () => { throw new Error('offline'); };
  const result = await enrichFolder(dir, { fetchImpl: offline });
  assert.equal(result['a.jar'].title, 'Offline Mod');
  const cache = JSON.parse(fs.readFileSync(path.join(dir, CACHE_FILE), 'utf8'));
  assert.deepEqual(cache.byHash, {});
});
