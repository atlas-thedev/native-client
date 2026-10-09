import React, { useCallback, useEffect, useState } from 'react';
import { Check, CircleAlert, Globe, KeyRound, LoaderCircle, Mail, Plus, RefreshCw, Server, Star, Trash2 } from 'lucide-react';
import { adminCall } from './adminShared.jsx';

const EMPTY_SETTINGS = { cloudflareToken: '', accountId: '', serverIp: '' };

/**
 * Domain autopilot. Buy a domain, paste it here and the Native server sets up Cloudflare
 * (zone, DNS to this server, SSL, https) and Resend email for it. The backend always stays
 * on api.nativelaunch.xyz — only the website and email move to new domains.
 */
export default function AdminDomains({ onNotify, onAccessRevoked }) {
  const [doc, setDoc] = useState(null);
  const [draft, setDraft] = useState(EMPTY_SETTINGS);
  const [form, setForm] = useState({ domain: '', website: true, email: true, mode: 'main' });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [steps, setSteps] = useState([]);

  const call = useCallback((method, path, body) => adminCall(method, path, body, onAccessRevoked), [onAccessRevoked]);
  const load = useCallback(async () => setDoc(await call('GET', '/domains')), [call]);
  useEffect(() => { load().catch((e) => setError(e?.message || 'Could not load domains.')); }, [load]);

  const run = async (key, fn) => {
    if (busy) return;
    setBusy(key);
    setError('');
    try { await fn(); } catch (e) { setError(e?.message || 'Something went wrong.'); } finally { setBusy(''); }
  };

  const saveSettings = (event) => {
    event.preventDefault();
    run('settings', async () => {
      const payload = {};
      for (const [k, v] of Object.entries(draft)) if (v.trim()) payload[k] = v.trim();
      if (!Object.keys(payload).length) throw new Error('Paste at least one value to save.');
      setDoc(await call('POST', '/domains/settings', payload));
      setDraft(EMPTY_SETTINGS);
      onNotify?.('Domains', 'Settings saved on the server.');
    });
  };
  const addDomain = (event) => {
    event.preventDefault();
    run('add', async () => {
      if (!form.domain.trim()) throw new Error('Type the domain you bought.');
      if (!form.website && !form.email) throw new Error('Pick website, email or both.');
      const result = await call('POST', '/domains', { ...form, domain: form.domain.trim() });
      setDoc(result);
      setSteps(result.steps || []);
      setForm((f) => ({ ...f, domain: '' }));
      onNotify?.('Domains', 'Domain set up. If it’s new to Cloudflare, change the nameservers at your registrar.');
    });
  };
  const act = (name, key, method, suffix, body, note) => run(`${key}:${name}`, async () => {
    setDoc(await call(method, `/domains/${encodeURIComponent(name)}${suffix}`, body));
    if (note) onNotify?.('Domains', note);
  });

  const s = doc?.settings;
  const ready = Boolean(s?.cloudflareToken);
  const spin = (key, Icon) => (busy === key ? <LoaderCircle size={13} className="is-spinning" /> : <Icon size={13} />);
  const flag = (label, value, ok) => (
    <div className="admin-pay-check">{ok ? <Check size={12} /> : <CircleAlert size={12} />}<span>{label}</span><code>{value || '—'}</code></div>
  );

  return (
    <div className="admin-scroll">
      {error && <div className="admin-error" role="alert"><span>{error}</span></div>}

      <section className="admin-card admin-pay">
        <div className="admin-card-head">
          <h3><Server size={14} />Where things live</h3>
        </div>
        <div className="admin-pay-checks">
          {flag('Backend (never moves)', s?.backend || 'https://api.nativelaunch.xyz', true)}
          {flag('Main website', s?.primarySite, Boolean(s?.primarySite))}
          {flag('Email sender', s?.emailFrom, Boolean(s?.emailFrom))}
          {flag('Resend key on server', s?.resend ? 'yes' : null, s?.resend)}
        </div>
      </section>

      <section className="admin-card admin-pay">
        <div className="admin-card-head">
          <h3><KeyRound size={14} />Cloudflare</h3>
          {s && <span className={`admin-chip ${ready ? 'is-live' : 'is-test'}`}>{ready ? `Token ${s.cloudflareToken}${s.tokenFromEnv ? ' (env)' : ''}` : 'No token'}</span>}
        </div>
        <form className="admin-pay-form" onSubmit={saveSettings} autoComplete="off">
          <label className="admin-field"><span>API token</span>
            <input type="password" value={draft.cloudflareToken} onChange={(e) => setDraft((d) => ({ ...d, cloudflareToken: e.target.value }))} placeholder={ready ? 'Paste a new token to replace it' : 'Cloudflare → My Profile → API Tokens'} spellCheck={false} />
          </label>
          <label className="admin-field"><span>Account ID {s?.accountId && <em>saved</em>}</span>
            <input type="text" value={draft.accountId} onChange={(e) => setDraft((d) => ({ ...d, accountId: e.target.value }))} placeholder={s?.accountId || 'Needed to add new domains to Cloudflare'} spellCheck={false} />
          </label>
          <label className="admin-field"><span>Server IP</span>
            <input type="text" value={draft.serverIp} onChange={(e) => setDraft((d) => ({ ...d, serverIp: e.target.value }))} placeholder={s?.serverIp || '3.106.132.147'} spellCheck={false} />
          </label>
          <div className="admin-pay-actions">
            <button type="submit" className="admin-btn" disabled={Boolean(busy)}>{spin('settings', KeyRound)}Save</button>
          </div>
        </form>
        <p className="admin-note">Token permissions: Zone → Zone (Edit), DNS (Edit), Zone Settings (Edit), Single Redirect (Edit), for all zones. Stored only on the Native server.</p>
      </section>

      <section className="admin-card admin-pay">
        <div className="admin-card-head"><h3><Plus size={14} />Add a domain</h3></div>
        <form className="admin-pay-form" onSubmit={addDomain} autoComplete="off">
          <label className="admin-field"><span>Domain</span>
            <input type="text" value={form.domain} onChange={(e) => setForm((f) => ({ ...f, domain: e.target.value }))} placeholder="e.g. playnative.fun" spellCheck={false} />
          </label>
          <label className="admin-check"><input type="checkbox" checked={form.website} onChange={(e) => setForm((f) => ({ ...f, website: e.target.checked }))} /> Website</label>
          <label className="admin-check"><input type="checkbox" checked={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.checked }))} /> Email (Resend)</label>
          {form.website && (
            <div className="admin-tabs" role="tablist" aria-label="Website mode">
              {[['main', 'Show the website'], ['redirect', 'Redirect to main site']].map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={form.mode === id} className={form.mode === id ? 'active' : ''} onClick={() => setForm((f) => ({ ...f, mode: id }))}>{label}</button>
              ))}
            </div>
          )}
          <div className="admin-pay-actions">
            <button type="submit" className="admin-btn primary" disabled={Boolean(busy) || !ready}>{spin('add', Globe)}Set it up</button>
          </div>
        </form>
        {steps.length > 0 && <p className="admin-note">{steps.join(' · ')}</p>}
      </section>

      {(doc?.domains || []).map((d) => {
        const st = d.status || {};
        const pending = st.zone && st.zone !== 'active';
        return (
          <section key={d.name} className="admin-card admin-pay">
            <div className="admin-card-head">
              <h3><Globe size={14} />{d.name}</h3>
              {d.primarySite && <span className="admin-chip is-live">Main website</span>}
              {d.emailSender && <span className="admin-chip is-live">Email sender</span>}
              {d.mode === 'redirect' && <span className="admin-chip is-test">Redirects</span>}
            </div>
            <div className="admin-pay-checks">
              {flag('Cloudflare', st.cloudflareError || st.zone, st.zone === 'active')}
              {d.website && flag('DNS → server', st.dns, st.dns === 'ok')}
              {d.website && flag('HTTPS', st.https?.ok ? `ok (${st.https.status})` : st.https?.error || st.https?.status, st.https?.ok)}
              {d.email && flag('Email', st.emailError || st.email, st.email === 'verified')}
              {st.checkedAt && flag('Checked', new Date(st.checkedAt).toLocaleString(), true)}
            </div>
            {pending && st.nameServers?.length > 0 && (
              <p className="admin-note">At your registrar, set the nameservers to <code>{st.nameServers.join('</code> and <code>')}</code>. It can take a few hours.</p>
            )}
            <div className="admin-pay-actions">
              <button type="button" className="admin-btn" onClick={() => act(d.name, 'check', 'POST', '/check')} disabled={Boolean(busy)}>{spin(`check:${d.name}`, RefreshCw)}Check</button>
              {d.website && !d.primarySite && <button type="button" className="admin-btn" onClick={() => act(d.name, 'site', 'POST', '/primary', { use: 'site' }, `${d.name} is now the main website. The site rebuilds in a few minutes.`)} disabled={Boolean(busy)}>{spin(`site:${d.name}`, Star)}Make main website</button>}
              {d.email && !d.emailSender && <button type="button" className="admin-btn" onClick={() => act(d.name, 'email', 'POST', '/primary', { use: 'email' }, `Emails now come from noreply@${d.name}.`)} disabled={Boolean(busy)}>{spin(`email:${d.name}`, Mail)}Use for email</button>}
              <button type="button" className="admin-icon-btn" onClick={() => window.confirm(`Remove ${d.name} from the list? Cloudflare and Resend are left as they are.`) && act(d.name, 'del', 'DELETE', '')} disabled={Boolean(busy)} title="Remove from list" aria-label={`Remove ${d.name}`}>{spin(`del:${d.name}`, Trash2)}</button>
            </div>
          </section>
        );
      })}
      <p className="admin-note">The website server answers any domain pointed at it, so new domains work as soon as Cloudflare is active. The backend stays on api.nativelaunch.xyz — keep that domain.</p>
    </div>
  );
}
