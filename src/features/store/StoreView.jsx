import { WornShot } from '../../lib/wornShot.jsx';
import { OwnedMark } from './RarityBadges.jsx';
import { BundlesPage, BundleShelf, bundleColor } from './BundleViews.jsx';
import { prepareSkinSource, skinTextureUrl } from '../../components/ui/SkinViewer3D.jsx';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { siteUrl } from '../../lib/siteUrl.js';
import { announcePlus } from '../../lib/usePlus.js';
import { PixelCape, PixelStar } from './PixelIcons.jsx';
import { PixelButton, PixelIconButton, PixelTabs } from '../../components/ui/PixelControls.jsx';
import { ShopStrip, SpotBackdrop } from '../../components/ui/ShopBits.jsx';
import Dropdown from '../../components/ui/Dropdown.jsx';
import { Check, Copy, Layers, Pause, Play, RotateCcw, ZoomIn, ZoomOut, Heart, UserRound, Sparkles, ChevronLeft, ChevronRight, Eye, Glasses, Globe, Infinity as InfinityIcon, Loader2, AppWindow, Lock, Package, Palette, Pencil, Plus, RefreshCw, Rotate3d, Search, Shirt, ShoppingBag, Store, Ticket, Trash2, Type, User, Users, X } from 'lucide-react';
import NativePlusIcon from '../../components/ui/NativePlusIcon.jsx';
import SkinViewer3D from '../../components/ui/SkinViewer3D.jsx';
import { drawCapeFront, loadStripImage } from '../../lib/animatedCape.js';
import './StoreView.css';
import { SHOTS, createCamera } from '../../lib/viewerCamera.js';
import '../../components/ui/shop.css';

/** The hero spotlight rotates through at most this many featured capes. */
export const MAX_FEATURED = 5;

/** Featured capes in catalogue order (the API sorts featured first by `order`), capped at MAX_FEATURED. */
export const featuredCapes = (items = []) => items
  .filter((item) => item.featured && (item.section === 'capes' || !item.section))
  .slice(0, MAX_FEATURED);

/** What an item costs right now: the offer price while a sale runs, otherwise the list price. */
const nowPrice = (item) => { const sale = Number(item?.salePrice); return Number.isFinite(sale) && sale > 0 && item?.salePrice != null ? sale : Number(item?.price) || 0; };
/** 3D cosmetics (hats, glasses, back items, shoes) live in their own store sections. */
const shotModelOf = (model) => (model === 'slim' ? 'slim' : model === 'classic' ? 'default' : 'auto-detect');
export const isCosmetic = (item) => item?.kind === 'cosmetic';
const sectionOf = (item) => item?.section || 'capes';
const moves = (item) => Boolean(item?.animated || item?.motion);
const SECTION_LABELS = { all: 'All', bundles: 'Bundles', capes: 'Cloaks', hats: 'Headwear', glasses: 'Glasses', back: 'Wings & Backpacks', shoes: 'Shoes', hand: 'In hand' };
/** The order categories show in (the same as the website store). */
const SECTION_ORDER = ['capes', 'hats', 'glasses', 'back', 'shoes', 'hand'];
/** In the All view each category shelf shows this many items before "See all". */
const SHELF_SIZE = 8;
const SLOT_WORDS = { hats: 'hat', glasses: 'glasses', back: 'back item', shoes: 'shoes', hand: 'hand item' };
// Each section has its own slab colour, like the Locker switch (same pixel style, different colours).
export const SECTION_COLORS = { all: '#e8e8ea', capes: '#b48cff', hats: '#ff8a7a', glasses: '#7fb2ff', back: '#9fe0ff', shoes: '#ffb45c', hand: '#d7a6ff' };

/** Featured items of one store section (or every section for 'all'), capped at MAX_FEATURED. */
export const featuredIn = (items = [], section = 'capes') => items
  .filter((item) => item.featured && (section === 'all' || sectionOf(item) === section))
  .slice(0, MAX_FEATURED);

/** Canvas keys are "<id>" or "<slot>:<id>" (hero / thumb / view). */
const itemIdOfKey = (key) => (key.includes(':') ? key.slice(key.lastIndexOf(':') + 1) : key);

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'animated', label: 'Animated' },
  { id: 'paid', label: 'Paid' },
  { id: 'new', label: 'New' },
  { id: 'owned', label: 'In my locker' },
  { id: 'wish', label: 'Wishlist' }
];
const SORTS = [
  { id: 'featured', label: 'Recommended' },
  { id: 'popular', label: 'Most used' },
  { id: 'new', label: 'Newest' },
  { id: 'name', label: 'A–Z' }
];

/** 1234 -> "1.2k" so the owner count stays a short number next to the people icon. */
const formatCount = (value) => {
  const n = Number(value) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(n);
};

/** A premium (Microsoft) account connected to Native shops with that Native account. */
const isPremiumLinked = (account) => account?.type === 'microsoft' && Boolean(account?.nativeLink?.connected);
const isStoreAccount = (account) => (Boolean(account?.token || account?.linkedFrom) && account?.type === 'native') || isPremiumLinked(account);

