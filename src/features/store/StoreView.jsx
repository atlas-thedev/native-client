import { WornShot } from '../../lib/wornShot.jsx';
import { prepareSkinSource, skinTextureUrl } from '../../components/ui/SkinViewer3D.jsx';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { announcePlus } from '../../lib/usePlus.js';
import { PixelCape, PixelStar } from './PixelIcons.jsx';
import { PixelButton, PixelIconButton, PixelTabs } from '../../components/ui/PixelControls.jsx';
import { ShopStrip, SpotBackdrop } from '../../components/ui/ShopBits.jsx';
import Dropdown from '../../components/ui/Dropdown.jsx';
import { Check, Copy, Heart, UserRound, Sparkles, ChevronLeft, ChevronRight, Eye, Glasses, Infinity as InfinityIcon, Loader2, Lock, Package, Pencil, Plus, RefreshCw, Rotate3d, Search, Shirt, ShoppingBag, Store, Ticket, Trash2, Type, User, Users, X } from 'lucide-react';
import NativePlusIcon from '../../components/ui/NativePlusIcon.jsx';
import SkinViewer3D from '../../components/ui/SkinViewer3D.jsx';
import { drawCapeFront, loadStripImage } from '../../lib/animatedCape.js';
import './StoreView.css';
import '../../components/ui/shop.css';

/** The hero spotlight rotates through at most this many featured capes. */
export const MAX_FEATURED = 5;
const HERO_ROTATE_MS = 7000;

/** Featured capes in catalogue order (the API sorts featured first by `order`), capped at MAX_FEATURED. */
export const featuredCapes = (items = []) => items
  .filter((item) => item.featured && (item.section === 'capes' || !item.section))
  .slice(0, MAX_FEATURED);

/** 3D cosmetics (hats, glasses, back items, shoes) live in their own store sections. */
const shotModelOf = (model) => (model === 'slim' ? 'slim' : model === 'classic' ? 'default' : 'auto-detect');
export const isCosmetic = (item) => item?.kind === 'cosmetic';
const sectionOf = (item) => item?.section || 'capes';
const moves = (item) => Boolean(item?.animated || item?.motion);
const SECTION_LABELS = { all: 'All', capes: 'Cloaks', hats: 'Headwear', glasses: 'Glasses', back: 'Wings & Backpacks', shoes: 'Shoes', hand: 'In hand', balloon: 'Balloons' };
/** The order categories show in (the same as the website store). */
const SECTION_ORDER = ['capes', 'hats', 'glasses', 'back', 'shoes', 'hand', 'balloon'];
/** In the All view each category shelf shows this many items before "See all". */
const SHELF_SIZE = 8;
const SLOT_WORDS = { hats: 'hat', glasses: 'glasses', back: 'back item', shoes: 'shoes', hand: 'hand item', balloon: 'balloon' };
// Each section has its own slab colour, like the Locker switch (same pixel style, different colours).
export const SECTION_COLORS = { all: '#e8e8ea', capes: '#b48cff', hats: '#ff8a7a', glasses: '#7fb2ff', back: '#9fe0ff', shoes: '#ffb45c', hand: '#d7a6ff', balloon: '#ff9ec7' };

/** Featured items of one store section (or every section for 'all'), capped at MAX_FEATURED. */
export const featuredIn = (items = [], section = 'capes') => items
  .filter((item) => item.featured && (section === 'all' || sectionOf(item) === section))
  .slice(0, MAX_FEATURED);

