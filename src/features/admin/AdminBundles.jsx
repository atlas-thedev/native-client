import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, Check, Copy, Eye, EyeOff, Gift, ImagePlus, Layers, LoaderCircle, Pencil, Plus, Sparkles, Star, Trash2, X } from 'lucide-react';
import AdminPicker from './AdminPicker.jsx';
import { ItemThumb } from './AdminStore.jsx';
import { Modal } from './AdminStoreTools.jsx';
import { RarityBadge, RarityEmblem } from '../store/RarityBadges.jsx';
import '../store/RarityBadges.css';
import { AdminSwitch, adminCall, formatDate, formatNumber, fromLocalInput, toLocalInput, useConfirm, usd } from './adminShared.jsx';

// Same colours as the Store's bundle page.
const RARITIES = [
  { id: 'rare', label: 'Rare', color: '#3d8bff' },
  { id: 'epic', label: 'Epic', color: '#a45cff' },
  { id: 'legendary', label: 'Legendary', color: '#ffb020' },
  { id: 'mythic', label: 'Mythic', color: '#ff3d6e' }
];
const rarityOf = (id) => RARITIES.find((entry) => entry.id === id) || RARITIES[1];
const colorOf = (bundle) => bundle?.accent || rarityOf(bundle?.rarity).color;
const MAX_ART = 4 * 1024 * 1024;

/** What one item sells for right now (its sale price when on sale), free items count as $0. */
const priceNow = (item) => {
  if (!item?.paid) return 0;
  const sale = Number(item.salePrice);
  return item.salePrice != null && Number.isFinite(sale) && sale > 0 ? sale : Number(item.price) || 0;
};
/** Worth, price and saving of a draft (same rules as the server: a fixed price wins over the discount). */
export function priceDraft(items, { discount = 0, price = '' } = {}) {
  const worth = Math.round(items.reduce((sum, item) => sum + priceNow(item), 0) * 100) / 100;
  const fixed = Number(price) > 0 ? Math.round(Number(price) * 100) / 100 : 0;
  const now = fixed || Math.round(worth * (1 - (Number(discount) || 0) / 100) * 100) / 100;
  const save = worth > 0 ? Math.max(0, Math.round((1 - now / worth) * 100)) : 0;
  return { worth, price: now, save, fixed: Boolean(fixed) };
}

const phaseLabel = (bundle) => {
  if (bundle.hidden) return ['Hidden', 'is-muted'];
  if (bundle.phase === 'upcoming') return ['Upcoming', 'is-test'];
  if (bundle.phase === 'ended') return ['Ended', 'is-refund'];
  if ((bundle.itemIds || []).length < 2) return ['Needs 2 items', 'is-refund'];
  return ['Live', 'is-live'];
};

const blank = () => ({ name: '', tagline: '', description: '', itemIds: [], rarity: 'epic', accent: '', discount: 25, price: '', pricing: 'discount', startsAt: '', endsAt: '', featured: false, hidden: false, art: undefined, artPreview: null });

