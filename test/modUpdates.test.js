const test = require('node:test');
const assert = require('node:assert/strict');

require('./electron-stub');
const mu = require('../electron/modUpdates');

test('Fabric version ranges are evaluated', () => {
  assert.equal(mu.matchesRange('1.2.3', '*'), true);
  assert.equal(mu.matchesRange('1.2.3', '>=1.2.0 <2.0.0'), true);
  assert.equal(mu.matchesRange('2.0.1', '>=1.2.0 <2.0.0'), false);
  assert.equal(mu.matchesRange('0.5.11+mc1.21', '<0.6'), true);
  assert.equal(mu.matchesRange('1.4.0', '^1.2'), true);
  assert.equal(mu.matchesRange('2.0.0', '^1.2'), false);
  assert.equal(mu.matchesRange('1.2.9', '1.2.x'), true);
  assert.equal(mu.matchesRange('1.0', '<0.5 || >=1.0'), true);
  assert.equal(mu.matchesRange('', '>=1'), null);
});

test('Modrinth loader tags follow loader compatibility', () => {
  assert.deepEqual(mu.modrinthLoaders('Quilt', '1.21.1'), ['quilt', 'fabric']);
  assert.deepEqual(mu.modrinthLoaders('NeoForge', '1.20.1'), ['neoforge', 'forge']);
  assert.deepEqual(mu.modrinthLoaders('NeoForge', '1.21.1'), ['neoforge']);
  assert.deepEqual(mu.modrinthLoaders('Legacy Fabric', '1.8.9'), ['legacy-fabric', 'fabric']);
});

test('local checks find duplicates, breaks, missing mods and wrong loaders', () => {
  const mods = [
    { file: 'sodium-0.5.jar', id: 'sodium', ids: ['sodium'], name: 'Sodium', version: '0.5.11', loader: 'fabric', platforms: ['fabric'], depends: { minecraft: '*', fabricloader: '*' }, breaks: {} },
    { file: 'sodium-0.6.jar', id: 'sodium', ids: ['sodium'], name: 'Sodium', version: '0.6.5', loader: 'fabric', platforms: ['fabric'], depends: {}, breaks: {} },
    { file: 'optifabric.jar', id: 'optifabric', ids: ['optifabric'], name: 'OptiFabric', version: '1.0', loader: 'fabric', platforms: ['fabric'], depends: {}, breaks: { sodium: '*' } },
    { file: 'modmenu.jar', id: 'modmenu', ids: ['modmenu', 'fabric-api-base'], name: 'Mod Menu', version: '11', loader: 'fabric', platforms: ['fabric'], depends: { 'fabric-language-kotlin': '*', 'fabric-api-base': '*' }, breaks: {} },
    { file: 'jei.jar', id: 'jei', ids: ['jei'], name: 'JEI', version: '19', loader: 'forge', platforms: ['forge'], depends: {}, breaks: {} }
  ];
  const problems = mu.localProblems(mods, { loader: 'Fabric', mcVersion: '1.21.1' });
  const kinds = problems.map((p) => p.kind).sort();
  assert.deepEqual(kinds, ['breaks', 'duplicate', 'missing', 'wrong-loader']);
  const dup = problems.find((p) => p.kind === 'duplicate');
  assert.deepEqual(dup.fix.files, ['sodium-0.5.jar']);
  assert.equal(problems.find((p) => p.kind === 'missing').missingId, 'fabric-language-kotlin');
});
