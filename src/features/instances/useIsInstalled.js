import { useEffect, useState } from 'react';

/**
 * True when the instance's client jar is on disk.
 *
 * Optimistic: assumes installed in a plain browser and when the check fails, so
 * a working Launch button is never replaced by Install on a bad reading.
 *
 * Pass the launcher status as `settleKey`. The check re-runs whenever it
 * changes, so finishing an install flips the button from Install to Launch
 * without needing an app restart.
 */
// Last answer per version+loader, so revisiting an instance shows the right button instantly.
const known = new Map();
// While a launch is running the answer can't change for the better, and each check is a synchronous disk
// scan in the main process (which is busy starting the game), so it waits until the launch settles.
const BUSY = new Set(['preparing', 'downloading', 'verifying', 'launching', 'stopping']);

export default function useIsInstalled(instance, settleKey) {
  const version = instance?.mc_version || instance?.version;
  const loader = instance?.mc_loader || instance?.loader || 'Vanilla';
  const key = `${version}:${loader}`;
  const [installed, setInstalled] = useState(() => known.get(key) ?? true);
  const settle = BUSY.has(settleKey) ? 'busy' : settleKey;

  useEffect(() => {
    if (!version) {
      setInstalled(false);
      return undefined;
    }
    if (settle === 'busy') return undefined;
    // Do not flash an Install action while the main process checks the disk.
    // A negative result will replace this optimistic state immediately.
    setInstalled(known.get(key) ?? true);
    const api = window.native?.instance;
    if (!api) {
      // Browser previews cannot inspect the desktop installation.
      return undefined;
    }

    let cancelled = false;
    api
      .isInstalled(version, loader)
      .then((result) => {
        known.set(key, Boolean(result));
        if (!cancelled) setInstalled(Boolean(result));
      })
      .catch(() => {
        // A transient IPC failure should not tell an existing user to reinstall.
        if (!cancelled) setInstalled(true);
      });

    return () => {
      cancelled = true;
    };
  }, [version, loader, settle]); // eslint-disable-line react-hooks/exhaustive-deps

  return installed;
}