/** Admin → Bundles: Free-Fire-style sets of Store items sold together for less. */
export default function AdminBundles({ items, strips = {}, onNotify, onAccessRevoked }) {
  const [list, setList] = useState(null);
  const [maxItems, setMaxItems] = useState(12);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState(null); // null | { id?: string, draft }
  const [granting, setGranting] = useState(null); // bundle id with the grant box open
  const [grantName, setGrantName] = useState('');
  const confirm = useConfirm();

  const byId = useMemo(() => new Map((items || []).map((item) => [item.id, item])), [items]);
  const load = useCallback(async () => {
    const result = await adminCall('GET', '/store/bundles', undefined, onAccessRevoked);
    setList(result.bundles || []);
    if (result.maxItems) setMaxItems(result.maxItems);
  }, [onAccessRevoked]);
  useEffect(() => { load().catch((reason) => setError(reason?.message || 'Could not load bundles.')); }, [load]);

  const act = async (key, fn, ok) => {
    if (busy) return undefined;
    setBusy(key);
    setError('');
    try {
      const result = await fn();
      if (result?.bundles) setList(result.bundles);
      if (ok) onNotify?.('Bundles', typeof ok === 'function' ? ok(result) : ok);
      return result;
    } catch (reason) {
      setError(reason?.message || 'Something went wrong.');
      return undefined;
    } finally { setBusy(''); }
  };

  const openNew = () => setEditing({ draft: blank() });
  const openEdit = (bundle) => setEditing({
    id: bundle.id,
    draft: {
      name: bundle.name, tagline: bundle.tagline || '', description: bundle.description || '', itemIds: bundle.itemIds || [],
      rarity: bundle.rarity || 'epic', accent: bundle.accent || '', discount: bundle.discount || 0, price: bundle.fixedPrice ? String(bundle.fixedPrice) : '',
      pricing: bundle.fixedPrice ? 'fixed' : 'discount', startsAt: toLocalInput(bundle.startsAt), endsAt: toLocalInput(bundle.endsAt),
      featured: Boolean(bundle.featured), hidden: Boolean(bundle.hidden), art: undefined, artPreview: bundle.artUrl || null
    }
  });

  const save = async (draft) => {
    const body = {
      name: draft.name.trim(), tagline: draft.tagline.trim(), description: draft.description.trim(), itemIds: draft.itemIds,
      rarity: draft.rarity, accent: draft.accent || null,
      discount: draft.pricing === 'discount' ? Number(draft.discount) || 0 : 0,
      price: draft.pricing === 'fixed' ? (Number(draft.price) || 0) : 0,
      startsAt: fromLocalInput(draft.startsAt), endsAt: fromLocalInput(draft.endsAt),
      featured: draft.featured, hidden: draft.hidden,
      ...(draft.art !== undefined ? { art: draft.art } : {})
    };
    const id = editing?.id;
    const result = await act('save', () => adminCall(id ? 'PATCH' : 'POST', id ? `/store/bundles/${encodeURIComponent(id)}` : '/store/bundles', body, onAccessRevoked), id ? `${body.name} saved.` : `${body.name} is in the Store.`);
    if (result) setEditing(null);
  };
  const remove = async (bundle) => {
    if (!confirm.ask(`del:${bundle.id}`)) return;
    const result = await act(`del:${bundle.id}`, () => adminCall('DELETE', `/store/bundles/${encodeURIComponent(bundle.id)}`, undefined, onAccessRevoked), `${bundle.name} removed. Players keep what they got.`);
    if (result && editing?.id === bundle.id) setEditing(null);
  };
  const toggle = (bundle, key) => act(`${key}:${bundle.id}`, () => adminCall('PATCH', `/store/bundles/${encodeURIComponent(bundle.id)}`, { [key]: !bundle[key] }, onAccessRevoked));
  const grant = async (bundle, event) => {
    event?.preventDefault();
    const username = grantName.trim();
    if (!username) return;
    const result = await act(`grant:${bundle.id}`, () => adminCall('POST', `/store/bundles/${encodeURIComponent(bundle.id)}/grant`, { username }, onAccessRevoked),
      (r) => (r.added ? `${r.username} got ${r.added} piece${r.added === 1 ? '' : 's'} of ${bundle.name}.` : `${r.username} already has all of ${bundle.name}.`));
    if (result) { setGranting(null); setGrantName(''); }
  };

  const live = (list || []).filter((bundle) => phaseLabel(bundle)[0] === 'Live').length;
  const sold = (list || []).reduce((sum, bundle) => sum + (bundle.sales || 0), 0);

  return (
    <div className="admin-scroll">
      {error && !editing && <div className="admin-error" role="alert"><span>{error}</span></div>}
      <section className="admin-card admin-bdl-head">
        <div className="admin-bdl-head-text">
          <h3><Layers size={14} />Bundles</h3>
          <p>Sets of Store items sold together for less, like Free Fire bundles. They show on the Store’s Bundles page, in the All view and in the Locker’s Sets tab. Pieces a player already owns are left out of the price; Native+ members claim bundles for free.</p>
        </div>
        <div className="admin-bdl-stats">
          <span><b>{list ? formatNumber(list.length) : '—'}</b>bundles</span>
          <span><b>{list ? formatNumber(live) : '—'}</b>live</span>
          <span><b>{list ? formatNumber(sold) : '—'}</b>sold</span>
        </div>
        <button type="button" className="admin-btn primary" onClick={openNew} disabled={!items?.length}><Plus size={13} />New bundle</button>
      </section>

      {!list ? <p className="admin-note"><LoaderCircle size={12} className="is-spinning" /> Loading bundles…</p>
        : !list.length ? (
          <div className="admin-bdl-empty">
            <Layers size={22} />
            <strong>No bundles yet</strong>
            <span>Pick 2–{maxItems} items that look good together, give the set a rarity and a discount, and it’s in the Store.</span>
            <button type="button" className="admin-btn primary" onClick={openNew} disabled={!items?.length}><Plus size={13} />Make the first bundle</button>
          </div>
        ) : (
          <div className="admin-bdl-grid">
            {list.map((bundle) => {
              const [label, tone] = phaseLabel(bundle);
              const pieces = (bundle.itemIds || []).map((id) => byId.get(id)).filter(Boolean);
              const rarity = rarityOf(bundle.rarity);
              return (
                <article key={bundle.id} className={`admin-bdl-card${bundle.hidden || bundle.phase === 'ended' ? ' is-dim' : ''}`} style={{ '--bc': colorOf(bundle) }}>
                  <div className="admin-bdl-art">
                    {bundle.artUrl && <img src={bundle.artUrl} alt="" draggable={false} />}
                    <div className="admin-bdl-pieces">
                      {pieces.slice(0, 6).map((item) => <span key={item.id} title={item.name}><ItemThumb item={item} strips={strips} width={24} height={38} /></span>)}
                      {pieces.length > 6 && <em>+{pieces.length - 6}</em>}
                    </div>
                    <RarityBadge rarity={rarity.id} size="sm" className="admin-bdl-rarity" />
                    {bundle.featured && <span className="admin-bdl-star" title="Featured"><Star size={11} fill="currentColor" /></span>}
                  </div>
                  <div className="admin-bdl-body">
                    <div className="admin-bdl-title">
                      <strong>{bundle.name}</strong>
                      <span className={`admin-chip is-inline ${tone}`}>{label}</span>
                    </div>
                    {bundle.tagline && <small className="admin-bdl-tag">{bundle.tagline}</small>}
                    <div className="admin-bdl-price">
                      {bundle.fullPrice > bundle.price && <s>{usd(bundle.fullPrice)}</s>}
                      <b>{bundle.paid ? usd(bundle.price) : 'Free'}</b>
                      {bundle.savePercent > 0 && <em>−{bundle.savePercent}%</em>}
                      <span>{pieces.length} items · {formatNumber(bundle.sales || 0)} sold</span>
                    </div>
                    {(bundle.startsAt || bundle.endsAt) && <small className="admin-bdl-when"><CalendarClock size={11} />{bundle.startsAt ? formatDate(bundle.startsAt) : 'Now'} → {bundle.endsAt ? formatDate(bundle.endsAt) : 'no end'}</small>}
                    {granting === bundle.id ? (
                      <form className="admin-bdl-grant" onSubmit={(event) => grant(bundle, event)}>
                        <input autoFocus value={grantName} onChange={(event) => setGrantName(event.target.value)} placeholder="Native username" maxLength={32} spellCheck={false} />
                        <button type="submit" className="admin-btn primary" disabled={!grantName.trim() || Boolean(busy)}>{busy === `grant:${bundle.id}` ? <LoaderCircle size={13} className="is-spinning" /> : <Gift size={13} />}Give</button>
                        <button type="button" className="admin-icon-btn" aria-label="Cancel" onClick={() => { setGranting(null); setGrantName(''); }}><X size={13} /></button>
                      </form>
                    ) : (
                      <div className="admin-bdl-actions">
                        <button type="button" className="admin-btn ghost" onClick={() => openEdit(bundle)}><Pencil size={12} />Edit</button>
                        <button type="button" className="admin-btn ghost" onClick={() => { setGranting(bundle.id); setGrantName(''); }} title="Give every piece to a player"><Gift size={12} />Give</button>
                        <button type="button" className="admin-icon-btn" onClick={() => toggle(bundle, 'featured')} title={bundle.featured ? 'Unfeature' : 'Feature (shown first)'} aria-label="Feature">{busy === `featured:${bundle.id}` ? <LoaderCircle size={13} className="is-spinning" /> : <Star size={13} fill={bundle.featured ? 'currentColor' : 'none'} />}</button>
                        <button type="button" className="admin-icon-btn" onClick={() => toggle(bundle, 'hidden')} title={bundle.hidden ? 'Show in the Store' : 'Hide from the Store'} aria-label="Hide">{busy === `hidden:${bundle.id}` ? <LoaderCircle size={13} className="is-spinning" /> : bundle.hidden ? <EyeOff size={13} /> : <Eye size={13} />}</button>
                        <button type="button" className="admin-icon-btn" onClick={() => { navigator.clipboard?.writeText(bundle.id); onNotify?.('Bundles', `Copied ${bundle.id}.`); }} title="Copy bundle id" aria-label="Copy id"><Copy size={13} /></button>
                        <button type="button" className={`admin-icon-btn${confirm.armed === `del:${bundle.id}` ? ' is-danger' : ''}`} onClick={() => remove(bundle)} title={confirm.armed === `del:${bundle.id}` ? 'Click again to delete' : 'Delete bundle'} aria-label="Delete">{busy === `del:${bundle.id}` ? <LoaderCircle size={13} className="is-spinning" /> : <Trash2 size={13} />}</button>
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}

      {editing && (
        <BundleEditor
          key={editing.id || 'new'}
          initial={editing.draft}
          isNew={!editing.id}
          items={items || []}
          strips={strips}
          maxItems={maxItems}
          busy={busy === 'save'}
          error={error}
          onSave={save}
          onDelete={editing.id ? () => remove(list.find((bundle) => bundle.id === editing.id)) : null}
          deleteArmed={confirm.armed === `del:${editing.id}`}
          onClose={() => { setEditing(null); setError(''); }}
        />
      )}
    </div>
  );
}

function BundleEditor({ initial, isNew, items, strips, maxItems, busy, error, onSave, onDelete, deleteArmed, onClose }) {
  const [draft, setDraft] = useState(initial);
  const [artError, setArtError] = useState('');
  const fileRef = useRef(null);
  const set = (key) => (value) => setDraft((current) => ({ ...current, [key]: value?.target ? value.target.value : value }));
  const sellable = useMemo(() => items.filter((item) => !item.exclusive || draft.itemIds.includes(item.id))
    .sort((a, b) => Number(draft.itemIds.includes(b.id)) - Number(draft.itemIds.includes(a.id)) || String(a.kind).localeCompare(String(b.kind)) || a.name.localeCompare(b.name)), [items]); // eslint-disable-line react-hooks/exhaustive-deps
  const [query, setQuery] = useState('');
  const shown = sellable.filter((item) => !query.trim() || item.name.toLowerCase().includes(query.trim().toLowerCase()) || draft.itemIds.includes(item.id));
  const picked = draft.itemIds.map((id) => items.find((item) => item.id === id)).filter(Boolean);
  const quote = priceDraft(picked, draft.pricing === 'fixed' ? { price: draft.price } : { discount: draft.discount });
  const color = draft.accent || rarityOf(draft.rarity).color;
  const ends = fromLocalInput(draft.endsAt);
  const starts = fromLocalInput(draft.startsAt);
  const badDates = starts && ends && ends <= starts;
  const fixedTooHigh = draft.pricing === 'fixed' && quote.worth > 0 && quote.price > quote.worth;
  const canSave = draft.name.trim() && picked.length >= 2 && picked.length <= maxItems && !badDates && !busy;

  const pickArt = (file) => {
    setArtError('');
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { setArtError('Use a PNG, JPEG or WebP image.'); return; }
    if (file.size > MAX_ART) { setArtError('Keep the image under 4 MB.'); return; }
    const reader = new FileReader();
    reader.onload = () => setDraft((current) => ({ ...current, art: String(reader.result), artPreview: String(reader.result) }));
    reader.readAsDataURL(file);
  };

  return (
    <Modal title={isNew ? 'New bundle' : `Edit ${initial.name}`} icon={<Layers size={15} />} onClose={onClose} wide>
      <div className="admin-bdl-editor" style={{ '--bc': color }}>
        <div className="admin-bdl-form">
          <div className="admin-field-row">
            <label className="admin-field"><span>Name</span><input value={draft.name} onChange={set('name')} placeholder="Cyber Ops" maxLength={60} autoFocus={isNew} /></label>
            <label className="admin-field"><span>Tagline</span><input value={draft.tagline} onChange={set('tagline')} placeholder="Jack in. Light up the night." maxLength={80} /></label>
          </div>
          <label className="admin-field"><span>Description</span><textarea rows={2} value={draft.description} onChange={set('description')} placeholder="What's in the set and why it's cool." maxLength={400} /></label>

          <div className="admin-field">
            <span>Items <em className="admin-bdl-count">{picked.length}/{maxItems} · at least 2</em></span>
            <div className="admin-bdl-search"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search items" /></div>
            <AdminPicker items={shown} value={draft.itemIds} onChange={set('itemIds')} max={maxItems} strips={strips} empty="No items match." />
          </div>

          <div className="admin-field">
            <span>Rarity</span>
            <div className="admin-bdl-rarities" role="radiogroup" aria-label="Rarity">
              {RARITIES.map((entry) => (
                <button key={entry.id} type="button" role="radio" aria-checked={draft.rarity === entry.id} className={draft.rarity === entry.id ? 'is-on' : ''} style={{ '--rc': entry.color }} onClick={() => set('rarity')(entry.id)}>
                  <RarityEmblem rarity={entry.id} size={16} />{entry.label}
                </button>
              ))}
              <label className="admin-bdl-accent" title="Custom colour (leave it to use the rarity colour)">
                <input type="color" value={color} onChange={set('accent')} />
                <span>{draft.accent ? draft.accent : 'Rarity colour'}</span>
                {draft.accent && <button type="button" className="admin-icon-btn" aria-label="Use the rarity colour" onClick={(event) => { event.preventDefault(); set('accent')(''); }}><X size={11} /></button>}
              </label>
            </div>
          </div>

          <div className="admin-field">
            <span>Price</span>
            <div className="admin-bdl-pricing">
              <div className="admin-filters admin-bdl-seg" role="tablist" aria-label="Pricing">
                {[['discount', 'Discount'], ['fixed', 'Fixed price']].map(([id, label]) => (
                  <button key={id} type="button" role="tab" aria-selected={draft.pricing === id} className={draft.pricing === id ? 'active' : ''} onClick={() => set('pricing')(id)}>{label}</button>
                ))}
              </div>
              {draft.pricing === 'discount' ? (
                <label className="admin-bdl-slider">
                  <input type="range" min={0} max={90} step={5} value={draft.discount} onChange={(event) => set('discount')(Number(event.target.value))} />
                  <b>−{draft.discount}%</b>
                </label>
              ) : (
                <label className="admin-bdl-fixed">$<input type="number" min={0.5} max={999.99} step={0.01} value={draft.price} onChange={set('price')} placeholder={quote.worth ? quote.worth.toFixed(2) : '4.99'} /></label>
              )}
            </div>
            {fixedTooHigh && <small className="admin-bdl-warn">That’s more than the items cost on their own ({usd(quote.worth)}).</small>}
          </div>

          <div className="admin-field">
            <span>Bundle art <em className="admin-bdl-count">optional · shown behind the set · PNG, JPEG or WebP, under 4 MB</em></span>
            <div className="admin-bdl-artpick">
              <button type="button" className="admin-bdl-artbox" onClick={() => fileRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); pickArt(event.dataTransfer?.files?.[0]); }}>
                {draft.artPreview ? <img src={draft.artPreview} alt="" /> : <><ImagePlus size={16} /><span>Drop an image or click</span></>}
              </button>
              {draft.artPreview && <button type="button" className="admin-btn ghost" onClick={() => setDraft((current) => ({ ...current, art: null, artPreview: null }))}><Trash2 size={12} />Remove</button>}
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => { pickArt(event.target.files?.[0]); event.target.value = ''; }} />
            </div>
            {artError && <small className="admin-bdl-warn">{artError}</small>}
          </div>

          <div className="admin-field-row">
            <label className="admin-field"><span>Starts</span><input type="datetime-local" value={draft.startsAt} onChange={set('startsAt')} /></label>
            <label className="admin-field"><span>Ends</span><input type="datetime-local" value={draft.endsAt} onChange={set('endsAt')} /></label>
          </div>
          <div className="admin-bdl-quick">
            {[['24 hours', 1], ['3 days', 3], ['1 week', 7], ['2 weeks', 14]].map(([label, days]) => (
              <button key={label} type="button" className="admin-btn ghost" onClick={() => setDraft((current) => ({ ...current, startsAt: current.startsAt || toLocalInput(Date.now()), endsAt: toLocalInput((fromLocalInput(current.startsAt) || Date.now()) + days * 86_400_000) }))}>{label}</button>
            ))}
            {(draft.startsAt || draft.endsAt) && <button type="button" className="admin-btn ghost" onClick={() => setDraft((current) => ({ ...current, startsAt: '', endsAt: '' }))}><X size={12} />No dates</button>}
          </div>
          {badDates && <small className="admin-bdl-warn">The bundle must end after it starts.</small>}

          <div className="admin-field-row">
            <AdminSwitch on={draft.featured} onChange={set('featured')} label="Featured" hint="Shown first, on the Bundles page stage" />
            <AdminSwitch on={draft.hidden} onChange={set('hidden')} label="Hidden" hint="Kept, but not in the Store" />
          </div>
        </div>

        <aside className="admin-bdl-preview" aria-label="Preview">
          <span className="admin-bdl-preview-label">Preview</span>
          <div className="admin-bdl-pcard">
            <div className="admin-bdl-pcard-art">
              {draft.artPreview && <img src={draft.artPreview} alt="" />}
              <RarityBadge rarity={rarityOf(draft.rarity).id} className="admin-bdl-rarity" />
              <div className="admin-bdl-pcard-pieces">
                {picked.slice(0, 8).map((item) => <span key={item.id}><ItemThumb item={item} strips={strips} width={30} height={48} /></span>)}
                {!picked.length && <small>Pick some items</small>}
              </div>
            </div>
            <div className="admin-bdl-pcard-meta">
              <strong>{draft.name.trim() || 'Bundle name'}</strong>
              <small>{draft.tagline.trim() || `${picked.length} items`}</small>
            </div>
          </div>
          <dl className="admin-bdl-sum">
            <div><dt>Items on their own</dt><dd>{usd(quote.worth)}</dd></div>
            <div><dt>Bundle price</dt><dd className="is-big">{quote.price > 0 ? usd(quote.price) : 'Free'}</dd></div>
            <div><dt>Players save</dt><dd>{quote.save > 0 ? `${usd(Math.max(0, quote.worth - quote.price))} · ${quote.save}%` : '—'}</dd></div>
          </dl>
          <p className="admin-note">Someone who owns some pieces pays only for the rest, at the same discount. Free items in a set cost nothing.</p>
          {error && <div className="admin-error" role="alert"><span>{error}</span></div>}
          <div className="admin-bdl-foot">
            {onDelete && <button type="button" className={`admin-btn danger${deleteArmed ? ' is-confirm' : ''}`} onClick={onDelete}><Trash2 size={12} />{deleteArmed ? 'Click to delete' : 'Delete'}</button>}
            <span />
            <button type="button" className="admin-btn ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="admin-btn primary" disabled={!canSave} onClick={() => onSave(draft)}>{busy ? <LoaderCircle size={13} className="is-spinning" /> : <Check size={13} />}{isNew ? 'Create bundle' : 'Save'}</button>
          </div>
        </aside>
      </div>
    </Modal>
  );
}
