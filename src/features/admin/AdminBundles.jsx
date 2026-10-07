import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, LoaderCircle, Package, Pencil, Plus, Search, Star, Trash2, X } from 'lucide-react';
import { CapeThumb } from './AdminStore.jsx';

const EMPTY = { name: '', description: '', itemIds: [], discount: 20, price: '', featured: false, hidden: false, order: 0 };
const money = (value) => `$${Number(value || 0).toFixed(2)}`;

function ItemThumb({ item, size = 40 }) {
  if (item.kind === 'cosmetic') return <img className="admin-bundle-thumb" src={item.stillUrl} alt="" width={size} height={size} loading="lazy" />;
  return <CapeThumb src={item.stillUrl} width={Math.round(size * 0.625)} height={size} />;
}

/** Store bundles: several items sold together at a discount (or a fixed price). */
export default function AdminBundles({ items, onNotify }) {
  const [bundles, setBundles] = useState(null);
  const [maxItems, setMaxItems] = useState(12);
  const [editing, setEditing] = useState(null); // 'new' | bundle id
  const [draft, setDraft] = useState(EMPTY);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [pick, setPick] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = useCallback(async () => {
    const result = await window.native?.admin?.storeBundles?.();
    if (result?.ok) { setBundles(result.bundles || []); setMaxItems(result.maxItems || 12); } else { setBundles([]); setError(result?.error || 'Could not load bundles.'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const byId = useMemo(() => new Map((items || []).map((item) => [item.id, item])), [items]);
  const choices = useMemo(() => {
    const q = pick.trim().toLowerCase();
    return (items || []).filter((item) => !item.exclusive && (!q || `${item.name} ${item.id} ${item.section}`.toLowerCase().includes(q)));
  }, [items, pick]);
  const full = draft.itemIds.reduce((sum, id) => { const item = byId.get(id); return sum + (item && item.paid ? Number(item.salePrice ?? item.price) || 0 : 0); }, 0);
  const estimate = Number(draft.price) > 0 ? Math.min(Number(draft.price), full) : Math.max(full ? 0.5 : 0, Math.round(full * (100 - (Number(draft.discount) || 0))) / 100);

  const openNew = () => { setEditing('new'); setDraft(EMPTY); setError(''); };
  const openEdit = (bundle) => {
    setEditing(bundle.id);
    setDraft({ name: bundle.name, description: bundle.description || '', itemIds: bundle.itemIds || [], discount: bundle.discount ?? 0, price: bundle.fixedPrice || '', featured: bundle.featured, hidden: bundle.hidden, order: bundle.order || 0 });
    setError('');
  };
  const close = () => { setEditing(null); setError(''); };
  const set = (key) => (event) => setDraft((current) => ({ ...current, [key]: event.target.type === 'checkbox' ? event.target.checked : event.target.value }));
  const toggleItem = (id) => setDraft((current) => ({
    ...current,
    itemIds: current.itemIds.includes(id) ? current.itemIds.filter((x) => x !== id) : current.itemIds.length >= maxItems ? current.itemIds : [...current.itemIds, id]
  }));

  const call = async (key, fn, message) => {
    setBusy(key);
    setError('');
    try {
      const result = await fn();
      if (!result?.ok) throw new Error(result?.error || 'That didn’t work.');
      if (result.bundles) setBundles(result.bundles);
      if (message) onNotify?.('Store', message);
      return result;
    } catch (reason) { setError(reason?.message || 'That didn’t work.'); return null; }
    finally { setBusy(''); }
  };
  const save = async () => {
    const body = {
      name: draft.name, description: draft.description, itemIds: draft.itemIds,
      discount: Number(draft.discount) || 0, price: draft.price === '' ? 0 : Number(draft.price),
      featured: draft.featured, hidden: draft.hidden, order: Number(draft.order) || 0
    };
    const done = editing === 'new'
      ? await call('save', () => window.native.admin.storeBundleCreate(body), `${draft.name} bundle created.`)
      : await call('save', () => window.native.admin.storeBundleUpdate(editing, body), `${draft.name} saved.`);
    if (done) close();
  };
  const patch = (bundle, change, message) => call(bundle.id, () => window.native.admin.storeBundleUpdate(bundle.id, change), message);
  const remove = (bundle) => {
    if (confirmDelete !== bundle.id) { setConfirmDelete(bundle.id); setTimeout(() => setConfirmDelete((current) => (current === bundle.id ? null : current)), 3000); return; }
    setConfirmDelete(null);
    call(bundle.id, () => window.native.admin.storeBundleDelete(bundle.id), `${bundle.name} deleted. Players keep what they bought.`).then(() => { if (editing === bundle.id) close(); });
  };

  return (
    <div className="admin-store admin-bundles">
      <div className="admin-toolbar">
        <span className="admin-result-count"><Package size={13} /> {bundles ? `${bundles.length} bundles · ${bundles.filter((b) => b.live).length} live · ${bundles.reduce((sum, b) => sum + (b.sales || 0), 0)} sold` : 'Loading…'}</span>
        <button type="button" className="admin-store-new" onClick={openNew}><Plus size={14} />New bundle</button>
      </div>
      {error && !editing && <div className="admin-error" role="alert"><span>{error}</span></div>}
      <div className="admin-store-body">
        <div className="admin-store-list" aria-busy={!bundles}>
          {!bundles ? (
            <div className="admin-loading"><LoaderCircle size={18} className="is-spinning" /><span>Loading bundles…</span></div>
          ) : bundles.length ? bundles.map((bundle) => (
            <article key={bundle.id} className={`admin-store-row${editing === bundle.id ? ' is-editing' : ''}${bundle.hidden ? ' is-hidden' : ''}`}>
              <div className="admin-bundle-stack">{(bundle.itemIds || []).slice(0, 3).map((id) => byId.get(id) && <ItemThumb key={id} item={byId.get(id)} size={36} />)}</div>
              <div className="admin-store-main">
                <div className="admin-user-name">
                  <strong>{bundle.name}</strong>
                  <em className="admin-tag">{(bundle.itemIds || []).length} items</em>
                  {bundle.paid ? <em className="admin-tag is-price">{money(bundle.price)}{bundle.fullPrice > bundle.price ? ` · −${bundle.savePercent}%` : ''}</em> : <em className="admin-tag">Free</em>}
                  {bundle.featured && <em className="admin-tag is-featured">Featured</em>}
                  {bundle.hidden && <em className="admin-tag is-hidden">Hidden</em>}
                  {!bundle.live && !bundle.hidden && <em className="admin-tag is-hidden">Not listed (needs 2+ items on sale)</em>}
                </div>
                <small><code>{bundle.id}</code> · {bundle.sales || 0} sold · items {money(bundle.fullPrice)} one by one</small>
                <small className="admin-user-meta">{(bundle.itemIds || []).map((id) => byId.get(id)?.name || id).join(' · ')}</small>
              </div>
              <div className="admin-store-actions">
                <button type="button" title={bundle.featured ? 'Unfeature' : 'Feature (shown first)'} className={bundle.featured ? 'is-on' : ''} disabled={busy === bundle.id} onClick={() => patch(bundle, { featured: !bundle.featured }, `${bundle.name} ${bundle.featured ? 'is no longer featured' : 'is now featured'}.`)}><Star size={14} /></button>
                <button type="button" title={bundle.hidden ? 'Show in Store' : 'Hide from Store'} disabled={busy === bundle.id} onClick={() => patch(bundle, { hidden: !bundle.hidden }, `${bundle.name} is now ${bundle.hidden ? 'visible' : 'hidden'}.`)}>{bundle.hidden ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                <button type="button" title="Edit" disabled={busy === bundle.id} onClick={() => openEdit(bundle)}><Pencil size={14} /></button>
                <button type="button" title={confirmDelete === bundle.id ? 'Click again to delete' : 'Delete'} className={confirmDelete === bundle.id ? 'is-danger' : ''} disabled={busy === bundle.id} onClick={() => remove(bundle)}>{busy === bundle.id ? <LoaderCircle size={14} className="is-spinning" /> : <Trash2 size={14} />}{confirmDelete === bundle.id && <span>Delete?</span>}</button>
              </div>
            </article>
          )) : <div className="admin-loading"><span>No bundles yet. Group a few cloaks and cosmetics and sell them together.</span></div>}
        </div>
        {editing && (
          <aside className="admin-store-editor" aria-label={editing === 'new' ? 'New bundle' : 'Edit bundle'}>
            <header>
              <h2>{editing === 'new' ? 'New bundle' : `Edit ${draft.name}`}</h2>
              <button type="button" className="admin-icon-btn" onClick={close} aria-label="Close"><X size={15} /></button>
            </header>
            <div className="admin-store-form">
              <label><span>Name</span><input value={draft.name} maxLength={60} onChange={set('name')} placeholder="Starter Pack" /></label>
              <label><span>Order</span><input type="number" value={draft.order} onChange={set('order')} placeholder="0 = first" /></label>
              <label className="is-wide"><span>Description</span><textarea rows={2} maxLength={400} value={draft.description} onChange={set('description')} placeholder="What’s in the box?" /></label>
              <label><span>Discount (%)</span><input type="number" min={0} max={90} value={draft.discount} disabled={Number(draft.price) > 0} onChange={set('discount')} /></label>
              <label><span>Fixed price (USD)</span><input type="number" min={0.5} max={999.99} step={0.01} value={draft.price} onChange={set('price')} placeholder="Use the discount" /></label>
              <label className="admin-check"><input type="checkbox" checked={draft.featured} onChange={set('featured')} /><span>Featured</span></label>
              <label className="admin-check"><input type="checkbox" checked={draft.hidden} onChange={set('hidden')} /><span>Hidden (draft)</span></label>
            </div>
            <div className="admin-bundle-picker">
              <div className="admin-bundle-picker-head">
                <strong>Items · {draft.itemIds.length}/{maxItems}</strong>
                <label className="admin-search"><Search size={13} /><input value={pick} onChange={(event) => setPick(event.target.value)} placeholder="Find items" /></label>
              </div>
              <div className="admin-bundle-choices">
                {choices.map((item) => {
                  const on = draft.itemIds.includes(item.id);
                  return (
                    <button type="button" key={item.id} className={`admin-bundle-choice${on ? ' is-on' : ''}`} disabled={!on && draft.itemIds.length >= maxItems} onClick={() => toggleItem(item.id)} title={item.id}>
                      <ItemThumb item={item} size={32} />
                      <span><b>{item.name}</b><small>{item.kind === 'cosmetic' ? item.section : 'cloak'} · {item.paid ? money(item.salePrice ?? item.price) : 'free'}</small></span>
                    </button>
                  );
                })}
              </div>
            </div>
            <p className="admin-note">
              {draft.itemIds.length < 2 ? 'Pick at least 2 items. Event items can’t be bundled.'
                : full > 0 ? `One by one: ${money(full)} → bundle: ${money(estimate)}${full > estimate ? ` (save ${Math.round(100 - (estimate * 100) / full)}%)` : ''}. Players who already own some pieces pay only for the rest. Native+ members get it included.`
                : 'Every piece is free: players add the whole bundle to their locker in one click.'}
            </p>
            {error && <div className="admin-error" role="alert"><span>{error}</span></div>}
            <footer>
              <button type="button" className="instances-ghost-btn" onClick={close}>Cancel</button>
              <button type="button" className="admin-store-save" disabled={busy === 'save' || draft.itemIds.length < 2 || !draft.name.trim()} onClick={save}>{busy === 'save' && <LoaderCircle size={14} className="is-spinning" />}{editing === 'new' ? 'Create bundle' : 'Save changes'}</button>
            </footer>
          </aside>
        )}
      </div>
    </div>
  );
}
