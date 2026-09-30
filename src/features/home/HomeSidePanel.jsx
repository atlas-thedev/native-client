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

// Pings are cached for a minute so revisiting Home doesn't re-hit servers.
const pingCache = new Map();
const PING_TTL = 60_000;

function useServerStatus(addresses) {
  const key = addresses.join('|');
  const [status, setStatus] = useState({});

  useEffect(() => {
    const ping = window.native?.server?.ping;
    if (!ping) return undefined;
    let cancelled = false;
    for (const address of addresses) {
      const hit = pingCache.get(address);
      if (hit && Date.now() - hit.at < PING_TTL) {
        setStatus((current) => ({ ...current, [address]: hit.value }));
        continue;
      }
      ping(address)
        .catch(() => ({ online: false }))
        .then((value) => {
          pingCache.set(address, { at: Date.now(), value });
          if (!cancelled) setStatus((current) => ({ ...current, [address]: value }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [key]);

  return status;
}

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
            <NativeIcon name="play" size={13} />
          </span>
        </span>
      </button>
    </li>
  );
}

/* ---------- panel --------------------------------------------------- */

export default function HomeSidePanel({ instances = [], fallbackInstance = null, onLaunch }) {
  const servers = useRecent(window.native?.instance?.recentServers);
  const worlds = useRecent(window.native?.instance?.recentWorlds);
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

  const [tab, setTab] = useState(null);
  const loaded = servers !== null && worlds !== null;

  // Open on whichever list holds the most recent session.
  useEffect(() => {
    if (!loaded || tab) return;
    const lastServer = serverRows[0]?.connectedAt || 0;
    const lastWorld = worldRows[0]?.playedAt || 0;
    setTab(lastWorld > lastServer ? 'worlds' : 'servers');
  }, [loaded, tab, serverRows, worldRows]);

  const status = useServerStatus(tab === 'servers' ? serverRows.map((entry) => entry.address) : []);

  if (!loaded || !tab) return null;

  const rows = tab === 'servers' ? serverRows : worldRows;

  return (
    <aside className="home-side" aria-label="Jump back in">
      <header className="jb-head">
        <span className="jb-title">Jump back in</span>
        <div className="jb-tabs" role="tablist">
          {[
            ['servers', 'Servers'],
            ['worlds', 'Worlds']
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`jb-tab ${tab === id ? 'is-active' : ''}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      {rows.length === 0 ? (
        <p className="jb-empty">
          {tab === 'servers'
            ? 'Servers you join will show up here.'
            : 'Singleplayer worlds you play will show up here.'}
        </p>
      ) : (
        <ul className="jb-list">
          {tab === 'servers'
            ? rows.map((entry) => {
                const { instance } = entry;
                const live = status[entry.address];
                return (
                  <Row
                    key={entry.address}
                    icon={<Thumb src={live?.favicon} text={serverName(entry.address)} />}
                    title={serverName(entry.address)}
                    subtitle={[instance.name, ago(entry.connectedAt)].filter(Boolean).join(' · ')}
                    meta={
                      live === undefined ? (
                        <span className="jb-skel" />
                      ) : live.online ? (
                        <span className="jb-players">
                          <span className="jb-dot" />
                          {numberFormat.format(live.players?.online ?? 0)}
                        </span>
                      ) : (
                        <span className="jb-offline">Offline</span>
                      )
                    }
                    playLabel={`Join ${hostOf(entry.address)} with ${instance.name}`}
                    onPlay={() => onLaunch?.(instance, { quickJoinServer: entry.address })}
                  />
                );
              })
            : rows.map((entry) => {
                const instance = byId.get(String(entry.instanceId));
                return (
                  <Row
                    key={`${entry.instanceId}/${entry.folder}`}
                    icon={<Thumb src={entry.iconUrl} text={entry.name} />}
                    title={entry.name}
                    subtitle={[instance.name || entry.instanceName, ago(entry.playedAt)].filter(Boolean).join(' · ')}
                    meta={<span className="jb-version">{instance.mc_version || instance.version}</span>}
                    playLabel={`Play ${entry.name}`}
                    onPlay={() => onLaunch?.(instance, { quickJoinWorld: entry.folder })}
                  />
                );
              })}
        </ul>
      )}
    </aside>
  );
}
