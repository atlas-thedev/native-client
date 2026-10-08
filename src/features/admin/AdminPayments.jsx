import React, { useCallback, useEffect, useState } from 'react';
import { Check, CircleAlert, KeyRound, LoaderCircle, Power, Trash2, Wand2 } from 'lucide-react';
import { adminError } from './adminShared.jsx';

const EMPTY = { projectId: '', privateKey: '', publicToken: '', webhookSecret: '' };
const MODES = [
  { id: 'off', label: 'Off' },
  { id: 'test', label: 'Test (admins only)' },
  { id: 'live', label: 'Live' }
];
const MODE_NOTE = {
  off: 'Checkouts are switched off.',
  test: 'Only admins can check out now — use Tebex’s test payment method.',
  live: 'Checkouts now take real payments.'
};

/**
 * Tebex Checkout keys + mode. Secrets go straight to the Native server and can never be
 * read back — the server only returns a short hint.
 */
export default function AdminPayments({ onNotify, onAccessRevoked, onChanged }) {
  const [settings, setSettings] = useState(null);
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
    if (!result?.ok) throw adminError(result, 'Could not load the Tebex settings.', onAccessRevoked);
    setSettings(result.settings);
  }, [onAccessRevoked]);
  useEffect(() => { load().catch((reason) => setError(reason?.message || 'Could not load the Tebex settings.')); }, [load]);

  const run = async (key, fn) => {
    if (busy) return;
    setBusy(key);
    setError('');
    try { await fn(); } catch (reason) { setError(reason?.message || 'Something went wrong.'); } finally { setBusy(''); }
  };

  const save = (event) => {
    event.preventDefault();
    run('save', async () => {
      const payload = {};
      for (const [k, v] of Object.entries(draft)) if (v.trim()) payload[k] = v.trim();
      if (!Object.keys(payload).length) throw new Error('Paste at least one value to save.');
      apply(await window.native?.admin?.billingSaveSettings?.(payload), 'Could not save the keys.');
      setDraft(EMPTY);
      onNotify?.('Tebex', 'Keys saved on the server.');
    });
  };
  const check = () => run('setup', async () => {
    const result = apply(await window.native?.admin?.billingSetup?.(), 'Tebex check failed.');
    setSteps(result.steps || []);
    onNotify?.('Tebex', 'Keys checked.');
    onChanged?.();
  });
  const activate = (mode) => run(`mode:${mode}`, async () => {
    apply(await window.native?.admin?.billingActivate?.(mode), 'Could not switch checkouts.');
    onNotify?.('Tebex', MODE_NOTE[mode]);
    onChanged?.();
  });
  const clearKey = () => run('clear', async () => {
    apply(await window.native?.admin?.billingSaveSettings?.({ clear: ['privateKey'] }), 'Could not remove the key.');
    onNotify?.('Tebex', 'Private key removed. Checkouts stop until you add a new one.');
  });

  const s = settings;
  const mode = s?.mode || 'off';
  const row = (label, value, ok) => (
    <div className="admin-pay-check">
      {ok ? <Check size={12} /> : <CircleAlert size={12} />}
      <span>{label}</span>
      <code>{value || 'missing'}</code>
    </div>
  );
  const field = (key, label, saved, placeholder, secret) => (
    <label className="admin-field"><span>{label} {saved && <em>saved {saved}</em>}</span>
      <input type={secret ? 'password' : 'text'} value={draft[key]} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} placeholder={saved ? 'Paste a new value to replace it' : placeholder} spellCheck={false} />
    </label>
  );

  return (
    <section className="admin-card admin-pay">
      <div className="admin-card-head">
        <h3><KeyRound size={14} />Tebex setup</h3>
        {s && <span className={`admin-chip ${mode === 'live' ? 'is-live' : 'is-test'}`}>Checkouts: {mode === 'live' ? 'Live' : mode === 'test' ? 'Test mode' : 'Off'}</span>}
      </div>
      {error && <div className="admin-error" role="alert"><span>{error}</span></div>}

      <form className="admin-pay-form" onSubmit={save} autoComplete="off">
        {field('projectId', 'Project ID', s?.projectId, 'e.g. 1234567')}
        {field('privateKey', 'Private key', s?.privateKey, 'From Tebex → Settings → API keys', true)}
        {field('publicToken', 'Public token', s?.publicToken ? `${s.publicToken.slice(0, 6)}…` : null, 'Used by the website for the payment portal')}
        {field('webhookSecret', 'Webhook secret', s?.webhookSecret ? 'yes' : null, 'From Tebex → Webhooks → Endpoints', true)}
        <div className="admin-pay-actions">
          <button type="submit" className="admin-btn" disabled={Boolean(busy)}>{busy === 'save' ? <LoaderCircle size={13} className="is-spinning" /> : <KeyRound size={13} />}Save keys</button>
          <button type="button" className="admin-btn primary" onClick={check} disabled={Boolean(busy) || !s?.projectId || !s?.privateKey}>{busy === 'setup' ? <LoaderCircle size={13} className="is-spinning" /> : <Wand2 size={13} />}Check keys</button>
          {s?.privateKey && !s?.fromEnvFile && (
            <button type="button" className="admin-icon-btn" onClick={clearKey} disabled={Boolean(busy)} title="Remove the saved private key" aria-label="Remove the saved private key"><Trash2 size={13} /></button>
          )}
        </div>
      </form>

      {s && (
        <div className="admin-pay-checks">
          {row('Project ID', s.projectId, s.projectId)}
          {row('Private key', s.privateKey, s.privateKey)}
          {row('Public token', s.publicToken ? `${s.publicToken.slice(0, 6)}…` : null, s.publicToken)}
          {row('Webhook secret', s.webhookSecret ? 'saved' : null, s.webhookSecret)}
          {row('Keys checked', s.checkedAt ? new Date(s.checkedAt).toLocaleString() : null, s.checkedAt)}
        </div>
      )}

      <div className="admin-tabs admin-pay-env" role="tablist" aria-label="Checkout mode">
        {MODES.map((m) => (
          <button key={m.id} type="button" role="tab" aria-selected={mode === m.id} className={mode === m.id ? 'active' : ''}
            onClick={() => mode !== m.id && activate(m.id)} disabled={Boolean(busy) || (m.id !== 'off' && !s?.ready)}>
            {busy === `mode:${m.id}` ? <LoaderCircle size={12} className="is-spinning" /> : <Power size={12} />}{m.label}
          </button>
        ))}
      </div>

      {steps.length > 0 && <p className="admin-note">{steps.join(' · ')}</p>}
      <p className="admin-note">
        In Tebex, add a webhook endpoint for <code>{s?.webhookUrl || 'https://api.playnative.fun/v1/billing/tebex/webhook'}</code> with
        all payment and recurring-payment events, then paste its secret here. Keys are stored only on the Native server and can’t be read back.
        Test mode lets only admins check out (use Tebex’s test payment method); go live once Tebex has approved Checkout API access.
      </p>
    </section>
  );
}
