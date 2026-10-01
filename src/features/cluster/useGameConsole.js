import { useCallback, useEffect, useRef, useState } from 'react';

const MAX_LINES = 20000;
const EMPTY_META = { source: 'empty', running: false, startedAt: null, endedAt: null, exit: null, dropped: 0 };

/**
 * Live console for one instance. Lines live in a ref (20k rows would be
 * expensive to copy on every 120 ms batch); `version` bumps to re-render.
 */
export default function useGameConsole(instanceId) {
  const linesRef = useRef([]);
  const [version, setVersion] = useState(0);
  const [meta, setMeta] = useState(EMPTY_META);
  const [loading, setLoading] = useState(true);
  const startedRef = useRef(null);

  const load = useCallback(async () => {
    const api = window.native?.console;
    if (!api || !instanceId) {
      setLoading(false);
      return;
    }
    try {
      const data = await api.get(instanceId);
      linesRef.current = Array.isArray(data?.lines) ? data.lines.slice(-MAX_LINES) : [];
      startedRef.current = data?.startedAt || null;
      const { lines, ...rest } = data || {};
      setMeta({ ...EMPTY_META, ...rest });
    } catch {
      linesRef.current = [];
      setMeta(EMPTY_META);
    } finally {
      setLoading(false);
      setVersion((v) => v + 1);
    }
  }, [instanceId]);

  useEffect(() => {
    setLoading(true);
    load();
    const api = window.native?.console;
    if (!api) return undefined;
    const offLines = api.onLines?.(({ instanceId: id, lines }) => {
      if (id !== instanceId || !lines?.length) return;
      const list = linesRef.current;
      // Ignore a replayed batch we already fetched.
      const last = list.length ? list[list.length - 1].n : 0;
      const fresh = startedRef.current ? lines.filter((line) => line.n > last) : lines;
      if (!fresh.length) return;
      list.push(...fresh);
      if (list.length > MAX_LINES) list.splice(0, list.length - MAX_LINES);
      setVersion((v) => v + 1);
    });
    const offSession = api.onSession?.((session) => {
      if (session?.instanceId !== instanceId) return;
      if (session.startedAt !== startedRef.current || session.source !== 'live') {
        // A new launch: start from a clean buffer.
        startedRef.current = session.startedAt;
        linesRef.current = [];
        setVersion((v) => v + 1);
      } else if ((session.counts && Object.values(session.counts).every((c) => !c)) && linesRef.current.length) {
        linesRef.current = []; // cleared
        setVersion((v) => v + 1);
      }
      setMeta({ ...EMPTY_META, ...session, source: 'live' });
    });
    return () => {
      offLines?.();
      offSession?.();
    };
  }, [instanceId, load]);

  const clear = useCallback(async () => {
    linesRef.current = [];
    setVersion((v) => v + 1);
    await window.native?.console?.clear?.(instanceId);
  }, [instanceId]);

  return { lines: linesRef.current, version, meta, loading, reload: load, clear };
}
