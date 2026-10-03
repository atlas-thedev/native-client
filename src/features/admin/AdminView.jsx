import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  LoaderCircle,
  RefreshCw,
  Search
} from 'lucide-react';
import { BADGE_DEFS } from '../social/Badges.jsx';
import AdminStore from './AdminStore.jsx';
import '../instances/InstancesView.css';
import './AdminView.css';

const formatNumber = (value) => Number(value || 0).toLocaleString();
const plural = (value, noun) => `${formatNumber(value)} ${noun}${Number(value) === 1 ? '' : 's'}`;

function formatBytes(bytes = 0) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

function formatDate(value, empty = 'Never') {
  if (!value) return empty;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? empty : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function InitialAvatar({ name }) {
  const letters = String(name || '?').slice(0, 2).toUpperCase();
  const hue = [...String(name || '')].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 360;
  return <span className="admin-user-avatar" style={{ '--avatar-hue': hue }}>{letters}</span>;
}

function BadgeControl({ badgeId, active, busy, onToggle }) {
  const badge = BADGE_DEFS[badgeId];
  if (!badge) return null;
  return (
    <button
      type="button"
      className={`admin-badge-toggle${active ? ' is-active' : ''}`}
      disabled={busy}
      onClick={() => onToggle(badgeId, !active)}
      aria-pressed={active}
      title={`${active ? 'Revoke' : 'Grant'} ${badge.name}`}
    >
      {badge.icon}
      <span>{badge.name}</span>
    </button>
  );
}

export default function AdminView({ onNotify, onAccessRevoked }) {
  const [section, setSection] = useState('overview');
  const [userFilter, setUserFilter] = useState('all');
  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState([]);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [busyBadge, setBusyBadge] = useState('');

  const loadOverview = useCallback(async () => {
    const result = await window.native?.admin?.overview?.();
    if (!result?.ok) {
      if (/administrator|session|required/i.test(result?.error || '')) onAccessRevoked?.();
      throw new Error(result?.error || 'Could not load database overview.');
    }
    setOverview(result.overview);
  }, [onAccessRevoked]);

  const loadUsers = useCallback(async (requestedPage = page, requestedQuery = query) => {
    const result = await window.native?.admin?.listUsers?.({
      query: requestedQuery,
      page: requestedPage,
      pageSize: 50
    });
    if (!result?.ok) {
      if (/administrator|session|required/i.test(result?.error || '')) onAccessRevoked?.();
      throw new Error(result?.error || 'Could not load users.');
    }
    setUsers(result.users || []);
    setPage(result.page || 1);
    setPagination({ total: result.total || 0, totalPages: result.totalPages || 1 });
  }, [onAccessRevoked, page, query]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        const result = await window.native?.admin?.listUsers?.({ query, page: 1, pageSize: 50 });
        if (!result?.ok) throw new Error(result?.error || 'Could not load users.');
        if (!cancelled) {
          setUsers(result.users || []);
          setPage(result.page || 1);
          setPagination({ total: result.total || 0, totalPages: result.totalPages || 1 });
        }
      } catch (reason) {
        if (!cancelled) {
          setError(reason?.message || 'Could not load users.');
          if (/administrator|session|required/i.test(reason?.message || '')) onAccessRevoked?.();
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, query ? 240 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, onAccessRevoked]);

  useEffect(() => {
    loadOverview().catch((reason) => setError(reason?.message || 'Could not load admin overview.'));
  }, [loadOverview]);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setError('');
    try { await Promise.all([loadOverview(), loadUsers()]); }
    catch (reason) { setError(reason?.message || 'Could not refresh the control room.'); }
    finally { setRefreshing(false); }
  };

  const changePage = async (nextPage) => {
    if (loading || nextPage < 1 || nextPage > pagination.totalPages) return;
    setLoading(true);
    setError('');
    try { await loadUsers(nextPage, query); }
    catch (reason) { setError(reason?.message || 'Could not load that page.'); }
    finally { setLoading(false); }
  };

  const toggleBadge = async (user, badge, granted) => {
    const busyKey = `${user.id}:${badge}`;
    setBusyBadge(busyKey);
    setError('');
    try {
      const result = await window.native?.admin?.setBadge?.(user.id, badge, granted);
      if (!result?.ok) throw new Error(result?.error || 'Could not update badge.');
      setUsers((current) => current.map((entry) => entry.id === user.id ? { ...entry, badges: result.user.badges || [] } : entry));
      onNotify?.(granted ? 'Badge granted' : 'Badge revoked', `${BADGE_DEFS[badge].name} · ${user.username}`);
    } catch (reason) {
      setError(reason?.message || 'Could not update badge.');
    } finally {
      setBusyBadge('');
    }
  };

  const tableRows = useMemo(() => overview?.database?.tables || [], [overview]);
  const visibleUsers = useMemo(() => users.filter((user) => {
    if (userFilter === 'online') return user.status && user.status !== 'offline';
    if (userFilter === 'admin') return user.isAdmin;
    return true;
  }), [userFilter, users]);

  const tabs = [
    ['overview', 'Overview', null],
    ['users', 'Users', formatNumber(pagination.total)],
    ['store', 'Store', null]
  ];

  return (
    <main className="instances-view admin-view">
      <header className="instances-header admin-header">
        <div className="instances-heading-group">
          <h1 className="instances-title page-title">Administration</h1>
          <p className="instances-subtitle">Manage Noctra users, badges, Store capes, and database health.</p>
        </div>
        <div className="instances-header-actions">
          <span className="admin-access-label">Admin only</span>
          <button className="instances-ghost-btn admin-refresh" onClick={refresh} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? 'is-spinning' : ''}/>
            <span>Refresh</span>
          </button>
        </div>
      </header>

      {error && <div className="admin-error" role="alert"><span>{error}</span><button onClick={refresh}>Try again</button></div>}

      <nav className="admin-tabs" aria-label="Admin sections">
        {tabs.map(([id, label, count]) => (
          <button key={id} type="button" className={section === id ? 'active' : ''} aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}>
            {label}{count && <span>{count}</span>}
          </button>
        ))}
      </nav>

      {section === 'store' ? (
        <AdminStore onNotify={onNotify} onError={setError}/>
      ) : section === 'overview' ? (
        <div className="admin-scroll">
          <div className="admin-overview">
            <p className="admin-lead">
              <strong>{formatNumber(overview?.onlineUsers)}</strong>
              <span>online now, out of {formatNumber(overview?.users)} registered users</span>
            </p>

            <section aria-label="Database statistics">
              <h2 className="admin-label">Activity</h2>
              <dl className="admin-facts">
                <div><dt>Active sessions</dt><dd>{formatNumber(overview?.activeSessions)}</dd></div>
                <div><dt>Friendships</dt><dd>{formatNumber(overview?.friendships)}</dd></div>
                <div><dt>Relay messages</dt><dd>{formatNumber(overview?.messages)}</dd></div>
                <div><dt>Groups</dt><dd>{formatNumber(overview?.groups)}</dd></div>
              </dl>
            </section>

            <section aria-label="Database tables">
              <h2 className="admin-label">
                Database <span>{formatBytes(overview?.database?.sizeBytes)} · {overview?.database?.engine || 'SQLite'} · {overview?.database?.journalMode || '\u2014'}</span>
                <em className="admin-health"><i/> Healthy</em>
              </h2>
              <dl className="admin-facts is-mono">
                {tableRows.map((table) => <div key={table.name}><dt>{table.name}</dt><dd>{formatNumber(table.rows)}</dd></div>)}
              </dl>
              <p className="admin-note">
                Last checked {formatDate(overview?.database?.checkedAt, 'just now')}. Passwords, salts, tokens, and verification codes are never returned to this page.
              </p>
            </section>
          </div>
        </div>
      ) : (
        <div className="admin-users-section">
          <div className="admin-toolbar">
            <label className="admin-search"><Search size={14}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search username, email, or ID"/></label>
            <div className="admin-filters">
              {[['all', 'All'], ['online', 'Online'], ['admin', 'Admins']].map(([id, label]) => (
                <button key={id} type="button" className={userFilter === id ? 'active' : ''} onClick={() => setUserFilter(id)}>{label}</button>
              ))}
            </div>
            <span className="admin-result-count">{formatNumber(visibleUsers.length)} shown</span>
          </div>

          <div className="admin-user-list" aria-busy={loading}>
            {loading && !users.length ? (
              <div className="admin-loading"><LoaderCircle size={18} className="is-spinning"/><span>Loading users…</span></div>
            ) : visibleUsers.length ? visibleUsers.map((user) => (
              <article className="admin-user-row" key={user.id}>
                <InitialAvatar name={user.username}/>
                <div className="admin-user-main">
                  <div className="admin-user-name">
                    <strong>{user.username}</strong>
                    {user.isAdmin && <em>Admin</em>}
                    <span className={`admin-presence is-${user.status || 'offline'}`}><i/>{user.status || 'offline'}</span>
                    <button type="button" className="admin-copy-id" onClick={() => navigator.clipboard?.writeText(user.id)} title="Copy user ID"><code>{user.id}</code><Copy size={10}/></button>
                  </div>
                  <small>{user.email}</small>
                  <small className="admin-user-meta">
                    Joined {formatDate(user.createdAt)} · {plural(user.friendCount, 'friend')} · {plural(user.groupCount, 'group')} · {plural(user.messageCount, 'message')}
                  </small>
                </div>
                <div className="admin-user-badges">
                  {Object.keys(BADGE_DEFS).map((badgeId) => (
                    <BadgeControl
                      key={badgeId}
                      badgeId={badgeId}
                      active={(user.badges || []).includes(badgeId)}
                      busy={Boolean(busyBadge)}
                      onToggle={(badge, granted) => toggleBadge(user, badge, granted)}
                    />
                  ))}
                </div>
              </article>
            )) : <div className="admin-loading"><span>No users match this view.</span></div>}
          </div>

          <footer className="admin-pagination">
            <span>Page {page} of {pagination.totalPages} · {formatNumber(pagination.total)} total users</span>
            <div><button onClick={() => changePage(page - 1)} disabled={loading || page <= 1} aria-label="Previous page"><ChevronLeft size={15}/></button><button onClick={() => changePage(page + 1)} disabled={loading || page >= pagination.totalPages} aria-label="Next page"><ChevronRight size={15}/></button></div>
          </footer>
        </div>
      )}
    </main>
  );
}
