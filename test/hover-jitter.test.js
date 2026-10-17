'use strict';
/* A card that moves when hovered slides out from under a cursor resting on its edge, loses the hover, moves back and
   shakes, many times a second (cloak cards in the Store and Locker did). Hover effects may move what is inside a
   card, never the hovered element itself. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FILES = ['src/features/store/StoreView.css', 'src/features/store/BundleViews.css', 'src/features/skins/LockerView.css',
  'src/features/skins/LockerLocal.css', 'src/styles/locker-store.css'];

test('hovered store and locker elements never move themselves', () => {
  const offenders = [];
  for (const file of FILES) {
    const css = fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    // reduced-motion blocks only ever switch movement off
    const plain = css.replace(/@media\s*\(prefers-reduced-motion[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '');
    for (const [, selectors, body] of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/\btranslate|translate[XY]?\(/.test(body)) continue;
      for (const selector of selectors.split(',').map((s) => s.trim())) {
        // the hovered element itself: ":hover" in the last part of the selector
        const last = selector.split(/\s+|>/).filter(Boolean).pop() || '';
        if (/:hover/.test(last) && !/(arrow|zoom)/.test(last)) offenders.push(`${file}: ${selector}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
