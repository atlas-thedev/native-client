import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowRight,
  BarChart3,
  DollarSign,
  FlaskConical,
  Globe,
  LayoutDashboard,
  Megaphone,
  Package,
  Receipt,
  Rocket,
  Server,
  ShieldCheck,
  ShoppingBag,
  Tag,
  ChevronLeft,
  ChevronRight,
  Crown,
  Database,
  Gift,
  LoaderCircle,
  MessagesSquare,
  Plus,
  RefreshCw,
  Search,
  Shirt,
  UserPlus,
  Users,
  UsersRound,
  Wifi
} from 'lucide-react';
import { BADGE_DEFS } from '../social/Badges.jsx';
import AdminStore, { ItemThumb } from './AdminStore.jsx';
import AdminUserPanel from './AdminUserPanel.jsx';
import AdminBeta from './AdminBeta.jsx';
import AdminSales from './AdminSales.jsx';
import AdminBundles from './AdminBundles.jsx';
import AdminWebsite from './AdminWebsite.jsx';
import AdminOffers from './AdminOffers.jsx';
import AdminServers from './AdminServers.jsx';
import AdminAds from './AdminAds.jsx';
import AdminApplications from './AdminApplications.jsx';
import { AdminSegmented, AdminSelect, InitialAvatar, Presence, adminCall, adminError, usd, formatAgo, formatBytes, formatDate, formatNumber } from './adminShared.jsx';
import '../instances/InstancesView.css';
import './AdminView.css';
import './AdminShell.css';

function Kpi({ icon, label, value, hint, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} className={`admin-kpi${onClick ? ' is-link' : ''}`} onClick={onClick}>
      <span className="admin-kpi-icon">{icon}</span>
      <span className="admin-kpi-label">{label}</span>
      <strong className="admin-kpi-value">{value}</strong>
      {hint && <span className="admin-kpi-hint">{hint}</span>}
    </Tag>
  );
}

