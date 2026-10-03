import React, { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Crown, DollarSign, LoaderCircle, Receipt, RotateCcw, Ticket, Trash2 } from 'lucide-react';
import Dropdown from '../../components/ui/Dropdown.jsx';
import { adminError, formatAgo, formatDate, formatNumber } from './adminShared.jsx';

const money = (value, currency = 'USD') => {
  try { return new Intl.NumberFormat([], { style: 'currency', currency }).format(Number(value) || 0); }
  catch { return `$${(Number(value) || 0).toFixed(2)}`; }
};

/** Sales, Noctra+ members, refunds, and redeem codes for event capes. */
export default function AdminSales({ items, onNotify, onAccessRevoked }) {
  const [overview, setOverview] = useState(null);
  const [codes, setCodes] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [copied, setCopied] = useState('');
  const [draft, setDraft] = useState({ itemId: '', code: '', maxUses: '100', expiresInDays: '30', note: '' });

  const load = useCallback(async () => {
    setError('');
    const [o, c] = await Promise.all([window.native?.admin?.billingOverview?.(), window.native?.admin?.billingCodes?.()]);
    if (!o?.ok) throw adminError(o, 'Could not load sales.', onAccessRevoked);
    setOverview(o);
    if (c?.ok) setCodes(c.codes || []);
  }, [onAccessRevoked]);

  useEffect(() => { load().catch((reason) => setError(reason?.message || 'Could not load sales.')); }, [load]);

  const createCode = async (event) => {
    event.preventDefault();
    if (!draft.itemId || busy) return;
    setBusy('create');
    setError('');
    try {
      const result = await window.native?.admin?.billingCreateCode?.({
        itemId: draft.itemId,
        code: draft.code.trim(),
        maxUses: Number(draft.maxUses) || 1,
        expiresInDays: Number(draft.expiresInDays) || 0,
        note: draft.note.trim()
      });
      if (!result?.ok) throw adminError(result, 'Could not create the code.', onAccessRevoked);
      setCodes(result.codes || []);
      setDraft((current) => ({ ...current, code: '', note: '' }));
      navigator.clipboard?.writeText(result.code);
      onNotify?.('Redeem code', `${result.code} created and copied.`);
    } catch (reason) {
      setError(reason?.message || 'Could not create the code.');
    } finally {
      setBusy('');
    }
  };

  const removeCode = async (code) => {
    if (busy) return;
    if (busy !== `confirm:${code}` && copied !== `del:${code}`) { setCopied(`del:${code}`); return; }
    setBusy(`delete:${code}`);
    try {
      const result = await window.native?.admin?.billingDeleteCode?.(code);
      if (!result?.ok) throw adminError(result, 'Could not delete the code.', onAccessRevoked);
      setCodes(result.codes || []);
    } catch (reason) {
      setError(reason?.message || 'Could not delete the code.');
    } finally {
      setBusy('');
      setCopied('');
    }
  };

  const copy = (code) => {
    navigator.clipboard?.writeText(code);
    setCopied(code);
    setTimeout(() => setCopied((current) => (current === code ? '' : current)), 1400);
  };

  const set = (key) => (event) => setDraft((current) => ({ ...current, [key]: event?.target ? event.target.value : event }));
  const capeOptions = [...(items || [])]
    .sort((a, b) => Number(Boolean(b.exclusive)) - Number(Boolean(a.exclusive)) || a.name.localeCompare(b.name))
    .map((item) => ({ value: item.id, label: `${item.name}${item.exclusive ? ' · Event' : item.paid ? ` · $${Number(item.price).toFixed(2)}` : ' · Free'}` }));

  return (
    <div className="admin-scroll">
      {error && <div className="admin-error" role="alert"><span>{error}</span></div>}
      {overview && !overview.enabled && <div className="admin-error" role="status"><span>Payments are off: the Paddle keys aren’t set on the server yet.</span></div>}

      <div className="admin-kpis">
        <div className="admin-kpi"><span className="admin-kpi-icon"><DollarSign size={15} /></span><span className="admin-kpi-label">Sales, all time</span><strong className="admin-kpi-value">{overview ? money(overview.sales.total) : '—'}</strong><span className="admin-kpi-hint">{overview ? `${formatNumber(overview.sales.count)} payments` : ''}</span></div>
        <div className="admin-kpi"><span className="admin-kpi-icon"><Receipt size={15} /></span><span className="admin-kpi-label">Last 30 days</span><strong className="admin-kpi-value">{overview ? money(overview.sales.last30) : '—'}</strong><span className="admin-kpi-hint">{overview ? `${formatNumber(overview.sales.last30Count)} payments` : ''}</span></div>
        <div className="admin-kpi"><span className="admin-kpi-icon"><Crown size={15} /></span><span className="admin-kpi-label">Noctra+ members</span><strong className="admin-kpi-value">{overview ? formatNumber(overview.plus.active) : '—'}</strong><span className="admin-kpi-hint">{overview ? `${overview.plus.monthly} monthly · ${overview.plus.yearly} yearly` : ''}</span></div>
        <div className="admin-kpi"><span className="admin-kpi-icon"><RotateCcw size={15} /></span><span className="admin-kpi-label">Refunds & chargebacks</span><strong className="admin-kpi-value">{overview ? formatNumber(overview.refunds.count) : '—'}</strong><span className="admin-kpi-hint">{overview ? money(overview.refunds.total) : ''}</span></div>
      </div>

      <div className="admin-overview-grid admin-sales-grid">
        <section className="admin-card">
          <div className="admin-card-head">
            <h3><Receipt size={14} />Recent payments</h3>
            {overview && <span className={`admin-chip ${overview.environment === 'production' ? 'is-live' : 'is-test'}`}>{overview.environment === 'production' ? 'Live' : 'Test mode'}</span>}
          </div>
          <div className="admin-sales-list">
            {!overview ? <p className="admin-note"><LoaderCircle size={12} className="is-spinning" /> Loading…</p>
              : !overview.recent.length ? <p className="admin-note">No payments yet.</p>
                : overview.recent.map((row) => (
                  <div key={row.transactionId} className={`admin-sale-row${row.status !== 'paid' ? ' is-refunded' : ''}`}>
                    <div className="admin-sale-main">
                      <strong>{row.kind === 'plus' ? `Noctra+ ${row.plan || ''}`.trim() : (row.itemName || row.itemId || 'Cape')}</strong>
                      <small>{row.username || 'Unknown player'} · <span title={formatDate(row.createdAt)}>{formatAgo(row.createdAt)}</span></small>
                    </div>
                    {row.status !== 'paid' && <span className="admin-chip is-refund">{row.status}</span>}
                    <span className="admin-sale-amount">{money(row.amount, row.currency)}</span>
                  </div>
                ))}
          </div>
          <p className="admin-note">Refunds are made in Paddle. Refunded capes are taken back automatically.</p>
        </section>

        <section className="admin-card">
          <div className="admin-card-head"><h3><Ticket size={14} />Redeem codes</h3><span>For events and giveaways</span></div>
          <form className="admin-code-form" onSubmit={createCode}>
            <label className="admin-field is-wide"><span>Cape</span>
              <Dropdown className="admin-dropdown" value={draft.itemId} onChange={set('itemId')} placeholder={items ? 'Pick a cape' : 'Loading…'} options={capeOptions} />
            </label>
            <label className="admin-field"><span>Code</span><input value={draft.code} onChange={(event) => setDraft((current) => ({ ...current, code: event.target.value.toUpperCase() }))} placeholder="Auto" maxLength={32} /></label>
            <label className="admin-field"><span>Uses</span><input type="number" min={1} value={draft.maxUses} onChange={set('maxUses')} /></label>
            <label className="admin-field"><span>Expires (days)</span><input type="number" min={0} value={draft.expiresInDays} onChange={set('expiresInDays')} placeholder="0 = never" /></label>
            <label className="admin-field"><span>Note</span><input value={draft.note} onChange={set('note')} placeholder="Summer event" maxLength={120} /></label>
            <button type="submit" className="admin-btn primary" disabled={!draft.itemId || Boolean(busy)}>{busy === 'create' ? <LoaderCircle size={13} className="is-spinning" /> : <Ticket size={13} />}Create code</button>
          </form>
          <div className="admin-code-list">
            {!codes ? <p className="admin-note"><LoaderCircle size={12} className="is-spinning" /> Loading…</p>
              : !codes.length ? <p className="admin-note">No codes yet.</p>
                : codes.map((row) => {
                  const expired = row.expiresAt && row.expiresAt < Date.now();
                  const used = row.uses >= row.maxUses;
                  return (
                    <div key={row.code} className={`admin-code-row${expired || used ? ' is-done' : ''}`}>
                      <button type="button" className="admin-code-chip" onClick={() => copy(row.code)} title="Copy code"><code>{row.code}</code>{copied === row.code ? <Check size={11} /> : <Copy size={11} />}</button>
                      <div className="admin-code-main">
                        <strong>{row.itemName || row.itemId}</strong>
                        <small>{row.uses}/{row.maxUses} used · {expired ? 'expired' : row.expiresAt ? `ends in ${Math.max(1, Math.ceil((row.expiresAt - Date.now()) / 86_400_000))}d` : 'no expiry'}{row.note ? ` · ${row.note}` : ''}</small>
                      </div>
                      <button type="button" className={`admin-icon-btn${copied === `del:${row.code}` ? ' is-danger' : ''}`} onClick={() => removeCode(row.code)} title={copied === `del:${row.code}` ? 'Click again to delete' : 'Delete code'} aria-label="Delete code">
                        {busy === `delete:${row.code}` ? <LoaderCircle size={13} className="is-spinning" /> : <Trash2 size={13} />}
                      </button>
                    </div>
                  );
                })}
          </div>
        </section>
      </div>
    </div>
  );
}
