// One-time rename of the pre-rename browser-storage keys (noctra.* -> native.*).
// Imported first in main.jsx so every module sees the new keys. The old key held the live data,
// so it wins over any stale native.* copy; the old key is removed afterwards.
const LEGACY_PREFIX = 'noctra.';
const LEGACY_KEYS = { noctra_relay_store_v5: 'native_relay_store_v5' };

try {
  const store = window.localStorage;
  const moves = [];
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (!key) continue;
    if (key.startsWith(LEGACY_PREFIX)) moves.push([key, `native.${key.slice(LEGACY_PREFIX.length)}`]);
    else if (LEGACY_KEYS[key]) moves.push([key, LEGACY_KEYS[key]]);
  }
  for (const [from, to] of moves) {
    const value = store.getItem(from);
    if (value !== null) store.setItem(to, value);
    store.removeItem(from);
  }
  // The "play as" choice stored the identity name; it was 'noctra' before the rename.
  const playAs = store.getItem('native.play-as.v1');
  if (playAs && playAs.includes('"noctra"')) store.setItem('native.play-as.v1', playAs.replace(/"noctra"/g, '"native"'));
} catch {
  /* storage unavailable: nothing to migrate */
}
