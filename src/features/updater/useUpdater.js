import { useCallback, useEffect, useState } from 'react';

const INITIAL_STATUS = {
  type: window.native?.updater ? 'idle' : 'disabled',
  currentVersion: window.native?.version ?? null,
  message: window.native?.updater ? null : 'Updates are available in the desktop app.'
};

export default function useUpdater() {
  const [status, setStatus] = useState(INITIAL_STATUS);

  useEffect(() => {
    const updater = window.native?.updater;
    if (!updater) return undefined;

    // Subscribe before reading the snapshot so an event cannot be lost between
    // the initial IPC request and listener registration.
    const unsubscribe = updater.onStatus(setStatus);
    updater.status()
      .then((snapshot) => snapshot && setStatus(snapshot))
      .catch(() => {});
    return unsubscribe;
  }, []);

  const check = useCallback(() => window.native?.updater?.check(), []);
  const download = useCallback(() => window.native?.updater?.download(), []);
  const cancel = useCallback(() => window.native?.updater?.cancel(), []);
  const pause = useCallback(() => (window.native?.updater?.pause ?? window.native?.updater?.cancel)?.(), []);
  const install = useCallback(() => window.native?.updater?.install(), []);

  return { status, check, download, cancel, pause, install };
}
