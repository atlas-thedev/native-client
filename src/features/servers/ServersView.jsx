import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Crown, Globe, Play, RefreshCw, Search, Signal, Sparkles, Trophy, Users, X } from 'lucide-react';
import { SERVERS, SERVER_CATEGORIES } from '../../data/servers.js';
import Dropdown from '../../components/ui/Dropdown.jsx';
import unknownIcon from '../../assets/placeholders/unknown-icon.svg';
import './ServersView.css';

/* Servers: a ranked server list (in the style of the big Minecraft server
   lists) with live status, plus any servers the backend promotes. Play
   launches the chosen instance and joins the server straight away. */

const STORE_KEY = 'native.servers.status';
const BATCH = 6;
const numberFormat = new Intl.NumberFormat();

const SORTS = [
  { value: 'rank', label: 'Top ranked' },
  { value: 'players', label: 'Most players' },
  { value: 'ping', label: 'Lowest ping' },
  { value: 'name', label: 'Name (A–Z)' }
];

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
function usePromotedServers(refreshToken = 0) {
  const [promoted, setPromoted] = useState([]);
  useEffect(() => {
    const load = window.native?.server?.promoted;
    if (!load) return undefined;
    let cancelled = false;
    load({ force: refreshToken > 0 })
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
  }, [refreshToken]);
  return promoted;
}

/**
 * Server status. Opening the page shows the last known numbers and only pings servers it has
 * never seen; everything is pinged again only when the user presses Refresh (refreshToken).
 */
function useServerStatus(servers, refreshToken = 0, onDone) {
  const [status, setStatus] = useState(() => readStore());
  const addresses = useMemo(() => servers.map((server) => server.address).join('|'), [servers]);
  const lastRefresh = useRef(0);
  const forcedPending = useRef(false);
  useEffect(() => {
    const ping = window.native?.server?.ping;
    if (!ping) { onDone?.(); return undefined; }
    let cancelled = false;
    const cached = readStore();
    if (refreshToken !== lastRefresh.current) forcedPending.current = true;
    lastRefresh.current = refreshToken;
    // a refresh survives the list changing under it (promoted servers arriving)
    const forced = forcedPending.current;
    const queue = servers.filter((server) => forced || !cached[server.address]);
    if (!queue.length) forcedPending.current = false;
    if (!queue.length) { onDone?.(); return undefined; }
    let running = 0;
    const worker = async () => {
      running += 1;
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
      running -= 1;
      if (!running && !cancelled) { forcedPending.current = false; onDone?.(); }
    };
    for (let i = 0; i < BATCH; i += 1) worker();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addresses, refreshToken]);
  return status;
}

const categoryLabel = (id) => SERVER_CATEGORIES.find((c) => c.id === id)?.label || id;

