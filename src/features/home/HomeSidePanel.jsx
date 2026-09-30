import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Icon from '../../components/ui/Icon.jsx';
import { timeAgo } from '../../lib/time.js';
import './HomeSidePanel.css';

/* Right-hand companion panel on Home.
   Modded instance  -> installed mods (toggle, search, manage) + servers tab.
   Vanilla instance -> servers only: recent joins from logs, then featured. */

const MODDED_LOADERS = new Set(['fabric', 'forge', 'neoforge', 'quilt']);

export const isModdedInstance = (instance) =>
  MODDED_LOADERS.has(String(instance?.mc_loader || instance?.loader || '').toLowerCase());

export const FEATURED_SERVERS = [
  { address: 'mc.hypixel.net', name: 'Hypixel', tag: 'Minigames' },
  { address: 'play.cubecraft.net', name: 'CubeCraft', tag: 'Minigames' },
  { address: 'play.wynncraft.com', name: 'Wynncraft', tag: 'MMORPG' },
  { address: 'play.manacube.com', name: 'ManaCube', tag: 'Skyblock' },
  { address: 'org.mc-complex.com', name: 'Complex Gaming', tag: 'Pixelmon' },
  { address: '2b2t.org', name: '2b2t', tag: 'Anarchy' }
];

// "play.hypixel.net:25565" -> "hypixel.net", so aliases of one network match.
const rootDomain = (address) =>
  String(address || '').toLowerCase().split(':')[0].split('.').slice(-2).join('.');

const isModFile = (name) => /\.jar(\.disabled)?$/i.test(name || '');
const numberFormat = new Intl.NumberFormat();

/* ---------- data ---------------------------------------------------- */

