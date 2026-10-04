import React, { useCallback, useEffect, useState } from 'react';
import { Check, CircleAlert, KeyRound, LoaderCircle, Power, Trash2, Wand2 } from 'lucide-react';
import { adminError } from './adminShared.jsx';

const ENV_LABEL = { sandbox: 'Sandbox', production: 'Live' };
const EMPTY = { apiKey: '', clientToken: '', webhookSecret: '' };

/**
 * Paddle keys per environment + one-click setup. Secrets go straight to the Native server and
 * can never be read back — the server only returns the last 4 characters.
 */
export default function AdminPayments({ onNotify, onAccessRevoked, onChanged }) {
  const [settings, setSettings] = useState(null);
  const [env, setEnv] = useState('production');
  const [draft, setDraft] = useState(EMPTY);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [steps, setSteps] = useState([]);

  const apply = (result, fallback) => {
    if (!result?.ok) throw adminError(result, fallback, onAccessRevoked);
    setSettings(result.settings);
    return result;
  };
  const load = useCallback(async () => {
    const result = await window.native?.admin?.billingSettings?.();
    if (!result?.ok) throw adminError(result, 'Could not load the Paddle settings.', onAccessRevoked);
    setSettings(result.settings);
  }, [onAccessRevoked]);
  useEffect(() => { load().catch((reason) => setError(reason?.message || 'Could not load the Paddle settings.')); }, [load]);
  useEffect(() => { setDraft(EMPTY); setSteps([]); setError(''); }, [env]);

  const run = async (key, fn) => {
    if (busy) return;
    setBusy(key);
    setError('');
    try { await fn(); } catch (reason) { setError(reason?.message || 'Something went wrong.'); } finally { setBusy(''); }
  };

  const save = (event) => {
    event.preventDefault();
    run('save', async () => {
      const payload = { environment: env };
      for (const [k, v] of Object.entries(draft)) if (v.trim()) payload[k] = v.trim();
      if (Object.keys(payload).length === 1) throw new Error('Paste at least one key to save.');
      apply(await window.native?.admin?.billingSaveSettings?.(payload), 'Could not save the keys.');
      setDraft(EMPTY);
      onNotify?.('Paddle', `${ENV_LABEL[env]} keys saved on the server.`);
    });
  };
  const setup = () => run('setup', async () => {
    const result = apply(await window.native?.admin?.billingSetup?.(env), 'Paddle setup failed.');
    setSteps(result.steps || []);
    onNotify?.('Paddle', `${ENV_LABEL[env]} is set up.`);
    onChanged?.();
  });
  const activate = () => run('activate', async () => {
    apply(await window.native?.admin?.billingActivate?.(env), 'Could not switch checkouts.');
    onNotify?.('Paddle', env === 'production' ? 'Checkouts now take real payments.' : 'Checkouts are back in test mode.');
    onChanged?.();
  });
  const clearKey = () => run('clear', async () => {
    apply(await window.native?.admin?.billingSaveSettings?.({ environment: env, clear: ['apiKey'] }), 'Could not remove the key.');
    onNotify?.('Paddle', `${ENV_LABEL[env]} API key removed. Checkouts in ${ENV_LABEL[env].toLowerCase()} stop until you add a new one.`);
  });

  const cur = settings?.environments?.[env];
  const active = settings?.active;
  const row = (label, value, ok) => (
    <div className="admin-pay-check">
      {ok ? <Check size={12} /> : <CircleAlert size={12} />}
      <span>{label}</span>
      <code>{value || 'missing'}</code>
    </div>
  );

  return (
    <section className="admin-card admin-pay">
      <div className="admin-card-head">
        <h3><KeyRound size={14} />Paddle setup</h3>
        {settings && <span className={`admin-chip ${active === 'production' ? 'is-live' : 'is-test'}`}>Checkouts: {active === 'production' ? 'Live' : 'Test mode'}</span>}
      </div>
      {error && <div className="admin-error" role="alert"><span>{error}</span></div>}

      <div className="admin-tabs admin-pay-env" role="tablist">
        {['production', 'sandbox'].map((name) => (
          <button key={name} type="button" role="tab" aria-selected={env === name} className={env === name ? 'active' : ''} onClick={() => setEnv(name)}>
            {ENV_LABEL[name]}{settings?.environments?.[name]?.ready && <span>ready</span>}
          </button>
        ))}
      </div>

      <form className="admin-pay-form" onSubmit={save} autoComplete="off">
        <label className="admin-field"><span>API key {cur?.apiKey && <em>saved {cur.apiKey}</em>}</span>
          <input type="password" value={draft.apiKey} onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))} placeholder={cur?.apiKey ? 'Paste a new key to replace it' : env === 'production' ? 'pdl_live_apikey_…' : 'pdl_sdbx_apikey_…'} spellCheck={false} />
        </label>
        <label className="admin-field"><span>Client-side token {cur?.clientToken && <em>saved {cur.clientToken.slice(0, 9)}…</em>}</span>
          <input value={draft.clientToken} onChange={(e) => setDraft((d) => ({ ...d, clientToken: e.target.value }))} placeholder={env === 'production' ? 'live_…' : 'test_…'} spellCheck={false} />
        </label>
        <label className="admin-field"><span>Webhook secret {cur?.webhookSecret ? <em>saved</em> : <em>optional — Set up fills it</em>}</span>
          <input type="password" value={draft.webhookSecret} onChange={(e) => setDraft((d) => ({ ...d, webhookSecret: e.target.value }))} placeholder="pdl_ntfset_…" spellCheck={false} />
        </label>
        <div className="admin-pay-actions">
          <button type="submit" className="admin-btn" disabled={Boolean(busy)}>{busy === 'save' ? <LoaderCircle size={13} className="is-spinning" /> : <KeyRound size={13} />}Save keys</button>
          <button type="button" className="admin-btn primary" onClick={setup} disabled={Boolean(busy) || !cur?.apiKey}>{busy === 'setup' ? <LoaderCircle size={13} className="is-spinning" /> : <Wand2 size={13} />}Set up Paddle</button>
          {cur?.ready && active !== env && (
            <button type="button" className="admin-btn" onClick={activate} disabled={Boolean(busy)}>{busy === 'activate' ? <LoaderCircle size={13} className="is-spinning" /> : <Power size={13} />}{env === 'production' ? 'Go live' : 'Use test mode'}</button>
          )}
          {cur?.apiKey && !cur?.fromEnvFile && (
            <button type="button" className="admin-icon-btn" onClick={clearKey} disabled={Boolean(busy)} title="Remove the saved API key" aria-label="Remove the saved API key"><Trash2 size={13} /></button>
          )}
        </div>
      </form>

      {cur && (
        <div className="admin-pay-checks">
          {row('Cape product', cur.capeProduct, cur.capeProduct)}
          {row('Native+ product', cur.plusProduct, cur.plusProduct)}
          {row('Monthly $2.99', cur.monthlyPrice, cur.monthlyPrice)}
          {row('Yearly $24.99', cur.yearlyPrice, cur.yearlyPrice)}
          {row('Webhook', cur.notificationId, cur.notificationId && cur.webhookSecret)}
        </div>
      )}
      {steps.length > 0 && <p className="admin-note">{steps.join(' · ')}</p>}
      <p className="admin-note">
        Keys are stored only on the Native server and can’t be read back. Set up Paddle creates or finds the products, prices and the webhook
        ({settings?.webhookUrl || 'api.nativelaunch.xyz'}). Keep the API key in place while selling — the server needs it to start checkouts; rotate it here any time.
        Go live only after Paddle has approved nativelaunch.xyz.
      </p>
    </section>
  );
}
