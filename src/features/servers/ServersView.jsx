import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Play, Search, Signal, Sparkles, Users, X } from 'lucide-react';
import { SERVERS, SERVER_CATEGORIES } from '../../data/servers.js';
import Dropdown from '../../components/ui/Dropdown.jsx';
import unknownIcon from '../../assets/placeholders/unknown-icon.svg';
import './ServersView.css';

/* Servers: a curated list of public servers with live status, plus any
   servers the backend promotes. Play launches the chosen instance and joins
   the server straight away. */

const STORE_KEY = 'native.servers.status';
const TTL = 5 * 60 * 1000;
const BATCH = 6;
const numberFormat = new Intl.NumberFormat();

function readStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function writeStore(patch) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...readStore(), ...patch }));
  } catch {
    /* storage full: live data still shows */
  }
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(value || '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : null;
}

function olderThan(version, min) {
  const a = parseVersion(version);
  const b = parseVersion(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

const instanceVersion = (instance) => instance?.mc_version || instance?.version || '';

/** Promoted servers come from the backend (Admin → Servers) and pin to the top. */
function usePromotedServers() {
  const [promoted, setPromoted] = useState([]);
  useEffect(() => {
    const load = window.native?.server?.promoted;
    if (!load) return undefined;
    let cancelled = false;
    load()
      .then((res) => {
        if (cancelled || !Array.isArray(res?.servers)) return;
        setPromoted(res.servers
          .filter((entry) => entry?.address)
          .map((entry) => ({
            name: entry.name || entry.address,
            address: String(entry.address).toLowerCase(),
            description: entry.description || '',
            categories: ['featured'],
            min: entry.min || '1.8',
            region: entry.tag || 'Partner',
            icon: entry.iconUrl || null,
            website: entry.website || '',
            promoted: true
          })));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return promoted;
}

function useServerStatus(servers) {
  const [status, setStatus] = useState(() => readStore());
  const addresses = useMemo(() => servers.map((server) => server.address).join('|'), [servers]);
  useEffect(() => {
    const ping = window.native?.server?.ping;
    if (!ping) return undefined;
    let cancelled = false;
    const cached = readStore();
    const queue = servers.filter((server) => {
      const hit = cached[server.address];
      return !(hit && Date.now() - (hit.at || 0) < TTL);
    });
    const worker = async () => {
      while (queue.length && !cancelled) {
        const server = queue.shift();
        let value;
        try {
          value = await ping(server.address);
        } catch {
          value = { online: false };
        }
        const previous = readStore()[server.address];
        const entry = {
          online: Boolean(value?.online),
          players: value?.players?.online ?? null,
          max: value?.players?.max ?? null,
          latency: Number.isFinite(value?.latency) ? value.latency : null,
          favicon: value?.favicon || previous?.favicon || null,
          at: Date.now()
        };
        writeStore({ [server.address]: entry });
        if (!cancelled) setStatus((current) => ({ ...current, [server.address]: entry }));
      }
    };
    for (let i = 0; i < BATCH; i += 1) worker();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addresses]);
  return status;
}

/** One server as a single inline row — denser and easier to scan than cards. */
function ServerRow({ server, live, onPlay, onCopy, copied }) {
  const icon = live?.favicon || server.icon || unknownIcon;
  const players = live?.players;
  const tags = server.promoted
    ? [server.region]
    : [`${server.min}+`, server.region, ...server.categories.filter((id) => id !== 'featured').slice(0, 1)
        .map((id) => SERVER_CATEGORIES.find((c) => c.id === id)?.label || id)];

  return (
    <article className={`srv-row${server.promoted ? ' is-promoted' : ''}`}>
      <img className="srv-row-icon" src={icon} alt="" draggable="false" />

      <div className="srv-row-main">
        <div className="srv-row-title">
          <h3>{server.name}</h3>
          {server.promoted && (
            <span className="srv-badge-promoted"><Sparkles size={10} />Promoted</span>
          )}
          <span className={`srv-state${live ? (live.online ? ' is-online' : ' is-offline') : ''}`}>
            <i />
            {live ? (live.online ? 'Online' : 'Offline') : '\u2026'}
          </span>
        </div>
        <p className="srv-row-desc">{server.description}</p>
        <div className="srv-row-meta">
          <button type="button" className="srv-address" onClick={() => onCopy(server.address)} title="Copy address">
            <span>{server.address}</span>
            {copied ? <Check size={11} /> : <Copy size={11} />}
          </button>
          {tags.filter(Boolean).map((tag) => (
            <span className="srv-tag" key={tag}>{tag}</span>
          ))}
        </div>
      </div>

      <div className="srv-row-stats">
        <span><Users size={13} />{players != null ? numberFormat.format(players) : '\u2014'}</span>
        <span><Signal size={13} />{live?.latency != null ? `${live.latency} ms` : '\u2014'}</span>
      </div>

      <button type="button" className="srv-play" onClick={() => onPlay(server)}>
        <Play size={13} fill="currentColor" />
        Play
      </button>
    </article>
  );
}

function VersionDialog({ server, instance, onCancel, onConfirm }) {
  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return createPortal(
    <div className="srv-dialog-backdrop" onMouseDown={onCancel}>
      <div className="srv-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <button type="button" className="srv-dialog-close" onClick={onCancel} aria-label="Close"><X size={16} /></button>
        <h3>Version may not work</h3>
        <p>
          {server.name} needs Minecraft <b>{server.min}</b> or newer. {instance.name} runs <b>{instanceVersion(instance)}</b>,
          so the server will probably refuse to connect.
        </p>
        <div className="srv-dialog-actions">
          <button type="button" className="srv-btn ghost" onClick={onCancel}>Cancel</button>
          <button type="button" className="srv-btn" onClick={onConfirm}>Play anyway</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default function ServersView({ instances = [], selectedInstance = null, onLaunch, onNotify }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [instanceId, setInstanceId] = useState(selectedInstance?.id || '');
  const [copied, setCopied] = useState('');
  const [pending, setPending] = useState(null);
  const copyTimer = useRef(null);

  const promoted = usePromotedServers();
  // Promoted entries win over a curated duplicate of the same address.
  const allServers = useMemo(() => {
    const taken = new Set(promoted.map((server) => server.address));
    return [...promoted, ...SERVERS.filter((server) => !taken.has(server.address))];
  }, [promoted]);
  const status = useServerStatus(allServers);

  useEffect(() => {
    if (!instanceId && selectedInstance?.id) setInstanceId(selectedInstance.id);
  }, [selectedInstance, instanceId]);

  const instance = instances.find((item) => item.id === instanceId) || selectedInstance || instances[0] || null;
  const instanceOptions = useMemo(
    () => instances.map((item) => ({ value: item.id, label: `${item.name} · ${instanceVersion(item)}` })),
    [instances]
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = allServers.filter((server) => {
      if (category !== 'all' && !server.categories.includes(category)) return false;
      if (!needle) return true;
      return `${server.name} ${server.address} ${server.description}`.toLowerCase().includes(needle);
    });
    // Promoted first, then busiest; offline servers sink.
    return list
      .map((server, index) => ({ server, index }))
      .sort((a, b) => {
        if (Boolean(a.server.promoted) !== Boolean(b.server.promoted)) return a.server.promoted ? -1 : 1;
        const la = status[a.server.address];
        const lb = status[b.server.address];
        const oa = la ? (la.online ? 0 : 1) : 0;
        const ob = lb ? (lb.online ? 0 : 1) : 0;
        if (oa !== ob) return oa - ob;
        const pa = la?.players ?? -1;
        const pb = lb?.players ?? -1;
        if (pa !== pb) return pb - pa;
        return a.index - b.index;
      })
      .map(({ server }) => server);
  }, [query, category, status, allServers]);

  const totalPlayers = useMemo(
    () => allServers.reduce((sum, server) => sum + (status[server.address]?.online ? status[server.address].players || 0 : 0), 0),
    [status, allServers]
  );

  const copy = (address) => {
    navigator.clipboard?.writeText(address).catch(() => {});
    setCopied(address);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(''), 1400);
  };

  const launch = (server) => {
    setPending(null);
    onLaunch?.(instance, { quickJoinServer: server.address });
  };

  const play = (server) => {
    if (!instance) {
      onNotify?.('No instance', 'Create an instance first to join a server.');
      return;
    }
    if (olderThan(instanceVersion(instance), server.min)) {
      setPending(server);
      return;
    }
    launch(server);
  };

  return (
    <div className="srv-view">
      <header className="srv-header">
        <div>
          <h1>Servers</h1>
          <p className="srv-subtitle">
            {allServers.length} popular servers
            {totalPlayers > 0 ? ` \u00b7 ${numberFormat.format(totalPlayers)} players online now` : ''}
          </p>
        </div>
        {instances.length > 0 && (
          <div className="srv-instance">
            <span>Play with</span>
            <Dropdown
              className="srv-instance-dropdown"
              value={instance?.id || ''}
              options={instanceOptions}
              onChange={(value) => setInstanceId(value)}
              placeholder="Choose instance"
            />
          </div>
        )}
      </header>

      <div className="srv-toolbar">
        <label className="srv-search">
          <Search size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search servers" spellCheck={false} />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear"><X size={14} /></button>
          )}
        </label>
        <div className="srv-chips">
          {SERVER_CATEGORIES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`srv-chip${category === item.id ? ' is-active' : ''}`}
              onClick={() => setCategory(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="srv-empty">No servers match “{query}”.</div>
      ) : (
        <div className="srv-list">
          {visible.map((server) => (
            <ServerRow
              key={server.address}
              server={server}
              live={status[server.address]}
              onPlay={play}
              onCopy={copy}
              copied={copied === server.address}
            />
          ))}
        </div>
      )}

      {pending && instance && (
        <VersionDialog server={pending} instance={instance} onCancel={() => setPending(null)} onConfirm={() => launch(pending)} />
      )}
    </div>
  );
}