/** Canvas keys are "<id>" or "<slot>:<id>" (hero / thumb / view). */
const itemIdOfKey = (key) => (key.includes(':') ? key.slice(key.indexOf(':') + 1) : key);

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'animated', label: 'Animated' },
  { id: 'free', label: 'Free' },
  { id: 'paid', label: 'Paid' },
  { id: 'new', label: 'New' },
  { id: 'owned', label: 'In my locker' },
  { id: 'wish', label: 'Wishlist' }
];
const SORTS = [
  { id: 'featured', label: 'Featured' },
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
  const [me, setMe] = useState({ owned: [], equipped: null, wearing: {}, wishlist: [] });
  const [section, setSection] = useState('all');
  const [sectionDir, setSectionDir] = useState(null); // 'right' | 'left': where the new shelf slides in from
  const [cosAssets, setCosAssets] = useState({}); // cosmetic id -> { model, texture, thumb }
  const [busy, setBusy] = useState(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('featured');
  const [viewId, setViewId] = useState(null); // cape open in the 3D viewer popup
  const [heroIndex, setHeroIndex] = useState(0);
  const [heroPaused, setHeroPaused] = useState(false);
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
  const [pending, setPending] = useState(null); // checkout waiting in the browser
  const [redeemOpen, setRedeemOpen] = useState(false);
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
      if (mine?.ok) setMe({ owned: mine.owned || [], equipped: (isPremiumLinked(account) ? mine.premiumEquipped : mine.equipped) || null, wearing: mine.wearing || {}, wishlist: mine.wishlist || [] });
    }
  }, [account]);

  useEffect(() => { load(false); }, [load]);
  useEffect(() => { loadBilling(); }, [loadBilling]);

  // After a checkout opens in the browser, watch for the payment to land.
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
      if (mine?.ok) setMe({ owned: mine.owned || [], equipped: (isPremiumLinked(account) ? mine.premiumEquipped : mine.equipped) || null, wearing: mine.wearing || {}, wishlist: mine.wishlist || [] });
      if (bill?.ok) { setPlus(bill.plus || null); announcePlus(bill.plus?.active); }
      const done = pending.kind === 'plus' ? bill?.plus?.active : (mine?.owned || []).some((entry) => entry.id === pending.itemId);
      if (done) {
        onNotify?.('Store', pending.kind === 'plus' ? 'Welcome to Native+! Every paid cloak and cosmetic is yours to wear.' : `${pending.name} is yours. It’s in your locker now.`);
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
    const ordered = section === 'all' ? list : [...list.filter((item) => sectionOf(item) === section), ...list.filter((item) => sectionOf(item) !== section)];
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

  const featured = useMemo(() => featuredIn(catalog?.items || [], section), [catalog, section]);
  const heroList = featured.length ? featured : (items[0] ? [items[0]] : []);
  const hero = heroList.length ? heroList[heroIndex % heroList.length] : null;
  const viewing = viewId ? (catalog?.items || []).find((item) => item.id === viewId) || null : null;

  // Keep the hero index valid when the featured list changes.
  useEffect(() => { setHeroIndex((index) => (heroList.length ? index % heroList.length : 0)); }, [heroList.length]);
  useEffect(() => { setHeroIndex(0); }, [section]);

  // Rotate through the featured capes; pause while hovered or while the 3D popup is open.
  useEffect(() => {
    if (featured.length < 2 || heroPaused || viewId) return undefined;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (reduce) return undefined;
    const timer = setTimeout(() => setHeroIndex((index) => (index + 1) % featured.length), HERO_ROTATE_MS);
    return () => clearTimeout(timer);
  }, [featured.length, heroIndex, heroPaused, viewId]);

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

  const shareUrl = (item) => `https://nativelaunch.xyz/${isCosmetic(item) ? 'cosmetics' : 'cloaks'}/${encodeURIComponent(item.id)}`;
  const copyLink = async (item) => {
    try { await navigator.clipboard.writeText(shareUrl(item)); onNotify?.('Store', `Link to ${item.name} copied. Paste it anywhere to show it off.`); }
    catch { window.native?.openExternal?.(shareUrl(item)); }
  };
  const myProfileUrl = () => `https://nativelaunch.xyz/u/${encodeURIComponent(account?.name || account?.username || '')}`;

  const buy = (item) => run(`buy:${item.id}`, async () => {
    const res = await window.native.billing.checkout(account, { kind: 'cape', itemId: item.id });
    if (!res?.ok) throw new Error(res?.error || 'Couldn’t start the checkout.');
    setPending({ kind: 'cape', itemId: item.id, name: item.name });
  });

  const joinPlus = (plan) => run(`plus:${plan}`, async () => {
    const res = await window.native.billing.checkout(account, { kind: 'plus', plan });
    if (!res?.ok) throw new Error(res?.error || 'Couldn’t start the checkout.');
    setPending({ kind: 'plus', plan, name: 'Native+' });
  });

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
  const heroAccount = useMemo(() => accountWearing(hero), [accountWearing, hero]);
  const viewAccount = useMemo(() => accountWearing(viewing), [accountWearing, viewing]);
  /** The cosmetic being shown, plus what the player wears in the other slots (cloaks show with the whole outfit too). */
  const cosmeticsFor = useCallback((item) => {
    if (!item) return null;
    const slot = isCosmetic(item) ? item.slot : null;
    // wings / backpacks replace the cloak, so leave them off while a cloak is the thing being previewed
    const others = Object.entries(me.wearing || {}).filter(([s]) => s !== slot && (slot || s !== 'back')).map(([, id]) => cosAssets[id]).filter(Boolean);
    const list = [isCosmetic(item) ? cosAssets[item.id] : null, ...others].filter(Boolean);
    return list.length ? list : null;
  }, [cosAssets, me.wearing]);
  const heroCosmetics = useMemo(() => cosmeticsFor(hero), [cosmeticsFor, hero]);
  const viewCosmetics = useMemo(() => cosmeticsFor(viewing), [cosmeticsFor, viewing]);
  /** Store art for a cosmetic: the piece worn on the player's own skin (drawn once, then cached), the flat thumbnail until then. */
  const shotSkin = skinTextureUrl({ ...account, skinUrl: wardrobe?.active?.skinUrl || account?.skinUrl || null });
  const shotModel = shotModelOf(wardrobe?.active?.model || wardrobe?.model || account?.model);
  const cosmeticArt = (item, className) => (cosAssets[item.id]
    ? <WornShot item={item} asset={cosAssets[item.id]} skinUrl={shotSkin} model={shotModel} prepare={prepareSkinSource} fallback={cosAssets[item.id].thumb} className={className} />
    : <span className={`${className} is-loading`} />);

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
        return <PixelButton variant="locked" size={size} block={block} label={`$${Number(item.price).toFixed(2)} · soon`} title="Payments are switched on soon." onClick={(event) => event.stopPropagation()} />;
      }
      if (pending?.itemId === item.id) {
        return <PixelButton variant="ghost" size={size} block={block} icon={spin} label={compact ? 'Waiting…' : 'Finish paying in your browser…'} title="Waiting for your payment. Click to stop waiting." onClick={stop(() => setPending(null))} />;
      }
      return <PixelButton size={size} block={block} disabled={locked} busy={busy === `buy:${item.id}`} busyIcon={spin} icon={<ShoppingBag size={15} />} label={`Buy $${Number(item.price).toFixed(2)}`} onClick={stop(() => buy(item))} />;
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
    return list.length > 1 ? [{ id: 'all', label: SECTION_LABELS.all, count: everything.length }, ...list] : list;
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
  const shelves = shelved ? sections.filter((entry) => entry.id !== 'all').map((entry) => ({ ...entry, items: items.filter((item) => sectionOf(item) === entry.id) })).filter((entry) => entry.items.length) : [];
  const priceOf = (item) => (item.exclusive ? 'Event' : item.paid ? `$${Number(item.price).toFixed(2)}` : 'Free');
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
      {ownedIds.has(item.id) && renderOwned(item)}
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
        {signedIn && ownedIds.has(item.id) && !item.exclusive && !['purchase', 'code'].includes(me.owned.find((entry) => entry.id === item.id)?.source) && <PixelButton variant="danger" size="lg" disabled={busy !== null} busy={busy === `unclaim:${item.id}`} busyIcon={<Loader2 size={15} className="is-spinning" />} icon={<Trash2 size={15} />} label="Remove" title="Remove from your locker" onClick={() => unclaim(item)} />}
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
          <span className="store-card-try" aria-hidden="true">View in 3D</span>
          <div className="store-card-badges">
            {item.exclusive && <span className="store-event-badge">Event</span>}
            {!item.exclusive && item.isNew && newMeans && <span className="store-new-badge">New</span>}
            {moves(item) && movesMean && <span className="store-anim-badge">Animated</span>}
          </div>
          {signedIn && (
            <button type="button" className={`store-wish${wished ? ' is-on' : ''}`} aria-pressed={wished} aria-label={wished ? `Remove ${item.name} from wishlist` : `Add ${item.name} to wishlist`} title={wished ? 'In your wishlist' : 'Add to wishlist'} onClick={(event) => { event.stopPropagation(); toggleWish(item); }}>
              <Heart size={14} fill={wished ? 'currentColor' : 'none'} />
            </button>
          )}
          {owned && (isCosmetic(item) && (me.wearing || {})[item.slot] === item.id
            ? <span className="store-card-state is-worn"><i />Wearing</span>
            : <span className="store-card-state"><Check size={10} strokeWidth={3} />Owned</span>)}
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
      <header className="store-header shop-hero">
        <SpotBackdrop />
        <div className="store-header-copy">
          <h1 className="store-title page-title">Native Store</h1>
          <p className="shop-hero-blurb">Cloaks and 3D cosmetics in one place. Try anything on your own skin, add it to your locker and wear it in the launcher and in game.</p>
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
          {hero && (
            <section
              className={`store-spot${featured.length ? ' is-featured' : ''}`}
              aria-label={featured.length ? 'Featured' : `${hero.name} details`}
              aria-roledescription={featured.length > 1 ? 'carousel' : undefined}
              onMouseEnter={() => setHeroPaused(true)}
              onMouseLeave={() => setHeroPaused(false)}
              onFocus={() => setHeroPaused(true)}
              onBlur={() => setHeroPaused(false)}
            >
              <SpotBackdrop />
              <div className="store-spot-info" key={`info:${hero.id}`}>
                {renderDetails(hero, {
                  kicker: featured.length
                    ? <span className="store-badge solid"><PixelStar size={9} />{featured.length > 1 ? `Featured · ${(heroIndex % featured.length) + 1}/${featured.length}` : 'Featured'}</span>
                    : null
                })}
              </div>
              <button type="button" className="store-spot-stage" onClick={() => setViewId(hero.id)} title={`View ${hero.name} in 3D`} aria-label={`View ${hero.name} in 3D`}>
                {heroAccount && <SkinViewer3D key={`hero:${hero.id}:${previews[hero.id] ? 1 : 0}`} account={heroAccount} cosmetics={heroCosmetics} zoom={isCosmetic(hero) ? 0.72 : 0.82} width={280} height={330} animation="walk" autoRotate />}
                <span className="store-spot-zoom"><Rotate3d size={13} />View in 3D</span>
              </button>
              {featured.length > 1 ? (
                <div className="store-spot-picker" role="tablist" aria-label="Featured items">
                  {featured.map((item, index) => {
                    const active = index === heroIndex % featured.length;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        className={`store-spot-thumb${active ? ' active' : ''}`}
                        onClick={() => setHeroIndex(index)}
                        title={item.name}
                      >
                        {isCosmetic(item) ? cosmeticArt(item, 'store-spot-thumb-img') : <canvas ref={bindCanvas(`thumb:${item.id}`)} width={80} height={128} aria-hidden="true" />}
                        <span>{item.name}</span>
                        {active && !heroPaused && !viewId && <i key={`bar:${heroIndex}`} className="store-spot-progress" style={{ animationDuration: `${HERO_ROTATE_MS}ms` }} />}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="store-spot-art" aria-hidden="true">
                  {isCosmetic(hero) ? cosmeticArt(hero, 'store-spot-art-img') : <canvas ref={bindCanvas(`hero:${hero.id}`)} width={80} height={128} />}
                </div>
              )}
            </section>
          )}

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
                  <PixelButton variant="ghost" icon={<Loader2 size={15} className="is-spinning" />} label="Finish paying in your browser…" onClick={() => setPending(null)} />
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
                label="Store sections"
                value={section}
                onChange={pickSection}
                items={sections.map((entry) => ({ id: entry.id, label: entry.label, count: entry.count, color: SECTION_COLORS[entry.id] }))}
              />
            </div>
          )}

          <div key={`shelf:${section}`} className={`store-shelf${sectionDir ? ` from-${sectionDir}` : ''}`}>
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
          </div>
        </div>
      )}
      {viewing && (
        <div className="store-modal-backdrop store-viewer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setViewId(null); }}>
          <div className="store-viewer" role="dialog" aria-modal="true" aria-label={`${viewing.name} in 3D`}>
            <div className="store-viewer-stage">
              <SpotBackdrop />
              {viewAccount && <SkinViewer3D key={`view:${viewing.id}:${previews[viewing.id] ? 1 : 0}`} account={viewAccount} cosmetics={viewCosmetics} zoom={isCosmetic(viewing) ? 0.74 : 0.82} width={320} height={400} animation="walk" autoRotate />}
              <div className="store-viewer-art" aria-hidden="true">{isCosmetic(viewing) ? cosmeticArt(viewing, 'store-viewer-art-img') : <canvas ref={bindCanvas(`view:${viewing.id}`)} width={80} height={128} />}</div>
              <span className="store-viewer-hint">Drag to turn</span>
            </div>
            <div className="store-viewer-info" key={`vinfo:${viewing.id}`}>
              <ShopStrip color={SECTION_COLORS[sectionOf(viewing)]} />
              {renderDetails(viewing, { Heading: 'h3' })}
            </div>
            <PixelIconButton size="md" className="store-viewer-close" icon={<X size={16} strokeWidth={3} />} label="Close" onClick={() => setViewId(null)} />
            {items.length > 1 && (
              <div className="store-viewer-nav">
                <PixelIconButton size="md" icon={<ChevronLeft size={17} strokeWidth={3} />} label="Previous item" title="Previous (←)" onClick={() => stepView(-1)} />
                <PixelIconButton size="md" icon={<ChevronRight size={17} strokeWidth={3} />} label="Next item" title="Next (→)" onClick={() => stepView(1)} />
              </div>
            )}
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
