import React, { useState } from 'react';
import { LoaderCircle, Pause, Play, Plus, Tag, Trash2 } from 'lucide-react';
import AdminPicker from './AdminPicker.jsx';
import { AdminSwitch, adminCall, formatDate, fromLocalInput, toLocalInput, usd, useAdminAction, useConfirm } from './adminShared.jsx';

const blank = () => ({ title: '', description: '', percent: 20, itemIds: [], startsAt: null, endsAt: null, banner: true, enabled: true });

const stateOf = (offer, now) => (!offer.enabled ? 'Paused' : offer.startsAt && offer.startsAt > now ? 'Scheduled' : offer.endsAt && offer.endsAt <= now ? 'Ended' : 'Live');

/** % discounts on every item or on picked items. The best live offer applies at checkout. */
export default function AdminOffers({ doc, setDoc, items, strips, onNotify, onAccessRevoked }) {
  const { busy, error, run } = useAdminAction(onNotify, 'Offers');
  const { armed, ask } = useConfirm();
  const [draft, setDraft] = useState(blank);
  const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const offers = doc?.settings?.offers || [];
  const sellable = (items || []).filter((item) => !item.exclusive);
  const name = (id) => (items || []).find((item) => item.id === id)?.name || id;
  const now = Date.now();

  const create = () => run('create', async () => {
    setDoc(await adminCall('POST', '/site/offers', draft, onAccessRevoked));
    setDraft(blank());
  }, 'Offer created.');
  const patch = (id, body, ok) => run(id, async () => setDoc(await adminCall('PATCH', `/site/offers/${encodeURIComponent(id)}`, body, onAccessRevoked)), ok);
  const remove = (id) => ask(`del:${id}`) && run(`del:${id}`, async () => setDoc(await adminCall('DELETE', `/site/offers/${encodeURIComponent(id)}`, undefined, onAccessRevoked)), 'Offer deleted.');
  const example = Math.max(0.5, Math.round(1.99 * (100 - draft.percent)) / 100);

  return (
    <div className="admin-scroll">
      {error && <div className="admin-error" role="alert"><span>{error}</span></div>}
      <div className="admin-overview-grid admin-site-grid">
        <section className="admin-card is-wide">
          <div className="admin-card-head">
            <h3><Plus size={14} />New offer</h3>
            <span>A % discount on everything or on picked items</span>
            <span className="admin-head-spacer" />
            <button type="button" className="admin-btn primary" disabled={draft.title.trim().length < 2 || Boolean(busy)} onClick={create}>
              {busy === 'create' ? <LoaderCircle size={13} className="is-spinning" /> : <Plus size={13} />}Create offer
            </button>
          </div>
          <div className="admin-form-grid">
            <label className="admin-field"><span>Title</span><input maxLength={60} placeholder="Launch week sale" value={draft.title} onChange={(event) => set('title', event.target.value)} /></label>
            <label className="admin-field"><span>Discount · {draft.percent}% off ({usd(1.99)} → {usd(example)})</span>
              <input className="admin-range" type="range" min={1} max={90} value={draft.percent} onChange={(event) => set('percent', Number(event.target.value))} />
            </label>
            <label className="admin-field"><span>Starts (optional)</span><input type="datetime-local" value={toLocalInput(draft.startsAt)} onChange={(event) => set('startsAt', fromLocalInput(event.target.value))} /></label>
            <label className="admin-field"><span>Ends (optional)</span><input type="datetime-local" value={toLocalInput(draft.endsAt)} onChange={(event) => set('endsAt', fromLocalInput(event.target.value))} /></label>
            <label className="admin-field is-wide"><span>Description (optional)</span><input maxLength={200} value={draft.description} onChange={(event) => set('description', event.target.value)} /></label>
            <AdminSwitch on={draft.banner} onChange={(v) => set('banner', v)} label="Show in the announcement bar" hint="Shown on the website while it’s live." />
            <AdminSwitch on={draft.enabled} onChange={(v) => set('enabled', v)} label="Enabled" hint="Paused offers never apply." />
          </div>
          <p className="admin-note"><strong>Items</strong>&nbsp;{draft.itemIds.length ? `${draft.itemIds.length} selected` : 'none selected = everything'}</p>
          <AdminPicker items={sellable} strips={strips} value={draft.itemIds} onChange={(v) => set('itemIds', v)} empty="No buyable items yet." />
        </section>

        <section className="admin-card is-wide">
          <div className="admin-card-head"><h3><Tag size={14} />Offers</h3><span>{offers.length ? `${offers.length} total` : ''}</span></div>
          {!doc ? <p className="admin-note"><LoaderCircle size={12} className="is-spinning" /> Loading…</p> : !offers.length ? <p className="admin-note">No offers yet. Create one above.</p> : (
            <div className="admin-code-list is-tall">
              {offers.map((offer) => {
                const state = stateOf(offer, now);
                return (
                  <div key={offer.id} className={`admin-code-row${state === 'Ended' ? ' is-done' : ''}`}>
                    <span className="admin-offer-pct">−{offer.percent}%</span>
                    <div className="admin-code-main">
                      <strong className="is-plain">{offer.title} <span className={`admin-chip ${state === 'Live' ? 'is-live' : 'is-test'} is-inline`}>{state}</span></strong>
                      <small>{offer.itemIds?.length ? offer.itemIds.map(name).join(', ') : 'everything'} · {offer.startsAt ? `from ${formatDate(offer.startsAt)}` : 'now'} → {offer.endsAt ? formatDate(offer.endsAt) : 'no end'}{offer.banner ? ' · in the bar' : ''}</small>
                    </div>
                    <button type="button" className="admin-btn ghost" disabled={Boolean(busy)} onClick={() => patch(offer.id, { enabled: !offer.enabled }, offer.enabled ? 'Offer paused.' : 'Offer enabled.')}>
                      {busy === offer.id ? <LoaderCircle size={13} className="is-spinning" /> : offer.enabled ? <Pause size={13} /> : <Play size={13} />}{offer.enabled ? 'Pause' : 'Enable'}
                    </button>
                    <button type="button" className={`admin-icon-btn${armed === `del:${offer.id}` ? ' is-danger' : ''}`} title={armed === `del:${offer.id}` ? 'Click again to delete' : 'Delete offer'} aria-label="Delete offer" onClick={() => remove(offer.id)}>
                      {busy === `del:${offer.id}` ? <LoaderCircle size={13} className="is-spinning" /> : <Trash2 size={13} />}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