/** One ranked entry: rank, icon, name + tags, IP box, players bar and Play. */
function ServerRow({ server, rank, live, onPlay, onCopy, copied }) {
  const icon = live?.favicon || server.icon || unknownIcon;
  const players = live?.players;
  const max = live?.max;
  const fill = players != null && max ? Math.min(100, Math.round((players / max) * 100)) : 0;
  const tags = server.promoted
    ? [server.region]
    : [server.region, ...server.categories.filter((id) => id !== 'featured' && id !== 'all').slice(0, 3).map(categoryLabel)];
  const medal = !server.promoted && rank <= 3 ? ` is-top${rank}` : '';

  return (
    <article className={`srv-row${server.promoted ? ' is-promoted' : ''}${medal}`}>
      <div className="srv-rank">
        {server.promoted ? <Sparkles size={15} /> : rank <= 3 ? <Trophy size={15} /> : null}
        <span>{server.promoted ? 'AD' : `#${rank}`}</span>
      </div>

      <img className="srv-row-icon" src={icon} alt="" draggable="false" />

      <div className="srv-row-main">
        <div className="srv-row-title">
          <h3>{server.name}</h3>
          {server.promoted && <span className="srv-badge-promoted"><Sparkles size={10} />Sponsored</span>}
          {!server.promoted && rank === 1 && <span className="srv-badge-top"><Crown size={10} />Top server</span>}
        </div>
        <p className="srv-row-desc">{server.description || 'No description yet.'}</p>
        <div className="srv-row-meta">
          <span className="srv-tag is-version">{server.min}+</span>
          {tags.filter(Boolean).map((tag) => <span className="srv-tag" key={tag}>{tag}</span>)}
          {server.website && (
            <a className="srv-tag is-link" href={server.website} target="_blank" rel="noreferrer"><Globe size={10} />Website</a>
          )}
        </div>
      </div>

      <button type="button" className={`srv-ip${copied ? ' is-copied' : ''}`} onClick={() => onCopy(server.address)} title="Copy server IP">
        <span className="srv-ip-label">{copied ? 'Copied!' : 'Server IP'}</span>
        <span className="srv-ip-value">{server.address}</span>
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>

      <div className="srv-row-stats">
        <span className={`srv-state${live ? (live.online ? ' is-online' : ' is-offline') : ''}`}>
          <i />{live ? (live.online ? 'Online' : 'Offline') : 'Checking…'}
        </span>
        <strong><Users size={12} />{players != null ? numberFormat.format(players) : '—'}{max ? <small> / {numberFormat.format(max)}</small> : null}</strong>
        <span className="srv-bar"><i style={{ width: `${fill}%` }} /></span>
        <span className="srv-ping"><Signal size={11} />{live?.latency != null ? `${live.latency} ms` : '—'}</span>
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
  const [sort, setSort] = useState('rank');
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [instanceId, setInstanceId] = useState(selectedInstance?.id || '');
  const [copied, setCopied] = useState('');
  const [pending, setPending] = useState(null);
  const copyTimer = useRef(null);

  const [refreshToken, setRefreshToken] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const promoted = usePromotedServers(refreshToken);
  // Promoted entries win over a curated duplicate of the same address.
  const allServers = useMemo(() => {
    const taken = new Set(promoted.map((server) => server.address));
    return [...promoted, ...SERVERS.filter((server) => !taken.has(server.address))];
  }, [promoted]);
  const status = useServerStatus(allServers, refreshToken, () => setRefreshing(false));
  const refresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshToken((value) => value + 1);
  };

  useEffect(() => {
    if (!instanceId && selectedInstance?.id) setInstanceId(selectedInstance.id);
  }, [selectedInstance, instanceId]);
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const instance = instances.find((item) => item.id === instanceId) || selectedInstance || instances[0] || null;
  const instanceOptions = useMemo(
    () => instances.map((item) => ({ value: item.id, label: `${item.name} · ${instanceVersion(item)}` })),
    [instances]
  );

  // The global ranking: online first, then busiest (promoted servers are not ranked).
  const rankOf = useMemo(() => {
    const ranked = allServers
      .filter((server) => !server.promoted)
      .map((server, index) => ({ server, index }))
      .sort((a, b) => {
        const la = status[a.server.address];
        const lb = status[b.server.address];
        const oa = la ? (la.online ? 0 : 1) : 0;
        const ob = lb ? (lb.online ? 0 : 1) : 0;
        if (oa !== ob) return oa - ob;
        const pa = la?.players ?? -1;
        const pb = lb?.players ?? -1;
        if (pa !== pb) return pb - pa;
        return a.index - b.index;
      });
    const map = {};
    ranked.forEach(({ server }, index) => { map[server.address] = index + 1; });
    return map;
  }, [allServers, status]);

  const counts = useMemo(() => {
    const map = { all: allServers.length };
    allServers.forEach((server) => server.categories.forEach((id) => { map[id] = (map[id] || 0) + 1; }));
    return map;
  }, [allServers]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = allServers.filter((server) => {
      if (category !== 'all' && !server.categories.includes(category)) return false;
      if (onlineOnly && !status[server.address]?.online) return false;
      if (!needle) return true;
      return `${server.name} ${server.address} ${server.description}`.toLowerCase().includes(needle);
    });
    const promotedFirst = (a, b) => (Boolean(a.promoted) !== Boolean(b.promoted) ? (a.promoted ? -1 : 1) : 0);
    return [...list].sort((a, b) => {
      const p = promotedFirst(a, b);
      if (p) return p;
      if (sort === 'players') return (status[b.address]?.players ?? -1) - (status[a.address]?.players ?? -1);
      if (sort === 'ping') return (status[a.address]?.latency ?? 1e9) - (status[b.address]?.latency ?? 1e9);
      if (sort === 'name') return a.name.localeCompare(b.name);
      return (rankOf[a.address] || 1e9) - (rankOf[b.address] || 1e9);
    });
  }, [query, category, onlineOnly, sort, status, allServers, rankOf]);

  const totalPlayers = useMemo(
    () => allServers.reduce((sum, server) => sum + (status[server.address]?.online ? status[server.address].players || 0 : 0), 0),
    [status, allServers]
  );
  const onlineCount = useMemo(() => allServers.filter((server) => status[server.address]?.online).length, [status, allServers]);

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
      <section className="srv-hero">
        <div className="srv-hero-text">
          <span className="srv-hero-kicker"><Trophy size={12} />Server list</span>
          <h1>Top Minecraft Servers</h1>
          <p>Find the best servers, copy the IP or press Play to join straight from Native.</p>
        </div>
        <div className="srv-hero-stats">
          <div><strong>{numberFormat.format(allServers.length)}</strong><span>Servers</span></div>
          <div><strong>{numberFormat.format(onlineCount)}</strong><span>Online</span></div>
          <div><strong>{numberFormat.format(totalPlayers)}</strong><span>Players now</span></div>
        </div>
        <label className="srv-search">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name, IP or description" spellCheck={false} />
          {query && <button type="button" onClick={() => setQuery('')} aria-label="Clear"><X size={14} /></button>}
        </label>
      </section>

      <div className="srv-layout">
        <aside className="srv-side">
          <div className="srv-side-block">
            <span className="srv-side-label">Categories</span>
            {SERVER_CATEGORIES.map((item) => (
              <button key={item.id} type="button" className={`srv-cat${category === item.id ? ' is-active' : ''}`} onClick={() => setCategory(item.id)}>
                <span>{item.label}</span>
                <em>{counts[item.id] || 0}</em>
              </button>
            ))}
          </div>

          <div className="srv-side-block">
            <span className="srv-side-label">Sort by</span>
            <Dropdown className="srv-dropdown" value={sort} options={SORTS} onChange={setSort} />
            <button type="button" role="switch" aria-checked={onlineOnly} className={`srv-toggle${onlineOnly ? ' is-on' : ''}`} onClick={() => setOnlineOnly((value) => !value)}>
              <span>Online only</span>
              <i aria-hidden="true"><b /></i>
            </button>
          </div>

          {instances.length > 0 && (
            <div className="srv-side-block">
              <span className="srv-side-label">Play with</span>
              <Dropdown className="srv-dropdown" value={instance?.id || ''} options={instanceOptions} onChange={(value) => setInstanceId(value)} placeholder="Choose instance" />
            </div>
          )}

          <button type="button" className={`srv-refresh${refreshing ? ' is-busy' : ''}`} onClick={refresh} disabled={refreshing} title="Ping every server again">
            <RefreshCw size={14} />
            {refreshing ? 'Refreshing…' : 'Refresh status'}
          </button>
        </aside>

        <section className="srv-main">
          <div className="srv-list-head">
            <span>{numberFormat.format(visible.length)} {visible.length === 1 ? 'server' : 'servers'}{category !== 'all' ? ` in ${categoryLabel(category)}` : ''}</span>
            <span className="srv-list-cols"><span>Server IP</span><span>Players</span><span /></span>
          </div>
          {visible.length === 0 ? (
            <div className="srv-empty">{query ? `No servers match “${query}”.` : 'No servers in this view.'}</div>
          ) : (
            <div className="srv-list">
              {visible.map((server) => (
                <ServerRow
                  key={server.address}
                  server={server}
                  rank={rankOf[server.address] || 0}
                  live={status[server.address]}
                  onPlay={play}
                  onCopy={copy}
                  copied={copied === server.address}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {pending && instance && (
        <VersionDialog server={pending} instance={instance} onCancel={() => setPending(null)} onConfirm={() => launch(pending)} />
      )}
    </div>
  );
}
