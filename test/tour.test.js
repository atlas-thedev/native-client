const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('quick tour: every step has a motion scene that exists', () => {
  const tour = read('src/features/shell/WelcomeTour.jsx');
  const scenes = read('src/features/shell/TourScenes.jsx');
  const stepScenes = [...tour.matchAll(/scene: '([a-z]+)'/g)].map((m) => m[1]);
  const block = scenes.slice(scenes.indexOf('const SCENES = {'), scenes.indexOf('};', scenes.indexOf('const SCENES = {')));
  const defined = new Set([...block.matchAll(/^\s+([a-z]+):/gm)].map((m) => m[1]));
  assert.ok(stepScenes.length >= 10, 'tour has its steps');
  for (const name of stepScenes) assert.ok(defined.has(name), `scene "${name}" is defined`);
});

test('quick tour: motion respects reduced-motion settings and never animates "all"', () => {
  const css = read('src/features/shell/WelcomeTour.css');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /data-motion='reduced'\] \.welcome-tour \*/);
  assert.doesNotMatch(css, /transition:\s*all\b/);
});

test('quick tour: keyboard, focus and dialog semantics are wired', () => {
  const tour = read('src/features/shell/WelcomeTour.jsx');
  assert.match(tour, /role="dialog"/);
  assert.match(tour, /aria-modal="true"/);
  assert.match(tour, /aria-live="polite"/);
  for (const key of ['Escape', 'ArrowLeft', 'ArrowRight', 'Tab']) assert.ok(tour.includes(`'${key}'`), `${key} handled`);
});
