'use strict';
process.env.NATIVE_DATA_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'native-dirplus-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const mod = require('../server/mod-routes');

const HASH = 'a'.repeat(64);

test('Native+ members carry the plus flag in the skin directory, others do not', () => {
  const users = {
    plusy: { username: 'Plusy', badges: JSON.stringify(['early_supporter', 'plus']) },
    plain: { username: 'Plain', badges: JSON.stringify(['early_supporter']) },
    nobadges: { username: 'NoBadges', badges: null }
  };
  db.getUserByUsername = (name) => users[String(name).toLowerCase()] || null;
  const entry = (name) => mod._internals.entryFor({ username: name, skin: HASH, model: 'default', updatedAt: new Date().toISOString() });
  assert.equal(entry('Plusy').x, 1);
  assert.equal('x' in entry('Plain'), false);
  assert.equal('x' in entry('NoBadges'), false);
});

test('a malformed badge list never breaks the directory', () => {
  db.getUserByUsername = () => ({ username: 'Broken', badges: '{not json' });
  const e = mod._internals.entryFor({ username: 'Broken', skin: HASH, model: 'default', updatedAt: new Date().toISOString() });
  assert.equal(e.n, 'Broken');
  assert.equal('x' in e, false);
});