/* Cached store billing state (localStorage): shown instantly, then refreshed from the server. */
const BILLING_CACHE = 'native.store.billing.v1';
const plusCacheKey = (account) => `native.store.plus.v1.${account?.id || account?.name || 'me'}`;
function readCache(key) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function writeCache(key, value) {
  try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

/**
 * The Native Store: browse capes, add them to your locker, wear them.
 * Most capes are free; paid ones can be bought or come with Native+.
 */
export default function StoreView({ account, onNotify, onOpenLocker, onOpenAccountSwitcher, onWardrobeChanged }) {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');
  const [offline, setOffline] = useState(false);
  const [me, setMe] = useState({ owned: [], equipped: null, wearing: {}, wishlist: [], bundles: {}, dyes: {} });
  const [tryDye, setTryDye] = useState({}); // itemId -> colour being tried in the 3D preview
  const [dyeTex, setDyeTex] = useState({}); // `${itemId}|${hex}` -> dyed texture (data URL)
  const dyeAsked = useRef(new Set());
  const [bundleId, setBundleId] = useState(null); // the bundle on the Bundles page stage
  const [section, setSection] = useState('all');
  const [sectionDir, setSectionDir] = useState(null); // 'right' | 'left': where the new shelf slides in from
  const [cosAssets, setCosAssets] = useState({}); // cosmetic id -> { model, texture, thumb }
  const [busy, setBusy] = useState(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('featured');
  const [viewId, setViewId] = useState(null); // cape open in the 3D viewer popup
  const [wardrobe, setWardrobe] = useState(null);
  const [previews, setPreviews] = useState({}); // id -> data URL (strip or still)
  const canvases = useRef(new Map());
  const images = useRef(new Map()); // id -> { image, frames, fps }
  const signedIn = isStoreAccount(account);
  // Last known billing config + membership, so the Native+ banner shows the right state at once.
  const [billing, setBillingState] = useState(() => readCache(BILLING_CACHE) || { enabled: false, plus: null });
  const [plus, setPlusState] = useState(() => (isStoreAccount(account) ? readCache(plusCacheKey(account)) : null)); // { active, plan, renewsAt, endsAt }
  const setBilling = useCallback((next) => { setBillingState(next); writeCache(BILLING_CACHE, next); }, []);
  const setPlus = useCallback((next) => { setPlusState(next); if (isStoreAccount(account)) writeCache(plusCacheKey(account), next); }, [account]);
  useEffect(() => { setPlusState(isStoreAccount(account) ? readCache(plusCacheKey(account)) : null); }, [account?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [pending, setPending] = useState(null); // checkout waiting in the checkout window
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [payAsk, setPayAsk] = useState(null); // { key, request, info } while asking where to pay
  const [code, setCode] = useState('');
  const cosAssetsRef = useRef({});

  const loadBilling = useCallback(async () => {
    const conf = await window.native?.billing?.config?.().catch(() => null);
    if (conf?.ok) setBilling({ enabled: Boolean(conf.enabled), plus: conf.plus || null });
    if (isStoreAccount(account)) {
      const mine = await window.native?.billing?.me?.(account).catch(() => null);
      if (mine?.ok) { setPlus(mine.plus || null); announcePlus(mine.plus?.active); }
      return mine;
    }
    return null;
  }, [account]);

  const load = useCallback(async (force = false) => {
    setError('');
    try {
      const res = await window.native?.store?.catalog?.({ force });
      if (!res?.ok) throw new Error(res?.error || 'Couldn’t load the store.');
      setCatalog(res);
      setOffline(Boolean(res.stale));
    } catch (e) {
      setError(e?.message || 'Couldn’t load the store.');
    }
    if (isStoreAccount(account)) {
      const mine = await window.native?.store?.me?.(account).catch(() => null);
      if (mine?.ok) setMe({ owned: mine.owned || [], equipped: (isPremiumLinked(account) ? mine.premiumEquipped : mine.equipped) || null, wearing: mine.wearing || {}, wishlist: mine.wishlist || [], bundles: mine.bundles || {}, dyes: mine.dyes || {} });
    }
  }, [account]);

  useEffect(() => { load(false); }, [load]);
  useEffect(() => { loadBilling(); }, [loadBilling]);

  // After a checkout opens, watch for the payment to land.
  // The in-launcher checkout window closed: paid → keep watching (the webhook lands in seconds);
  // closed without paying → stop waiting shortly after one last check. Billing window → refresh.
  useEffect(() => window.native?.billing?.onWindowClosed?.(({ kind, paid } = {}) => {
    if (kind !== 'checkout') { load(true); return; }
    if (paid) setPending((current) => (current ? { ...current, paid: true } : current));
    else setTimeout(() => setPending((current) => (current && !current.paid ? null : current)), 8000);
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!pending) return undefined;
    let stopped = false;
    const check = async () => {
      if (stopped) return;
      const [mine, bill] = await Promise.all([
        window.native?.store?.me?.(account).catch(() => null),
        window.native?.billing?.me?.(account).catch(() => null)
      ]);
      if (stopped) return;
      if (mine?.ok) setMe({ owned: mine.owned || [], equipped: (isPremiumLinked(account) ? mine.premiumEquipped : mine.equipped) || null, wearing: mine.wearing || {}, wishlist: mine.wishlist || [], bundles: mine.bundles || {}, dyes: mine.dyes || {} });
      if (bill?.ok) { setPlus(bill.plus || null); announcePlus(bill.plus?.active); }
      const done = pending.kind === 'plus' ? bill?.plus?.active
        : pending.kind === 'bundle' ? Boolean(mine?.bundles?.[pending.bundleId]?.complete)
        : (mine?.owned || []).some((entry) => entry.id === pending.itemId);
      if (done) {
        onNotify?.('Store', pending.kind === 'plus' ? 'Welcome to Native+! Every paid cloak and cosmetic is yours to wear.' : pending.kind === 'bundle' ? `The ${pending.name} bundle is yours. Every piece is in your locker — wear the whole set from the Bundles page.` : `${pending.name} is yours. It’s in your locker now.`);
        window.dispatchEvent(new Event('native:store-changed'));
        load(true);
        setPending(null);
      }
    };
    const timer = setInterval(check, 4000);
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    const giveUp = setTimeout(() => setPending(null), 20 * 60_000);
    return () => { stopped = true; clearInterval(timer); clearTimeout(giveUp); window.removeEventListener('focus', onFocus); };
  }, [pending, account]); // eslint-disable-line react-hooks/exhaustive-deps
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
        if (isCosmetic(item)) continue;
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
          const entry = images.current.get(itemIdOfKey(key));
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

  // Cosmetic models + thumbnails: the open section first, then everything else in the background.
  useEffect(() => {
    if (!catalog || !window.native?.store?.cosmetic) return undefined;
    let alive = true;
    const list = (catalog.items || []).filter(isCosmetic);
    // pieces of bundles first (the All view opens with the bundle shelf), then the open section, then the rest
    const inBundles = new Set((catalog.bundles || []).flatMap((bundle) => bundle.itemIds || []));
    const rank = (item) => (inBundles.has(item.id) ? 0 : section === 'all' || sectionOf(item) === section ? 1 : 2);
    const ordered = [...list].sort((a, b) => rank(a) - rank(b));
    (async () => {
      for (const item of ordered) {
        if (!alive) return;
        if (cosAssetsRef.current[item.id]) continue;
        const res = await window.native.store.cosmetic(item.id).catch(() => null);
        if (!alive || !res?.ok) continue;
        cosAssetsRef.current = { ...cosAssetsRef.current, [item.id]: res };
        setCosAssets(cosAssetsRef.current);
      }
    })();
    return () => { alive = false; };
  }, [catalog, section]);

  const ownedIds = useMemo(() => new Set(me.owned.map((entry) => entry.id)), [me.owned]);
  const wishIds = useMemo(() => new Set((me.wishlist || []).map((entry) => entry.id)), [me.wishlist]);
  const items = useMemo(() => {
    const list = (catalog?.items || []).filter((item) => section === 'all' || sectionOf(item) === section);
    const q = query.trim().toLowerCase();
    const filtered = list.filter((item) => {
      if (q && !`${item.name} ${item.description} ${(item.tags || []).join(' ')} ${item.author} ${SECTION_LABELS[sectionOf(item)] || ''}`.toLowerCase().includes(q)) return false;
      if (filter === 'animated') return moves(item);
      if (filter === 'free') return !item.paid && !item.exclusive;
      if (filter === 'paid') return item.paid;
      if (filter === 'new') return item.isNew;
      if (filter === 'owned') return ownedIds.has(item.id);
      if (filter === 'wish') return wishIds.has(item.id);
      return true;
    });
    const by = {
      featured: () => 0,
      new: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
      popular: (a, b) => (b.owners || 0) - (a.owners || 0),
      name: (a, b) => a.name.localeCompare(b.name)
    }[sort];
    return sort === 'featured' ? filtered : [...filtered].sort(by);
  }, [catalog, query, filter, sort, ownedIds, wishIds, section]);

  // when (almost) everything is new the badge and the "Just added" shelf are noise
  const movesMean = useMemo(() => { const all = catalog?.items || []; return all.filter(moves).length <= all.length * 0.4; }, [catalog]);
  const newMeans = useMemo(() => { const all = catalog?.items || []; return all.filter((item) => item.isNew).length <= all.length * 0.4; }, [catalog]);
  /** The All view with no filter, search or sort shows one shelf per category instead of one long grid. */
  const shelved = section === 'all' && filter === 'all' && !query.trim() && sort === 'featured';
  const newest = useMemo(() => (newMeans && section !== 'all' && filter === 'all' && !query.trim() && sort === 'featured'
    ? (catalog?.items || []).filter((item) => sectionOf(item) === section && item.isNew && !item.exclusive).sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0)).slice(0, 4)
    : []), [catalog, section, filter, query, sort, newMeans]);

  const viewing = viewId ? (catalog?.items || []).find((item) => item.id === viewId) || null : null;
  // 3D viewer controls: the same round buttons and smooth camera as the locker.
  const viewViewer = useRef(null);
  const viewCam = useRef(null);
  const [viewTick, setViewTick] = useState(0);
  const [viewZoom, setViewZoom] = useState({ in: true, out: true });
  const [viewPaused, setViewPaused] = useState(false);
  const syncViewZoom = () => { const cam = viewCam.current; if (cam) setViewZoom({ in: cam.canZoomIn(), out: cam.canZoomOut() }); };
  useEffect(() => {
    const viewer = viewViewer.current;
    if (!viewer || !viewing) return undefined;
    const cam = createCamera(viewer);
    viewCam.current = cam;
    cam.fly(viewing.slot === 'balloon' ? SHOTS.balloon : [-1, viewing.kind === 'cosmetic' ? 0.74 : 0.82], { duration: 0 });
    syncViewZoom();
    return () => { cam.dispose(); if (viewCam.current === cam) viewCam.current = null; };
  }, [viewTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const viewZoomBy = (factor) => { viewCam.current?.zoomBy(factor); syncViewZoom(); };
  const viewReset = () => {
    const viewer = viewViewer.current;
    if (!viewer) return;
    try { viewer.resetCameraPose?.(); viewer.controls?.update?.(); viewer.playerObject?.rotation.set(0, 0, 0); viewCam.current?.reset(); syncViewZoom(); viewer.render?.(); } catch {}
  };

  // The popup steps through the capes currently listed in the grid.
  const stepView = useCallback((delta) => {
    if (!items.length) return;
    const at = items.findIndex((item) => item.id === viewId);
    const next = items[((at < 0 ? 0 : at) + delta + items.length) % items.length];
    if (next) setViewId(next.id);
  }, [items, viewId]);

  useEffect(() => {
    if (!viewId) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') setViewId(null);
      else if (event.key === 'ArrowRight') stepView(1);
      else if (event.key === 'ArrowLeft') stepView(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewId, stepView]);

  const run = async (label, fn) => {
    setBusy(label);
    try { await fn(); window.dispatchEvent(new Event('native:store-changed')); } catch (e) { onNotify?.('Store', e?.message || 'Something went wrong.'); }
    finally { setBusy(null); }
  };

  const claim = (item) => run(`claim:${item.id}`, async () => {
    const res = await window.native.store.claim(account, item.id);
    if (!res?.ok) throw new Error(res?.error || 'Couldn’t add that cloak.');
    setMe((current) => ({ ...current, owned: res.owned || current.owned }));
    onNotify?.('Store', `${item.name} was added to your locker.`);
  });

  /** Applies a change at once, then confirms with the server (and rolls back if it fails). */
  const optimistic = async (apply, request, confirm) => {
    const before = me;
    setMe(apply);
    try {
      const res = await request();
      if (!res?.ok) throw new Error(res?.error || 'Couldn’t do that.');
      confirm?.(res);
      window.dispatchEvent(new Event('native:store-changed'));
    } catch (e) {
      setMe(before);
      onNotify?.('Store', e?.message || 'Something went wrong.');
    }
  };

  /** Hats, glasses, back items and shoes: one per slot, on top of the cape. */
  const wearCosmetic = (item, off = false) => {
    const word = SLOT_WORDS[item.slot] || 'cosmetic';
    const isOwned = ownedIds.has(item.id);
    const message = off ? `${item.name} taken off.` : `${item.name} is now your ${word} — in the launcher and in game.`;
    return optimistic(
      (current) => {
        const wearing = { ...(current.wearing || {}) };
        if (off) delete wearing[item.slot]; else wearing[item.slot] = item.id;
        return { ...current, wearing, owned: !off && !isOwned ? [{ id: item.id, acquiredAt: Date.now() }, ...current.owned] : current.owned };
      },
      () => window.native.store.wear(account, off ? null : item.id, item.slot),
      (res) => { setMe((current) => ({ ...current, owned: res.owned || current.owned, wearing: res.wearing || current.wearing })); onNotify?.('Store', message); }
    );
  };

  const wear = (item) => {
    const premium = isPremiumLinked(account);
    const isOwned = item ? ownedIds.has(item.id) : true;
    const message = item ? `${item.name} is now your cloak — in the launcher and in game.` : 'Cloak taken off.';
    return optimistic(
      (current) => ({ ...current, owned: item && !isOwned ? [{ id: item.id, acquiredAt: Date.now() }, ...current.owned] : current.owned, equipped: item?.id || null }),
      () => window.native.store.equip(account, item?.id || null, premium ? { target: 'premium' } : {}),
      (res) => { if (res.state && !premium) { setWardrobe(res.state); onWardrobeChanged?.(res.state); } onNotify?.('Store', message); }
    );
  };

  const toggleWish = (item) => {
    const on = !wishIds.has(item.id);
    return optimistic(
      (current) => ({ ...current, wishlist: on ? [{ id: item.id, addedAt: Date.now() }, ...(current.wishlist || [])] : (current.wishlist || []).filter((entry) => entry.id !== item.id) }),
      () => window.native.store.wish(account, item.id, on),
      (res) => setMe((current) => ({ ...current, wishlist: res.wishlist || current.wishlist }))
    );
  };

  const shareUrl = (item) => `${siteUrl()}/${isCosmetic(item) ? 'cosmetics' : 'cloaks'}/${encodeURIComponent(item.id)}`;
  const copyLink = async (item) => {
    try { await navigator.clipboard.writeText(shareUrl(item)); onNotify?.('Store', `Link to ${item.name} copied. Paste it anywhere to show it off.`); }
    catch { window.native?.openExternal?.(shareUrl(item)); }
  };
  const myProfileUrl = () => `${siteUrl()}/u/${encodeURIComponent(account?.name || account?.username || '')}`;

  // Every purchase first asks where to pay: a checkout window inside the launcher, or the web browser.
  const askPay = (key, request, info) => { if (!busy) setPayAsk({ key, request, info }); };
  const pay = (where) => {
    const ask = payAsk;
    if (!ask) return;
    setPayAsk(null);
    run(ask.key, async () => {
      const res = await window.native.billing.checkout(account, { ...ask.request, where });
      if (!res?.ok) throw new Error(res?.error || 'Couldn’t start the checkout.');
      setPending({ ...ask.info, where: res.inApp ? 'app' : 'browser' });
    });
  };
  const payLabel = pending?.where === 'browser' ? 'Finish paying in your browser…' : 'Finish paying in the checkout window…';

  const buy = (item) => askPay(`buy:${item.id}`, { kind: 'cape', itemId: item.id }, { kind: 'cape', itemId: item.id, name: item.name });

  const joinPlus = (plan) => askPay(`plus:${plan}`, { kind: 'plus', plan }, { kind: 'plus', plan, name: 'Native+' });

  const manageBilling = () => run('portal', async () => {
    const res = await window.native.billing.portal(account);
    if (!res?.ok) throw new Error(res?.error || 'Couldn’t open billing.');
  });

  const redeemCode = (event) => {
    event.preventDefault();
    if (!code.trim()) return;
    run('redeem', async () => {
      const res = await window.native.store.redeem(account, code.trim());
      if (!res?.ok) throw new Error(res?.error || 'That code didn’t work.');
      setCode('');
      setRedeemOpen(false);
      await load(true);
      if (res.item?.id) setViewId(res.item.id);
      onNotify?.('Store', `${res.item?.name || 'Your cloak'} was added to your locker.`);
    });
  };

  const unclaim = (item) => run(`unclaim:${item.id}`, async () => {
    const res = await window.native.store.unclaim(account, item.id);
    if (!res?.ok) throw new Error(res?.error || 'Couldn’t remove that cloak.');
    if (res.state && !isPremiumLinked(account)) { setWardrobe(res.state); onWardrobeChanged?.(res.state); }
    setMe((current) => ({ ...current, wearing: res.wearing || Object.fromEntries(Object.entries(current.wearing || {}).filter(([, id]) => id !== item.id)), owned: res.owned || [], equipped: isPremiumLinked(account) ? (current.equipped && (res.owned || []).some((entry) => entry.id === current.equipped) ? current.equipped : null) : (res.equipped || null) }));
    onNotify?.('Store', `${item.name} was removed from your locker.`);
  });

  /** The store cloak the player wears right now (shown with cosmetics so you see the whole outfit). */
  const wornCape = useMemo(() => (me.equipped ? (catalog?.items || []).find((item) => item.id === me.equipped && !isCosmetic(item)) || null : null), [catalog, me.equipped]);
  /** The signed-in player's skin wearing `item` with the rest of their outfit, for the 3D viewers. */
  const accountWearing = useCallback((item) => {
    if (!item) return null;
    const cape = isCosmetic(item) ? (sectionOf(item) === 'back' ? null : wornCape) : item; // wings and backpacks are easier to see without a cloak
    const preview = cape ? previews[cape.id] : null;
    return {
      ...account,
      skinUrl: wardrobe?.active?.skinUrl || account?.skinUrl || null,
      model: wardrobe?.active?.model || wardrobe?.model || account?.model,
      capeUrl: cape?.stillUrl || null,
      hasCape: Boolean(cape),
      capeAnim: cape?.animated && preview ? { stripUrl: preview, frames: cape.frames, fps: cape.fps } : null
    };
  }, [previews, wardrobe, account, wornCape]);
  const viewAccount = useMemo(() => accountWearing(viewing), [accountWearing, viewing]);
  /** The cosmetic being shown, plus what the player wears in the other slots (cloaks show with the whole outfit too). */
  const catalogById = useMemo(() => new Map((catalog?.items || []).map((item) => [item.id, item])), [catalog]);
  // Dyeable cosmetics: the colour shown (being tried, saved, or its own) and its dyed texture.
  const dyeShown = useCallback((item) => (item?.dyeable ? tryDye[item.id] || me.dyes?.[item.id] || item.dyeDefault || null : null), [tryDye, me.dyes]);
  const loadDye = useCallback((id, color) => {
    const key = `${id}|${color}`;
    if (dyeAsked.current.has(key)) return;
    dyeAsked.current.add(key);
    window.native?.store?.dyeTexture?.(id, color).then((res) => {
      if (res?.ok && res.texture) setDyeTex((current) => ({ ...current, [key]: res.texture }));
      else dyeAsked.current.delete(key);
    }).catch(() => { dyeAsked.current.delete(key); });
  }, []);
  const dyedAsset = useCallback((id) => {
    const asset = cosAssets[id];
    const item = catalogById.get(id);
    const color = dyeShown(item);
    if (!asset || !color || color === item.dyeDefault) return asset;
    return dyeTex[`${id}|${color}`] ? { ...asset, texture: dyeTex[`${id}|${color}`] } : asset;
  }, [cosAssets, catalogById, dyeShown, dyeTex]);
  useEffect(() => {
    for (const id of new Set([viewId, ...Object.values(me.wearing || {})].filter(Boolean))) {
      const item = catalogById.get(id);
      const color = dyeShown(item);
      if (color && color !== item.dyeDefault) loadDye(id, color);
    }
  }, [viewId, me.wearing, catalogById, dyeShown, loadDye]);
  useEffect(() => { if (!viewId) setTryDye({}); }, [viewId]);
  // Owners can keep the colour they tried: it shows in the launcher, on the website and in game.
  const [dyeBusy, setDyeBusy] = useState(false);
  const saveDye = async (item) => {
    const color = tryDye[item.id];
    if (!color || dyeBusy) return;
    setDyeBusy(true);
    try {
      const res = await window.native?.store?.dye?.(account, item.id, color === item.dyeDefault ? null : color);
      if (!res?.ok) throw new Error(res?.error || 'Could not dye that.');
      setMe((current) => ({ ...current, dyes: res.dyes || current.dyes }));
      setTryDye((current) => { const next = { ...current }; delete next[item.id]; return next; });
      onNotify?.('Store', `${item.name} is now ${color === item.dyeDefault ? 'back to its own colour' : 'dyed'}.`);
    } catch (error) { onNotify?.('Store', error?.message || 'Could not dye that.'); }
    finally { setDyeBusy(false); }
  };
  const renderDye = (item) => {
    const own = item.dyeDefault || null;
    const picks = [...(own ? [own] : []), ...(item.dyeColors || []).filter((hex) => hex !== own)];
    if (picks.length < 2) return null;
    const current = dyeShown(item) || own;
    const saved = me.dyes?.[item.id] || own;
    const owned = signedIn && ownedIds.has(item.id);
    const changed = tryDye[item.id] && tryDye[item.id] !== saved;
    return (
      <div className="store-dye" role="group" aria-label={`Try colours on ${item.name}`}>
        <span className="store-dye-label"><Palette size={13} />Try a colour</span>
        <div className="store-dye-swatches">
          {picks.map((hex) => <button key={hex} type="button" className={`store-dye-swatch${current === hex ? ' is-on' : ''}${hex === own ? ' is-own' : ''}`} style={{ '--dye': hex }} title={hex === own ? `Original (${hex})` : hex} aria-label={hex === own ? 'Original colour' : `Colour ${hex}`} aria-pressed={current === hex} onClick={() => setTryDye((cur) => ({ ...cur, [item.id]: hex }))} />)}
        </div>
        {owned && changed
          ? <PixelButton size="sm" icon={dyeBusy ? <Loader2 size={13} className="is-spinning" /> : <Check size={13} />} label="Keep this colour" disabled={dyeBusy} onClick={() => saveDye(item)} />
          : <small className="store-dye-note">{owned ? 'Your colour shows in game too.' : 'Pick any colour once it’s in your locker.'}</small>}
      </div>
    );
  };
  const cosmeticsFor = useCallback((item) => {
    if (!item) return null;
    const slot = isCosmetic(item) ? item.slot : null;
    // wings / backpacks replace the cloak, so leave them off while a cloak is the thing being previewed
    const others = Object.entries(me.wearing || {}).filter(([s]) => s !== slot && (slot || s !== 'back')).map(([, id]) => dyedAsset(id)).filter(Boolean);
    const list = [isCosmetic(item) ? dyedAsset(item.id) : null, ...others].filter(Boolean);
    return list.length ? list : null;
  }, [dyedAsset, me.wearing]);
  const viewCosmetics = useMemo(() => cosmeticsFor(viewing), [cosmeticsFor, viewing]);
  /** Store art for a cosmetic: the piece worn on the player's own skin (drawn once, then cached), the flat thumbnail until then. */
  const shotSkin = skinTextureUrl({ ...account, skinUrl: wardrobe?.active?.skinUrl || account?.skinUrl || null });
  const shotModel = shotModelOf(wardrobe?.active?.model || wardrobe?.model || account?.model);
  const cosmeticArt = (item, className) => (cosAssets[item.id]
    ? <WornShot item={item} asset={cosAssets[item.id]} skinUrl={shotSkin} model={shotModel} prepare={prepareSkinSource} fallback={cosAssets[item.id].thumb} className={className} />
    : <span className={`${className} is-loading`} />);

  /* ── bundles ── */
  const bundles = useMemo(() => catalog?.bundles || [], [catalog]);
  const itemsById = useMemo(() => new Map((catalog?.items || []).map((item) => [item.id, item])), [catalog]);
  const piecesOf = useCallback((bundle) => (bundle?.itemIds || []).map((id) => itemsById.get(id)).filter(Boolean), [itemsById]);
  const mineOf = useCallback((bundle) => (signedIn && bundle ? me.bundles?.[bundle.id] || null : null), [signedIn, me.bundles]);
  /** Props for the outfit picture of a bundle: every cosmetic on the player's skin plus the bundle's cloak. */
  const outfitOf = (bundle) => {
    const pieces = piecesOf(bundle);
    const cos = pieces.filter(isCosmetic);
    const cape = pieces.find((item) => !isCosmetic(item));
    return {
      pieces: cos.map((item) => ({ item, asset: cosAssets[item.id] })),
      cape: cape ? { id: cape.id, url: cape.stillUrl } : null,
      skinUrl: shotSkin,
      model: shotModel,
      prepare: prepareSkinSource,
      ready: cos.every((item) => cosAssets[item.id])
    };
  };
  /** A bundle piece as art: the worn shot for cosmetics, the (animated) cloak for capes. */
  const renderPieceArt = (item, className, prefix) => (isCosmetic(item)
    ? cosmeticArt(item, className)
    : <canvas ref={bindCanvas(`${prefix}:${item.id}`)} width={80} height={128} className={className} aria-hidden="true" />);
  /** The live 3D stage of the Bundles page: the player wearing the whole set. */
  const renderBundleStage = (bundle) => {
    const pieces = piecesOf(bundle);
    const cape = pieces.find((item) => !isCosmetic(item)) || null;
    const back = pieces.some((item) => isCosmetic(item) && item.slot === 'back');
    const cos = pieces.filter(isCosmetic).map((item) => cosAssets[item.id]).filter(Boolean);
    const strip = cape ? previews[cape.id] : null;
    const who = {
      ...account,
      skinUrl: wardrobe?.active?.skinUrl || account?.skinUrl || null,
      model: wardrobe?.active?.model || wardrobe?.model || account?.model,
      capeUrl: cape && !back ? cape.stillUrl : null,
      hasCape: Boolean(cape && !back),
      capeAnim: cape && !back && cape.animated && strip ? { stripUrl: strip, frames: cape.frames, fps: cape.fps } : null
    };
    const ready = pieces.filter(isCosmetic).every((item) => cosAssets[item.id]);
    return <SkinViewer3D key={`bundle:${bundle.id}:${ready ? 1 : 0}:${strip ? 1 : 0}`} account={who} cosmetics={cos.length ? cos : null} zoom={0.6} width={400} height={440} animation="walk" autoRotate />;
  };
  const setWorn = (bundle) => {
    const pieces = piecesOf(bundle).filter((item) => ownedIds.has(item.id));
    return pieces.length > 0 && pieces.every((item) => (isCosmetic(item) ? (me.wearing || {})[item.slot] === item.id : me.equipped === item.id));
  };
  const buyBundle = (bundle) => askPay(`bundle:${bundle.id}`, { kind: 'bundle', bundleId: bundle.id }, { kind: 'bundle', bundleId: bundle.id, name: bundle.name });
  const claimBundle = (bundle) => run(`bundle:${bundle.id}`, async () => {
    const res = await window.native.store.claimBundle(account, bundle.id);
    if (!res?.ok) throw new Error(res?.error || 'Couldn’t add that bundle.');
    setMe((current) => ({ ...current, owned: res.owned?.length ? res.owned : current.owned, bundles: res.bundles || current.bundles }));
    onNotify?.('Store', `The ${bundle.name} bundle was added to your locker.`);
  });
  /** Puts on every piece of the bundle you own: cosmetics in their slots, then the cloak. */
  const wearSet = (bundle) => run(`wearset:${bundle.id}`, async () => {
    const premium = isPremiumLinked(account);
    const pieces = piecesOf(bundle).filter((item) => ownedIds.has(item.id));
    let wearingNow = { ...(me.wearing || {}) };
    for (const item of pieces.filter(isCosmetic)) {
      const res = await window.native.store.wear(account, item.id, item.slot);
      if (!res?.ok) throw new Error(res?.error || `Couldn’t put on ${item.name}.`);
      wearingNow = res.wearing || { ...wearingNow, [item.slot]: item.id };
    }
    const cape = pieces.find((item) => !isCosmetic(item));
    if (cape) {
      const res = await window.native.store.equip(account, cape.id, premium ? { target: 'premium' } : {});
      if (!res?.ok) throw new Error(res?.error || `Couldn’t put on ${cape.name}.`);
      if (res.state && !premium) { setWardrobe(res.state); onWardrobeChanged?.(res.state); }
    }
    setMe((current) => ({ ...current, wearing: wearingNow, equipped: cape ? cape.id : current.equipped }));
    window.dispatchEvent(new Event('native:cosmetics-changed'));
    onNotify?.('Store', `You’re wearing the ${bundle.name} set — in the launcher and in game.`);
  });
  const openBundle = (id) => { setViewId(null); setBundleId(id); if (section !== 'bundles') pickSection('bundles'); };
  // The Locker's "Get the rest" opens the Store on that bundle (left in localStorage, or sent while the Store is open).
  const openBundleRef = useRef(openBundle);
  openBundleRef.current = openBundle;
  useEffect(() => {
    const take = () => {
      let id = null;
      try { id = localStorage.getItem('native.store.openBundle'); localStorage.removeItem('native.store.openBundle'); } catch {}
      if (id) openBundleRef.current(id);
    };
    take();
    window.addEventListener('native:store-open-bundle', take);
    return () => window.removeEventListener('native:store-open-bundle', take);
  }, []);
  const renderBundleActions = (bundle) => {
    const mine = mineOf(bundle);
    const spin = <Loader2 size={15} className="is-spinning" />;
    const locked = busy !== null;
    const ownsSome = Boolean(mine && mine.owned > 0);
    const wearBtn = (label = 'Wear set') => (setWorn(bundle)
      ? <PixelButton variant="ghost" size="lg" icon={<Check size={15} strokeWidth={3} />} label="Wearing this set" title="Every piece you own is on" onClick={() => onOpenLocker?.()} />
      : <PixelButton size="lg" poof disabled={locked} busy={busy === `wearset:${bundle.id}`} busyIcon={spin} icon={<Shirt size={15} />} label={label} onClick={() => wearSet(bundle)} />);
    if (bundle.phase === 'ended') return ownsSome ? wearBtn(mine.complete ? 'Wear set' : 'Wear what you own') : null;
    if (!signedIn) return <PixelButton variant="ghost" size="lg" icon={<Lock size={15} />} label="Sign in with Native" onClick={() => onOpenAccountSwitcher?.()} />;
    if (mine?.complete) return <>{wearBtn()}{onOpenLocker && <PixelButton variant="ghost" size="lg" icon={<Package size={15} />} label="Locker" onClick={onOpenLocker} />}</>;
    const due = mine ? mine.due : bundle.price;
    let main;
    if (due > 0) {
      if (plus?.active) main = <PixelButton variant="gold" size="lg" poof disabled={locked} busy={busy === `bundle:${bundle.id}`} busyIcon={spin} icon={<NativePlusIcon size={15} />} label="Add with Native+" title="Included with Native+" onClick={() => claimBundle(bundle)} />;
      else if (!billing.enabled) main = <PixelButton variant="locked" size="lg" label={`$${due.toFixed(2)} · soon`} title="Payments are switched on soon." />;
      else if (pending?.kind === 'bundle' && pending.bundleId === bundle.id) main = <PixelButton variant="ghost" size="lg" icon={spin} label={payLabel} title="Waiting for your payment. Click to stop waiting." onClick={() => setPending(null)} />;
      else main = <PixelButton size="lg" poof disabled={locked} busy={busy === `bundle:${bundle.id}`} busyIcon={spin} icon={<ShoppingBag size={15} />} label={ownsSome ? `Complete set $${due.toFixed(2)}` : `Buy bundle $${due.toFixed(2)}`} onClick={() => buyBundle(bundle)} />;
    } else {
      main = <PixelButton size="lg" poof disabled={locked} busy={busy === `bundle:${bundle.id}`} busyIcon={spin} icon={<Plus size={15} strokeWidth={3} />} label="Claim bundle" onClick={() => claimBundle(bundle)} />;
    }
    return <>{main}{ownsSome && !setWorn(bundle) && <PixelButton variant="ghost" size="lg" disabled={locked} busy={busy === `wearset:${bundle.id}`} busyIcon={spin} icon={<Shirt size={15} />} label="Wear yours" title="Put on the pieces you already own" onClick={() => wearSet(bundle)} />}</>;
  };
  /** "Part of the X bundle": shown in an item's details when a live bundle has it. */
  const renderUpsell = (item) => {
    const bundle = bundles.find((entry) => entry.phase !== 'ended' && (entry.itemIds || []).includes(item.id));
    if (!bundle) return null;
    const mine = mineOf(bundle);
    return (
      <button type="button" className="bdl-upsell" style={{ '--bc': bundleColor(bundle) }} onClick={() => openBundle(bundle.id)}>
        <span><Layers size={15} /></span>
        <span className="bdl-upsell-text">
          <strong>Part of the {bundle.name} bundle</strong>
          <small>{mine?.complete ? 'You own the whole set' : `${(bundle.itemIds || []).length} items${bundle.paid && bundle.savePercent ? ` · save ${bundle.savePercent}%` : ''}`}</small>
        </span>
        <ChevronRight size={15} />
      </button>
    );
  };

  const actionFor = (item, compact = false) => {
    const owned = ownedIds.has(item.id);
    const size = compact ? 'md' : 'lg';
    const block = compact;
    const spin = <Loader2 size={15} className="is-spinning" />;
    const stop = (fn) => (event) => { event.stopPropagation(); fn(); };
    if (item.exclusive && !owned) {
      return <PixelButton variant="exclusive" size={size} block={block} icon={<PixelStar size={12} className="px-icon" />} label={compact ? 'Event only' : 'Events & codes only'} title="Not sold. You get it at Native events or with a code." onClick={(event) => event.stopPropagation()} />;
    }
    if (!signedIn) {
      return <PixelButton variant="ghost" size={size} block={block} icon={<Lock size={15} />} label={compact ? 'Sign in' : 'Sign in with Native'} onClick={stop(() => onOpenAccountSwitcher?.())} />;
    }
    const wearing = isCosmetic(item) ? (me.wearing || {})[item.slot] === item.id : me.equipped === item.id;
    const put = isCosmetic(item) ? () => wearCosmetic(item) : () => wear(item);
    const off = isCosmetic(item) ? () => wearCosmetic(item, true) : () => wear(null);
    const offKey = isCosmetic(item) ? `wear:off:${item.slot}` : 'wear:off';
    const locked = busy !== null;
    if (!owned && item.paid) {
      if (plus?.active) {
        return <PixelButton variant="gold" size={size} block={block} poof disabled={locked} busy={busy === `claim:${item.id}`} busyIcon={spin} icon={<NativePlusIcon size={15} />} label={compact ? 'Plus' : 'Add with Native+'} title="Included with Native+" onClick={stop(() => claim(item))} />;
      }
      if (!billing.enabled) {
        return <PixelButton variant="locked" size={size} block={block} label={`$${nowPrice(item).toFixed(2)} · soon`} title="Payments are switched on soon." onClick={(event) => event.stopPropagation()} />;
      }
      if (pending?.itemId === item.id) {
        return <PixelButton variant="ghost" size={size} block={block} icon={spin} label={compact ? 'Waiting…' : payLabel} title="Waiting for your payment. Click to stop waiting." onClick={stop(() => setPending(null))} />;
      }
      return <PixelButton size={size} block={block} disabled={locked} busy={busy === `buy:${item.id}`} busyIcon={spin} icon={<ShoppingBag size={15} />} label={`Buy $${nowPrice(item).toFixed(2)}`} onClick={stop(() => buy(item))} />;
    }
    if (!owned) {
      return <PixelButton size={size} block={block} poof disabled={locked} busy={busy === `claim:${item.id}`} busyIcon={spin} icon={<Plus size={15} strokeWidth={3} />} label={compact ? 'Add' : 'Add to locker'} title="Add to your locker" onClick={stop(() => claim(item))} />;
    }
    return wearing
      ? <PixelButton variant="ghost" size={size} block={block} disabled={locked} busy={busy === offKey} busyIcon={spin} icon={<X size={15} strokeWidth={3} />} label="Take off" onClick={stop(off)} />
      : <PixelButton size={size} block={block} poof disabled={locked} busy={busy === `wear:${item.id}`} busyIcon={spin} icon={<Shirt size={15} />} label={compact ? 'Wear' : 'Wear now'} onClick={stop(put)} />;
  };

  const inSection = (catalog?.items || []).filter((item) => section === 'all' || sectionOf(item) === section);
  const counts = {
    all: inSection.length,
    animated: inSection.filter(moves).length,
    free: inSection.filter((item) => !item.paid && !item.exclusive).length,
    paid: inSection.filter((item) => item.paid).length,
    new: inSection.filter((item) => item.isNew).length,
    owned: inSection.filter((item) => ownedIds.has(item.id)).length,
    wish: inSection.filter((item) => wishIds.has(item.id)).length
  };
  const everything = catalog?.items || [];
  const ownedTotal = everything.filter((item) => ownedIds.has(item.id)).length;
  const sections = (() => {
    const known = (catalog?.sections || []).map((entry) => entry.id);
    const rank = (id) => { const at = SECTION_ORDER.indexOf(id); return at < 0 ? SECTION_ORDER.length : at; };
    const ids = [...new Set([...SECTION_ORDER, ...known, ...everything.map(sectionOf)])]
      .filter((id) => everything.some((item) => sectionOf(item) === id))
      .sort((a, b) => rank(a) - rank(b));
    const list = ids.map((id) => ({ id, label: SECTION_LABELS[id] || (catalog?.sections || []).find((entry) => entry.id === id)?.name || id, count: everything.filter((item) => sectionOf(item) === id).length }));
    const withBundles = bundles.length ? [{ id: 'bundles', label: SECTION_LABELS.bundles, count: bundles.filter((b) => b.phase !== 'ended').length || bundles.length, color: '#ffc23d' }, ...list] : list;
    return withBundles; // no "All" tab: Bundles first, then each category
  })();
  // a category that vanished (e.g. after a refresh) falls back to All
  const sectionKey = sections.map((entry) => entry.id).join();
  useEffect(() => { if (catalog && sections.length && !sections.some((entry) => entry.id === section)) setSection(sections[0].id); }, [catalog, sectionKey, section]); // eslint-disable-line react-hooks/exhaustive-deps
  const noun = section === 'all' ? 'the store' : section === 'capes' ? 'cloaks' : (SECTION_LABELS[section] || 'items').toLowerCase();
  const pickSection = (id) => {
    const from = sections.findIndex((entry) => entry.id === section);
    const to = sections.findIndex((entry) => entry.id === id);
    setSectionDir(to >= from ? 'right' : 'left');
    setSection(id);
    setViewId(null);
  };
  /** Category shelves for the All view, in store order. */
  const shelves = shelved ? sections.filter((entry) => entry.id !== 'all' && entry.id !== 'bundles').map((entry) => ({ ...entry, items: items.filter((item) => sectionOf(item) === entry.id) })).filter((entry) => entry.items.length) : [];
  const priceOf = (item) => (item.exclusive ? 'Event' : item.paid ? `$${nowPrice(item).toFixed(2)}` : 'Free');
  const bindCanvas = (key) => (node) => { if (node) canvases.current.set(key, node); else canvases.current.delete(key); };

  /** "You own this": a quiet row under the price with when it was added, whether it's on, and a way to the locker. */
  const renderOwned = (item) => {
    const entry = me.owned.find((owned) => owned.id === item.id);
    const on = isCosmetic(item) ? (me.wearing || {})[item.slot] === item.id : me.equipped === item.id;
    const since = entry?.acquiredAt ? new Date(entry.acquiredAt).toLocaleDateString([], { dateStyle: 'medium' }) : null;
    const how = entry?.source === 'purchase' ? 'Bought' : entry?.source === 'code' ? 'Redeemed' : entry?.source === 'plus' ? 'With Native+' : 'Added';
    return (
      <div className={`store-owned${on ? ' is-on' : ''}`}>
        <Package size={16} aria-hidden="true" />
        <div className="store-owned-copy">
          <strong>In your locker</strong>
          <span>{since ? `${how} ${since}` : how}<i aria-hidden="true">·</i><b className="store-owned-state">{on ? 'Wearing now' : 'Not worn'}</b></span>
        </div>
        {onOpenLocker && <button type="button" className="store-owned-link" onClick={onOpenLocker}>Open locker<ChevronRight size={13} /></button>}
      </div>
    );
  };
  const visibleTags = (item) => (item.tags || []).filter((tag) => tag !== 'animated' && tag !== 'exclusive');
  /** Badges, name, description, facts, tags and actions: shared by the hero and the 3D popup. */
  const renderDetails = (item, { kicker = null, Heading = 'h2' } = {}) => (
    <>
      <div className="store-spot-badges">
        {kicker}
        {item.featured && !kicker && <span className="store-badge solid"><PixelStar size={9} />Featured</span>}
        {item.exclusive && <span className="store-event-badge">Event</span>}
      </div>
      <Heading className="store-spot-name">{item.name}</Heading>
      <p className="store-spot-desc">{item.description}</p>
      {item.exclusive && <div className="store-exclusive-note"><PixelStar size={11} /><span>{ownedIds.has(item.id) ? 'You’re one of the few who have this. Thanks for testing Native!' : 'Not sold. You get it at Native events or with a redeem code.'}</span></div>}
      <div className="shop-price">
        <div>
          <small><InfinityIcon />{item.exclusive ? 'Event' : 'Lifetime'}</small>
          <strong>{priceOf(item)}</strong>
        </div>
        <span className="shop-creator"><Pencil />Creator: <b>{item.author || 'Native'}</b></span>
      </div>
      {Heading === 'h3' && item.dyeable && isCosmetic(item) && renderDye(item)}
      {ownedIds.has(item.id) && renderOwned(item)}
      {renderUpsell(item)}
      <dl className="store-spot-facts">
        <div><dt>Owned</dt><dd className="store-owners" title={`${item.owners || 0} ${item.owners === 1 ? 'player owns' : 'players own'} this`}><Users size={13} />{formatCount(item.owners)}</dd></div>
        <div><dt>Type</dt><dd>{isCosmetic(item) ? `${moves(item) ? 'Animated' : '3D'} ${SLOT_WORDS[item.slot] || 'cosmetic'}` : item.animated ? 'Animated' : 'Static'}</dd></div>
      </dl>
      {Heading === 'h3' && <p className="shop-lines"><span><Eye />Visible in Minecraft to all Native users</span><span><User />Visible on your Native profile</span></p>}
      {visibleTags(item).length > 0 && (
        <div className="store-tags">
          {visibleTags(item).map((tag) => <span key={tag} className="store-tag">#{tag}</span>)}
        </div>
      )}
      <div className="store-detail-actions">
        {actionFor(item)}
        {signedIn && <PixelButton variant="ghost" size="lg" icon={<Heart size={15} fill={wishIds.has(item.id) ? 'currentColor' : 'none'} />} label={wishIds.has(item.id) ? 'Wishlisted' : 'Wishlist'} title="Save for later" onClick={() => toggleWish(item)} />}
        <PixelIconButton size="lg" icon={<Copy size={15} />} label="Copy link" title="Copy a shareable link" onClick={() => copyLink(item)} />
        {signedIn && ownedIds.has(item.id) && !item.exclusive && !['purchase', 'code', 'founder'].includes(me.owned.find((entry) => entry.id === item.id)?.source) && <PixelButton variant="danger" size="lg" disabled={busy !== null} busy={busy === `unclaim:${item.id}`} busyIcon={<Loader2 size={15} className="is-spinning" />} icon={<Trash2 size={15} />} label="Remove" title="Remove from your locker" onClick={() => unclaim(item)} />}
      </div>
    </>
  );

  const renderCard = (item, index, prefix = '') => {
    const owned = ownedIds.has(item.id);
    const wished = wishIds.has(item.id);
    return (
      <article
        key={`${prefix}${item.id}`}
        style={{ '--i': Math.min(index, 14) }}
        className={`store-card store-pop${viewId === item.id ? ' active' : ''}${owned ? ' is-owned' : ''}`}
        onClick={() => setViewId(item.id)}
        tabIndex={0}
        aria-haspopup="dialog"
        aria-label={`${item.name}: view in 3D`}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setViewId(item.id); } }}
      >
        <div className="store-card-art">
          {isCosmetic(item)
            ? cosmeticArt(item, 'store-card-thumb')
            : <canvas ref={bindCanvas(prefix ? `${prefix}:${item.id}` : item.id)} width={80} height={128} className={`store-card-canvas${previews[item.id] ? '' : ' is-pending'}`} aria-hidden="true" />}
          <div className="store-card-badges">
            {item.exclusive && <span className="store-event-badge">Event</span>}
            {!item.exclusive && item.isNew && newMeans && <span className="store-new-badge">New</span>}
            {moves(item) && movesMean && <span className="store-anim-badge">Animated</span>}
            {item.dyeable && <span className="store-dye-badge" title="Try its colours in the 3D preview"><Palette size={11} />Dyeable</span>}
          </div>
          {signedIn && (
            <button type="button" className={`store-wish${wished ? ' is-on' : ''}`} aria-pressed={wished} aria-label={wished ? `Remove ${item.name} from wishlist` : `Add ${item.name} to wishlist`} title={wished ? 'In your wishlist' : 'Add to wishlist'} onClick={(event) => { event.stopPropagation(); toggleWish(item); }}>
              <Heart size={14} fill={wished ? 'currentColor' : 'none'} />
            </button>
          )}
          {owned && (isCosmetic(item) && (me.wearing || {})[item.slot] === item.id
            ? <span className="store-card-state is-worn"><i />Wearing</span>
            : <OwnedMark className="store-card-owned" />)}
        </div>
        <div className="store-card-meta">
          <div className="store-card-title"><strong>{item.name}</strong><span className={`store-price${item.exclusive ? ' is-exclusive' : ''}`}>{priceOf(item)}</span></div>
          <small className="store-owners" title={`${item.owners || 0} ${item.owners === 1 ? 'player owns' : 'players own'} this`}><Users size={12} />{formatCount(item.owners)}</small>
        </div>
        <div className="store-card-action">{actionFor(item, true)}</div>
      </article>
    );
  };

  return (
    <div className="store-view">
      <header className="store-header">
        <div className="store-header-copy">
          <h1 className="store-title page-title">Store</h1>
          <p className="store-subtitle">Cloaks and 3D cosmetics in one place. Try anything on your own skin, add it to your locker and wear it in the launcher and in game.</p>
        </div>
        <div className="store-header-actions">
          {signedIn && everything.length > 0 && (
            <div className="store-collection" title="Store items in your locker">
              <div className="store-collection-top"><span>Collection</span><strong>{ownedTotal}<small>/{everything.length}</small></strong></div>
              <div className="store-collection-bar"><i style={{ width: `${everything.length ? Math.round((ownedTotal / everything.length) * 100) : 0}%` }} /></div>
            </div>
          )}
          {signedIn && <PixelButton variant="ghost" icon={<Ticket size={15} />} label="Redeem code" onClick={() => setRedeemOpen(true)} />}
          {signedIn && <PixelButton variant="ghost" icon={<Package size={15} />} label="My locker" onClick={onOpenLocker} />}
          {signedIn && <PixelButton variant="ghost" icon={<UserRound size={15} />} label="My profile" title="Open your public profile to share it" onClick={() => window.native?.openExternal?.(myProfileUrl())} />}
          <PixelIconButton size="md" icon={<RefreshCw size={15} />} label="Refresh the store" title="Refresh" onClick={() => load(true)} />
        </div>
      </header>

      {error && <div className="store-note is-error" role="alert">{error}</div>}
      {offline && catalog && <div className="store-note">You’re offline. Showing the last store we saved.</div>}
      {!catalog && !error && (
        <div className="store-scroll" aria-busy="true" aria-label="Loading the store">
          <div className="store-grid">{Array.from({ length: 8 }, (_, index) => <div key={index} className="store-card store-skeleton" style={{ '--i': index }}><div className="store-card-art" /><div className="store-card-meta"><span /><small /></div></div>)}</div>
        </div>
      )}

      {catalog && !(catalog.items || []).length && (
        <div className="store-coming">
          <span className="store-coming-icon"><PixelCape size={22} /></span>
          <h2>New cloaks are on the way</h2>
          <p>The first Native cloaks are being made right now. They’ll show up here — and in your locker — the moment they drop.</p>
          <PixelButton variant="ghost" icon={<RefreshCw size={15} />} label="Check again" onClick={() => load(true)} />
        </div>
      )}

      {catalog && (catalog.items || []).length > 0 && (
        <div className="store-scroll">
          {billing.enabled && (
            <section className={`store-plus${plus?.active ? ' is-member' : ''}`} aria-label="Native+">
              <span className="store-plus-mark is-plus"><NativePlusIcon size={30} title="Native+" /></span>
              <div className="store-plus-copy">
                <strong>{plus?.active ? 'You’re a Native+ member' : 'Native+'}</strong>
                <span>
                  {plus?.active && plus.gifted
                    ? `Given to you by the Native team${plus.endsAt ? ` until ${new Date(plus.endsAt).toLocaleDateString([], { dateStyle: 'medium' })}` : ''}. Every paid cloak and cosmetic is yours to wear.`
                    : plus?.active
                    ? (plus.endsAt ? `Ends ${new Date(plus.endsAt).toLocaleDateString([], { dateStyle: 'medium' })}. Paid cloaks and cosmetics go back when it ends.` : `Every paid cloak is yours to wear${plus.renewsAt ? ` · renews ${new Date(plus.renewsAt).toLocaleDateString([], { dateStyle: 'medium' })}` : ''}.`)
                    : 'Every paid cloak and cosmetic while you’re a member, plus the Native+ badge. Cancel any time.'}
                </span>
              </div>
              <div className="store-plus-actions">
                {!signedIn ? (
                  <PixelButton variant="ghost" icon={<Lock size={15} />} label="Sign in with Native" onClick={onOpenAccountSwitcher} />
                ) : plus?.active && plus.gifted ? (
                  null
                ) : plus?.active ? (
                  <PixelButton variant="ghost" disabled={busy !== null} busy={busy === 'portal'} busyIcon={<Loader2 size={15} className="is-spinning" />} label="Manage" onClick={manageBilling} />
                ) : pending?.kind === 'plus' ? (
                  <PixelButton variant="ghost" icon={<Loader2 size={15} className="is-spinning" />} label={payLabel} onClick={() => setPending(null)} />
                ) : (
                  <>
                    <PixelButton variant="ghost" disabled={busy !== null} busy={busy === 'plus:monthly'} busyIcon={<Loader2 size={15} className="is-spinning" />} label={`$${(billing.plus?.monthly?.amount ?? 2.99).toFixed(2)} / month`} onClick={() => joinPlus('monthly')} />
                    <PixelButton variant="gold" poof disabled={busy !== null} busy={busy === 'plus:yearly'} busyIcon={<Loader2 size={15} className="is-spinning" />} icon={<NativePlusIcon size={15} />} label={`$${(billing.plus?.yearly?.amount ?? 24.99).toFixed(2)} / year`} onClick={() => joinPlus('yearly')} />
                  </>
                )}
              </div>
            </section>
          )}

          {sections.length > 1 && (
            <div className="store-sections">
              <PixelTabs
                size="sm"
                fill
                label="Store sections"
                value={section}
                onChange={pickSection}
                items={sections.map((entry) => ({ id: entry.id, label: entry.label, count: entry.count, color: entry.color }))}
              />
            </div>
          )}

          <div key={`shelf:${section}`} className={`store-shelf${sectionDir ? ` from-${sectionDir}` : ''}`}>
          {section === 'bundles' ? (
            <BundlesPage
              bundles={bundles}
              selectedId={bundleId}
              onSelect={(id) => { setBundleId(id); document.querySelector('.store-scroll')?.scrollTo({ top: 0, behavior: 'smooth' }); }}
              piecesOf={piecesOf}
              mineOf={mineOf}
              outfitOf={outfitOf}
              stage={renderBundleStage}
              renderPieceArt={renderPieceArt}
              renderActions={renderBundleActions}
              ownedIds={ownedIds}
              signedIn={signedIn}
              onOpenItem={(id) => setViewId(id)}
            />
          ) : <>
          {newest.length > 0 && (
            <section className="store-new-shelf" aria-label="Just added">
              <div className="store-shelf-head"><Sparkles size={14} /><strong>Just added</strong><span>New in the last 3 weeks</span></div>
              <div className="store-grid store-new-grid">{newest.map((item, index) => renderCard(item, index, 'new'))}</div>
            </section>
          )}
          <div className="store-toolbar">
            <PixelTabs
              size="sm"
              className="store-chips"
              label="Filter"
              value={filter}
              onChange={setFilter}
              items={FILTERS.filter((f) => (f.id !== 'owned' && f.id !== 'wish') || signedIn).map((f) => ({ id: f.id, label: f.label, count: counts[f.id] }))}
            />
            <label className="store-search">
              <Search size={14} aria-hidden="true" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${noun}`} aria-label={`Search ${noun}`} />
            </label>
            <Dropdown className="store-sort" value={sort} onChange={setSort} options={SORTS.map((x) => ({ value: x.id, label: x.label }))} />
          </div>

          {shelves.length > 0 && <BundleShelf bundles={bundles} piecesOf={piecesOf} mineOf={mineOf} outfitOf={outfitOf} onOpen={openBundle} onViewAll={() => pickSection('bundles')} />}
          {shelves.length > 0 ? (
            shelves.map((shelf) => (
              <section key={shelf.id} className="store-cat-shelf" aria-label={shelf.label}>
                <div className="store-cat-head">
                  <strong>{shelf.label}</strong>
                  {shelf.items.length > 4 && <button type="button" className="store-cat-more" onClick={() => pickSection(shelf.id)}>View all<ChevronRight size={13} /></button>}
                </div>
                <div className="store-grid">{shelf.items.slice(0, SHELF_SIZE).map((item, index) => renderCard(item, index, `shelf-${shelf.id}`))}</div>
              </section>
            ))
          ) : items.length === 0 ? (
            <div className="store-empty"><Store size={18} /><span>{filter === 'owned' ? `Your locker has nothing from ${noun} yet.` : filter === 'wish' ? `Tap the heart on any item to save it here.` : `No ${noun} match that.`}</span></div>
          ) : (
            <div className="store-grid" key={`grid:${filter}:${sort}`}>
              {items.map((item, index) => renderCard(item, index))}
            </div>
          )}
          </>}
          </div>
        </div>
      )}
      {viewing && (
        <div className="store-modal-backdrop store-viewer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setViewId(null); }}>
          <div className="store-viewer" role="dialog" aria-modal="true" aria-label={`${viewing.name} in 3D`}>
            <div className="store-viewer-stage">
              <SpotBackdrop />
              {viewAccount && <SkinViewer3D key={`view:${viewing.id}:${previews[viewing.id] ? 1 : 0}`} account={viewAccount} cosmetics={viewCosmetics} zoom={isCosmetic(viewing) ? 0.74 : 0.82} shot={viewing.slot === 'balloon' ? SHOTS.balloon : null} width={320} height={400} animation={viewPaused ? null : 'walk'} paused={viewPaused} autoRotate={!viewPaused} onViewer={(viewer) => { viewViewer.current = viewer; setViewTick((n) => n + 1); }} />}
              <div className="store-viewer-actions"><div><button type="button" onClick={viewReset} title="Reset view"><RotateCcw size={16} /></button><button type="button" onClick={() => viewZoomBy(1 / 1.25)} disabled={!viewZoom.out} title="Zoom out"><ZoomOut size={16} /></button><button type="button" onClick={() => viewZoomBy(1.25)} disabled={!viewZoom.in} title="Zoom in"><ZoomIn size={16} /></button></div><div><button type="button" onClick={() => setViewPaused((value) => !value)} title={viewPaused ? 'Play preview' : 'Pause preview'}>{viewPaused ? <Play size={16} /> : <Pause size={16} />}</button></div></div>
              <div className="store-viewer-art" aria-hidden="true">{isCosmetic(viewing) ? cosmeticArt(viewing, 'store-viewer-art-img') : <canvas ref={bindCanvas(`view:${viewing.id}`)} width={80} height={128} />}</div>
              {items.length > 1 ? (
                <div className="store-viewer-nav">
                  <button type="button" className="store-viewer-arrow" aria-label="Previous item" title="Previous (←)" onClick={() => stepView(-1)}>
                    <ChevronLeft size={16} strokeWidth={2.6} />
                  </button>
                  <span className="store-viewer-count">
                    <strong>{Math.max(1, items.findIndex((entry) => entry.id === viewing.id) + 1)}</strong> / {items.length}
                  </span>
                  <button type="button" className="store-viewer-arrow" aria-label="Next item" title="Next (→)" onClick={() => stepView(1)}>
                    <ChevronRight size={16} strokeWidth={2.6} />
                  </button>
                </div>
              ) : (
                <span className="store-viewer-hint">Drag to turn</span>
              )}
            </div>
            <div className="store-viewer-info" key={`vinfo:${viewing.id}`}>
              <ShopStrip color={SECTION_COLORS[sectionOf(viewing)]} />
              {renderDetails(viewing, { Heading: 'h3' })}
            </div>
            <PixelIconButton size="md" className="store-viewer-close" icon={<X size={16} strokeWidth={3} />} label="Close" onClick={() => setViewId(null)} />
          </div>
        </div>
      )}
      {payAsk && (
        <div className="store-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPayAsk(null); }}>
          <div className="store-modal" role="dialog" aria-label="Where do you want to pay?">
            <div className="store-modal-head">
              <span className="store-plus-mark"><ShoppingBag size={16} /></span>
              <div>
                <h3>Where do you want to pay?</h3>
                <p>{payAsk.info?.name ? `${payAsk.info.name}: ` : ''}secure checkout by Tebex either way. It unlocks here as soon as you’ve paid.</p>
              </div>
              <PixelIconButton icon={<X size={15} strokeWidth={3} />} label="Close" onClick={() => setPayAsk(null)} />
            </div>
            <PixelButton size="lg" block poof autoFocus icon={<AppWindow size={15} />} label="Pay in the launcher" onClick={() => pay('app')} />
            <PixelButton variant="ghost" size="lg" block icon={<Globe size={15} />} label="Pay in my browser" onClick={() => pay('browser')} />
          </div>
        </div>
      )}
      {redeemOpen && (
        <div className="store-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setRedeemOpen(false); }}>
          <form className="store-modal" role="dialog" aria-label="Redeem a code" onSubmit={redeemCode}>
            <div className="store-modal-head">
              <span className="store-plus-mark"><Ticket size={16} /></span>
              <div>
                <h3>Redeem a code</h3>
                <p>Got a code from a Native event or a giveaway? Enter it to add the cloak to your locker.</p>
              </div>
              <PixelIconButton icon={<X size={15} strokeWidth={3} />} label="Close" onClick={() => setRedeemOpen(false)} />
            </div>
            <input className="store-code-input" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="SUMMER-26" maxLength={32} autoFocus aria-label="Code" />
            <PixelButton type="submit" size="lg" block poof disabled={!code.trim() || busy !== null} busy={busy === 'redeem'} busyIcon={<Loader2 size={15} className="is-spinning" />} icon={<Ticket size={15} />} label="Redeem" />
          </form>
        </div>
      )}
    </div>
  );
}
