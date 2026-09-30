import { useCallback, useEffect, useState } from 'react';

/**
 * Crash reports pushed from the main process. Opens the report as soon as a
 * crash is detected (with an "analyzing" state first) and lets any screen
 * reopen a stored report by id.
 */
export default function useCrashReports() {
  const [state, setState] = useState({ open: false, analyzing: null, record: null, error: null });

  useEffect(() => {
    const api = window.native?.crash;
    if (!api) return undefined;
    const offAnalyzing = api.onAnalyzing((payload) => {
      setState({ open: true, analyzing: payload, record: null, error: null });
    });
    const offDetected = api.onDetected((record) => {
      if (!record?.id) {
        setState({ open: true, analyzing: null, record: null, error: record?.error || 'The crash could not be analyzed.' });
        return;
      }
      setState({ open: true, analyzing: null, record, error: null });
    });
    return () => {
      offAnalyzing();
      offDetected();
    };
  }, []);

  const openReport = useCallback(async (id) => {
    const api = window.native?.crash;
    if (!api || !id) return;
    try {
      const record = await api.get(id);
      setState({ open: true, analyzing: null, record, error: null });
    } catch (error) {
      setState({ open: true, analyzing: null, record: null, error: error?.message || String(error) });
    }
  }, []);

  const analyzeInstance = useCallback(async (instance) => {
    const api = window.native?.crash;
    if (!api || !instance) return;
    setState({ open: true, analyzing: { instance, at: Date.now() }, record: null, error: null });
    try {
      const record = await api.analyzeInstance(instance);
      setState({ open: true, analyzing: null, record, error: null });
    } catch (error) {
      setState({ open: true, analyzing: null, record: null, error: error?.message || String(error) });
    }
  }, []);

  const showRecord = useCallback((record) => setState({ open: true, analyzing: null, record, error: null }), []);
  const close = useCallback(() => setState((prev) => ({ ...prev, open: false })), []);

  return { ...state, openReport, analyzeInstance, showRecord, close };
}
