import { useEffect, useRef } from 'react';
import { MAX_SESSION_SECS, MIN_SESSION_SECS } from './playtimeStats.js';

const PENDING_KEY = 'native.playtime.pending';
const LEGACY_PENDING_KEY = 'native.playtime.pending';

/* Launcher statuses that mean the Minecraft process is actually alive. */
const RUNNING = new Set(['running', 'game-running']);
/* Statuses that mean it is not. 'error' during install never opened the game. */
const STOPPED = new Set(['idle', 'stopped', 'exited', 'closed', 'error']);

function readPending() {
  try {
    const raw = localStorage.getItem(PENDING_KEY) || localStorage.getItem(LEGACY_PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.instanceId || !parsed?.startedAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writePending(value) {
  try {
    if (value) localStorage.setItem(PENDING_KEY, JSON.stringify(value));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    /* storage disabled; tracking degrades to in-memory only */
  }
}

/**
 * Records real play sessions.
 *
 * The session clock starts when the launcher reports the game process running
 * and stops when it reports it gone, so downloads, verification and failed
 * launches are never counted as playtime.
 *
 * The open session is mirrored into localStorage on every tick. If the client
 * is killed or the machine loses power mid-session, the next start credits the
 * elapsed time and flags it as recovered instead of losing the session.
 *
 * @param onSession - called with (instanceId, seconds, meta) for each session.
 */
export default function usePlaytimeTracker(onSession, { launcherState } = {}) {
  const handler = useRef(onSession);
  const active = useRef(null);
  const heartbeat = useRef(null);

  handler.current = onSession;

  const commit = (session, { crashed = false, recovered = false } = {}) => {
    if (!session?.instanceId || !session?.startedAt) return;
    const endedAt = Math.min(Date.now(), session.startedAt + MAX_SESSION_SECS * 1000);
    const secs = Math.round((endedAt - session.startedAt) / 1000);
    writePending(null);
    active.current = null;
    clearInterval(heartbeat.current);
    if (secs < MIN_SESSION_SECS) return;
    handler.current?.(session.instanceId, secs, { startedAt: session.startedAt, endedAt, crashed, recovered });
  };

  const start = (instanceId) => {
    if (!instanceId || active.current?.instanceId === instanceId) return;
    if (active.current) commit(active.current, { crashed: true });

    const session = { instanceId, startedAt: Date.now() };
    active.current = session;
    writePending(session);

    // Refresh the mirror so a hard crash loses at most one interval.
    clearInterval(heartbeat.current);
    heartbeat.current = setInterval(() => {
      if (active.current) writePending({ ...active.current, seenAt: Date.now() });
    }, 30000);
  };

  /* Recover a session that never got to close itself. */
  useEffect(() => {
    const pending = readPending();
    if (!pending) return;
    // Credit up to the last heartbeat: time after it was never observed.
    const endedAt = pending.seenAt || pending.startedAt;
    const secs = Math.round((endedAt - pending.startedAt) / 1000);
    writePending(null);
    if (secs >= MIN_SESSION_SECS) {
      handler.current?.(pending.instanceId, Math.min(secs, MAX_SESSION_SECS), {
        startedAt: pending.startedAt,
        endedAt,
        crashed: true,
        recovered: true
      });
    }
  }, []);

  /* Prefer the main-process signal when the preload exposes one. */
  useEffect(() => {
    const api = window.native?.launcher;
    if (!api?.onState) return undefined;

    const off = api.onState((payload) => {
      const status = payload?.status;
      const instanceId = payload?.instanceId || payload?.instance?.id || active.current?.instanceId;
      if (RUNNING.has(status)) start(instanceId);
      else if (STOPPED.has(status) && active.current) commit(active.current);
    });

    return () => {
      off?.();
    };
  }, []);

  /* Fallback for builds whose launcher state only reaches the renderer hook. */
  useEffect(() => {
    if (!launcherState) return;
    const status = launcherState.status;
    const instanceId = launcherState.instanceId || launcherState.instance?.id;
    if (RUNNING.has(status)) start(instanceId);
    else if (STOPPED.has(status) && active.current) commit(active.current);
  }, [launcherState?.status, launcherState?.instanceId]);

  /* Quitting the client while the game runs still banks the time. */
  useEffect(() => {
    const flush = () => {
      if (active.current) commit(active.current, { crashed: true });
    };
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      clearInterval(heartbeat.current);
    };
  }, []);
}