function useInstanceMods(instance, enabled) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const id = instance?.id;

  useEffect(() => {
    if (!enabled || !id || !window.native?.mods?.installed || !window.native?.instance?.listDir) {
      setRows([]);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError('');

    Promise.all([window.native.mods.installed(id), window.native.instance.listDir(id, 'mods')])
      .then(([manifest, files = []]) => {
        if (cancelled) return;
        const tracked = Object.entries(manifest || {})
          .map(([projectId, value]) => ({
            id: projectId,
            ...(typeof value === 'string' ? { filename: value } : value)
          }))
          .filter((entry) => (entry.folder || 'mods') === 'mods' && entry.filename);
        const trackedNames = new Set(tracked.map((entry) => entry.filename));
        const next = [
          ...tracked.map((entry) => ({
            ...entry,
            title: entry.metadata?.title || entry.filename,
            enabled: !entry.filename.endsWith('.disabled'),
            managed: true
          })),
          ...files
            .filter((file) => !file.isDir && isModFile(file.name) && !trackedNames.has(file.name))
            .map((file) => ({
              id: file.name,
              filename: file.name,
              title: file.name.replace(/\.jar(\.disabled)?$/i, ''),
              enabled: !file.name.endsWith('.disabled'),
              managed: false
            }))
        ];
        setRows(next);
        setLoading(false);

        // Titles and icons for jars Noctra did not install itself.
        if (window.native.mods.enrich && next.some((row) => !row.metadata?.iconUrl)) {
          window.native.mods
            .enrich(id, 'mods')
            .then((found) => {
              if (cancelled || !found) return;
              setRows((current) =>
                current.map((row) => {
                  const extra = found[row.filename];
                  if (!extra) return row;
                  const metadata = { ...extra };
                  for (const [key, value] of Object.entries(row.metadata || {})) {
                    if (value) metadata[key] = value;
                  }
                  return {
                    ...row,
                    metadata,
                    title: row.managed && row.metadata?.title ? row.title : extra.title || row.title
                  };
                })
              );
            })
            .catch(() => {});
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || 'Could not read the mods folder.');
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id, enabled, revision]);

  const toggle = useCallback(
    async (row) => {
      const nextEnabled = !row.enabled;
      // Optimistic: flip immediately, reconcile with disk afterwards.
      setRows((current) => current.map((item) => (item.id === row.id ? { ...item, enabled: nextEnabled } : item)));
      try {
        if (row.managed) {
          await window.native.mods.toggle({ instanceId: id, projectId: row.id, enabled: nextEnabled });
        } else {
          await window.native.instance.toggleFile(id, 'mods', row.filename, nextEnabled);
        }
      } catch (err) {
        setError(err?.message || 'Could not change that mod.');
      }
      setRevision((value) => value + 1);
    },
    [id]
  );

  return { rows, loading, error, toggle };
}

// Status pings are cached for a minute so tab switches don't re-hit servers.
const pingCache = new Map();
const PING_TTL = 60_000;

function useServerStatus(addresses) {
  const key = addresses.join('|');
  const [status, setStatus] = useState(() => {
    const initial = {};
    for (const address of addresses) {
      const hit = pingCache.get(address);
      if (hit) initial[address] = hit.value;
    }
    return initial;
  });

  useEffect(() => {
    if (!window.native?.server?.ping) return undefined;
    let cancelled = false;
    for (const address of addresses) {
      const hit = pingCache.get(address);
      if (hit && Date.now() - hit.at < PING_TTL) {
        setStatus((current) => (current[address] === hit.value ? current : { ...current, [address]: hit.value }));
        continue;
      }
      window.native.server
        .ping(address)
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

function useRecentServers() {
  const [servers, setServers] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const load = window.native?.instance?.recentServers;
    if (!load) {
      setServers([]);
      return undefined;
    }
    load()
      .then((list) => !cancelled && setServers(Array.isArray(list) ? list : []))
      .catch(() => !cancelled && setServers([]));
    return () => {
      cancelled = true;
    };
  }, []);
  return servers;
}

/* ---------- pieces -------------------------------------------------- */

function Monogram({ text }) {
  const letters = String(text || '?')
    .replace(/[^a-z0-9 ]/gi, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
  return <span className="hs-thumb is-mono">{letters || '?'}</span>;
}

function Thumb({ src, text }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return <Monogram text={text} />;
  return <img className="hs-thumb" src={src} alt="" loading="lazy" onError={() => setBroken(true)} />;
}

function ModRow({ row, onToggle }) {
  const meta = row.metadata || {};
  const detail = [meta.author, meta.version].filter(Boolean).join(' · ') || row.filename;
  return (
    <li className={`hs-row ${row.enabled ? '' : 'is-off'}`}>
      <Thumb src={meta.iconUrl} text={row.title} />
      <div className="hs-row-text">
        <span className="hs-row-title" title={row.title}>{row.title}</span>
        <span className="hs-row-sub" title={detail}>{detail}</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={row.enabled}
        className={`hs-switch ${row.enabled ? 'is-on' : ''}`}
        onClick={() => onToggle(row)}
        title={row.enabled ? `Disable ${row.title}` : `Enable ${row.title}`}
      >
        <span className="hs-switch-thumb" />
      </button>
    </li>
  );
}

function ServerRow({ server, status, onJoin, canJoin, joinWith }) {
  const pending = status === undefined;
  const online = status?.online;
  return (
    <li className="hs-row is-server">
      <Thumb src={status?.favicon} text={server.name} />
      <div className="hs-row-text">
        <span className="hs-row-title" title={server.address}>{server.name}</span>
        <span className="hs-row-sub" title={server.detail}>{server.detail}</span>
      </div>
      <div className="hs-server-meta">
        {pending ? (
          <span className="hs-skel" />
        ) : online ? (
          <span className="hs-players">
            <span className="hs-dot" />
            {numberFormat.format(status.players?.online ?? 0)}
          </span>
        ) : (
          <span className="hs-players is-offline">Offline</span>
        )}
        {online && Number.isFinite(status.latency) && <span className="hs-ping">{status.latency} ms</span>}
      </div>
      <button
        type="button"
        className="hs-join"
        onClick={() => onJoin(server)}
        disabled={!canJoin || online === false}
        title={canJoin ? `Join ${server.address}${joinWith ? ` with ${joinWith}` : ''}` : 'Create an instance to join servers'}
      >
        Join
      </button>
    </li>
  );
}

/* ---------- panel --------------------------------------------------- */

export default function HomeSidePanel({ instance, instances = [], onLaunch, onOpenCluster, onNavigateBrowse }) {
  const modded = isModdedInstance(instance);
  const [tab, setTab] = useState(modded ? 'mods' : 'servers');
  const [query, setQuery] = useState('');

  useEffect(() => {
    setTab(modded ? 'mods' : 'servers');
    setQuery('');
  }, [instance?.id, modded]);

  const mods = useInstanceMods(instance, modded);
  const recent = useRecentServers();

  const recentServers = useMemo(
    () =>
      (recent || []).slice(0, 5).map((entry) => ({
        address: entry.address,
        name: FEATURED_SERVERS.find((known) => rootDomain(known.address) === rootDomain(entry.address))?.name || entry.address,
        instanceId: entry.instanceId,
        detail: [entry.instanceName, entry.connectedAt ? timeAgo(entry.connectedAt) : null].filter(Boolean).join(' · ')
      })),
    [recent]
  );
  const featuredServers = useMemo(() => {
    const seen = new Set(recentServers.map((server) => rootDomain(server.address)));
    return FEATURED_SERVERS.filter((server) => !seen.has(rootDomain(server.address))).map((server) => ({
      ...server,
      detail: `${server.tag} · ${server.address}`
    }));
  }, [recentServers]);

  const status = useServerStatus(
    tab === 'servers' ? [...recentServers, ...featuredServers].map((server) => server.address) : []
  );

  const visibleMods = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return [...mods.rows]
      .filter((row) =>
        !needle ||
        `${row.title} ${row.metadata?.author || ''} ${row.filename}`.toLowerCase().includes(needle)
      )
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  }, [mods.rows, query]);

  const enabledCount = mods.rows.filter((row) => row.enabled).length;
  const disabledCount = mods.rows.length - enabledCount;

  const joinServer = (server) => {
    // Prefer the instance the server was last played on, if it still exists.
    const target = instances.find((item) => item.id === server.instanceId) || instance;
    if (target) onLaunch?.(target, { quickJoinServer: server.address });
  };

  return (
    <aside className="home-side" aria-label="Instance content">
      <header className="hs-head">
        {modded ? (
          <div className="hs-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'mods'}
              className={`hs-tab ${tab === 'mods' ? 'is-active' : ''}`}
              onClick={() => setTab('mods')}
            >
              Mods
              {mods.rows.length > 0 && <span className="hs-tab-count">{mods.rows.length}</span>}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'servers'}
              className={`hs-tab ${tab === 'servers' ? 'is-active' : ''}`}
              onClick={() => setTab('servers')}
            >
              Servers
            </button>
          </div>
        ) : (
          <span className="hs-title">Servers</span>
        )}
        <span className="hs-context" title={instance?.name}>
          {instance?.name || 'Minecraft'}
        </span>
      </header>

      {tab === 'mods' ? (
        <>
          <div className="hs-toolbar">
            <label className="hs-search">
              <Icon name="search-md" size={14} />
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search mods"
                spellCheck={false}
              />
            </label>
          </div>
          {mods.rows.length > 0 && (
            <div className="hs-summary">
              <span>{enabledCount} enabled</span>
              {disabledCount > 0 && <span>{disabledCount} disabled</span>}
            </div>
          )}

          <div className="hs-body">
            {mods.loading ? (
              <ul className="hs-list" aria-busy="true">
                {Array.from({ length: 6 }, (_, index) => (
                  <li key={index} className="hs-row is-skeleton">
                    <span className="hs-thumb" />
                    <div className="hs-row-text">
                      <span className="hs-skel is-wide" />
                      <span className="hs-skel" />
                    </div>
                  </li>
                ))}
              </ul>
            ) : mods.rows.length === 0 ? (
              <div className="hs-empty">
                <p className="hs-empty-title">No mods yet</p>
                <p className="hs-empty-body">
                  Add mods built for {instance?.mc_version || instance?.version} {instance?.mc_loader || instance?.loader}.
                </p>
              </div>
            ) : visibleMods.length === 0 ? (
              <div className="hs-empty">
                <p className="hs-empty-body">Nothing matches “{query}”.</p>
              </div>
            ) : (
              <ul className="hs-list">
                {visibleMods.map((row) => (
                  <ModRow key={row.id} row={row} onToggle={mods.toggle} />
                ))}
              </ul>
            )}
          </div>

          {mods.error && <p className="hs-error">{mods.error}</p>}

          <footer className="hs-foot">
            <button type="button" className="hs-btn" onClick={() => onOpenCluster?.(instance, 'mods')}>
              Manage
            </button>
            <button type="button" className="hs-btn is-primary" onClick={() => onNavigateBrowse?.(instance, 'mod')}>
              <Icon name="plus" size={14} />
              Add mods
            </button>
          </footer>
        </>
      ) : (
        <div className="hs-body">
          {recent === null ? null : (
            <>
              {recentServers.length > 0 && (
                <section className="hs-group">
                  <h3 className="hs-group-label">Recently joined</h3>
                  <ul className="hs-list">
                    {recentServers.map((server) => (
                      <ServerRow
                        key={server.address}
                        server={server}
                        status={status[server.address]}
                        onJoin={joinServer}
                        canJoin={Boolean(instance)}
                        joinWith={(instances.find((item) => item.id === server.instanceId) || instance)?.name}
                      />
                    ))}
                  </ul>
                </section>
              )}
              <section className="hs-group">
                <h3 className="hs-group-label">Featured</h3>
                <ul className="hs-list">
                  {featuredServers.map((server) => (
                    <ServerRow
                      key={server.address}
                      server={server}
                      status={status[server.address]}
                      onJoin={joinServer}
                      canJoin={Boolean(instance)}
                      joinWith={instance?.name}
                    />
                  ))}
                </ul>
              </section>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
