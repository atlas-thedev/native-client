'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'native-search-'));
process.env.NATIVE_DATA_DIR = DATA_DIR;
process.env.NATIVE_DB_PATH = path.join(DATA_DIR, 'native.db');

const db = require('../server/db');
const profiles = require('../server/profiles-routes');

test.after(() => { try { db.closeDb(); } catch {} fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

test('search: names match anywhere, best match first, underscores are literal', () => {
  for (const name of ['Natla', 'Atlas', 'atlas_dev', 'atlasXdev', 'Bob']) {
    db.createUser({ email: `${name.toLowerCase()}@example.com`, username: name, password: 'correct horse battery' });
  }
  profiles.setHooks({ allItems: () => [{ id: 'a', name: 'Royal Crown' }, { id: 'b', name: 'Crown Jewel' }, { id: 'c', name: 'Hidden Crown', hidden: true }] });
  const names = (q) => profiles._internals.search(q).players.map((p) => p.name);
  const atlas = names('atlas');
  assert.equal(atlas[0], 'Atlas'); // exact first
  assert.deepEqual(atlas.slice(1).sort(), ['atlasXdev', 'atlas_dev']);
  assert.ok(!atlas.includes('Natla'));
  assert.ok(names('tla').includes('Natla'));
  assert.deepEqual(names('atlas_'), ['atlas_dev']); // "_" is not a wildcard
  assert.deepEqual(names('%'), []);
  assert.deepEqual(profiles._internals.search('crown').items.map((i) => i.name), ['Crown Jewel', 'Royal Crown']);
});
