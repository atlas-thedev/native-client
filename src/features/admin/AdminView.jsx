import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck
} from 'lucide-react';
import { BADGE_DEFS } from '../social/Badges.jsx';
import '../instances/InstancesView.css';
import '../settings/SettingsPanels.css';
import './AdminView.css';

const formatNumber = (value) => Number(value || 0).toLocaleString();

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

function StatCard({ label, value, detail }) {
  return (
    <article className="sp-metric">
      <span className="sp-metric-label">{label}</span>
      <span className="sp-metric-value">{value}</span>
      <span className="sp-metric-sub">{detail}</span>
    </article>
  );
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

  return (
    <main className="instances-view admin-view">
      <header className="instances-header admin-header">
        <div className="instances-heading-group">
          <h1 className="instances-title page-title">Administration</h1>
          <p className="instances-subtitle">Manage Noctra users, badges, and database health.</p>
        </div>
        <div className="instances-header-actions">
          <span className="admin-access-label"><ShieldCheck size={13}/> Admin only</span>
          <button className="instances-ghost-btn admin-refresh" onClick={refresh} disabled={refreshing}>
            <RefreshCw size={15} className={refreshing ? 'is-spinning' : ''}/>
            <span>Refresh data</span>
          </button>
        </div>
      </header>

      {error && <div className="admin-error" role="alert"><span>{error}</span><button onClick={refresh}>Try again</button></div>}

      <nav className="instances-nav-tabs admin-tabs" aria-label="Admin sections">
        <button type="button" className={`instances-nav-tab ${section === 'overview' ? 'active' : ''}`} onClick={() => setSection('overview')}>
          <Database size={15}/><span>Overview</span>
        </button>
        <button type="button" className={`instances-nav-tab ${section === 'users' ? 'active' : ''}`} onClick={() => setSection('users')}>
          <Activity size={15}/><span>Users</span><span className="instances-tab-count">{formatNumber(pagination.total)}</span>
        </button>
      </nav>

      {section === 'overview' ? (
        <div className="instances-body admin-body">
          <section className="sp-metric-grid admin-stats" aria-label="Database statistics">
            <StatCard label="Registered users" value={formatNumber(overview?.users)} detail={`${formatNumber(overview?.activeSessions)} active sessions`}/>
            <StatCard label="Online now" value={formatNumber(overview?.onlineUsers)} detail="Authenticated presence"/>
            <StatCard label="Relay messages" value={formatNumber(overview?.messages)} detail={`${formatNumber(overview?.groups)} groups`}/>
            <StatCard label="Database size" value={formatBytes(overview?.database?.sizeBytes)} detail={`${overview?.database?.engine || 'SQLite'} · ${overview?.database?.journalMode || '—'}`}/>
          </section>

          <div className="admin-overview-grid">
            <section className="admin-panel admin-database-panel">
              <div className="sp-section-head admin-panel-heading">
                <div><h2 className="sp-section-title">Database tables</h2><p>Sanitized row counts from the live database.</p></div>
                <span className="admin-health"><i/> Healthy</span>
              </div>
              <div className="admin-table-grid">
                {tableRows.map((table) => <div key={table.name}><code>{table.name}</code><strong>{formatNumber(table.rows)}</strong><small>rows</small></div>)}
              </div>
            </section>

            <aside className="admin-panel admin-security-panel">
              <div className="sp-section-head admin-panel-heading"><div><h2 className="sp-section-title">Access & health</h2><p>Live administrative service status.</p></div></div>
              <div className="admin-health-row"><span>Last checked</span><strong>{formatDate(overview?.database?.checkedAt, 'Just now')}</strong></div>
              <div className="admin-health-row"><span>Active sessions</span><strong>{formatNumber(overview?.activeSessions)}</strong></div>
              <div className="admin-health-row"><span>Friendships</span><strong>{formatNumber(overview?.friendships)}</strong></div>
              <div className="admin-safe-note"><ShieldCheck size={16}/><span><strong>Protected data</strong><small>Passwords, salts, tokens, and verification codes are never returned to this page.</small></span></div>
            </aside>
          </div>
        </div>
      ) : (
        <div className="admin-users-section">
          <div className="instances-toolbar admin-toolbar">
            <label className="instances-search admin-search"><Search size={15}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search username, email, or ID…"/></label>
            <div className="instances-chips">
              {[['all', 'All users'], ['online', 'Online'], ['admin', 'Admins']].map(([id, label]) => (
                <button key={id} type="button" className={`instances-chip ${userFilter === id ? 'active' : ''}`} onClick={() => setUserFilter(id)}>{label}</button>
              ))}
            </div>
            <span className="admin-result-count">{formatNumber(visibleUsers.length)} shown</span>
          </div>

          <section className="admin-panel admin-users-panel">
            <header className="admin-user-columns" aria-hidden="true"><span>Player</span><span>Activity</span><span>Badge access</span></header>
            <div className="admin-user-list" aria-busy={loading}>
            {loading && !users.length ? (
              <div className="admin-loading"><LoaderCircle size={22} className="is-spinning"/><span>Loading secure user records…</span></div>
            ) : visibleUsers.length ? visibleUsers.map((user) => (
              <article className="admin-user-row" key={user.id}>
                <div className="admin-user-identity">
                  <InitialAvatar name={user.username}/>
                  <span><strong>{user.username}{user.isAdmin && <em><ShieldCheck size={10}/> Admin</em>}</strong><small>{user.email}</small><button onClick={() => navigator.clipboard?.writeText(user.id)} title="Copy user ID"><code>{user.id}</code><Copy size={10}/></button></span>
                </div>
                <div className="admin-user-activity">
                  <span className={`admin-presence is-${user.status || 'offline'}`}><i/>{user.status || 'offline'}</span>
                  <small>Joined {formatDate(user.createdAt)}</small>
                  <small>{formatNumber(user.friendCount)} friends · {formatNumber(user.groupCount)} groups · {formatNumber(user.messageCount)} messages</small>
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
            )) : <div className="admin-loading"><Search size={22}/><span>No users match this view.</span></div>}
            </div>

            <footer className="admin-pagination">
              <span>Page {page} of {pagination.totalPages} · {formatNumber(pagination.total)} total users</span>
              <div><button onClick={() => changePage(page - 1)} disabled={loading || page <= 1} aria-label="Previous page"><ChevronLeft size={15}/></button><button onClick={() => changePage(page + 1)} disabled={loading || page >= pagination.totalPages} aria-label="Next page"><ChevronRight size={15}/></button></div>
            </footer>
          </section>
        </div>
      )}
    </main>
  );
}