/** Overview card: give any Store cape to any player by username. */
function QuickGive({ items, strips, onNotify, onDone }) {
  const [username, setUsername] = useState('');
  const [itemId, setItemId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const item = (items || []).find((entry) => entry.id === itemId) || null;

  const give = async (event) => {
    event.preventDefault();
    if (!item || !username.trim() || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await window.native?.admin?.storeGrant?.(item.id, username.trim());
      if (!result?.ok) throw new Error(result?.error || 'Could not give that cape.');
      setMessage({ ok: true, text: `${item.name} is now in ${username.trim()}’s locker.` });
      onNotify?.('Capes', `${item.name} → ${username.trim()}`);
      setUsername('');
      onDone?.();
    } catch (reason) {
      setMessage({ ok: false, text: reason?.message || 'Could not give that cape.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="admin-card admin-quick-give" onSubmit={give}>
      <div className="admin-card-head"><h3><Gift size={14} />Give a cape</h3><span>Goes straight to their locker</span></div>
      <div className="admin-quick-give-body">
        <div className="admin-quick-give-art">{item ? <ItemThumb item={item} strips={strips} width={45} height={72} /> : <Shirt size={18} />}</div>
        <div className="admin-quick-give-fields">
          <label className="admin-field"><span>Player</span><input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Native username" maxLength={32} /></label>
          <div className="admin-field"><span>Cape</span>
            <AdminSelect value={itemId} onChange={setItemId} placeholder={items ? 'Pick a cape' : 'Loading…'} options={(items || []).map((entry) => ({ value: entry.id, label: `${entry.name}${entry.exclusive ? ' · Exclusive' : ''}` }))} />
          </div>
        </div>
      </div>
      {message && <p className={`admin-inline-note${message.ok ? ' is-ok' : ' is-error'}`}>{message.text}</p>}
      <button type="submit" className="admin-btn primary" disabled={busy || !item || !username.trim()}>{busy ? <LoaderCircle size={13} className="is-spinning" /> : <Gift size={13} />}Give cape</button>
    </form>
  );
}

/** Sidebar sections: [id, label, icon, description]. */
const NAV_GROUPS = [
  ['General', [
    ['overview', 'Overview', LayoutDashboard, 'Players, sales, sign-ups and database health at a glance.'],
    ['users', 'Users', Users, 'Find a player, manage their account, capes, badges and sessions.']
  ]],
  ['Store', [
    ['store', 'Store', ShoppingBag, 'Cloaks and cosmetics: create, price, hide and preview items.'],
    ['bundles', 'Bundles', Package, 'Group Store items into bundles with their own price.'],
    ['sales', 'Sales', Receipt, 'Orders, Native+ members and payment status.'],
    ['offers', 'Offers', Tag, 'Time-limited discounts on Store items.']
  ]],
  ['Launcher & site', [
    ['website', 'Website', Globe, 'Maintenance, pre-launch and website settings.'],
    ['servers', 'Servers', Server, 'Partner servers pinned to the top of the Servers page.'],
    ['ads', 'Ads', Megaphone, 'Home page ad cards and their schedule.'],
    ['beta', 'Beta', FlaskConical, 'Beta applications and beta builds.']
  ]]
];

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
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [storeItems, setStoreItems] = useState(null);
  const [strips, setStrips] = useState({});
  const [siteDoc, setSiteDoc] = useState(null);
  const [billing, setBilling] = useState(null);
  const [betaView, setBetaView] = useState('applications');

  const loadOverview = useCallback(async () => {
    const result = await window.native?.admin?.overview?.();
    if (!result?.ok) throw adminError(result, 'Could not load database overview.', onAccessRevoked);
    setOverview(result.overview);
  }, [onAccessRevoked]);

  // website settings, offers, launch and sign-up stats (what the old website admin showed)
  const loadSite = useCallback(async () => {
    const result = await adminCall('GET', '/site', undefined, onAccessRevoked);
    setSiteDoc(result);
  }, [onAccessRevoked]);
  const loadBilling = useCallback(async () => {
    const result = await window.native?.admin?.billingOverview?.();
    if (result?.ok !== false) setBilling(result);
  }, []);

  const loadStoreItems = useCallback(async () => {
    const result = await window.native?.admin?.storeItems?.();
    if (result?.ok) setStoreItems(result.items || []);
  }, []);

  const loadUsers = useCallback(async (requestedPage = page, requestedQuery = query) => {
    const result = await window.native?.admin?.listUsers?.({ query: requestedQuery, page: requestedPage, pageSize: 50 });
    if (!result?.ok) throw adminError(result, 'Could not load users.', onAccessRevoked);
    setUsers(result.users || []);
    setPage(result.page || 1);
    setPagination({ total: result.total || 0, totalPages: result.totalPages || 1 });
    return result.users || [];
  }, [onAccessRevoked, page, query]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        const result = await window.native?.admin?.listUsers?.({ query, page: 1, pageSize: 50 });
        if (!result?.ok) throw adminError(result, 'Could not load users.', onAccessRevoked);
        if (!cancelled) {
          setUsers(result.users || []);
          setPage(result.page || 1);
          setPagination({ total: result.total || 0, totalPages: result.totalPages || 1 });
        }
      } catch (reason) {
        if (!cancelled) setError(reason?.message || 'Could not load users.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, query ? 240 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, onAccessRevoked]);

  useEffect(() => {
    loadOverview().catch((reason) => setError(reason?.message || 'Could not load admin overview.'));
    loadStoreItems().catch(() => {});
    loadSite().catch(() => {});
    loadBilling().catch(() => {});
  }, [loadOverview, loadStoreItems, loadSite, loadBilling]);

  // Animated previews for the cape pickers (fetched once per item).
  useEffect(() => {
    if (!storeItems) return undefined;
    let alive = true;
    (async () => {
      for (const item of storeItems) {
        if (!alive) return;
        if (!item.animated || strips[item.id]) continue;
        const res = await window.native?.store?.strip?.(item.id).catch(() => null);
        if (alive && res?.ok) setStrips((current) => ({ ...current, [item.id]: res.url }));
      }
    })();
    return () => { alive = false; };
  }, [storeItems]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setError('');
    try { await Promise.all([loadOverview(), loadUsers(), loadStoreItems(), loadSite().catch(() => {}), loadBilling().catch(() => {})]); }
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

  const openUser = (id) => { setSelectedUserId(id); setSection('users'); };
  const userChanged = (patch) => {
    if (patch?.id) setUsers((current) => current.map((entry) => (entry.id === patch.id ? { ...entry, ...patch } : entry)));
    loadStoreItems().catch(() => {});
  };

  const tableRows = useMemo(() => overview?.database?.tables || [], [overview]);
  const visibleUsers = useMemo(() => users.filter((user) => {
    if (userFilter === 'online') return user.status && user.status !== 'offline';
    if (userFilter === 'admin') return user.isAdmin;
    return true;
  }), [userFilter, users]);
  const selectedSummary = users.find((user) => user.id === selectedUserId) || (overview?.recentUsers || []).find((user) => user.id === selectedUserId) || null;
  const capeTotals = useMemo(() => ({
    capes: (storeItems || []).length,
    owners: (storeItems || []).reduce((sum, item) => sum + (Number(item.owners) || 0), 0)
  }), [storeItems]);
  const topCapes = useMemo(() => [...(storeItems || [])].sort((a, b) => (b.owners || 0) - (a.owners || 0)).slice(0, 4), [storeItems]);
  const maxOwners = Math.max(1, ...topCapes.map((item) => item.owners || 0));
  const siteOverview = siteDoc?.overview || null;
  const liveOffers = siteDoc?.config?.offers || [];
  const signupDays = useMemo(() => Array.from({ length: 30 }, (_, index) => {
    const day = new Date(Date.now() - (29 - index) * 86_400_000).toISOString().slice(0, 10);
    return { day, count: siteOverview?.signups?.find((entry) => entry.day === day)?.count ?? 0 };
  }), [siteOverview]);
  const maxSignup = Math.max(1, ...signupDays.map((day) => day.count));
  const maxFounder = Math.max(1, ...(siteOverview?.founderByCape || []).map((cape) => cape.count));

  const counts = {
    users: pagination.total ? formatNumber(pagination.total) : null,
    store: storeItems ? formatNumber(storeItems.length) : null,
    website: siteDoc?.settings?.maintenance?.enabled ? 'Maint.' : (siteDoc?.config?.launch?.prelaunch ? 'Pre' : null),
    offers: siteDoc?.config?.offers?.length ? `${siteDoc.config.offers.length}` : null,
    servers: siteDoc?.config?.servers?.length ? `${siteDoc.config.servers.length}` : null,
    ads: siteDoc?.config?.ads?.length ? `${siteDoc.config.ads.length}` : null
  };
  const current = NAV_GROUPS.flatMap(([, items]) => items).find(([id]) => id === section) || NAV_GROUPS[0][1][0];
  const currentGroup = NAV_GROUPS.find(([, items]) => items.some(([id]) => id === section))?.[0] || 'General';

  return (
    <main className="admin-view admin-shell">
      <aside className="admin-sidebar" aria-label="Admin sections">
        <div className="admin-side-brand">
          <span><ShieldCheck size={17} /></span>
          <div>
            <strong>Administration</strong>
            <small><i />Admin only</small>
          </div>
        </div>

        {NAV_GROUPS.map(([group, items]) => (
          <nav key={group} className="admin-side-group" aria-label={group}>
            <span className="admin-side-label">{group}</span>
            {items.map(([id, label, Icon]) => (
              <button key={id} type="button" title={label} className={`admin-side-item${section === id ? ' active' : ''}`} aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}>
                <Icon size={15} />
                <span>{label}</span>
                {counts[id] && <em>{counts[id]}</em>}
              </button>
            ))}
          </nav>
        ))}

        <div className="admin-side-foot">
          <button type="button" className="admin-btn ghost" onClick={refresh} disabled={refreshing} title="Refresh">
            <RefreshCw size={13} className={refreshing ? 'is-spinning' : ''} />
            <span>{refreshing ? 'Refreshing…' : 'Refresh data'}</span>
          </button>
        </div>
      </aside>

      <section className="admin-main">
        <header className="admin-main-head">
          <div>
            <div className="admin-crumb"><span>Admin</span><ChevronRight size={11} /><span>{currentGroup}</span></div>
            <h1 className="page-title">{current[1]}</h1>
            <p>{current[3]}</p>
          </div>
          {section === 'beta' && (
            <AdminSegmented value={betaView} onChange={setBetaView} ariaLabel="Beta sections" options={[['applications', 'Applications'], ['updates', 'Beta updates']]} />
          )}
        </header>

      {error && <div className="admin-error" role="alert"><span>{error}</span><button type="button" onClick={refresh}>Try again</button></div>}

      {section === 'beta' ? (
        <div className="admin-subview">
          {betaView === 'applications'
            ? <div className="admin-scroll"><AdminApplications doc={siteDoc} setDoc={setSiteDoc} onNotify={onNotify} onAccessRevoked={onAccessRevoked} /></div>
            : <AdminBeta onNotify={onNotify} onAccessRevoked={onAccessRevoked} />}
        </div>
      ) : section === 'website' ? (
        <AdminWebsite doc={siteDoc} setDoc={setSiteDoc} items={storeItems} strips={strips} onNotify={onNotify} onAccessRevoked={onAccessRevoked} />
      ) : section === 'offers' ? (
        <AdminOffers doc={siteDoc} setDoc={setSiteDoc} items={storeItems} strips={strips} onNotify={onNotify} onAccessRevoked={onAccessRevoked} />
      ) : section === 'ads' ? (
        <AdminAds doc={siteDoc} setDoc={setSiteDoc} onNotify={onNotify} onAccessRevoked={onAccessRevoked} />
      ) : section === 'servers' ? (
        <AdminServers doc={siteDoc} setDoc={setSiteDoc} onNotify={onNotify} onAccessRevoked={onAccessRevoked} />
      ) : section === 'bundles' ? (
        <AdminBundles items={storeItems} strips={strips} onNotify={onNotify} onAccessRevoked={onAccessRevoked} />
      ) : section === 'sales' ? (
        <AdminSales items={storeItems} onNotify={onNotify} onAccessRevoked={onAccessRevoked} />
      ) : section === 'store' ? (
        <AdminStore onNotify={onNotify} onError={setError} onAccessRevoked={onAccessRevoked} onItemsChanged={() => loadStoreItems().catch(() => {})} />
      ) : section === 'overview' ? (
        <div className="admin-scroll">
          <div className="admin-kpis">
            <Kpi icon={<Users size={15} />} label="Registered players" value={formatNumber(overview?.users)} hint={overview ? `+${formatNumber(overview.newThisWeek)} this week` : '—'} onClick={() => { setUserFilter('all'); setSection('users'); }} />
            <Kpi icon={<Wifi size={15} />} label="Online now" value={formatNumber(overview?.onlineUsers)} hint={overview?.users ? `${Math.round(((overview.onlineUsers || 0) / overview.users) * 100)}% of players` : '—'} onClick={() => { setUserFilter('online'); setSection('users'); }} />
            <Kpi icon={<Activity size={15} />} label="Active sessions" value={formatNumber(overview?.activeSessions)} hint="Signed-in devices" />
            <Kpi icon={<Shirt size={15} />} label="Items in lockers" value={formatNumber(capeTotals.owners)} hint={`${formatNumber(capeTotals.capes)} items in the Store`} onClick={() => setSection('store')} />
          </div>
          <div className="admin-kpis">
            <Kpi icon={<DollarSign size={15} />} label="Sales, all time" value={billing?.sales ? usd(billing.sales.total) : '—'} hint={billing?.sales ? `${formatNumber(billing.sales.count)} orders · ${usd(billing.sales.last30)} last 30d` : 'Loading…'} onClick={() => setSection('sales')} />
            <Kpi icon={<Crown size={15} />} label="Native+ members" value={billing?.plus ? formatNumber(billing.plus.active) : '—'} hint={billing ? `Payments ${billing.enabled ? 'on' : 'off'}${billing.environment ? ` · ${billing.environment}` : ''}` : 'Loading…'} onClick={() => setSection('sales')} />
            <Kpi icon={<Tag size={15} />} label="Live offers" value={siteDoc ? formatNumber(liveOffers.length) : '—'} hint={liveOffers.length ? liveOffers.map((offer) => `${offer.title} −${offer.percent}%`).join(', ') : 'None'} onClick={() => setSection('offers')} />
          </div>

          {siteOverview && (
            <div className="admin-overview-grid">
              <section className="admin-card is-wide">
                <div className="admin-card-head">
                  <h3><BarChart3 size={14} />Sign-ups · last 30 days</h3>
                  <span>{formatNumber(siteOverview.newToday)} today · {formatNumber(siteOverview.newThisWeek)} this week · {formatNumber(siteOverview.preLaunchUsers)} pre-launch</span>
                </div>
                <div className="admin-chart" role="img" aria-label="Daily sign-ups for the last 30 days">
                  {signupDays.map((day) => (
                    <div key={day.day} className="admin-chart-bar" title={`${day.day.slice(5)} · ${day.count}`}>
                      <i style={{ height: `${Math.max(3, (day.count / maxSignup) * 100)}%` }} />
                    </div>
                  ))}
                </div>
              </section>
              <section className="admin-card">
                <div className="admin-card-head"><h3><Rocket size={14} />Founder cape picks</h3><span>{formatNumber(siteOverview.founderPicks)} claimed{siteOverview.preLaunchUsers ? ` · ${Math.round((siteOverview.founderPicks / siteOverview.preLaunchUsers) * 100)}%` : ''}</span></div>
                <div className="admin-top-capes">
                  {(siteOverview.founderByCape || []).length ? siteOverview.founderByCape.map((cape) => {
                    const item = (storeItems || []).find((entry) => entry.id === cape.id);
                    return (
                      <div key={cape.id} className="admin-top-cape">
                        {item ? <ItemThumb item={item} strips={strips} width={25} height={40} /> : <span />}
                        <div><strong>{cape.name}</strong><span className="admin-bar"><i style={{ width: `${Math.round((cape.count / maxFounder) * 100)}%` }} /></span></div>
                        <small>{formatNumber(cape.count)}</small>
                      </div>
                    );
                  }) : <p className="admin-note">No founder capes claimed yet.</p>}
                </div>
              </section>
            </div>
          )}

          <div className="admin-overview-grid">
            <section className="admin-card">
              <div className="admin-card-head"><h3><UserPlus size={14} />Newest players</h3><button type="button" className="admin-link" onClick={() => { setUserFilter('all'); setSection('users'); }}>All players<ArrowRight size={12} /></button></div>
              <div className="admin-mini-list">
                {(overview?.recentUsers || []).length ? overview.recentUsers.map((user) => (
                  <button key={user.id} type="button" className="admin-mini-row" onClick={() => openUser(user.id)}>
                    <InitialAvatar name={user.username} size="sm" />
                    <span className="admin-mini-name"><strong>{user.username}</strong>{user.isAdmin && <Crown size={11} />}</span>
                    <Presence status={user.status} />
                    <small>{formatAgo(user.createdAt)}</small>
                  </button>
                )) : (users.slice(0, 6).length ? users.slice(0, 6).map((user) => (
                  <button key={user.id} type="button" className="admin-mini-row" onClick={() => openUser(user.id)}>
                    <InitialAvatar name={user.username} size="sm" />
                    <span className="admin-mini-name"><strong>{user.username}</strong>{user.isAdmin && <Crown size={11} />}</span>
                    <Presence status={user.status} />
                    <small>{formatAgo(user.createdAt)}</small>
                  </button>
                )) : <p className="admin-note">No players yet.</p>)}
              </div>
            </section>

            <QuickGive items={storeItems} strips={strips} onNotify={onNotify} onDone={() => loadStoreItems().catch(() => {})} />

            <section className="admin-card">
              <div className="admin-card-head"><h3><Shirt size={14} />Most worn capes</h3><button type="button" className="admin-link" onClick={() => setSection('store')}>Manage<ArrowRight size={12} /></button></div>
              <div className="admin-top-capes">
                {topCapes.length ? topCapes.map((item) => (
                  <div key={item.id} className="admin-top-cape">
                    <ItemThumb item={item} strips={strips} width={25} height={40} />
                    <div><strong>{item.name}</strong><span className="admin-bar"><i style={{ width: `${Math.round(((item.owners || 0) / maxOwners) * 100)}%` }} /></span></div>
                    <small>{formatNumber(item.owners)}</small>
                  </div>
                )) : <p className="admin-note">{storeItems ? 'No capes yet.' : 'Loading…'}</p>}
                <button type="button" className="admin-btn ghost" onClick={() => setSection('store')}><Plus size={13} />New cape</button>
              </div>
            </section>

            <section className="admin-card">
              <div className="admin-card-head"><h3><MessagesSquare size={14} />Relay & friends</h3></div>
              <dl className="admin-facts">
                <div><dt><UsersRound size={12} />Friendships</dt><dd>{formatNumber(overview?.friendships)}</dd></div>
                <div><dt><MessagesSquare size={12} />Relay messages</dt><dd>{formatNumber(overview?.messages)}</dd></div>
                <div><dt><Users size={12} />Groups</dt><dd>{formatNumber(overview?.groups)}</dd></div>
                <div><dt><Crown size={12} />Admins</dt><dd>{overview?.admins != null ? formatNumber(overview.admins) : formatNumber(users.filter((user) => user.isAdmin).length)}</dd></div>
              </dl>
            </section>

            <section className="admin-card is-wide" aria-label="Database tables">
              <div className="admin-card-head">
                <h3><Database size={14} />Database</h3>
                <span>{formatBytes(overview?.database?.sizeBytes)} · {overview?.database?.engine || 'SQLite'} · {overview?.database?.journalMode || '\u2014'}</span>
                <em className="admin-health"><i />Healthy</em>
              </div>
              <dl className="admin-table-grid">
                {tableRows.map((table) => <div key={table.name}><dt>{table.name}</dt><dd>{formatNumber(table.rows)}</dd></div>)}
              </dl>
              <p className="admin-note">
                Last checked {formatDate(overview?.database?.checkedAt, 'just now')}. Passwords, salts, tokens, and verification codes are never returned to this page.
              </p>
            </section>
          </div>
        </div>
      ) : (
        <div className={`admin-users${selectedUserId ? ' has-panel' : ''}`}>
          <section className="admin-panel admin-user-list-panel">
            <div className="admin-toolbar">
              <label className="admin-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search username, email, or ID" /></label>
              <AdminSegmented value={userFilter} onChange={setUserFilter} ariaLabel="Filter players" options={[['all', 'All'], ['online', 'Online'], ['admin', 'Admins']]} />
            </div>

            <div className="admin-user-list" aria-busy={loading}>
              {loading && !users.length ? (
                <div className="admin-loading"><LoaderCircle size={18} className="is-spinning" /><span>Loading users…</span></div>
              ) : visibleUsers.length ? visibleUsers.map((user) => (
                <button type="button" className={`admin-user-row${selectedUserId === user.id ? ' is-selected' : ''}`} key={user.id} onClick={() => setSelectedUserId(user.id)} aria-pressed={selectedUserId === user.id}>
                  <InitialAvatar name={user.username} />
                  <span className="admin-user-main">
                    <span className="admin-user-name">
                      <strong>{user.username}</strong>
                      {user.isAdmin && <span className="admin-chip is-admin"><Crown size={10} />Admin</span>}
                    </span>
                    <small>{user.email}</small>
                  </span>
                  <span className="admin-user-badges" aria-label="Badges">
                    {(user.badges || []).slice(0, 4).map((badgeId) => BADGE_DEFS[badgeId] ? <span key={badgeId} title={BADGE_DEFS[badgeId].name}>{BADGE_DEFS[badgeId].icon}</span> : null)}
                  </span>
                  <Presence status={user.status} />
                  <ChevronRight size={14} className="admin-user-chevron" />
                </button>
              )) : <div className="admin-loading"><span>No users match this view.</span></div>}
            </div>

            <footer className="admin-pagination">
              <span>{formatNumber(visibleUsers.length)} shown · page {page} of {pagination.totalPages} · {formatNumber(pagination.total)} total</span>
              <div>
                <button type="button" onClick={() => changePage(page - 1)} disabled={loading || page <= 1} aria-label="Previous page"><ChevronLeft size={15} /></button>
                <button type="button" onClick={() => changePage(page + 1)} disabled={loading || page >= pagination.totalPages} aria-label="Next page"><ChevronRight size={15} /></button>
              </div>
            </footer>
          </section>

          {selectedUserId ? (
            <AdminUserPanel
              key={selectedUserId}
              userId={selectedUserId}
              summary={selectedSummary}
              items={storeItems}
              strips={strips}
              onNotify={onNotify}
              onUserChanged={userChanged}
              onAccessRevoked={onAccessRevoked}
              onClose={() => setSelectedUserId(null)}
            />
          ) : (
            <aside className="admin-panel admin-user-empty">
              <span className="admin-user-empty-icon"><Users size={20} /></span>
              <h3>Pick a player</h3>
              <p>See their account, attach or put on capes, hand out badges, make them an admin, or sign them out everywhere.</p>
            </aside>
          )}
        </div>
      )}
      </section>
    </main>
  );
}
