import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PixelCape, PixelStar } from './PixelIcons.jsx';
import { Check, Loader2, Lock, Package, Plus, RefreshCw, Search, Shirt, Store, Trash2, Users } from 'lucide-react';
import Dropdown from '../../components/ui/Dropdown.jsx';
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

/** 1234 -> "1.2k" so the owner count stays a short number next to the people icon. */
const formatCount = (value) => {
  const n = Number(value) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(n);
};

const CLOUDS = [
  { size: 9, left: '6%', top: 34, delay: -12 },
  { size: 13, left: '34%', top: 18, delay: -31 },
  { size: 10, left: '61%', top: 52, delay: -47 },
  { size: 12, left: '84%', top: 26, delay: -5 }
];

/** Pixel clouds drifting over a slanted ground stripe, behind the spotlight. */
function SpotBackdrop() {
  return (
    <div className="store-spot-backdrop" aria-hidden="true">
      {CLOUDS.map((cloud, index) => (
        <span key={index} className="store-cloud" style={{ fontSize: cloud.size, left: cloud.left, top: cloud.top, animationDelay: `${cloud.delay}s` }} />
      ))}
      <svg className="store-spot-ground" viewBox="0 0 1200 112" preserveAspectRatio="none">
        <polygon points="0,4 1200,74 1200,90 0,20" className="is-top" />
        <polygon points="0,20 1200,90 1200,96 0,26" className="is-edge" />
        <polygon points="0,26 1200,96 1200,112 0,112" className="is-base" />
      </svg>
    </div>
  );
}

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
    const owned = ownedIds.has(item.id);
    if (item.exclusive && !owned) {
      return <span className="store-exclusive-pill" title="Not sold. The Noctra team gives this cape to beta testers."><Lock size={12} />{compact ? 'Exclusive' : 'Beta testers only'}</span>;
    }
    if (!signedIn) {
      return <button type="button" className="store-btn ghost" onClick={(event) => { event.stopPropagation(); onOpenAccountSwitcher?.(); }}><Lock size={13} />{compact ? 'Sign in' : 'Sign in with Noctra'}</button>;
    }
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

  const capes = (catalog?.items || []).filter((item) => item.section === 'capes' || !item.section);
  const counts = {
    all: capes.length,
    animated: capes.filter((item) => item.animated).length,
    static: capes.filter((item) => !item.animated).length,
    new: capes.filter((item) => item.isNew).length,
    owned: capes.filter((item) => ownedIds.has(item.id)).length
  };
  const priceOf = (item) => (item.exclusive ? 'Exclusive' : item.price > 0 ? `$${item.price}` : 'Free');
  const bindCanvas = (key) => (node) => { if (node) canvases.current.set(key, node); else canvases.current.delete(key); };

  return (
    <div className="store-view">
      <header className="store-header">
        <div className="store-header-copy">
          <h1 className="store-title page-title">Store</h1>
          <p className="store-subtitle">Capes made by Noctra. Add one to your locker and wear it everywhere — the launcher, the website and in game. Everything is free right now.</p>
        </div>
        <div className="store-header-actions">
          {signedIn && capes.length > 0 && (
            <div className="store-collection" title="Store capes in your locker">
              <div className="store-collection-top"><span>Collection</span><strong>{counts.owned}<small>/{capes.length}</small></strong></div>
              <div className="store-collection-bar"><i style={{ width: `${capes.length ? Math.round((counts.owned / capes.length) * 100) : 0}%` }} /></div>
            </div>
          )}
          {signedIn && <button type="button" className="store-btn ghost" onClick={onOpenLocker}><Package size={13} />My locker</button>}
          <button type="button" className="store-icon-btn" onClick={() => load(true)} title="Refresh" aria-label="Refresh the store"><RefreshCw size={14} /></button>
        </div>
      </header>

      {error && <div className="store-note is-error" role="alert">{error}</div>}
      {!catalog && !error && <div className="store-note"><Loader2 size={14} className="is-spinning" /> Loading the store…</div>}

      {catalog && !(catalog.items || []).length && (
        <div className="store-coming">
          <span className="store-coming-icon"><PixelCape size={22} /></span>
          <h2>New capes are on the way</h2>
          <p>The first Noctra capes are being made right now. They’ll show up here — and in your locker — the moment they drop.</p>
          <button type="button" className="store-btn ghost" onClick={() => load(true)}><RefreshCw size={13} />Check again</button>
        </div>
      )}

      {catalog && (catalog.items || []).length > 0 && (
        <div className="store-scroll">
          {selected && (
            <section className="store-spot" aria-label={`${selected.name} details`}>
              <SpotBackdrop />
              <div className="store-spot-info">
                <div className="store-spot-badges">
                  {selected.featured && <span className="store-badge solid"><PixelStar size={9} />Featured</span>}
                  {selected.isNew && <span className="store-badge solid">New</span>}
                  {selected.exclusive && <span className="store-badge exclusive"><PixelStar size={9} />Exclusive</span>}
                  {selected.animated && <span className="store-badge">Animated</span>}
                  {ownedIds.has(selected.id) && <span className="store-badge owned"><Check size={10} strokeWidth={3} />In your locker</span>}
                </div>
                <h2 className="store-spot-name">{selected.name}</h2>
                <p className="store-spot-desc">{selected.description}</p>
                {selected.exclusive && <div className="store-exclusive-note"><PixelStar size={11} /><span>{ownedIds.has(selected.id) ? 'You’re one of the few who have this. Thanks for testing Noctra!' : 'Not sold and can’t be claimed. The Noctra team gives it to beta testers.'}</span></div>}
                <dl className="store-spot-facts">
                  <div><dt>Price</dt><dd>{priceOf(selected)}</dd></div>
                  <div><dt>Owned</dt><dd className="store-owners" title={`${selected.owners || 0} ${selected.owners === 1 ? 'player owns' : 'players own'} this`}><Users size={13} />{formatCount(selected.owners)}</dd></div>
                  <div><dt>Type</dt><dd>{selected.animated ? 'Animated' : 'Static'}</dd></div>
                  <div><dt>By</dt><dd>{selected.author || 'Noctra'}</dd></div>
                </dl>
                {(selected.tags || []).filter((tag) => tag !== 'animated' && tag !== 'exclusive').length > 0 && (
                  <div className="store-tags">
                    {(selected.tags || []).filter((tag) => tag !== 'animated' && tag !== 'exclusive').map((tag) => <span key={tag} className="store-tag">#{tag}</span>)}
                  </div>
                )}
                <div className="store-detail-actions">
                  {actionFor(selected)}
                  {signedIn && ownedIds.has(selected.id) && !selected.exclusive && <button type="button" className="store-btn ghost subtle" disabled={busy !== null} onClick={() => unclaim(selected)} title="Remove from locker"><Trash2 size={13} />Remove</button>}
                </div>
              </div>
              <div className="store-spot-stage">
                {previewAccount && <SkinViewer3D key={`${selected.id}:${previews[selected.id] ? 1 : 0}`} account={previewAccount} width={280} height={330} animation="walk" autoRotate />}
              </div>
              <div className="store-spot-art" aria-hidden="true">
                <canvas ref={bindCanvas(`hero:${selected.id}`)} width={80} height={128} />
              </div>
            </section>
          )}

          <div className="store-toolbar">
            <div className="store-chips" role="tablist" aria-label="Filter">
              {FILTERS.filter((f) => f.id !== 'owned' || signedIn).map((f) => (
                <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={`store-chip${filter === f.id ? ' active' : ''}`} onClick={() => setFilter(f.id)}>
                  {f.label}<span className="store-chip-count">{counts[f.id]}</span>
                </button>
              ))}
            </div>
            <label className="store-search">
              <Search size={14} aria-hidden="true" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search capes" aria-label="Search capes" />
            </label>
            <Dropdown className="store-sort" value={sort} onChange={setSort} options={SORTS.map((s) => ({ value: s.id, label: s.label }))} />
          </div>

          {items.length === 0 ? (
            <div className="store-empty"><Store size={18} /><span>{filter === 'owned' ? 'Your locker has no store capes yet.' : 'No capes match that.'}</span></div>
          ) : (
            <div className="store-grid">
              {items.map((item) => {
                const owned = ownedIds.has(item.id);
                return (
                  <article
                    key={item.id}
                    className={`store-card${selected?.id === item.id ? ' active' : ''}${owned ? ' is-owned' : ''}`}
                    onClick={() => setSelectedId(item.id)}
                    tabIndex={0}
                    aria-pressed={selected?.id === item.id}
                    onKeyDown={(event) => { if (event.key === 'Enter') setSelectedId(item.id); }}
                  >
                    <div className="store-card-art">
                      <canvas ref={bindCanvas(item.id)} width={80} height={128} className="store-card-canvas" aria-hidden="true" />
                      <div className="store-card-badges">
                        {item.exclusive && <span className="store-badge exclusive"><PixelStar size={8} />Exclusive</span>}
                        {item.isNew && !item.exclusive && <span className="store-badge solid">New</span>}
                        {item.animated && !item.exclusive && <span className="store-badge">Anim</span>}
                      </div>
                      {owned && <span className="store-card-state"><Check size={10} strokeWidth={3} />Owned</span>}
                    </div>
                    <div className="store-card-meta">
                      <div className="store-card-title"><strong>{item.name}</strong><span className={`store-price${item.exclusive ? ' is-exclusive' : ''}`}>{priceOf(item)}</span></div>
                      <small className="store-owners" title={`${item.owners || 0} ${item.owners === 1 ? 'player owns' : 'players own'} this`}><Users size={12} />{formatCount(item.owners)}</small>
                    </div>
                    <div className="store-card-action">{actionFor(item, true)}</div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
