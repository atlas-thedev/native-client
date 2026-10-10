import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Bug, Check, Clock, Crown, Inbox, ListChecks, LoaderCircle, Search, Trash2, Users, X } from 'lucide-react';
import { AdminDateTime, AdminNumber, AdminSegmented, AdminSwitch, InitialAvatar, adminCall, formatDate, formatNumber, useAdminAction, useConfirm } from './adminShared.jsx';

const FILTERS = [['pending', 'To review'], ['approved', 'Accepted'], ['waitlist', 'Waitlist'], ['rejected', 'Rejected'], ['all', 'All']];
const LABEL = { pending: 'Pending', approved: 'Accepted', waitlist: 'Waitlist', rejected: 'Rejected' };
const PLATFORM = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
const hours = (value) => (Number(value) >= 40 ? '40+' : String(value ?? '–'));

/** Super Beta Tester applications from the website form. Accepting grants the badge, cape and lifetime Native+. */
export default function AdminApplications({ doc, setDoc, onNotify, onAccessRevoked }) {
  const { busy, error, setError, run } = useAdminAction(onNotify, 'Beta applications');
  const { armed, ask } = useConfirm();
  const [filter, setFilter] = useState('pending');
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    const result = await adminCall('GET', `/beta?status=${filter}&q=${encodeURIComponent(q)}`, undefined, onAccessRevoked);
    setData(result);
    setSelected((current) => (current && result.applications?.some((app) => app.id === current) ? current : result.applications?.[0]?.id ?? null));
  }, [filter, q, onAccessRevoked]);
  useEffect(() => {
    const timer = setTimeout(() => { load().catch((reason) => setError(reason.message)); }, q ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, q, setError]);

  const current = useMemo(() => data?.applications?.find((app) => app.id === selected) || null, [data, selected]);
  useEffect(() => { setNote(current?.note || ''); }, [current?.id, current?.note]);

  const decide = (status) => current && run(status, async () => {
    const result = await adminCall('PATCH', `/beta/${encodeURIComponent(current.id)}`, { status, note }, onAccessRevoked);
    const keep = filter === 'all' || filter === status;
    setData((d) => d && { ...d, counts: result.counts, applications: keep ? d.applications.map((app) => (app.id === result.application.id ? result.application : app)) : d.applications.filter((app) => app.id !== result.application.id) });
    if (!keep) setSelected(data?.applications?.filter((app) => app.id !== current.id)?.[0]?.id ?? null);
  }, status === 'approved' ? `${current.username} is a Super Beta Tester now. Badge, cape and Native+ given.` : status === 'rejected' ? `${current.username} rejected.` : status === 'waitlist' ? `${current.username} waitlisted.` : 'Moved back to pending.');

  const remove = () => current && ask(`del:${current.id}`) && run('del', async () => {
    const result = await adminCall('DELETE', `/beta/${encodeURIComponent(current.id)}`, undefined, onAccessRevoked);
    setData((d) => d && { ...d, counts: result.counts, applications: d.applications.filter((app) => app.id !== current.id) });
    setSelected(null);
  }, 'Application deleted.');

  const beta = doc?.settings?.beta || data?.settings || { open: true, closesAt: null, maxTesters: 0 };
  const saveBeta = (patch) => run('settings', async () => {
    setDoc(await adminCall('POST', '/site', { beta: patch }, onAccessRevoked));
    await load();
  }, 'Beta settings saved.');

  const counts = data?.counts;
  const answers = current?.answers || {};
  const filterOptions = FILTERS.map(([id, label]) => [id, <>{label}{counts && <em className="admin-filter-count">{counts[id]}</em>}</>]);
  return (
    <>
      {error && <div className="admin-error" role="alert"><span>{error}</span></div>}
      <div className="admin-kpis">
        <div className="admin-kpi"><span className="admin-kpi-icon"><Inbox size={15} /></span><span className="admin-kpi-label">To review</span><strong className="admin-kpi-value">{counts ? formatNumber(counts.pending) : '—'}</strong><span className="admin-kpi-hint">{data ? (data.open ? 'Applications open' : 'Applications closed') : ''}</span></div>
        <div className="admin-kpi"><span className="admin-kpi-icon"><Crown size={15} /></span><span className="admin-kpi-label">Super Beta Testers</span><strong className="admin-kpi-value">{counts ? formatNumber(counts.approved) : '—'}</strong><span className="admin-kpi-hint">{beta.maxTesters ? `of ${beta.maxTesters} spots` : 'No limit'}</span></div>
        <div className="admin-kpi"><span className="admin-kpi-icon"><Clock size={15} /></span><span className="admin-kpi-label">Waitlist</span><strong className="admin-kpi-value">{counts ? formatNumber(counts.waitlist) : '—'}</strong><span className="admin-kpi-hint">Next in line for a spot</span></div>
        <div className="admin-kpi"><span className="admin-kpi-icon"><ListChecks size={15} /></span><span className="admin-kpi-label">All applications</span><strong className="admin-kpi-value">{counts ? formatNumber(counts.all) : '—'}</strong><span className="admin-kpi-hint">{counts ? `${counts.rejected} rejected` : ''}</span></div>
      </div>

      <section className="admin-card">
        <div className="admin-card-head"><h3><Bug size={14} />Program settings</h3><span>Existing applications can always be reviewed</span></div>
        <div className="admin-form-grid is-three">
          <AdminSwitch on={beta.open} disabled={busy === 'settings'} onChange={(v) => saveBeta({ open: v })} label="Accept applications" hint={beta.open ? 'The form is live on the website’s /beta page.' : 'The form shows “closed”.'} />
          <div className="admin-field"><span>Close automatically at</span>
            <AdminDateTime value={beta.closesAt} placeholder="Never" disabled={busy === 'settings'} onChange={(v) => { if (v !== (beta.closesAt ?? null)) saveBeta({ closesAt: v }); }} />
          </div>
          <div className="admin-field"><span>Max Super Beta Testers (0 = no limit)</span>
            <AdminNumber min={0} max={100000} value={beta.maxTesters || 0} disabled={busy === 'settings'} onChange={(v) => { if (v !== (beta.maxTesters || 0)) saveBeta({ maxTesters: v }); }} />
          </div>
        </div>
      </section>

      <section className="admin-panel admin-apps">
        <div className="admin-toolbar">
          <AdminSegmented value={filter} onChange={setFilter} options={filterOptions} ariaLabel="Application status" />
          <label className="admin-search"><Search size={14} /><input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search name, Discord, answers…" /></label>
        </div>
        {!data ? <div className="admin-loading"><LoaderCircle size={18} className="is-spinning" /><span>Loading applications…</span></div>
          : !data.applications?.length ? <div className="admin-loading"><Users size={16} /><span>{filter === 'pending' ? 'Inbox zero. No applications waiting.' : 'Nothing here.'}</span></div>
            : (
              <div className="admin-apps-body">
                <div className="admin-apps-list">
                  {data.applications.map((app) => (
                    <button key={app.id} type="button" className={`admin-user-row${selected === app.id ? ' is-selected' : ''}`} onClick={() => setSelected(app.id)}>
                      <InitialAvatar name={app.username} size="sm" />
                      <span className="admin-user-main">
                        <span className="admin-user-name"><strong>{app.username}</strong>{app.status !== 'pending' && <span className={`admin-chip ${app.status === 'approved' ? 'is-live' : 'is-test'} is-inline`}>{LABEL[app.status]}</span>}</span>
                        <small>{app.answers?.discord} · {PLATFORM[app.answers?.platform] || '–'} · {hours(app.answers?.hours)}h/wk</small>
                      </span>
                      <small className="admin-apps-date">{new Date(app.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</small>
                    </button>
                  ))}
                </div>
                {current && (
                  <article className="admin-app" key={current.id}>
                    <header>
                      <h3>{current.username} <span className={`admin-chip ${current.status === 'approved' ? 'is-live' : 'is-test'} is-inline`}>{LABEL[current.status]}</span></h3>
                      <small>{current.email || 'no email'} · account since {formatDate(current.accountCreatedAt)}</small>
                      <small>Applied {formatDate(current.createdAt)}{current.updatedAt !== current.createdAt ? ` · edited ${formatDate(current.updatedAt)}` : ''}</small>
                      {current.reviewedAt && <small>Reviewed {formatDate(current.reviewedAt)}{current.reviewedBy ? ` by ${current.reviewedBy}` : ''}</small>}
                    </header>
                    <dl className="admin-app-facts">
                      {[
                        ['Discord', answers.discord], ['Age', answers.age || '–'], ['Platform', PLATFORM[answers.platform] || '–'], ['Time zone', answers.timezone || '–'],
                        ['PC', answers.specs || '–'], ['Hours a week', hours(answers.hours)], ['Versions', (answers.versions || []).join(', ') || '–'], ['Plays', (answers.playstyle || []).join(', ') || '–']
                      ].map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
                    </dl>
                    <div className="admin-app-text"><span>Why they want in</span><p>{answers.why}</p></div>
                    {answers.experience && <div className="admin-app-text"><span>Testing experience</span><p>{answers.experience}</p></div>}
                    <label className="admin-field"><span>Note to the player (shown with the decision)</span>
                      <textarea rows={3} maxLength={400} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Welcome aboard! Check Discord for the testers channel." />
                    </label>
                    <div className="admin-row-actions">
                      <button type="button" className="admin-btn primary" disabled={Boolean(busy) || current.status === 'approved'} onClick={() => decide('approved')}>{busy === 'approved' ? <LoaderCircle size={13} className="is-spinning" /> : <Check size={13} />}Accept</button>
                      <button type="button" className="admin-btn ghost" disabled={Boolean(busy) || current.status === 'waitlist'} onClick={() => decide('waitlist')}>{busy === 'waitlist' ? <LoaderCircle size={13} className="is-spinning" /> : <Clock size={13} />}Waitlist</button>
                      <button type="button" className="admin-btn ghost" disabled={Boolean(busy) || current.status === 'rejected'} onClick={() => decide('rejected')}>{busy === 'rejected' ? <LoaderCircle size={13} className="is-spinning" /> : <X size={13} />}Reject</button>
                      {current.status !== 'pending' && <button type="button" className="admin-btn ghost" disabled={Boolean(busy)} onClick={() => decide('pending')}>Back to pending</button>}
                      {current.status !== 'pending' && (current.note || '') !== note && <button type="button" className="admin-btn ghost" disabled={Boolean(busy)} onClick={() => decide(current.status)}>Save note</button>}
                      <span className="admin-head-spacer" />
                      <button type="button" className={`admin-icon-btn${armed === `del:${current.id}` ? ' is-danger' : ''}`} title={armed === `del:${current.id}` ? `Click again to delete${current.status === 'approved' ? ' (takes their beta perks back)' : ''}` : 'Delete application'} aria-label="Delete application" disabled={Boolean(busy)} onClick={remove}>
                        {busy === 'del' ? <LoaderCircle size={13} className="is-spinning" /> : <Trash2 size={13} />}
                      </button>
                    </div>
                    {current.status === 'approved' && <p className="admin-note"><Crown size={12} /> Has the Super Beta Tester badge, cape and lifetime Native+.</p>}
                  </article>
                )}
              </div>
            )}
      </section>
    </>
  );
}
