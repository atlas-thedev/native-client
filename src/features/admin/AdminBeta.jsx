import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlaskConical, Github, LoaderCircle, Plus, RefreshCw, Search, Trash2, UserCheck, Users } from 'lucide-react';
import { InitialAvatar, adminError, formatAgo, formatNumber } from './adminShared.jsx';

const PLATFORM = { win32: 'Windows', windows: 'Windows', darwin: 'macOS', macos: 'macOS', linux: 'Linux' };
const MODES = [
  ['on', 'On'],
  ['auto', 'Auto'],
  ['off', 'Off']
];

/**
 * Beta updates: who gets launcher pre-releases (vX.Y.Z-beta.N).
 * Admins add anyone by username; accepted Super Beta Testers join automatically
 * (unless that's switched off). Each tester can be forced on / off or left on Auto.
 */
export default function AdminBeta({ onNotify, onAccessRevoked }) {
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const apply = (result, fallback) => {
    if (!result?.ok) throw adminError(result, fallback, onAccessRevoked);
    return result;
  };
  const load = useCallback(async () => {
    const result = apply(await window.native?.admin?.betaTesters?.(''), 'Could not load beta testers.');
    setData(result);
  }, [onAccessRevoked]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  const run = async (key, fn) => {
    if (busy) return;
    setBusy(key);
    setError('');
    try { await fn(); } catch (e) { setError(e?.message || 'Something went wrong.'); } finally { setBusy(''); }
  };
  const merge = (result) => setData((d) => (d ? { ...d, testers: result.testers ?? d.testers, config: result.config ?? d.config } : d));

  const add = (event) => {
    event.preventDefault();
    const username = name.trim();
    if (!username) return;
    run('add', async () => {
      merge(apply(await window.native?.admin?.betaAddTester?.(username), 'Could not add that player.'));
      setName('');
      onNotify?.('Beta updates', `${username} now gets beta builds.`);
      load().catch(() => {});
    });
  };
  const setMode = (tester, mode) => run(`mode:${tester.userId}`, async () => {
    merge(apply(await window.native?.admin?.betaSetTester?.(tester.userId, mode === 'on' ? true : mode === 'off' ? false : null), 'Could not update the tester.'));
  });
  const remove = (tester) => run(`del:${tester.userId}`, async () => {
    merge(apply(await window.native?.admin?.betaRemoveTester?.(tester.userId), 'Could not remove the tester.'));
    onNotify?.('Beta updates', tester.accepted ? `${tester.username} is back on Auto.` : `${tester.username} is back on stable builds.`);
  });
  const saveConfig = (patch) => run('config', async () => {
    merge(apply(await window.native?.admin?.betaUpdates?.(patch), 'Could not save.'));
    load().catch(() => {});
  });

  const testers = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.testers || []).filter((t) => !needle || t.username.toLowerCase().includes(needle));
  }, [data, q]);
  const cfg = data?.config || { enabled: true, includeAccepted: true };
  const rel = data?.releases || {};

  return (
    <div className="admin-scroll admin-beta">
      <div className="admin-kpis">
        <div className="admin-kpi"><span className="admin-kpi-icon"><FlaskConical size={15} /></span><span className="admin-kpi-label">Beta testers</span><strong className="admin-kpi-value">{data ? formatNumber(data.stats?.active) : '—'}</strong><span className="admin-kpi-hint">{cfg.enabled ? 'Getting beta builds' : 'Channel switched off'}</span></div>
        <div className="admin-kpi"><span className="admin-kpi-icon"><UserCheck size={15} /></span><span className="admin-kpi-label">Seen this week</span><strong className="admin-kpi-value">{data ? formatNumber(data.stats?.seen7d) : '—'}</strong><span className="admin-kpi-hint">Opened Native in 7 days</span></div>
        <div className="admin-kpi"><span className="admin-kpi-icon"><Users size={15} /></span><span className="admin-kpi-label">On latest beta</span><strong className="admin-kpi-value">{data ? formatNumber(data.stats?.onBeta) : '—'}</strong><span className="admin-kpi-hint">{rel.beta ? `v${rel.beta.version}` : 'No beta released yet'}</span></div>
        <div className="admin-kpi"><span className="admin-kpi-icon"><Github size={15} /></span><span className="admin-kpi-label">Latest stable</span><strong className="admin-kpi-value">{rel.stable ? `v${rel.stable.version}` : '—'}</strong><span className="admin-kpi-hint">{rel.stable?.publishedAt ? formatAgo(rel.stable.publishedAt) : 'GitHub Releases'}</span></div>
      </div>

      <div className="admin-beta-grid">
        <section className="admin-card">
          <div className="admin-card-head"><h3><FlaskConical size={14} />Beta channel</h3></div>
          <div className="admin-beta-switches">
            <BetaSwitch on={cfg.enabled} disabled={busy === 'config'} label="Beta updates" hint="Off = every launcher stays on stable builds, testers included." onChange={(v) => saveConfig({ enabled: v })} />
            <BetaSwitch on={cfg.includeAccepted} disabled={busy === 'config' || !cfg.enabled} label="Accepted Super Beta Testers" hint="Players accepted on the website join automatically (Auto)." onChange={(v) => saveConfig({ includeAccepted: v })} />
          </div>
          <p className="admin-note">
            Ship a beta with <code>release.bat</code> → option <strong>beta</strong> (tag <code>vX.Y.Z-beta.N</code>). Only testers get it; when the
            stable release comes out testers move onto it too.
          </p>
          {rel.beta && (
            <a className="admin-beta-release" href={rel.beta.url} onClick={(e) => { e.preventDefault(); window.native?.openExternal?.(rel.beta.url); }}>
              <em>Beta</em><strong>v{rel.beta.version}</strong><small>{formatAgo(rel.beta.publishedAt)} · {formatNumber(rel.beta.downloads)} downloads</small>
            </a>
          )}
        </section>

        <section className="admin-card is-wide">
          <div className="admin-card-head">
            <h3><Users size={14} />Testers</h3>
            <button type="button" className="admin-btn ghost" onClick={() => run('reload', load)} disabled={!!busy}>
              <RefreshCw size={13} className={busy === 'reload' ? 'is-spinning' : ''} /><span>Refresh</span>
            </button>
          </div>
          <form className="admin-beta-add" onSubmit={add}>
            <label className="admin-search"><Plus size={13} /><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Add a player by Native username" maxLength={40} /></label>
            <button type="submit" className="admin-btn primary" disabled={!name.trim() || busy === 'add'}>
              {busy === 'add' ? <LoaderCircle size={13} className="is-spinning" /> : <Plus size={13} />}<span>Add tester</span>
            </button>
            <label className="admin-search admin-beta-filter"><Search size={13} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" /></label>
          </form>
          {error && <div className="admin-error" role="alert"><span>{error}</span></div>}
          <div className="admin-beta-list">
            {!data ? <p className="admin-note">Loading…</p> : !testers.length ? (
              <p className="admin-note">{q ? 'No testers match.' : 'No beta testers yet. Add someone above, or accept applications on the website.'}</p>
            ) : testers.map((t) => (
              <div key={t.userId} className={`admin-beta-row${t.active ? ' is-active' : ''}`}>
                <InitialAvatar name={t.username} size="sm" />
                <span className="admin-beta-who">
                  <strong>{t.username}</strong>
                  <small>
                    {t.accepted ? 'Accepted applicant' : `Added${t.addedBy ? ` by ${t.addedBy}` : ''}`}
                    {t.lastSeenAt ? ` · v${t.lastVersion || '?'} on ${PLATFORM[t.lastPlatform] || 'unknown'} · ${formatAgo(t.lastSeenAt)}` : ' · not seen yet'}
                  </small>
                </span>
                <span className={`admin-beta-state${t.active ? ' is-on' : ''}`}>{t.active ? 'Beta' : 'Stable'}</span>
                <span className="admin-beta-modes" role="radiogroup" aria-label={`${t.username} beta mode`}>
                  {MODES.filter(([id]) => id !== 'auto' || t.accepted).map(([id, label]) => (
                    <button key={id} type="button" role="radio" aria-checked={t.mode === id} className={t.mode === id ? 'is-on' : ''} disabled={!!busy} onClick={() => t.mode !== id && setMode(t, id)}>{label}</button>
                  ))}
                </span>
                <button type="button" className="admin-btn ghost admin-beta-del" title={t.accepted ? 'Reset to Auto' : 'Remove from beta'} aria-label="Remove" disabled={!!busy} onClick={() => remove(t)}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function BetaSwitch({ on, onChange, label, hint, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled} className={`admin-beta-switch${on ? ' is-on' : ''}`} onClick={() => onChange(!on)}>
      <span><strong>{label}</strong><small>{hint}</small></span>
      <i aria-hidden="true"><b /></i>
    </button>
  );
}
