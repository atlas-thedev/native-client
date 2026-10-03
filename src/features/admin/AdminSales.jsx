import React, { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Crown, DollarSign, Gift, LoaderCircle, Receipt, RotateCcw, Ticket, Trash2 } from 'lucide-react';
import NoctraPlusIcon from '../../components/ui/NoctraPlusIcon.jsx';
import Dropdown from '../../components/ui/Dropdown.jsx';
import AdminPayments from './AdminPayments.jsx';
import { adminError, formatAgo, formatDate, formatNumber } from './adminShared.jsx';

const money = (value, currency = 'USD') => {
  try { return new Intl.NumberFormat([], { style: 'currency', currency }).format(Number(value) || 0); }
  catch { return `$${(Number(value) || 0).toFixed(2)}`; }
};

const PLUS_LENGTHS = [
  { value: '30', label: '1 month' },
  { value: '90', label: '3 months' },
  { value: '180', label: '6 months' },
  { value: '365', label: '1 year' },
  { value: '0', label: 'Forever' }
];

/** Sales, Noctra+ members (paid and given), refunds, and redeem codes for event capes. */
export default function AdminSales({ items, onNotify, onAccessRevoked }) {
  const [overview, setOverview] = useState(null);
  const [codes, setCodes] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [copied, setCopied] = useState('');
  const [draft, setDraft] = useState({ itemId: '', code: '', maxUses: '100', expiresInDays: '30', note: '' });
  const [gifts, setGifts] = useState(null);
  const [gift, setGift] = useState({ username: '', days: '30', note: '' });

  const load = useCallback(async () => {
    setError('');
    const [o, c, g] = await Promise.all([window.native?.admin?.billingOverview?.(), window.native?.admin?.billingCodes?.(), window.native?.admin?.plusGifts?.()]);
    if (!o?.ok) throw adminError(o, 'Could not load sales.', onAccessRevoked);
    setOverview(o);
    if (c?.ok) setCodes(c.codes || []);
    if (g?.ok) setGifts(g.gifts || []);
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

  const givePlus = async (event) => {
    event.preventDefault();
    const username = gift.username.trim();
    if (!username || busy) return;
    setBusy('gift');
    setError('');
    try {
      const result = await window.native?.admin?.givePlus?.({ username, days: Number(gift.days) || 0, note: gift.note.trim() });
      if (!result?.ok) throw adminError(result, 'Could not give Noctra+.', onAccessRevoked);
      setGifts(result.gifts || []);
      setGift((current) => ({ ...current, username: '', note: '' }));
      onNotify?.('Noctra+', `${result.username} has Noctra+ ${result.expiresAt ? `until ${formatDate(result.expiresAt)}` : 'forever'}.`);
      load().catch(() => {});
    } catch (reason) {
      setError(reason?.message || 'Could not give Noctra+.');
    } finally {
      setBusy('');
    }
  };

  const removePlus = async (row) => {
    if (busy) return;
    if (copied !== `plus:${row.userId}`) { setCopied(`plus:${row.userId}`); return; }
    setBusy(`plus:${row.userId}`);
    try {
      const result = await window.native?.admin?.removePlus?.(row.userId);
      if (!result?.ok) throw adminError(result, 'Could not take Noctra+ away.', onAccessRevoked);
      setGifts(result.gifts || []);
      load().catch(() => {});
    } catch (reason) {
      setError(reason?.message || 'Could not take Noctra+ away.');
    } finally {
      setBusy('');
      setCopied('');
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
      {overview && !overview.enabled && <div className="admin-error" role="status"><span>Payments are off: add your Paddle keys in Paddle setup below.</span></div>}

      <div className="admin-kpis">
        <div className="admin-kpi"><span className="admin-kpi-icon"><DollarSign size={15} /></span><span className="admin-kpi-label">Sales, all time</span><strong className="admin-kpi-value">{overview ? money(overview.sales.total) : '—'}</strong><span className="admin-kpi-hint">{overview ? `${formatNumber(overview.sales.count)} payments` : ''}</span></div>
        <div className="admin-kpi"><span className="admin-kpi-icon"><Receipt size={15} /></span><span className="admin-kpi-label">Last 30 days</span><strong className="admin-kpi-value">{overview ? money(overview.sales.last30) : '—'}</strong><span className="admin-kpi-hint">{overview ? `${formatNumber(overview.sales.last30Count)} payments` : ''}</span></div>
        <div className="admin-kpi"><span className="admin-kpi-icon"><Crown size={15} /></span><span className="admin-kpi-label">Noctra+ members</span><strong className="admin-kpi-value">{overview ? formatNumber(overview.plus.active) : '—'}</strong><span className="admin-kpi-hint">{overview ? `${overview.plus.monthly} monthly · ${overview.plus.yearly} yearly${overview.plus.gifted ? ` · ${overview.plus.gifted} given` : ''}` : ''}</span></div>
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

        <section className="admin-card admin-plus-card">
          <div className="admin-card-head"><h3><NoctraPlusIcon size={15} ring="transparent" />Give Noctra+</h3><span>Free membership, no payment</span></div>
          <form className="admin-code-form" onSubmit={givePlus}>
            <label className="admin-field is-wide"><span>Player</span><input value={gift.username} onChange={(event) => setGift((current) => ({ ...current, username: event.target.value }))} placeholder="Noctra username" maxLength={32} autoComplete="off" spellCheck={false} /></label>
            <label className="admin-field"><span>How long</span>
              <Dropdown className="admin-dropdown" value={gift.days} onChange={(value) => setGift((current) => ({ ...current, days: value?.target ? value.target.value : value }))} options={PLUS_LENGTHS} />
            </label>
            <label className="admin-field"><span>Note</span><input value={gift.note} onChange={(event) => setGift((current) => ({ ...current, note: event.target.value }))} placeholder="Giveaway winner" maxLength={120} /></label>
            <button type="submit" className="admin-btn primary" disabled={!gift.username.trim() || Boolean(busy)}>{busy === 'gift' ? <LoaderCircle size={13} className="is-spinning" /> : <Gift size={13} />}Give Noctra+</button>
          </form>
          <p className="admin-note">Giving more time to someone who already has a gift adds to what they have left. They get every paid cape and the Noctra+ badge right away.</p>
          <div className="admin-code-list">
            {!gifts ? <p className="admin-note"><LoaderCircle size={12} className="is-spinning" /> Loading…</p>
              : !gifts.length ? <p className="admin-note">Nobody has a given Noctra+ yet.</p>
                : gifts.map((row) => (
                  <div key={row.userId} className="admin-code-row">
                    <span className="admin-plus-chip"><NoctraPlusIcon size={16} ring="#0b0b0f" /></span>
                    <div className="admin-code-main">
                      <strong>{row.username || row.userId}</strong>
                      <small>{row.expiresAt ? `ends in ${Math.max(1, Math.ceil((row.expiresAt - Date.now()) / 86_400_000))}d · ${formatDate(row.expiresAt)}` : 'forever'}{row.grantedBy ? ` · by ${row.grantedBy}` : ''}{row.note ? ` · ${row.note}` : ''}{row.subscribed ? ' · also subscribed' : ''}</small>
                    </div>
                    <button type="button" className={`admin-icon-btn${copied === `plus:${row.userId}` ? ' is-danger' : ''}`} onClick={() => removePlus(row)} title={copied === `plus:${row.userId}` ? 'Click again to take Noctra+ away' : 'Take Noctra+ away'} aria-label="Take Noctra+ away">
                      {busy === `plus:${row.userId}` ? <LoaderCircle size={13} className="is-spinning" /> : <Trash2 size={13} />}
                    </button>
                  </div>
                ))}
          </div>
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

      <AdminPayments onNotify={onNotify} onAccessRevoked={onAccessRevoked} onChanged={() => load().catch(() => {})} />
    </div>
  );
}
