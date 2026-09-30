import React, { useEffect, useMemo, useState } from 'react';
import NativeIcon from '../../components/ui/NativeIcon.jsx';
import './HomeSidePanel.css';

/* "Jump back in" — the last servers and singleplayer worlds you played,
   floating over the Home wallpaper as a frosted glass card. */

const LIMIT = 5;
const numberFormat = new Intl.NumberFormat();

const KNOWN_NETWORKS = {
  'hypixel.net': 'Hypixel',
  'cubecraft.net': 'CubeCraft',
  'wynncraft.com': 'Wynncraft',
  'manacube.com': 'ManaCube',
  'mc-complex.com': 'Complex Gaming',
  'minemen.club': 'Minemen Club',
  'donutsmp.net': 'DonutSMP',
  'hivebedrock.network': 'The Hive',
  '2b2t.org': '2b2t'
};

const hostOf = (address) => String(address || '').replace(/:25565$/, '');
const rootDomain = (address) => hostOf(address).toLowerCase().split(':')[0].split('.').slice(-2).join('.');
const serverName = (address) => KNOWN_NETWORKS[rootDomain(address)] || hostOf(address);

function ago(timestamp) {
  if (!timestamp) return '';
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/* ---------- data ---------------------------------------------------- */

function useRecent(loader) {
  const [items, setItems] = useState(null);
  useEffect(() => {
    let cancelled = false;
    if (!loader) {
      setItems([]);
      return undefined;
    }
    loader()
      .then((list) => !cancelled && setItems(Array.isArray(list) ? list : []))
      .catch(() => !cancelled && setItems([]));
    return () => {
      cancelled = true;
    };
  }, [loader]);
  return items;
}

/* ---------- persistent icon + status cache ------------------------------
   Server favicons and world icons are kept in localStorage so a server you
   have pinged before shows its real icon instantly (and while offline),
   instead of flashing a placeholder on every visit. */

const STORE_KEY = 'noctra.home.jumpBackIn.v1';
const MAX_SERVERS = 40;
const MAX_WORLDS = 60;
const PING_TTL = 60_000;

export const serverKey = (address) => hostOf(address).toLowerCase();

function readStore() {
  try {
    const data = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return { servers: data.servers || {}, worlds: data.worlds || {} };
  } catch {
    return { servers: {}, worlds: {} };
  }
}

function trim(map, max) {
  const entries = Object.entries(map).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  return Object.fromEntries(entries.slice(0, max));
}

function writeStore(patch) {
  try {
    const store = readStore();
    const next = {
      servers: trim({ ...store.servers, ...(patch.servers || {}) }, MAX_SERVERS),
      worlds: trim({ ...store.worlds, ...(patch.worlds || {}) }, MAX_WORLDS)
    };
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    // Quota or private mode: icons simply are not remembered.
  }
}

/** Cached entry for a server, falling back to another host on the same
    network (play.hypixel.net ↔ mc.hypixel.net share one icon). */
function cachedServer(store, address) {
  const key = serverKey(address);
  if (store.servers[key]) return store.servers[key];
  const root = rootDomain(address);
  const sibling = Object.entries(store.servers).find(([other, value]) => rootDomain(other) === root && value.favicon);
  return sibling ? { favicon: sibling[1].favicon } : null;
}

function useServerStatus(addresses) {
  const key = addresses.join('|');
  const [status, setStatus] = useState(() => {
    const store = readStore();
    const initial = {};
    for (const address of addresses) {
      const hit = cachedServer(store, address);
      if (hit) initial[address] = { ...hit, stale: true };
    }
    return initial;
  });

  useEffect(() => {
    const store = readStore();
    // Paint remembered icons / numbers right away.
    setStatus((current) => {
      const next = { ...current };
      for (const address of addresses) {
        if (!next[address]) {
          const hit = cachedServer(store, address);
          if (hit) next[address] = { ...hit, stale: true };
        }
      }
      return next;
    });

    const ping = window.native?.server?.ping;
    if (!ping) return undefined;
    let cancelled = false;
    for (const address of addresses) {
      const hit = store.servers[serverKey(address)];
      if (hit && hit.online && Date.now() - (hit.at || 0) < PING_TTL) continue;
      ping(address)
        .catch(() => ({ online: false }))
        .then((value) => {
          const previous = readStore().servers[serverKey(address)] || cachedServer(readStore(), address);
          const entry = {
            online: Boolean(value?.online),
            players: value?.players || null,
            latency: Number.isFinite(value?.latency) ? value.latency : null,
            // Keep the last known icon when the server is offline or sends none.
            favicon: value?.favicon || previous?.favicon || null,
            at: Date.now()
          };
          writeStore({ servers: { [serverKey(address)]: entry } });
          if (!cancelled) setStatus((current) => ({ ...current, [address]: entry }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [key]);

  return status;
}

/** World icons: use the file from disk, remember it, reuse it if the file
    later goes missing (e.g. the world is open in another tool). */
function withWorldIcons(worlds) {
  if (!worlds) return worlds;
  const store = readStore();
  const patch = {};
  const result = worlds.map((world) => {
    const key = `${world.instanceId}/${world.folder}`;
    if (world.iconUrl) {
      if (store.worlds[key]?.iconUrl !== world.iconUrl) patch[key] = { iconUrl: world.iconUrl, at: Date.now() };
      return world;
    }
    const cached = store.worlds[key]?.iconUrl;
    return cached ? { ...world, iconUrl: cached } : world;
  });
  if (Object.keys(patch).length) writeStore({ worlds: patch });
  return result;
}

const latencyTone = (ms) => (ms == null ? '' : ms < 80 ? 'is-good' : ms < 180 ? 'is-ok' : 'is-bad');

/* ---------- pieces -------------------------------------------------- */

function Thumb({ src, text }) {
  const [broken, setBroken] = useState(false);
  if (src && !broken) {
    return <img className="jb-thumb" src={src} alt="" onError={() => setBroken(true)} />;
  }
  const letter = String(text || '?').replace(/[^a-z0-9]/gi, '').charAt(0).toUpperCase() || '?';
  return <span className="jb-thumb is-mono">{letter}</span>;
}

function Row({ icon, title, subtitle, meta, onPlay, playLabel }) {
  return (
    <li className="jb-row">
      <button type="button" className="jb-row-hit" onClick={onPlay} disabled={!onPlay} title={playLabel}>
        {icon}
        <span className="jb-row-text">
          <span className="jb-row-title">{title}</span>
          <span className="jb-row-sub">{subtitle}</span>
        </span>
        <span className="jb-row-end">
          <span className="jb-meta">{meta}</span>
          <span className="jb-play" aria-hidden="true">
            <NativeIcon name="play" size={15} />
          </span>
        </span>
      </button>
    </li>
  );
}

/* ---------- panel --------------------------------------------------- */

export default function HomeSidePanel({ instances = [], fallbackInstance = null, onLaunch }) {
  const servers = useRecent(window.native?.instance?.recentServers);
  const rawWorlds = useRecent(window.native?.instance?.recentWorlds);
  const worlds = useMemo(() => withWorldIcons(rawWorlds), [rawWorlds]);
  const byId = useMemo(() => new Map(instances.map((item) => [String(item.id), item])), [instances]);

  // Servers from shared logs (or a deleted instance) join with the selected one.
  const serverRows = useMemo(
    () =>
      (servers || [])
        .map((entry) => ({ ...entry, instance: byId.get(String(entry.instanceId)) || fallbackInstance }))
        .filter((entry) => entry.instance)
        .slice(0, LIMIT),
    [servers, byId, fallbackInstance]
  );
  // Worlds live inside an instance folder, so they need that instance.
  const worldRows = useMemo(
    () => (worlds || []).filter((entry) => byId.has(String(entry.instanceId))).slice(0, LIMIT),
    [worlds, byId]
  );

  const loaded = servers !== null && worlds !== null;

  // One timeline: servers and worlds interleaved by when you last played them.
  const recent = useMemo(
    () =>
      [
        ...serverRows.map((entry) => ({ kind: 'server', at: entry.connectedAt || 0, entry })),
        ...worldRows.map((entry) => ({ kind: 'world', at: entry.playedAt || 0, entry }))
      ]
        .sort((a, b) => b.at - a.at)
        .slice(0, LIMIT),
    [serverRows, worldRows]
  );

  const status = useServerStatus(
    recent.filter((item) => item.kind === 'server').map((item) => item.entry.address)
  );

  // Nothing played yet: keep the wallpaper clean.
  if (!loaded || recent.length === 0) return null;

  return (
    <aside className="home-side" aria-label="Jump back in">
      <h2 className="jb-title">Jump back in</h2>
      <ul className="jb-list">
        {recent.map(({ kind, entry }) => {
          if (kind === 'server') {
            const { instance } = entry;
            const live = status[entry.address];
            return (
              <Row
                key={`s:${entry.address}`}
                icon={<Thumb src={live?.favicon} text={serverName(entry.address)} />}
                title={serverName(entry.address)}
                subtitle={['Server', ago(entry.connectedAt)].filter(Boolean).join(' · ')}
                meta={
                  live?.online === undefined ? (
                    <span className="jb-skel" />
                  ) : live.online ? (
                    <span className="jb-stat">
                      <span className={`jb-ping ${latencyTone(live.latency)}`}>
                        <span className="jb-dot" />
                        {live.latency != null ? `${live.latency} ms` : 'Online'}
                      </span>
                      <span className="jb-players">{numberFormat.format(live.players?.online ?? 0)} online</span>
                    </span>
                  ) : (
                    <span className="jb-offline">Offline</span>
                  )
                }
                playLabel={`Join ${hostOf(entry.address)} with ${instance.name}`}
                onPlay={() => onLaunch?.(instance, { quickJoinServer: entry.address })}
              />
            );
          }
          const instance = byId.get(String(entry.instanceId));
          return (
            <Row
              key={`w:${entry.instanceId}/${entry.folder}`}
              icon={<Thumb src={entry.iconUrl} text={entry.name} />}
              title={entry.name}
              subtitle={['World', instance.name || entry.instanceName, ago(entry.playedAt)].filter(Boolean).join(' · ')}
              meta={<span className="jb-version">{instance.mc_version || instance.version}</span>}
              playLabel={`Play ${entry.name} in ${instance.name}`}
              onPlay={() => onLaunch?.(instance, { quickJoinWorld: entry.folder })}
            />
          );
        })}
      </ul>
    </aside>
  );
}
