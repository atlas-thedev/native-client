import { useCallback, useEffect, useRef, useState } from 'react';
import { getClusterArt } from '../../data/versionsData.js';
import {
  EMPTY_STATS,
  SEEDED_INSTANCE_IDS,
  STATS_VERSION,
  applySession,
  normalizeStats,
  summarizeLibrary
} from './playtimeStats.js';

const STORAGE_KEY = 'noctra.instances';
const LEGACY_STORAGE_KEYS = ['native.instances', 'oneclient.instances'];

/* The library starts empty. Instances are only ever created by the user or by
   an import, so nothing on the instance page is invented. */
const DEFAULT_DATA = { instances: [], selectedId: null };

function newInstanceId() {
  // Date.now() alone collided when two instances were created in the same ms
  // (e.g. importing a modpack), which silently broke selection.
  return `noctra-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Always pass saved artwork through the resolver (it replaces stale Vite file
 * URLs from another build) and normalise the statistics.
 *
 * Older builds shipped demo clusters with hand-written playtime, session and
 * active-day counts. Those instances are reset to zero here, once, so the page
 * only ever shows time that was really recorded.
 */
function hydrate(instance) {
  const seededFake =
    SEEDED_INSTANCE_IDS.has(instance?.id) && Number(instance?.statsVersion) < STATS_VERSION;

  const stats = seededFake ? { ...EMPTY_STATS } : normalizeStats(instance);

  return {
    ...instance,
    ...stats,
    // serverJoins was never measured; keep it only if a real counter set it.
    serverJoins: Number(instance?.statsVersion) >= STATS_VERSION ? instance.serverJoins || 0 : 0,
    art: getClusterArt(instance)
  };
}

function normalizeSaved(saved) {
  if (!saved?.instances?.length) return null;
  const instances = saved.instances.map(hydrate);
  return { instances, selectedId: saved.selectedId || instances[0]?.id || null };
}

async function loadData() {
  if (window.native?.instances) {
    const saved = await window.native.instances.load();
    return normalizeSaved(saved) || DEFAULT_DATA;
  }

  // Browser / dev fallback. Migrate the pre-rebrand keys if they're still around.
  for (const key of [STORAGE_KEY, ...LEGACY_STORAGE_KEYS]) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      const parsed = normalizeSaved(JSON.parse(raw));
      if (parsed) {
        if (key !== STORAGE_KEY) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
          localStorage.removeItem(key);
        }
        return parsed;
      }
    } catch {
      /* corrupt payload, fall through */
    }
  }

  return DEFAULT_DATA;
}

function saveData(data) {
  if (window.native?.instances) {
    return window.native.instances.save(data);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  return Promise.resolve();
}

/** Drop undefined keys so partial form values can't clobber computed fields. */
function compact(values) {
  const result = {};
  Object.entries(values || {}).forEach(([key, value]) => {
    if (value !== undefined) result[key] = value;
  });
  return result;
}

/* Statistics are owned by the session recorder, never by a form or an import. */
const STAT_KEYS = [
  'playtimeSecs',
  'sessionCount',
  'avgSessionSecs',
  'longestSessionSecs',
  'lastSessionSecs',
  'crashCount',
  'activeDays',
  'playedDays',
  'sessions',
  'firstPlayed',
  'lastPlayed',
  'serverJoins',
  'statsVersion'
];

function stripStats(values) {
  const result = { ...values };
  STAT_KEYS.forEach((key) => delete result[key]);
  return result;
}

function buildInstance(values) {
  const input = compact(values);
  const version = input.version || input.mc_version || '1.21.1';
  const loader = input.loader || input.mc_loader || 'Fabric';
  const name = String(input.name || '').trim() || `${version} ${loader}`;

  const instance = {
    ...stripStats(input),
    id: input.id || newInstanceId(),
    name,
    version,
    mc_version: version,
    loader,
    mc_loader: loader,
    description: input.description || 'Custom Minecraft installation',
    tags: input.tags?.length ? input.tags : ['Custom'],
    group: input.group || null,
    icon: input.icon || null,
    memoryMb: input.memoryMb || null,
    created: input.created || Date.now(),
    serverJoins: 0,
    ...EMPTY_STATS
  };

  instance.art = input.art || getClusterArt(instance);
  return instance;
}

function loadInitialSync(initialData) {
  const fromProp = normalizeSaved(initialData);
  if (fromProp) return fromProp;

  if (window.native?.instances?.loadSync) {
    try {
      const saved = normalizeSaved(window.native.instances.loadSync());
      if (saved) return saved;
    } catch {}
  }

  for (const key of [STORAGE_KEY, ...LEGACY_STORAGE_KEYS]) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = normalizeSaved(JSON.parse(raw));
      if (parsed) return parsed;
    } catch {}
  }

  return DEFAULT_DATA;
}

export default function useInstances(initialData = null) {
  const [data, setData] = useState(() => loadInitialSync(initialData));
  const dataRef = useRef(data);
  dataRef.current = data;
  const [loaded, setLoaded] = useState(() => Boolean(initialData?.instances?.length));

  useEffect(() => {
    const parsed = normalizeSaved(initialData);
    if (!parsed) return;
    setData(parsed);
    setLoaded(true);
  }, [initialData]);

  useEffect(() => {
    let cancelled = false;
    loadData()
      .then((saved) => {
        if (!cancelled) setData(saved);
      })
      .catch((err) => console.error('Could not load instances:', err))
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    saveData(data).catch((err) => console.error('Could not save instances:', err));
  }, [data, loaded]);

  const selected =
    data.instances.find((item) => item.id === data.selectedId) ?? data.instances[0] ?? null;

  /**
   * Appends a real, completed session. Called by usePlaytimeTracker when the
   * game process exits, so every stat on the instance page traces back to a
   * launch that actually happened.
   */
  const recordSession = useCallback((id, durationSeconds, meta = {}) => {
    setData((current) => ({
      ...current,
      instances: current.instances.map((item) => {
        if (item.id !== id) return item;
        const next = applySession(normalizeStats(item), {
          secs: durationSeconds,
          startedAt: meta.startedAt,
          endedAt: meta.endedAt,
          crashed: meta.crashed,
          recovered: meta.recovered
        });
        return { ...item, ...next };
      })
    }));
  }, []);

  return {
    instances: data.instances,
    selected,
    selectedId: data.selectedId,
    loaded,
    totals: summarizeLibrary(data.instances),
    recordSession,

    select(id) {
      setData((current) => ({ ...current, selectedId: id }));
    },

    create(values) {
      const instance = buildInstance(values);
      setData((current) => ({
        ...current,
        instances: [...current.instances, instance],
        selectedId: instance.id
      }));
      return instance;
    },

    add(instance) {
      const hydrated = hydrate(buildInstance(instance));
      setData((current) => ({
        ...current,
        instances: [...current.instances, hydrated],
        selectedId: hydrated.id
      }));
      return hydrated;
    },

    duplicate(id) {
      const source = data.instances.find((item) => item.id === id);
      if (!source) return null;
      // A copy has its own history: it starts at zero, never inheriting time.
      const copy = buildInstance({
        ...stripStats(source),
        id: newInstanceId(),
        name: `${source.name} (copy)`,
        created: Date.now()
      });
      setData((current) => ({
        ...current,
        instances: [...current.instances, copy],
        selectedId: copy.id
      }));
      return copy;
    },

    update(id, values) {
      setData((current) => ({
        ...current,
        instances: current.instances.map((item) => {
          if (item.id !== id) return item;
          const merged = { ...item, ...stripStats(compact(values)) };
          // Keep the paired version/loader fields in sync.
          if (values?.version) merged.mc_version = values.version;
          if (values?.mc_version) merged.version = values.mc_version;
          if (values?.loader) merged.mc_loader = values.loader;
          if (values?.mc_loader) merged.loader = values.mc_loader;
          return merged;
        })
      }));
    },

    async saveOverrides(id, values) {
      // Read the latest state, not the render-time closure, so overrides never clobber newer edits.
      const latest = dataRef.current;
      const next = { ...latest, instances: latest.instances.map(item => item.id === id ? { ...item, overrides: values.overrides } : item) };
      await saveData(next);
      setData(current => ({ ...current, instances: current.instances.map(item => item.id === id ? { ...item, overrides: values.overrides } : item) }));
    },

    /** Clears recorded history for one instance without deleting it. */
    resetStats(id) {
      setData((current) => ({
        ...current,
        instances: current.instances.map((item) =>
          item.id === id ? { ...item, ...EMPTY_STATS, serverJoins: 0 } : item
        )
      }));
    },

    remove(id) {
      setData((current) => {
        const instances = current.instances.filter((item) => item.id !== id);
        return {
          ...current,
          instances,
          selectedId:
            current.selectedId === id ? instances[0]?.id ?? null : current.selectedId
        };
      });
    }
  };
}
