import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, Lock, Package, Plus, RefreshCw, Search, Shirt, Sparkles, Store, Trash2, Users } from 'lucide-react';
import SkinViewer3D from '../../components/ui/SkinViewer3D.jsx';
import { drawCapeFront, loadStripImage } from '../../lib/animatedCape.js';
import './StoreView.css';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'animated', label: 'Animated' },
  { id: 'static', label: 'Static' },
  { id: 'new', label: 'New' },
  { id: 'owned', label: 'In my locker' }
];
const SORTS = [
  { id: 'featured', label: 'Featured' },
  { id: 'new', label: 'Newest' },
  { id: 'popular', label: 'Most popular' },
  { id: 'name', label: 'A – Z' }
];

const isStoreAccount = (account) => Boolean(account?.token) && account?.type === 'noctra';

/**
 * The Noctra Store: browse capes, add them to your locker, wear them.
 * Everything is free today; animated capes only come from here.
 */
export default function StoreView({ account, onNotify, onOpenLocker, onOpenAccountSwitcher, onWardrobeChanged }) {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');
  const [me, setMe] = useState({ owned: [], equipped: null });
  const [busy, setBusy] = useState(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('featured');
  const [selectedId, setSelectedId] = useState(null);
  const [wardrobe, setWardrobe] = useState(null);
  const [previews, setPreviews] = useState({}); // id -> data URL (strip or still)
  const canvases = useRef(new Map());
  const images = useRef(new Map()); // id -> { image, frames, fps }
  const signedIn = isStoreAccount(account);

  const load = useCallback(async (force = false) => {
    setError('');
    try {
      const res = await window.native?.store?.catalog?.({ force });
      if (!res?.ok) throw new Error(res?.error || 'Couldn’t load the store.');
      setCatalog(res);
      setSelectedId((id) => id || res.items[0]?.id || null);
    } catch (e) {
      setError(e?.message || 'Couldn’t load the store.');
    }
    if (isStoreAccount(account)) {
      const mine = await window.native?.store?.me?.(account).catch(() => null);
      if (mine?.ok) setMe({ owned: mine.owned || [], equipped: mine.equipped || null });
    }
  }, [account]);

  useEffect(() => { load(false); }, [load]);
  useEffect(() => {
    if (!account) return;
    window.native?.wardrobe?.get?.(account).then((state) => state && setWardrobe(state)).catch(() => {});
  }, [account?.id]);

  // Download previews once, then animate every visible card from a single loop.
  useEffect(() => {
    if (!catalog) return undefined;
    let alive = true;
    (async () => {
      for (const item of catalog.items) {
        if (!alive) return;
        if (images.current.has(item.id)) continue;
        try {
          const res = await window.native.store.strip(item.id);
          if (!res?.ok || !alive) continue;
          const image = await loadStripImage(res.url);
          images.current.set(item.id, { image, frames: item.animated ? item.frames : 1, fps: item.animated ? item.fps : 0 });
          setPreviews((current) => ({ ...current, [item.id]: res.url }));
        } catch { /* the card keeps its placeholder */ }
      }
    })();
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    let raf = 0;
    let last = 0;
    const tick = (now) => {
      if (now - last > 40) {
        last = now;
        canvases.current.forEach((canvas, key) => {
          const entry = images.current.get(key.startsWith('hero:') ? key.slice(5) : key);
          if (!entry || !canvas.isConnected) return;
          const index = entry.frames > 1 && !reduce ? Math.floor((now * entry.fps) / 1000) % entry.frames : 0;
          drawCapeFront(canvas, entry.image, entry.frames, index);
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [catalog]);

  const ownedIds = useMemo(() => new Set(me.owned.map((entry) => entry.id)), [me.owned]);
  const items = useMemo(() => {
    const list = (catalog?.items || []).filter((item) => item.section === 'capes' || !item.section);
    const q = query.trim().toLowerCase();
    const filtered = list.filter((item) => {
      if (q && !`${item.name} ${item.description} ${(item.tags || []).join(' ')} ${item.author}`.toLowerCase().includes(q)) return false;
      if (filter === 'animated') return item.animated;
      if (filter === 'static') return !item.animated;
      if (filter === 'new') return item.isNew;
      if (filter === 'owned') return ownedIds.has(item.id);
      return true;
    });
    const by = {
      featured: () => 0,
      new: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
      popular: (a, b) => (b.owners || 0) - (a.owners || 0),
      name: (a, b) => a.name.localeCompare(b.name)
    }[sort];
    return sort === 'featured' ? filtered : [...filtered].sort(by);
  }, [catalog, query, filter, sort, ownedIds]);

  const selected = (catalog?.items || []).find((item) => item.id === selectedId) || items[0] || null;
  const featured = (catalog?.items || []).find((item) => item.featured) || null;

  const run = async (label, fn) => {
    setBusy(label);
    try { await fn(); window.dispatchEvent(new Event('noctra:store-changed')); } catch (e) { onNotify?.('Store', e?.message || 'Something went wrong.'); }
    finally { setBusy(null); }
  };

  const claim = (item) => run(`claim:${item.id}`, async () => {
    const res = await window.native.store.claim(account, item.id);
    if (!res?.ok) throw new Error(res?.error || 'Couldn’t add that cape.');
    setMe((current) => ({ ...current, owned: res.owned || current.owned }));
    onNotify?.('Store', `${item.name} was added to your locker.`);
  });

  const wear = (item) => run(`wear:${item?.id || 'off'}`, async () => {
    const res = await window.native.store.equip(account, item?.id || null);
    if (!res?.ok) throw new Error(res?.error || 'Couldn’t equip that cape.');
    if (res.state) { setWardrobe(res.state); onWardrobeChanged?.(res.state); }
    setMe((current) => ({ owned: item && !ownedIds.has(item.id) ? [{ id: item.id, acquiredAt: Date.now() }, ...current.owned] : current.owned, equipped: item?.id || null }));
    onNotify?.('Store', item ? `${item.name} is now your cape — in the launcher and in game.` : 'Cape taken off.');
  });

  const unclaim = (item) => run(`unclaim:${item.id}`, async () => {
    const res = await window.native.store.unclaim(account, item.id);
    if (!res?.ok) throw new Error(res?.error || 'Couldn’t remove that cape.');
    if (res.state) { setWardrobe(res.state); onWardrobeChanged?.(res.state); }
    setMe({ owned: res.owned || [], equipped: res.equipped || null });
    onNotify?.('Store', `${item.name} was removed from your locker.`);
  });

  const previewAccount = useMemo(() => {
    if (!selected) return null;
    const preview = previews[selected.id];
    return {
      ...account,
      skinUrl: wardrobe?.active?.skinUrl || account?.skinUrl || null,
      model: wardrobe?.active?.model || wardrobe?.model || account?.model,
      capeUrl: selected.stillUrl,
      hasCape: true,
      capeAnim: selected.animated && preview ? { stripUrl: preview, frames: selected.frames, fps: selected.fps } : null
    };
  }, [selected, previews, wardrobe, account]);

  const actionFor = (item, compact = false) => {
    if (!signedIn) {
      return <button type="button" className="store-btn ghost" onClick={(event) => { event.stopPropagation(); onOpenAccountSwitcher?.(); }}><Lock size={13} />{compact ? 'Sign in' : 'Sign in with Noctra'}</button>;
    }
    const owned = ownedIds.has(item.id);
    const wearing = me.equipped === item.id;
    if (!owned) {
      return <button type="button" className="store-btn" disabled={busy !== null} onClick={(event) => { event.stopPropagation(); claim(item); }}>{busy === `claim:${item.id}` ? <Loader2 size={13} className="is-spinning" /> : <Plus size={13} />}Add to locker</button>;
    }
    if (compact) {
      return wearing
        ? <button type="button" className="store-btn ghost" disabled={busy !== null} onClick={(event) => { event.stopPropagation(); wear(null); }}>{busy === 'wear:off' ? <Loader2 size={13} className="is-spinning" /> : null}Take off</button>
        : <button type="button" className="store-btn ghost" disabled={busy !== null} onClick={(event) => { event.stopPropagation(); wear(item); }}>{busy === `wear:${item.id}` ? <Loader2 size={13} className="is-spinning" /> : <Shirt size={13} />}Wear</button>;
    }
    return wearing
      ? <button type="button" className="store-btn ghost" disabled={busy !== null} onClick={() => wear(null)}>{busy === 'wear:off' ? <Loader2 size={13} className="is-spinning" /> : null}Take off</button>
      : <button type="button" className="store-btn" disabled={busy !== null} onClick={() => wear(item)}>{busy === `wear:${item.id}` ? <Loader2 size={13} className="is-spinning" /> : <Shirt size={13} />}Wear now</button>;
  };

  return (
    <div className="store-view">
      <header className="store-header">
        <div>
          <h1 className="store-title page-title">Store</h1>
          <p className="store-subtitle">Capes made by Noctra. Add one to your locker and wear it everywhere — the launcher, the website and in game. Everything is free right now.</p>
        </div>
        <div className="store-header-actions">
          {signedIn && <button type="button" className="store-btn ghost" onClick={onOpenLocker}><Package size={13} />My locker · {me.owned.length}</button>}
          <button type="button" className="store-icon-btn" onClick={() => load(true)} title="Refresh" aria-label="Refresh the store"><RefreshCw size={14} /></button>
        </div>
      </header>

      {error && <div className="store-note is-error" role="alert">{error}</div>}
      {!catalog && !error && <div className="store-note"><Loader2 size={14} className="is-spinning" /> Loading the store…</div>}

      {catalog && !(catalog.items || []).length && (
        <div className="store-coming">
          <span className="store-coming-icon"><Sparkles size={20} /></span>
          <h2>New capes are on the way</h2>
          <p>The first Noctra capes are being made right now. They’ll show up here — and in your locker — the moment they drop.</p>
          <button type="button" className="store-btn ghost" onClick={() => load(true)}><RefreshCw size={13} />Check again</button>
        </div>
      )}

      {catalog && (catalog.items || []).length > 0 && (
        <div className="store-body">
          <aside className="store-detail">
            {selected ? (
              <>
                <div className="store-stage">
                  {previewAccount && <SkinViewer3D key={`${selected.id}:${previews[selected.id] ? 1 : 0}`} account={previewAccount} width={300} height={360} animation="walk" autoRotate />}
                  {selected.featured && <span className="store-badge solid"><Sparkles size={11} />Featured</span>}
                </div>
                <div className="store-detail-meta">
                  <div className="store-detail-row">
                    <h2>{selected.name}</h2>
                    <span className="store-price">{selected.price > 0 ? `$${selected.price}` : 'Free'}</span>
                  </div>
                  <p>{selected.description}</p>
                  <div className="store-tags">
                    {selected.animated && <span className="store-tag strong">Animated</span>}
                    {(selected.tags || []).filter((tag) => tag !== 'animated').map((tag) => <span key={tag} className="store-tag">#{tag}</span>)}
                  </div>
                  <div className="store-stats"><Users size={13} />{selected.owners || 0} {selected.owners === 1 ? 'player has' : 'players have'} this · by {selected.author || 'Noctra'}</div>
                  <div className="store-detail-actions">
                    {actionFor(selected)}
                    {signedIn && ownedIds.has(selected.id) && <button type="button" className="store-icon-btn" disabled={busy !== null} onClick={() => unclaim(selected)} title="Remove from locker" aria-label="Remove from locker"><Trash2 size={14} /></button>}
                  </div>
                </div>
              </>
            ) : <div className="store-note">Nothing here yet.</div>}
          </aside>

          <section className="store-main">
            {featured && filter === 'all' && !query && (
              <button type="button" className={`store-hero${selected?.id === featured.id ? ' active' : ''}`} onClick={() => setSelectedId(featured.id)}>
                <canvas ref={(node) => { if (node) canvases.current.set(`hero:${featured.id}`, node); else canvases.current.delete(`hero:${featured.id}`); }} width={80} height={128} className="store-hero-canvas" aria-hidden="true" />
                <div>
                  <span className="store-badge solid"><Sparkles size={11} />New · Featured</span>
                  <h3>{featured.name}</h3>
                  <p>{featured.description}</p>
                </div>
                <div className="store-hero-action">{actionFor(featured, true)}</div>
              </button>
            )}

            <div className="store-toolbar">
              <label className="store-search">
                <Search size={14} aria-hidden="true" />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search capes" aria-label="Search capes" />
              </label>
              <div className="store-chips" role="tablist" aria-label="Filter">
                {FILTERS.filter((f) => f.id !== 'owned' || signedIn).map((f) => (
                  <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={`store-chip${filter === f.id ? ' active' : ''}`} onClick={() => setFilter(f.id)}>{f.label}</button>
                ))}
              </div>
              <select className="store-sort" value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort">
                {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>

            {items.length === 0 ? (
              <div className="store-empty"><Store size={18} /><span>{filter === 'owned' ? 'Your locker has no store capes yet.' : 'No capes match that.'}</span></div>
            ) : (
              <div className="store-grid">
                {items.map((item) => (
                  <article key={item.id} className={`store-card${selected?.id === item.id ? ' active' : ''}${me.equipped === item.id ? ' is-worn' : ''}`} onClick={() => setSelectedId(item.id)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') setSelectedId(item.id); }}>
                    <div className="store-card-art">
                      <canvas ref={(node) => { if (node) canvases.current.set(item.id, node); else canvases.current.delete(item.id); }} width={80} height={128} className="store-card-canvas" aria-hidden="true" />
                      <div className="store-card-badges">
                        {item.isNew && <span className="store-badge solid">NEW</span>}
                        {item.animated && <span className="store-badge">ANIM</span>}
                      </div>
                      {ownedIds.has(item.id) && <span className={`store-card-mark${me.equipped === item.id ? ' is-worn' : ''}`} title={me.equipped === item.id ? 'You’re wearing this' : 'In your locker'} aria-label={me.equipped === item.id ? 'You’re wearing this' : 'In your locker'}><Check size={11} strokeWidth={3} /></span>}
                    </div>
                    <div className="store-card-meta">
                      <strong>{item.name}</strong>
                      <small><Users size={11} />{item.owners || 0} · {item.price > 0 ? `$${item.price}` : 'Free'}</small>
                    </div>
                    <div className="store-card-action">{actionFor(item, true)}</div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
