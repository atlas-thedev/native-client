import { useEffect, useRef } from 'react';

/**
 * Applies finished play sessions to their instances.
 *
 * The clock itself runs in the launcher's main process (electron/playtime.js), so it keeps counting
 * when this window is closed or reloaded. Finished sessions wait in a queue on disk; this hook takes
 * them as soon as the instance list has loaded (and whenever a new one arrives), hands them to
 * `onSession`, and the instance store acknowledges them only after instances.json is saved.
 *
 * @param onSession - called with (instanceId, seconds, meta) for each session.
 * @param ready     - true once the saved instances are loaded (applying earlier would be overwritten).
 */
export default function usePlaytimeTracker(onSession, { ready = true } = {}) {
  const handler = useRef(onSession);
  handler.current = onSession;

  useEffect(() => {
    const api = window.native?.playtime;
    if (!api || !ready) return undefined;
    let alive = true;
    const seen = new Set();

    const drain = async () => {
      let sessions = [];
      try { sessions = (await api.drain()) || []; } catch { return; }
      if (!alive) return;
      for (const session of sessions) {
        if (!session?.id || seen.has(session.id)) continue;
        seen.add(session.id);
        handler.current?.(session.instanceId, session.secs, {
          id: session.id,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          crashed: session.crashed,
          recovered: session.recovered
        });
      }
    };

    drain();
    const off = api.onSession?.(drain);
    return () => {
      alive = false;
      off?.();
    };
  }, [ready]);
}
