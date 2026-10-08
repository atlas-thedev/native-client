import { useEffect, useRef, useState } from 'react';

// A tiny, no-cors reachability probe. Google's generate_204 endpoint returns an
// empty 204 and is one of the most reliable connectivity checks on the web; in
// no-cors mode we can't read the response, but the fetch *resolving* means the
// request reached a server, which is all we need. The renderer already performs
// external fetches directly (Modrinth, GitHub, mclo.gs…), so there is no CSP in
// the way of this probe.
// Several independent endpoints: one slow or blocked host must not make the
// launcher claim it is offline. Any single answer proves the internet works.
const PROBE_URLS = [
  'https://www.gstatic.com/generate_204',
  'https://api.playnative.fun/',
  'https://api.modrinth.com/',
  'https://cloudflare.com/cdn-cgi/trace'
];
const PROBE_TIMEOUT = 8000;
// A single failed round is usually a blip; only report trouble after this many in a row.
const FAILURES_BEFORE_DEGRADED = 2;
// Poll gently while healthy, and more eagerly while we're trying to recover so
// the indicator clears quickly once the connection comes back.
const STEADY_INTERVAL = 30000;
const RETRY_INTERVAL = 6000;

function readNavigatorOnline() {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}

async function probeOne(url) {
  await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(PROBE_TIMEOUT) });
  return true;
}

async function probeReachable() {
  try {
    return await Promise.any(PROBE_URLS.map(probeOne));
  } catch {
    return false;
  }
}

/**
 * Launcher-wide connectivity signal.
 *
 * Combines the browser's own `navigator.onLine` flag (and its online/offline
 * events) with an active reachability probe, because `navigator.onLine` alone
 * only knows whether an interface is up — not whether the internet is actually
 * reachable. Returns `{ status }` where status is:
 *   - `online`   — interface up and the probe succeeded
 *   - `degraded` — interface reports up but the probe failed (DNS / captive
 *                  portal / dead link)
 *   - `offline`  — the browser reports no connection
 */
export default function useNetwork() {
  const [status, setStatus] = useState(() => ({
    online: readNavigatorOnline(),
    reachable: true,
    state: readNavigatorOnline() ? 'online' : 'offline',
    checkedAt: 0
  }));
  const forceRef = useRef(() => {});
  const failuresRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    let running = false;

    const evaluate = async () => {
      if (running) return;
      running = true;
      const online = readNavigatorOnline();
      const probed = online ? await probeReachable() : false;
      running = false;
      if (cancelled) return;
      failuresRef.current = probed ? 0 : failuresRef.current + 1;
      // Don't flash "connection problem" for one missed probe.
      const reachable = probed || (online && failuresRef.current < FAILURES_BEFORE_DEGRADED);
      const state = !online ? 'offline' : reachable ? 'online' : 'degraded';
      setStatus({ online, reachable, state, checkedAt: Date.now() });
      if (timer) clearTimeout(timer);
      timer = setTimeout(evaluate, state === 'online' && probed ? STEADY_INTERVAL : RETRY_INTERVAL);
    };

    forceRef.current = evaluate;
    evaluate();

    const handleOnline = () => evaluate();
    const handleOffline = () => {
      if (cancelled) return;
      setStatus({ online: false, reachable: false, state: 'offline', checkedAt: Date.now() });
      if (timer) clearTimeout(timer);
      timer = setTimeout(evaluate, RETRY_INTERVAL);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return { status, refresh: () => forceRef.current?.() };
}
