import { WornShot } from '../../lib/wornShot.jsx';
import { RARITY, bundleColor } from '../store/BundleViews.jsx';
import { prepareSkinSource, skinTextureUrl } from '../../components/ui/SkinViewer3D.jsx';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Download, Eye, EyeOff, Folder, HardDrive, Layers, Lock, Palette, Pause, Play, Plus, RefreshCw, RotateCcw, Search, Sparkles, Star, Store, Trash2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { createCamera, SHOTS } from '../../lib/viewerCamera.js';
import SkinViewer3D from '../../components/ui/SkinViewer3D.jsx';
import LockerSwitch from './LockerSwitch.jsx';
import { PixelButton, PixelIconButton, PixelTabs } from '../../components/ui/PixelControls.jsx';
import { CAPE_PRESETS, presetTextureDataUrl } from './capePresets.js';
import { drawCapeFront, loadStripImage } from '../../lib/animatedCape.js';
import { loadStoreCape, peekStoreCape } from '../../lib/storeCapeCache.js';
import useOfficialCapes from './useOfficialCapes.js';
import { detectSkinModel, readFileAsDataUrl } from '../../lib/skins.js';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import './LockerView.css';
import './LockerLocal.css';

const SKINS_PER_PAGE = 9;
// Quick picks for dyeable cosmetics (same list as the server and the website).
const SECTION_KEY = 'native.locker.section';
const COS_TAB_KEY = 'native.locker.cosTab';
// Cosmetics sub-tabs. `slot` = a 3D cosmetic slot; cloaks come from the Store, capes from Minecraft.
const COS_TABS = [
  { id: 'cloaks', label: 'Cloaks', color: '#b48cff', kicker: 'Native Store', title: 'Cloaks', noun: 'cloaks' },
  { id: 'hats', label: 'Hats', color: '#ff8a7a', slot: 'hats', kicker: 'Native Store · 3D', title: 'Hats', noun: 'hats' },
  { id: 'glasses', label: 'Glasses', color: '#7fb2ff', slot: 'glasses', kicker: 'Native Store · 3D', title: 'Glasses', noun: 'glasses' },
  { id: 'back', label: 'Wings', color: '#9fe0ff', slot: 'back', kicker: 'Native Store · 3D', title: 'Wings & Backpacks', noun: 'wings or backpacks' },
  { id: 'shoes', label: 'Shoes', color: '#ffb45c', slot: 'shoes', kicker: 'Native Store · 3D', title: 'Shoes', noun: 'shoes' },
  { id: 'hand', label: 'Hand', color: '#d7a6ff', slot: 'hand', kicker: 'Native Store · 3D', title: 'Hand Items', noun: 'hand items' },
  { id: 'bundles', label: 'Sets', color: '#ffb020', kicker: 'Native Store · Bundles', title: 'Sets', noun: 'sets' },
  { id: 'capes', label: 'Capes', color: '#8ee07a', kicker: 'Minecraft', title: 'Capes', noun: 'capes' }
];
// Front-facing slots turn the player to face you; the rest show the back.
const FRONT_TABS = new Set(['hats', 'glasses', 'shoes', 'hand', 'bundles']);
const priceLabel = (item) => { const sale = Number(item.salePrice); const now = item.salePrice != null && Number.isFinite(sale) && sale > 0 ? sale : Number(item.price) || 0; return item.exclusive ? 'Event' : item.paid ? `$${now.toFixed(2)}` : 'Free'; };

// Collapses "Founder's Cape", "founders", "FOUNDER" … to one comparable token so
// a bundled preset can be recognized as the same cape the account already owns.
const normalizeCapeName = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/cape$/, '');

export default function LockerView({ account, onWardrobeChanged, onNotify, onOpenStore, online = true }) {
  const { t } = useI18n();
  // Offline accounts keep their skins on this PC only; nothing is sent to Native.
  const localOnly = account?.type === 'offline';
  const [wardrobe, setWardrobe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  // 'idle' | 'syncing' | 'offline' — the cloud copy is fetched in the background.
  const [cloud, setCloud] = useState('idle');
  const [paused, setPaused] = useState(false);
  const [showCape, setShowCape] = useState(true);
  const [showLayers, setShowLayers] = useState(true);
  const [skinPage, setSkinPage] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [importData, setImportData] = useState(null);
  const [importSaving, setImportSaving] = useState(false);
  // Native Store capes this account owns: [{ item, acquiredAt }]
  const [storeCapes, setStoreCapes] = useState([]);
  const [storeBusy, setStoreBusy] = useState(null);
  // Premium account: the Native cloak it wears in game (other Native players see it).
  const [premiumEquipped, setPremiumEquipped] = useState(null);
  // The worn Store cloak as the server knows it. Remembered per account so the cape is on the model the moment the Locker opens.
  const wornHintKey = `native.locker.worn.${account?.id || 'guest'}`;
  const [storeEquipped, setStoreEquipped] = useState(() => { try { return localStorage.getItem(`native.locker.worn.${account?.id || 'guest'}`) || null; } catch { return null; } });
  const [capeReady, setCapeReady] = useState(0); // bumps when a cloak texture finishes loading
  // 3D cosmetics: what's worn per slot ({ hats: id, ... }) and each owned cosmetic's model/texture/thumb
  const [wearing, setWearing] = useState({});
  const [sides, setSides] = useState({});
  const [dyes, setDyes] = useState({}); // itemId -> '#rrggbb' the player picked
  const [dyeTex, setDyeTex] = useState({}); // `${itemId}|${hex}` -> dyed texture (data URL)
  const dyeRequested = useRef(new Set());
  const [cosAssets, setCosAssets] = useState({});
  const cosRequested = useRef(new Set());
  // Everything in the Store (so the Locker can offer what you don't own yet) and the item being tried on.
  const [catalogItems, setCatalogItems] = useState([]);
  const [tryOn, setTryOn] = useState(null);
  const [catalogBundles, setCatalogBundles] = useState([]); // Store bundles (sets of items)
  const [bundleMine, setBundleMine] = useState({}); // bundleId -> { owned, total, complete, due }
  const [trySet, setTrySet] = useState(null); // a bundle being previewed on the model
  const [cosTab, setCosTab] = useState(() => {
    try { const saved = localStorage.getItem(COS_TAB_KEY); return COS_TABS.some((tab) => tab.id === saved) ? saved : 'cloaks'; } catch { return 'cloaks'; }
  });
  const [cosDir, setCosDir] = useState(null);
  // bumped on every tab click, so clicking a tab always re-frames the camera (even the same tab after orbiting/zooming)
  const [shotTick, setShotTick] = useState(0);
  const switchCosTab = (next) => {
    setShotTick((n) => n + 1);
    if (next === cosTab) return;
    const from = COS_TABS.findIndex((tab) => tab.id === cosTab);
    const to = COS_TABS.findIndex((tab) => tab.id === next);
    setCosDir(to > from ? 'right' : 'left');
    setCosTab(next);
    setTryOn(null);
    try { localStorage.setItem(COS_TAB_KEY, next); } catch {}
  };
  // The two big tabs: 'skins' or 'cosmetics' (cloaks + capes). `leaving` is the
  // section animating out while the new one bounces in.
  const [section, setSection] = useState(() => {
    try { return localStorage.getItem(SECTION_KEY) === 'cosmetics' ? 'cosmetics' : 'skins'; } catch { return 'skins'; }
  });
  const [leaving, setLeaving] = useState(null);
  const switchSection = (next) => {
    setShotTick((n) => n + 1);
    if (next === section) return;
    setLeaving(section);
    setSection(next);
    setTryOn(null);
    try { localStorage.setItem(SECTION_KEY, next); } catch {}
  };
  const viewerRef = useRef(null);
  // Camera: eases to the part being dressed (head for hats, feet for shoes...) and zooms in/out.
  const camRef = useRef(null);
  const stageRef = useRef(null);
  const [viewerTick, setViewerTick] = useState(0);
  const [zoomState, setZoomState] = useState({ in: true, out: true });
  const syncZoom = () => { const cam = camRef.current; if (cam) setZoomState({ in: cam.canZoomIn(), out: cam.canZoomOut() }); };
  const zoomBy = (factor, animate = true) => { camRef.current?.zoomBy(factor, { animate }); syncZoom(); };
  const fileInputRef = useRef(null);
  const [capeQuery, setCapeQuery] = useState('');
  const [skinQuery, setSkinQuery] = useState('');

  const publishState = (next) => {
    setWardrobe(next);
    onWardrobeChanged?.(next);
    return next;
  };

  // Accounts whose locker lives in the Native cloud: Native accounts and premium
  // accounts (every premium account is a Native account). Offline ones stay on this PC.
  const cloudAccount = !localOnly && (account?.type === 'native' || (account?.type === 'microsoft' && Boolean(account?.nativeLink?.connected)));
  const onlineRef = useRef(online);
  onlineRef.current = online;
  const syncRun = useRef(0);

  // Pull the cloud copy / publish local edits without ever blocking the saved one.
  const syncInBackground = async () => {
    if (!account || !cloudAccount) { setCloud('idle'); return; }
    if (!onlineRef.current) { setCloud('offline'); return; }
    const run = ++syncRun.current;
    setCloud('syncing');
    try {
      const res = await window.native?.wardrobe?.sync?.(account);
      if (run !== syncRun.current) return;
      if (res?.pulled && res?.state) publishState(res.state);
      else if (res?.ok) window.native.wardrobe.get(account).then((next) => { if (run === syncRun.current) publishState(next); }).catch(() => {});
      setCloud(res?.offline ? 'offline' : 'idle');
    } catch {
      if (run === syncRun.current) setCloud(onlineRef.current ? 'idle' : 'offline');
    }
  };

  const loadWardrobe = async () => {
    if (!account) return;
    setLoading(true);
    try {
      if (window.native?.wardrobe?.get) {
        // The saved copy on this PC is shown straight away (instant when offline).
        const current = await window.native.wardrobe.get(account);
        publishState(current);
        syncInBackground();
      } else {
        const saved = localStorage.getItem(`native.wardrobe.${account.id || 'default'}`)
          || localStorage.getItem(`native.wardrobe.${account.id || 'default'}`);
        publishState(saved ? JSON.parse(saved) : { model: account.model || 'classic', items: [], skins: [], capes: [], favorites: [], latest: [], active: { skinUrl: null, capeUrl: null, model: account.model || 'classic', hasSkin: false, hasCape: false } });
      }
    } catch (error) {
      console.warn('Could not load wardrobe:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadWardrobe(); }, [account?.id]);

  // Live: the launcher shell pulls the cloud copy whenever the website / another device changes it.
  useEffect(() => {
    if (!account) return undefined;
    const refresh = () => { window.native?.wardrobe?.get?.(account).then((next) => { if (next) publishState(next); }).catch(() => {}); };
    window.addEventListener('native:wardrobe-refreshed', refresh);
    return () => window.removeEventListener('native:wardrobe-refreshed', refresh);
  }, [account?.id]);

  // Native Store capes this account owns (claimed in the Store page or on the website).
  const storeSeq = useRef(0);
  const loadStoreCapes = async () => {
    const premiumLinked = account?.type === 'microsoft' && Boolean(account?.nativeLink?.connected);
    if (!premiumLinked && (!(account?.token || account?.linkedFrom) || account?.type !== 'native' || localOnly)) { setStoreCapes([]); setPremiumEquipped(null); return; }
    const run = ++storeSeq.current;
    try {
      // The catalogue is cached locally, so show it (and start loading the worn cloak) without waiting for the account call.
      const catalogJob = Promise.resolve(window.native?.store?.catalog?.({}));
      catalogJob.then((early) => { if (run === storeSeq.current && early?.ok) { setCatalogItems(early.items || []); setCatalogBundles(early.bundles || []); } }).catch(() => {});
      const [catalog, mine] = await Promise.all([catalogJob, window.native?.store?.me?.(account)]);
      if (run !== storeSeq.current || !catalog?.ok || !mine?.ok) return;
      const byId = new Map((catalog.items || []).map((item) => [item.id, item]));
      setCatalogItems(catalog.items || []);
      setCatalogBundles(catalog.bundles || []);
      setBundleMine(mine.bundles || {});
      setStoreEquipped(mine.equipped || null);
      try { if (mine.equipped) localStorage.setItem(wornHintKey, mine.equipped); else localStorage.removeItem(wornHintKey); } catch {}
      setStoreCapes((mine.owned || []).filter((entry) => byId.has(entry.id)).map((entry) => ({ item: byId.get(entry.id), acquiredAt: entry.acquiredAt })));
      setPremiumEquipped(premiumLinked ? (mine.equipped || null) : null);
      setWearing(mine.wearing || {});
      setSides(mine.sides || {});
      setDyes(mine.dyes || {});
      const cosmetics = (mine.owned || []).map((entry) => byId.get(entry.id)).filter((item) => item && item.kind === 'cosmetic');
      for (const item of cosmetics) fetchCosmetic(item.id);
    } catch {}
  };
  // Model, texture and thumbnail of one cosmetic, fetched once.
  const fetchCosmetic = (id) => {
    if (cosRequested.current.has(id)) return;
    cosRequested.current.add(id);
    window.native?.store?.cosmetic?.(id).then((res) => {
      if (res?.ok) setCosAssets((current) => (current[id] ? current : { ...current, [id]: res }));
      else cosRequested.current.delete(id);
    }).catch(() => { cosRequested.current.delete(id); });
  };
  // Store items you don't own yet get their thumbnails when their tab opens.
  useEffect(() => {
    const slot = COS_TABS.find((tab) => tab.id === cosTab)?.slot;
    if (section === 'cosmetics' && cosTab === 'bundles') {
      const ids = new Set(catalogBundles.flatMap((bundle) => bundle.itemIds || []));
      for (const item of catalogItems) if (item.kind === 'cosmetic' && ids.has(item.id)) fetchCosmetic(item.id);
      return;
    }
    if (section !== 'cosmetics' || !slot) return;
    for (const item of catalogItems) if (item.kind === 'cosmetic' && item.slot === slot) fetchCosmetic(item.id);
  }, [section, cosTab, catalogItems, catalogBundles]);
  // Leaving the Sets tab stops previewing a set.
  useEffect(() => { if (cosTab !== 'bundles' || section !== 'cosmetics') setTrySet(null); }, [cosTab, section]);
  useEffect(() => { loadStoreCapes(); }, [account?.id, account?.token, account?.nativeLink?.connected, online]);
  useEffect(() => {
    const refresh = () => loadStoreCapes();
    window.addEventListener('native:wardrobe-refreshed', refresh);
    window.addEventListener('native:store-changed', refresh);
    return () => { window.removeEventListener('native:wardrobe-refreshed', refresh); window.removeEventListener('native:store-changed', refresh); };
  }, [account?.id, account?.token]);

  // Connection lost -> keep working from the saved copy. Connection back -> sync again in the background.
  const wasOnline = useRef(online);
  useEffect(() => {
    const before = wasOnline.current;
    wasOnline.current = online;
    if (!cloudAccount) return;
    if (!online) setCloud('offline');
    else if (!before) syncInBackground();
  }, [online]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer?.playerObject) return;
    if (viewer.playerObject.skin?.outerLayer) viewer.playerObject.skin.outerLayer.visible = showLayers;
    if (viewer.playerObject.cape) viewer.playerObject.cape.visible = showCape;
    if (viewer.renderPaused) viewer.render();
  }, [showLayers, showCape]);

  const official = useOfficialCapes(account);
  // Microsoft accounts manage their REAL owned Minecraft capes; everyone else
  // uses the bundled presets. On an official-profile error (e.g. 402 no licence)
  // we fall back to the preset strip so the user is never left without capes.
  const officialMode = official.active;
  const showOfficialCards = officialMode && !official.loading && !official.error;

  // Skeletons: shown while the first read is in flight, and (cloud accounts) while the
  // cloud copy loads for the very first time. A saved copy is never hidden behind them.
  const hasSavedContent = Boolean(wardrobe?.items?.length || wardrobe?.active?.skinUrl);
  const skeleton = loading || (cloudAccount && online && cloud === 'syncing' && !hasSavedContent);
  const capesSkeleton = skeleton || (officialMode && official.loading && !official.capes?.length);

  // Premium (Microsoft) accounts show their real Mojang skin, not a wardrobe one.
  const officialSkin = officialMode ? (official.profile?.skins || []).find((skin) => skin.state === 'ACTIVE') || null : null;
  const currentModel = officialSkin ? (String(officialSkin.variant || '').toUpperCase() === 'SLIM' ? 'slim' : 'classic') : (wardrobe?.model || account?.model || 'classic');
  // Official cape equips never touch the local wardrobe, so feed the active
  // official cape URL straight into the viewer; otherwise use the wardrobe cape.
  const premiumCapeItem = showOfficialCards && premiumEquipped ? (storeCapes.find(({ item }) => item.id === premiumEquipped)?.item || null) : null;
  // A worn Store cloak the wardrobe hasn't caught up with yet (cloud sync still downloading): show it straight from the Store cache.
  const earlyCapeItem = !officialMode && !wardrobe?.active?.cape?.storeId && storeEquipped
    ? (catalogItems.find((item) => item.id === storeEquipped && item.kind !== 'cosmetic') || null) : null;
  const wornCapeUrl = showOfficialCards ? (premiumCapeItem?.stillUrl || official.activeCape?.url || null) : (wardrobe?.active?.capeUrl || earlyCapeItem?.stillUrl || null);
  const trySetBundle = trySet ? (catalogBundles.find((bundle) => bundle.id === trySet) || null) : null;
  const trySetPieces = trySetBundle ? trySetBundle.itemIds.map((id) => catalogItems.find((item) => item.id === id)).filter(Boolean) : [];
  const tryCloak = tryOn && tryOn.kind !== 'cosmetic' ? tryOn : (trySetPieces.find((item) => item.kind !== 'cosmetic') || null);
  const previewStoreItem = tryCloak || (showCape ? (premiumCapeItem || earlyCapeItem) : null);
  useEffect(() => {
    if (!previewStoreItem || peekStoreCape(previewStoreItem)) return undefined;
    let live = true;
    loadStoreCape(previewStoreItem).then((hit) => { if (live && hit) setCapeReady((n) => n + 1); });
    return () => { live = false; };
  }, [previewStoreItem?.id, previewStoreItem?.stripUrl, previewStoreItem?.stillUrl]);
  const storePreview = previewStoreItem ? peekStoreCape(previewStoreItem) : null; // data URLs once loaded, so the model never waits on the network
  const previewCapeUrl = tryCloak ? (storePreview?.still || tryCloak.stillUrl || null) : (showCape ? (premiumCapeItem || earlyCapeItem ? (storePreview?.still || wornCapeUrl) : wornCapeUrl) : null);
  // Animated Store capes animate in the preview on premium accounts too (the strip repaints the still).
  const storeAnimOf = (item) => (item?.animated && item.stripUrl ? { stripUrl: storePreview?.strip || item.stripUrl, frames: item.frames, fps: item.fps } : null);
  const premiumCapeAnim = previewCapeUrl ? storeAnimOf(premiumCapeItem) : null;
  const previewCapeAnim = tryCloak
    ? storeAnimOf(tryCloak)
    : previewCapeUrl ? (showOfficialCards ? premiumCapeAnim : (earlyCapeItem ? storeAnimOf(earlyCapeItem) : (wardrobe?.active?.capeAnim || null))) : null;
  const [showCosmetics, setShowCosmetics] = useState(true);
  // Dyeable cosmetics: the colour shown for an item (being picked, saved, or its own) and its dyed texture.
  const catalogById = useMemo(() => new Map(catalogItems.map((item) => [item.id, item])), [catalogItems]);
  const dyeOf = (id) => dyes[id] || null;
  const loadDye = (id, color) => {
    const key = `${id}|${color}`;
    if (dyeRequested.current.has(key)) return;
    dyeRequested.current.add(key);
    window.native?.store?.dyeTexture?.(id, color).then((res) => {
      if (res?.ok) setDyeTex((current) => ({ ...current, [key]: res.texture }));
      else dyeRequested.current.delete(key);
    }).catch(() => { dyeRequested.current.delete(key); });
  };
  const dyedAsset = (id) => {
    const asset = cosAssets[id];
    const item = catalogById.get(id);
    const color = dyeOf(id);
    if (!asset || !color || !item?.dyeable || color === item.dyeDefault) return asset;
    return dyeTex[`${id}|${color}`] ? { ...asset, texture: dyeTex[`${id}|${color}`] } : asset;
  };
  useEffect(() => {
    for (const id of new Set([...Object.values(wearing || {}), ...Object.keys(dyes)])) { const color = dyeOf(id); if (color && catalogById.get(id)?.dyeable && color !== catalogById.get(id)?.dyeDefault) loadDye(id, color); }
  }, [wearing, dyes, catalogById]); // eslint-disable-line react-hooks/exhaustive-deps
  // What the player wears, with the item being tried on swapped into its slot.
  const wornCosmetics = useMemo(() => {
    const slots = showCosmetics ? { ...(wearing || {}) } : {};
    if (tryOn?.kind === 'cosmetic') slots[tryOn.slot] = tryOn.id;
    if (tryOn && tryOn.kind !== 'cosmetic') delete slots.back; // a cloak being tried on must be seen
    if (trySetPieces.length) {
      if (trySetPieces.some((item) => item.kind !== 'cosmetic')) delete slots.back;
      for (const item of trySetPieces) if (item.kind === 'cosmetic') slots[item.slot] = item.id;
    }
    return Object.entries(slots).map(([slot, id]) => (cosAssets[id] ? { ...dyedAsset(id), side: sides[slot] || null } : null)).filter(Boolean);
  }, [wearing, cosAssets, showCosmetics, tryOn, trySet, catalogBundles, sides, dyes, dyeTex, catalogById]); // eslint-disable-line react-hooks/exhaustive-deps
  const viewAngle = section === 'cosmetics' ? (FRONT_TABS.has(cosTab) ? 0.42 : Math.PI * 0.85) : 0;
  const viewerAccount = useMemo(() => ({ ...account, model: currentModel, skinUrl: officialSkin?.url || wardrobe?.active?.skinUrl || null, capeUrl: previewCapeUrl, hasCape: Boolean(previewCapeUrl), capeAnim: previewCapeAnim }), [account, currentModel, officialSkin?.url, wardrobe?.active?.skinUrl, previewCapeUrl, previewCapeAnim]);

  const skinItems = useMemo(() => {
    const byId = new Map();
    [...(wardrobe?.favorites || []), ...(wardrobe?.latest || []), ...(wardrobe?.skins || [])].filter((item) => item.kind === 'skin').forEach((item) => byId.set(item.id, item));
    return [...byId.values()];
  }, [wardrobe]);

  // The active custom cape's name, read from the authoritative wardrobe state.
  // (Previously this looked up a non-existent `active.capeId`, so the picker
  // never highlighted the equipped preset — the Part 1 "no selection" bug.)
  const activeCapeName = wardrobe?.active?.cape?.name || null;

  // Cloaks: Native Store items this account owns. Every Native player sees them in game.
  const wornStoreId = officialMode ? premiumEquipped : (wardrobe?.active?.cape?.storeId || null);
  const cloakCards = useMemo(() => {
    const none = { key: 'cloak:none', kind: 'cloakNone', name: 'No cloak', textureUrl: null, active: !wornStoreId };
    return [none, ...storeCapes.filter(({ item }) => item.kind !== 'cosmetic').map(({ item }) => ({
      key: `store:${item.id}`,
      kind: 'store',
      name: item.name,
      textureUrl: item.stillUrl,
      storeItem: item,
      animated: Boolean(item.animated),
      active: wornStoreId === item.id
    }))];
  }, [storeCapes, wornStoreId]);

  // Capes: real Minecraft capes. Premium accounts list the capes their Microsoft
  // account owns (changed on the Minecraft profile itself, unowned ones locked);
  // Native and offline accounts pick from the bundled Minecraft capes.
  const capeCards = useMemo(() => {
    if (showOfficialCards) {
      const none = { key: 'none', kind: 'none', name: t('locker.noCapeOption'), textureUrl: null, active: !official.activeCapeId };
      const owned = official.capes.map((cape) => ({
        key: `own:${cape.id}`,
        kind: 'official',
        id: cape.id,
        name: cape.alias || cape.name || 'Cape',
        textureUrl: cape.url || null,
        active: cape.state === 'ACTIVE'
      }));
      const ownedTokens = new Set(official.capes.map((cape) => normalizeCapeName(cape.alias || cape.name || cape.id)));
      const locked = CAPE_PRESETS
        .filter((preset) => preset.textureUrl && !ownedTokens.has(normalizeCapeName(preset.name)))
        .map((preset) => ({ key: `lock:${preset.id}`, kind: 'locked', name: preset.name, textureUrl: preset.textureUrl, active: false }));
      return [none, ...owned, ...locked];
    }
    return CAPE_PRESETS.map((cape) => ({
      key: cape.id,
      kind: cape.id === 'none' ? 'none' : 'preset',
      name: cape.name,
      textureUrl: cape.textureUrl,
      preset: cape,
      active: cape.id === 'none' ? !wardrobe?.active?.hasCape : (!wardrobe?.active?.cape?.storeId && activeCapeName === cape.name)
    }));
  }, [showOfficialCards, official.capes, official.activeCapeId, wardrobe?.active?.hasCape, wardrobe?.active?.cape?.storeId, activeCapeName, t]);

  const matches = (name, query) => !query.trim() || String(name || '').toLowerCase().includes(query.trim().toLowerCase());
  const shownCloaks = useMemo(() => cloakCards.filter((card) => matches(card.name, capeQuery)), [cloakCards, capeQuery]);
  const shownCapes = useMemo(() => capeCards.filter((card) => matches(card.name, capeQuery)), [capeCards, capeQuery]);
  const shownSkins = useMemo(() => skinItems.filter((item) => matches(item.name, skinQuery)), [skinItems, skinQuery]);
  const skinPages = Math.max(1, Math.ceil(shownSkins.length / SKINS_PER_PAGE));
  const visibleSkins = shownSkins.slice(skinPage * SKINS_PER_PAGE, (skinPage + 1) * SKINS_PER_PAGE);
  useEffect(() => { setSkinPage(0); }, [skinQuery]);

  useEffect(() => {
    setSkinPage((page) => Math.min(page, skinPages - 1));
  }, [skinPages]);

  // Cosmetics turn the player around to show the cape; Skins turn back. A little hop sells it.
  useEffect(() => {
    const viewer = viewerRef.current;
    const player = viewer?.playerObject;
    if (!player) return undefined;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches || document.documentElement.dataset.motion === 'reduced';
    const from = player.rotation.y;
    const target = viewAngle;
    if (reduce) { player.rotation.y = target; viewer.render?.(); return undefined; }
    const baseY = player.position.y;
    const start = performance.now();
    const duration = 720;
    let frame = 0;
    const backOut = (t) => { const c = 1.6; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      player.rotation.y = from + (target - from) * backOut(t);
      player.position.y = baseY + Math.sin(Math.min(1, t * 1.6) * Math.PI) * 2.2;
      if (viewer.renderPaused) viewer.render?.();
      if (t < 1) frame = requestAnimationFrame(step);
      else player.position.y = baseY;
    };
    frame = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(frame); player.position.y = baseY; };
  }, [viewAngle]);

  const shotKey = section === 'cosmetics' ? ({ cloaks: 'cloak', capes: 'cloak' }[cosTab] || cosTab) : 'all';
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return undefined;
    const cam = createCamera(viewer);
    camRef.current = cam;
    cam.fly(SHOTS[shotKey] || SHOTS.all, { duration: 0 });
    syncZoom();
    return () => { cam.dispose(); if (camRef.current === cam) camRef.current = null; };
  }, [viewerTick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { camRef.current?.fly(SHOTS[shotKey] || SHOTS.all); syncZoom(); }, [shotKey, shotTick]); // eslint-disable-line react-hooks/exhaustive-deps
  // Mouse wheel / trackpad zoom on the stage.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    const onWheel = (event) => {
      if (!camRef.current) return;
      event.preventDefault();
      zoomBy(Math.exp(-event.deltaY * 0.0016), false);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [viewerTick, skeleton]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleResetView = () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    // Orbiting moves the camera, not the model, so restore the camera pose
    // (angle and distance) as well as the model's rotation and joints.
    try {
      viewer.resetCameraPose?.();
      viewer.controls?.update?.();
      viewer.playerObject?.rotation.set(0, viewAngle, 0);
      viewer.playerObject?.resetJoints?.();
      camRef.current?.reset();
      syncZoom();
      viewer.render?.();
    } catch (error) {
      console.warn('Could not reset the skin view:', error);
    }
  };

  const handleExport = async () => {
    const id = wardrobe?.active?.skinId || wardrobe?.activeSkin;
    if (!id || !window.native?.wardrobe?.export) return;
    try { await window.native.wardrobe.export(account, id); }
    catch (error) { onNotify?.(t('locker.title'), error?.message || 'Could not export texture.'); }
  };

  const handleCloudSync = async () => {
    if (!account || localOnly) return;
    setSyncing(true);
    try {
      const res = await window.native?.wardrobe?.sync?.(account);
      if (res?.state) {
        publishState(res.state);
      } else {
        const updated = await window.native?.wardrobe?.get?.(account);
        if (updated) publishState(updated);
      }
      onNotify?.(t('locker.title'), 'All cosmetics synchronized with Native Cloud.');
    } catch (error) {
      onNotify?.(t('locker.title'), error?.message || 'Cloud sync completed locally.');
    } finally { setSyncing(false); }
  };

  const processFile = async (file) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.png') && file.type !== 'image/png') { onNotify?.('Invalid File', t('locker.uploadNotPng')); return; }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const model = await detectSkinModel(dataUrl);
      setImportData({ fileName: file.name, dataUrl, name: file.name.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ') || 'unnamed', model: model || 'classic', detected: model || 'classic' });
      setImportOpen(true);
    } catch (error) { onNotify?.('Upload Error', error?.message || 'Could not read file.'); }
  };

  const saveImport = async () => {
    if (!importData || !account) return;
    setImportSaving(true);
    try {
      const next = await window.native?.wardrobe?.upload?.(account, 'skin', importData.dataUrl, { name: importData.name, model: importData.model });
      if (next) publishState(next);
      window.native?.wardrobe?.sync?.(account).catch(() => {});
      // Premium: a new skin goes straight onto the Minecraft profile.
      if (officialMode && next?.active?.skinId) applyPremiumSkin({ id: next.active.skinId, name: importData.name });
      setImportOpen(false); setImportData(null);
      onNotify?.(t('locker.title'), t('locker.uploadDone', { name: importData.name }));
    } catch (error) { onNotify?.('Error', error?.message || 'Could not upload skin.'); }
    finally { setImportSaving(false); }
  };

  const applySkin = async (skin) => {
    if (!skin?.id || !account) return;
    try {
      const next = await window.native?.wardrobe?.apply?.(account, skin.id);
      if (next) publishState(next);
      window.native?.wardrobe?.sync?.(account).catch(() => {});
    } catch (error) { onNotify?.(t('locker.title'), error?.message || 'Could not equip skin.'); }
  };

  const toggleFavorite = async (item, event) => {
    event?.stopPropagation();
    if (!item?.id || !account) return;
    try { const next = await window.native?.wardrobe?.favorite?.(account, item.id, !item.favorite); if (next) publishState(next); }
    catch (error) { console.warn('Could not update favourite:', error); }
  };

  const removeItem = async (item, event) => {
    event?.stopPropagation();
    if (!item?.id || !account) return;
    try {
      const next = await window.native?.wardrobe?.remove?.(account, item.id);
      if (next) publishState(next);
      window.native?.wardrobe?.sync?.(account).catch(() => {});
    } catch (error) { onNotify?.(t('locker.title'), error?.message || 'Could not remove item.'); }
  };

  const applyCape = async (cape) => {
    if (!account) return;
    try {
      let next;
      if (!cape.textureUrl) {
        next = await window.native?.wardrobe?.clearActive?.(account, 'cape');
      } else {
        const textureDataUrl = await presetTextureDataUrl(cape);
        next = await window.native?.wardrobe?.upload?.(account, 'cape', textureDataUrl, { name: cape.name });
      }
      if (next) publishState(next);
      window.native?.wardrobe?.sync?.(account).catch(() => {});
    } catch (error) { onNotify?.(t('locker.title'), error?.message || 'Could not equip cape.'); }
  };

  const applyWardrobeCape = async (item) => {
    if (!account || !item?.id) return;
    try {
      const next = await window.native?.wardrobe?.apply?.(account, item.id);
      if (next) publishState(next);
      window.native?.wardrobe?.sync?.(account).catch(() => {});
    } catch (error) { onNotify?.(t('locker.title'), error?.message || 'Could not equip cape.'); }
  };

  // Premium (Microsoft) account: wear a Native Store cloak in game.
  const wearPremiumCape = async (item) => {
    if (!account || storeBusy) return;
    setStoreBusy(item?.id || 'off');
    try {
      const res = await window.native?.store?.equip?.(account, item?.id || null, { target: 'premium' });
      if (!res?.ok) throw new Error(res?.error || 'Could not wear that cloak.');
      setPremiumEquipped(res.premiumEquipped || null);
      if (item) onNotify?.(t('locker.title'), `${item.name} is now your cloak in game.`);
    } catch (error) { onNotify?.(t('locker.title'), error?.message || 'Could not wear that cloak.'); }
    finally { setStoreBusy(null); }
  };

  const wearStoreCape = async (item) => {
    if (!account || storeBusy) return;
    setStoreBusy(item?.id || 'off');
    try {
      const res = await window.native?.store?.equip?.(account, item?.id || null);
      if (!res?.ok) throw new Error(res?.error || 'Could not wear that cloak.');
      if (res.state) publishState(res.state);
    } catch (error) { onNotify?.(t('locker.title'), error?.message || 'Could not wear that cloak.'); }
    finally { setStoreBusy(null); }
  };

  // Hats, glasses, back items and shoes: one per slot. Clicking the worn one takes it off.
  const toggleCosmetic = async (item) => {
    if (!account || storeBusy || localOnly) return;
    const off = wearing?.[item.slot] === item.id;
    setStoreBusy(item.id);
    try {
      const res = await window.native?.store?.wear?.(account, off ? null : item.id, item.slot);
      if (!res?.ok) throw new Error(res?.error || 'Could not do that.');
      setWearing(res.wearing || {});
      if (res.sides) setSides(res.sides);
      window.dispatchEvent(new Event('native:cosmetics-changed'));
    } catch (error) { onNotify?.(t('locker.title'), error?.message || 'Could not do that.'); }
    finally { setStoreBusy(null); }
  };
  // The side a hand item uses until the player picks one: the first sided part of its model.
  const defaultSide = (slot) => {
    try {
      const model = cosAssets[wearing?.[slot]]?.model;
      const json = typeof model === 'string' ? JSON.parse(model) : model;
      return (json?.parts || []).find((part) => part.side)?.side || 'right';
    } catch { return 'right'; }
  };
  // Hand items: pick the hand (and side) they sit on.
  const pickSide = async (slot, side) => {
    if (!account || storeBusy || localOnly) return;
    setSides((prev) => ({ ...prev, [slot]: side }));
    try {
      const res = await window.native?.store?.wear?.(account, null, slot, side);
      if (!res?.ok) throw new Error(res?.error || 'Could not do that.');
      if (res.sides) setSides(res.sides);
      window.dispatchEvent(new Event('native:cosmetics-changed'));
    } catch (error) { onNotify?.(t('locker.title'), error?.message || 'Could not do that.'); }
  };
  // Dye a worn cosmetic: the preview changes at once, the colour is saved for the launcher, the website and in game.
  const saveDye = async (item, color) => {
    if (!account || localOnly) return;
    const before = dyes;
    const next = { ...dyes };
    if (!color || color === item.dyeDefault) delete next[item.id]; else next[item.id] = color;
    setDyes(next);
    try {
      const res = await window.native?.store?.dye?.(account, item.id, color);
      if (!res?.ok) throw new Error(res?.error || 'Could not dye that.');
      setDyes(res.dyes || {});
      window.dispatchEvent(new Event('native:cosmetics-changed'));
    } catch (error) { setDyes(before); onNotify?.(t('locker.title'), error?.message || 'Could not dye that.'); }
  };

  // Take off whatever is in a slot.
  const clearSlot = async (slot) => {
    if (!account || storeBusy || localOnly || !wearing?.[slot]) return;
    setStoreBusy(`off:${slot}`);
    try {
      const res = await window.native?.store?.wear?.(account, null, slot);
      if (!res?.ok) throw new Error(res?.error || 'Could not do that.');
      setWearing(res.wearing || {});
      if (res.sides) setSides(res.sides);
      window.dispatchEvent(new Event('native:cosmetics-changed'));
    } catch (error) { onNotify?.(t('locker.title'), error?.message || 'Could not do that.'); }
    finally { setStoreBusy(null); }
  };
  // The item being tried on: add it to the locker and put it on, straight from here.
  const addTryOn = async () => {
    const item = tryOn;
    if (!item || !account || storeBusy || item.paid || item.exclusive) return;
    setStoreBusy(`add:${item.id}`);
    try {
      const res = await window.native?.store?.claim?.(account, item.id);
      if (!res?.ok) throw new Error(res?.error || 'Could not add that.');
      if (item.kind === 'cosmetic') {
        const worn = await window.native?.store?.wear?.(account, item.id, item.slot);
        if (!worn?.ok) throw new Error(worn?.error || 'Added, but could not put it on.');
        setWearing(worn.wearing || {});
        window.dispatchEvent(new Event('native:cosmetics-changed'));
      } else {
        const worn = await window.native?.store?.equip?.(account, item.id, officialMode ? { target: 'premium' } : undefined);
        if (!worn?.ok) throw new Error(worn?.error || 'Added, but could not put it on.');
        if (officialMode) setPremiumEquipped(worn.premiumEquipped || item.id);
        else if (worn.state) publishState(worn.state);
      }
      setTryOn(null);
      onNotify?.(t('locker.title'), `${item.name} is in your locker and you’re wearing it — in the launcher and in game.`);
      window.dispatchEvent(new Event('native:store-changed'));
    } catch (error) { onNotify?.(t('locker.title'), error?.message || 'Could not add that.'); }
    finally { setStoreBusy(null); }
  };
  // Sets: put on every piece of a bundle you own (one per slot, plus its cloak).
  const wearSet = async (bundle) => {
    if (!account || storeBusy || localOnly) return;
    const pieces = (bundle.itemIds || []).map((id) => catalogById.get(id)).filter((item) => item && ownedIds.has(item.id));
    if (!pieces.length) return;
    setStoreBusy(`set:${bundle.id}`);
    try {
      let worn = wearing || {};
      for (const item of pieces.filter((piece) => piece.kind === 'cosmetic')) {
        const res = await window.native?.store?.wear?.(account, item.id, item.slot);
        if (!res?.ok) throw new Error(res?.error || `Could not put on ${item.name}.`);
        worn = res.wearing || worn;
        if (res.sides) setSides(res.sides);
      }
      setWearing(worn);
      const cloak = pieces.find((piece) => piece.kind !== 'cosmetic');
      if (cloak) {
        const res = await window.native?.store?.equip?.(account, cloak.id, officialMode ? { target: 'premium' } : undefined);
        if (!res?.ok) throw new Error(res?.error || `Could not wear ${cloak.name}.`);
        if (officialMode) setPremiumEquipped(res.premiumEquipped || cloak.id);
        else if (res.state) publishState(res.state);
      }
      setTrySet(null);
      window.dispatchEvent(new Event('native:cosmetics-changed'));
      const all = pieces.length === (bundle.itemIds || []).length;
      onNotify?.(t('locker.title'), all ? `You’re wearing the ${bundle.name} set — in the launcher and in game.` : `You’re wearing your ${pieces.length} ${bundle.name} pieces.`);
    } catch (error) { onNotify?.(t('locker.title'), error?.message || 'Could not wear that set.'); }
    finally { setStoreBusy(null); }
  };
  // "Get the rest": open the Store on that bundle.
  const openStoreBundle = (bundle) => {
    try { localStorage.setItem('native.store.openBundle', bundle.id); } catch {}
    window.dispatchEvent(new Event('native:store-open-bundle'));
    onOpenStore?.();
  };
  const ownedCosmetics = storeCapes.filter(({ item }) => item.kind === 'cosmetic').map(({ item }) => item);
  const ownedIds = useMemo(() => new Set(storeCapes.map(({ item }) => item.id)), [storeCapes]);
  const canShop = !localOnly && catalogItems.length > 0;
  const storeItemsFor = (tab) => catalogItems.filter((item) => (tab.slot ? item.kind === 'cosmetic' && item.slot === tab.slot : item.kind !== 'cosmetic') && !ownedIds.has(item.id));
  const cosTabCount = (tab) => (tab.id === 'bundles' ? catalogBundles.filter((bundle) => (bundle.itemIds || []).some((id) => ownedIds.has(id))).length : tab.id === 'cloaks' ? storeCapes.length - ownedCosmetics.length : tab.slot ? ownedCosmetics.filter((item) => item.slot === tab.slot).length : null);
  const nothingCard = (slot) => {
    const active = !wearing?.[slot];
    return <button key={`none:${slot}`} type="button" style={{ '--i': 0 }} className={`locker-cape-card locker-cosmetic-card locker-pop ${active ? 'active' : ''}`.trim()} onClick={() => clearSlot(slot)} title="Wear nothing here">
      <span className="locker-no-cape"><X size={20}/></span>
      <span>Nothing</span>
      {storeBusy === `off:${slot}` && <RefreshCw size={12} className="locker-cape-check is-spinning"/>}
      {active && storeBusy !== `off:${slot}` && <Check size={13} className="locker-cape-check"/>}
    </button>;
  };
  // Card art for a cosmetic: the piece worn on this player's skin (drawn once and cached), the flat thumbnail until then.
  const shotSkin = skinTextureUrl({ ...account, skinUrl: officialSkin?.url || wardrobe?.active?.skinUrl || account?.skinUrl || null });
  const shotModel = currentModel === 'slim' ? 'slim' : currentModel === 'classic' ? 'default' : 'auto-detect';
  const cosmeticShot = (item) => (cosAssets[item.id]
    ? <WornShot item={item} asset={dyedAsset(item.id)} skinUrl={shotSkin} model={shotModel} prepare={prepareSkinSource} fallback={cosAssets[item.id].thumb} className="locker-cosmetic-thumb" />
    : <span className="locker-cosmetic-thumb is-loading"/>);
  // A Store item you don't own: click to try it on the model.
  const storeCard = (item, index) => {
    const trying = tryOn?.id === item.id;
    return <button key={`shop:${item.id}`} type="button" style={{ '--i': index }} className={`locker-cape-card locker-shop-card locker-pop ${item.kind === 'cosmetic' ? 'locker-cosmetic-card' : ''} ${trying ? 'is-trying' : ''}`.replace(/\s+/g, ' ').trim()} onClick={() => setTryOn(trying ? null : item)} title={trying ? 'Stop trying on' : `Try on ${item.name}`} aria-pressed={trying}>
      {item.kind === 'cosmetic'
        ? cosmeticShot(item)
        : item.animated ? <AnimatedCapeThumb item={item} fallback={item.stillUrl}/> : <span className="locker-cape-texture" style={{ backgroundImage: `url(${item.stillUrl})` }}/>}
      <span>{item.name}</span>
      <em className={`locker-price ${item.exclusive ? 'is-event' : item.paid ? 'is-paid' : 'is-free'}`}>{priceLabel(item)}</em>
      {trying && <span className="locker-trying-tag" title="Trying on" aria-label="Trying on"><Check size={11} strokeWidth={3}/></span>}
    </button>;
  };
  const renderShop = (tab) => {
    if (!canShop || tab.id === 'capes' || tab.id === 'bundles') return null;
    const more = storeItemsFor(tab).filter((item) => matches(item.name, capeQuery));
    if (!more.length) {
      if (capeQuery.trim()) return null;
      return <p className="locker-cape-hint locker-pop" style={{ '--i': 2 }}>You have every {tab.noun.replace(/s$/, '')} in the Native Store. New ones land there first.</p>;
    }
    return <section className="locker-row locker-shop-row">
      <div className="locker-row-header"><div><span className="locker-kicker">More in the Native Store</span><h2>Try one on</h2></div><button type="button" className="locker-store-btn" onClick={() => onOpenStore?.()} title="Open the Native Store"><Store size={13}/>Native Store</button></div>
      <div className="locker-cape-grid">{more.map((item, index) => storeCard(item, index + 2))}</div>
    </section>;
  };

  const cosmeticCard = (item, index) => {
    const active = wearing?.[item.slot] === item.id;
    return <button key={`cos:${item.id}`} type="button" style={{ '--i': index }} className={`locker-cape-card locker-cosmetic-card locker-pop ${active ? 'active' : ''}`.trim()} onClick={() => toggleCosmetic(item)} title={active ? `Take off ${item.name}` : `Wear ${item.name}`}>
      {cosmeticShot(item)}
      <span>{item.name}</span>
      {storeBusy === item.id && <RefreshCw size={12} className="locker-cape-check is-spinning"/>}
      {active && storeBusy !== item.id && <Check size={13} className="locker-cape-check"/>}
    </button>;
  };

  // Cloak cards go to the Native Store; owned Minecraft capes go through the
  // official profile API; locked capes are inert; presets use the local wardrobe.
  const handleCapeCardClick = (card) => {
    if (card.kind === 'locked') return;
    if (card.kind === 'cloakNone' || card.kind === 'store') {
      if (card.active || localOnly) return;
      const item = card.kind === 'store' ? card.storeItem : null;
      if (officialMode) wearPremiumCape(item); else wearStoreCape(item);
      return;
    }
    if (showOfficialCards) {
      if (official.busy) return;
      official.equip(card.kind === 'official' ? card.id : null);
      return;
    }
    if (card.kind === 'wardrobe') { applyWardrobeCape(card.item); return; }
    applyCape(card.preset);
  };

  // Premium skins live on the Minecraft profile: picking one changes it for real.
  const [skinBusy, setSkinBusy] = useState(null);
  const applyPremiumSkin = async (skin) => {
    if (!skin?.id || !account || skinBusy) return;
    setSkinBusy(skin.id);
    try {
      const res = await window.native?.wardrobe?.applyOfficialSkin?.(account, skin.id);
      if (res && res.ok === false) throw new Error(res.error || 'Minecraft didn’t accept that skin.');
      const next = await window.native?.wardrobe?.apply?.(account, skin.id);
      if (next) publishState(next);
      official.reload?.();
      onNotify?.(t('locker.title'), `${skin.name} is now your Minecraft skin everywhere.`);
    } catch (error) { onNotify?.(t('locker.title'), error?.message || 'Could not change your Minecraft skin.'); }
    finally { setSkinBusy(null); }
  };
  const pickSkin = (skin) => (officialMode ? applyPremiumSkin(skin) : applySkin(skin));

  const capeCard = (card, index) => {
    const locked = card.kind === 'locked';
    const isCloak = card.kind === 'store' || card.kind === 'cloakNone';
    return <button key={card.key} type="button" style={{ '--i': index }} className={`locker-cape-card locker-pop ${card.active ? 'active' : ''} ${locked ? 'locked' : ''}`.trim()} onClick={() => handleCapeCardClick(card)} disabled={locked || (!isCloak && showOfficialCards && official.busy)} title={locked ? t('locker.officialHint') : card.name}>
      {card.animated && card.storeItem ? <AnimatedCapeThumb item={card.storeItem} fallback={card.textureUrl}/> : card.textureUrl ? <span className="locker-cape-texture" style={{ backgroundImage: `url(${card.textureUrl})` }}/> : <span className="locker-no-cape"><X size={20}/></span>}
      <span>{card.name}</span>
      {storeBusy && ((card.storeItem?.id || 'off') === storeBusy) && <RefreshCw size={12} className="locker-cape-check is-spinning"/>}
      {card.active && <Check size={13} className="locker-cape-check"/>}
      {locked && <Lock size={11} className="locker-cape-lock"/>}
    </button>;
  };

  const renderSkins = () => <section className="locker-row locker-skins-row">
    <div className="locker-row-header">
      <div><span className="locker-kicker">{t('locker.favorites')}</span><h2>{t('locker.latest')}</h2></div>
      <div className="locker-cape-actions"><LockerSearch value={skinQuery} onChange={setSkinQuery} label="Search skins"/>{skinPages > 1 && <CarouselControls page={skinPage} pages={skinPages} setPage={setSkinPage}/>}</div>
    </div>
    <div className="locker-skin-grid">
      <button type="button" className="locker-upload-card locker-pop" style={{ '--i': 0 }} onClick={() => fileInputRef.current?.click()}><span className="locker-upload-plus"><Plus size={18}/></span><strong>{t('locker.uploadSkin')}</strong><small>{t('locker.dragDrop')}</small></button>
      {skeleton && [0, 1, 2, 3].map((n) => <div key={`skel-${n}`} className="locker-skel locker-skel-card" style={{ animationDelay: `${n * 120}ms` }}/>)}
      {!skeleton && visibleSkins.map((skin, index) => <article key={skin.id} style={{ '--i': index + 1 }} className={`locker-skin-card locker-pop ${skin.active ? 'active' : ''} ${skinBusy === skin.id ? 'is-busy' : ''}`} onClick={() => pickSkin(skin)}>
        <button type="button" className="locker-favourite" onClick={(event) => toggleFavorite(skin, event)} title={skin.favorite ? t('locker.unfavorite') : t('locker.favorite')}><Star size={13} fill={skin.favorite ? 'currentColor' : 'none'}/></button>
        <div className="locker-skin-preview"><SkinViewer3D account={{ ...account, skinUrl: skin.url, model: skin.model }} width={116} height={156} paused/></div>
        <div className="locker-card-meta"><strong>{skin.name}</strong><small>{skin.ageDays ? `${skin.ageDays}d` : 'new'}</small></div>
        <button type="button" className="locker-remove" onClick={(event) => removeItem(skin, event)}><Trash2 size={13}/></button>
        {skinBusy === skin.id && <RefreshCw size={13} className="locker-skin-busy is-spinning"/>}
      </article>)}
      {!skeleton && !visibleSkins.length && <div className="locker-empty-skins locker-pop" style={{ '--i': 1 }}><Star size={18}/><span>{skinQuery.trim() ? `Nothing matches “${skinQuery.trim()}”.` : t('locker.emptyFavorites')}</span></div>}
    </div>
  </section>;

  const renderCosmetics = () => {
    const tab = COS_TABS.find((entry) => entry.id === cosTab) || COS_TABS[0];
    const header = <div className="locker-row-header">
      <div><span className="locker-kicker">{tab.id === 'capes' && showOfficialCards ? 'Official Minecraft' : tab.kicker}</span><h2>{tab.title}</h2></div>
      <div className="locker-cape-actions">
        {tab.slot === 'hand' && wearing?.[tab.slot] && !localOnly && <div className="locker-side-pick" role="group" aria-label="Which side">
          {['left', 'right'].map((side) => <button key={side} type="button" className={(sides[tab.slot] || defaultSide(tab.slot)) === side ? 'on' : ''} onClick={() => pickSide(tab.slot, side)}>{side === 'left' ? 'Left' : 'Right'}</button>)}
        </div>}
        <LockerSearch value={capeQuery} onChange={setCapeQuery} label={`Search ${tab.noun}`}/>
      </div>
    </div>;
    const dyeItem = tab.slot && !localOnly && wearing?.[tab.slot] ? catalogById.get(wearing[tab.slot]) : null;
    const dyePanel = dyeItem?.dyeable ? (() => {
      const current = dyeOf(dyeItem.id) || dyeItem.dyeDefault || '#ffffff';
      const own = dyeItem.dyeDefault || null;
      const picks = [...(own ? [own] : []), ...(dyeItem.dyeColors || []).filter((hex) => hex !== own)];
      if (picks.length < 2) return null;
      return <div className="locker-dye locker-pop" role="group" aria-label={`Dye ${dyeItem.name}`}>
        <span className="locker-dye-label"><Palette size={14}/>Dye <b>{dyeItem.name}</b></span>
        <div className="locker-dye-swatches">
          {picks.map((hex) => <button key={hex} type="button" className={`locker-dye-swatch${current === hex ? ' is-on' : ''}${hex === own ? ' is-own' : ''}`} style={{ '--dye': hex }} title={hex === own ? `Original (${hex})` : hex} aria-label={hex === own ? 'Original colour' : `Colour ${hex}`} aria-pressed={current === hex} onClick={() => saveDye(dyeItem, hex)}/>)}
        </div>
        <span className="locker-dye-hex">{current}</span>
        {dyes[dyeItem.id] && <button type="button" className="locker-dye-reset" onClick={() => saveDye(dyeItem, null)} title="Back to its own colour"><RotateCcw size={12}/>Reset</button>}
      </div>;
    })() : null;
    let body;
    if (tab.id === 'cloaks') {
      body = <section className="locker-row locker-capes-row">
        {header}
        {localOnly ? <p className="locker-cape-hint">Cloaks come from the Native Store. Sign in with Microsoft or a Native account to get them.</p> : <>
          <div className="locker-cape-grid">{shownCloaks.map(capeCard)}</div>
          {capeQuery.trim() && !shownCloaks.length && <p className="locker-cape-hint">No cloak matches “{capeQuery.trim()}”.</p>}
          {officialMode && wornStoreId && <p className="locker-cape-hint">Native players see your cloak instead of your Minecraft cape.</p>}
          {wearing?.back && <p className="locker-cape-hint">Your {ownedCosmetics.find((item) => item.id === wearing.back)?.name || 'back item'} takes the cloak’s place on your back. <button type="button" className="locker-inline-link" onClick={() => clearSlot('back')}>Take it off</button> to show your cloak.</p>}
        </>}
      </section>;
    } else if (tab.id === 'bundles') {
      const sets = catalogBundles
        .map((bundle) => ({ bundle, pieces: (bundle.itemIds || []).map((id) => catalogById.get(id)).filter(Boolean) }))
        .filter(({ bundle, pieces }) => pieces.length && matches(bundle.name, capeQuery))
        .map((entry) => ({ ...entry, have: entry.pieces.filter((item) => ownedIds.has(item.id)).length }))
        .filter(({ bundle, have }) => have > 0 || bundle.phase !== 'ended')
        .sort((a, b) => Number(b.have === b.pieces.length) - Number(a.have === a.pieces.length) || b.have / b.pieces.length - a.have / a.pieces.length);
      const setCard = ({ bundle, pieces, have }, index) => {
        const color = bundleColor(bundle);
        const complete = have === pieces.length;
        const previewing = trySet === bundle.id;
        const wornAll = pieces.every((item) => (item.kind === 'cosmetic' ? wearing?.[item.slot] === item.id : (officialMode ? premiumEquipped : (wardrobe?.active?.cape?.storeId || storeEquipped)) === item.id));
        const busy = storeBusy === `set:${bundle.id}`;
        const cloak = pieces.find((item) => item.kind !== 'cosmetic');
        const look = pieces.filter((item) => item.kind === 'cosmetic' && cosAssets[item.id]).map((item) => (ownedIds.has(item.id) ? dyedAsset(item.id) : cosAssets[item.id]));
        const act = () => (have > 0 ? (!wornAll && !storeBusy && wearSet(bundle)) : openStoreBundle(bundle));
        const tip = have > 0 ? (wornAll ? 'Wearing this set' : complete ? 'Put on every piece' : 'Put on the pieces you own') : 'Open this bundle in the Native Store';
        return <article key={`set:${bundle.id}`} style={{ '--i': index, '--bc': color }} title={`${bundle.name} · ${RARITY[bundle.rarity]?.label || 'Epic'} · ${tip}`} className={`locker-skin-card locker-set-card locker-pop${wornAll ? ' active' : ''}${previewing ? ' is-trying' : ''}${busy ? ' is-busy' : ''}${have === 0 ? ' is-unowned' : ''}`} onClick={act} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') act(); }}>
          <span className="locker-set-mark" aria-hidden="true">{bundle.name}</span>
          <button type="button" className="locker-favourite locker-set-eye" onClick={(event) => { event.stopPropagation(); setTryOn(null); setTrySet(previewing ? null : bundle.id); }} title={previewing ? 'Stop previewing' : 'Preview the whole set on you'}>{previewing ? <EyeOff size={13}/> : <Eye size={13}/>}</button>
          <div className="locker-skin-preview"><SkinViewer3D key={`set:${bundle.id}:${look.length}`} account={{ ...account, skinUrl: shotSkin, model: shotModel, capeUrl: cloak?.stillUrl || null, capeAnim: null }} cosmetics={look.length ? look : null} zoom={0.55} width={116} height={156} paused/></div>
          <div className="locker-card-meta"><strong>{bundle.name}</strong><small>{complete ? <Check size={11} strokeWidth={3}/> : `${have}/${pieces.length}`}</small></div>
          {busy && <RefreshCw size={13} className="locker-skin-busy is-spinning"/>}
        </article>;
      };
      body = <section className="locker-row locker-capes-row">
        {header}
        {localOnly ? <p className="locker-cape-hint">Sets come from the Native Store. Sign in with Microsoft or a Native account to get them.</p> : <>
          {sets.length > 0 && <div className="locker-skin-grid locker-set-grid">{sets.map(setCard)}</div>}
          {!sets.length && <p className="locker-cape-hint">{capeQuery.trim() ? `No set matches “${capeQuery.trim()}”.` : <>No sets yet. <button type="button" className="locker-inline-link" onClick={() => onOpenStore?.()}>See the bundles in the Native Store</button> — full looks for less.</>}</p>}
          {sets.length > 0 && <p className="locker-cape-hint">Click a set to wear it. The eye previews it on you first.</p>}
        </>}
      </section>;
    } else if (tab.slot) {
      const owned = ownedCosmetics.filter((item) => item.slot === tab.slot && matches(item.name, capeQuery));
      body = <section className="locker-row locker-capes-row">
        {header}
        {dyePanel}
        {localOnly ? <p className="locker-cape-hint">Hats, glasses, wings and shoes come from the Native Store. Sign in with Microsoft or a Native account to wear them.</p> : <>
          <div className="locker-cape-grid">{nothingCard(tab.slot)}{owned.map((item, index) => cosmeticCard(item, index + 1))}</div>
          {!owned.length && !capeQuery.trim() && <p className="locker-cape-hint">No {tab.noun} yet. {canShop ? 'Pick one below to try it on, then add it.' : <><button type="button" className="locker-inline-link" onClick={() => onOpenStore?.()}>Find some in the Native Store</button> — they show in game on every version from 1.16 up.</>}</p>}
        </>}
      </section>;
    } else {
      body = <section className="locker-row locker-capes-row">
        {header}
        {capesSkeleton && <div className="locker-cape-grid" aria-label={t('locker.officialLoading')}>{[0, 1, 2, 3, 4].map((n) => <div key={`cskel-${n}`} className="locker-skel locker-skel-cape" style={{ animationDelay: `${n * 100}ms` }}/>)}</div>}
        {officialMode && !official.loading && official.error && <OfficialCapeError error={official.error} onRetry={official.reload} onReauth={official.reauth} busy={official.loading} t={t}/>}
        {!capesSkeleton && <>
          <div className="locker-cape-grid">{shownCapes.map(capeCard)}</div>
          {capeQuery.trim() && !shownCapes.length && <p className="locker-cape-hint">No cape matches “{capeQuery.trim()}”.</p>}
          {showOfficialCards && official.profile?.partial && (
            <p className="locker-cape-hint is-warn">
              Only the cape you’re wearing could be loaded (your Microsoft sign-in needs a refresh).{' '}
              <button type="button" className="locker-cape-hint-link" onClick={official.reauth} disabled={official.loading}>Sign in again</button> to see every cape you own.
            </p>
          )}
          {showOfficialCards && <p className="locker-cape-hint">These are your real Minecraft capes. Changing one changes it on your Minecraft profile, on every server.</p>}
        </>}
      </section>;
    }
    return <div className="locker-cosmetics">
      <div className="locker-cos-tabs">
        <PixelTabs
          size="sm"
          fill
          label="Cosmetic types"
          value={tab.id}
          onChange={switchCosTab}
          items={COS_TABS.map((entry) => { const count = localOnly ? null : cosTabCount(entry); return { id: entry.id, label: entry.label, title: entry.title, count: count || null }; })}
        />
      </div>
      <div key={`cos:${tab.id}`} className={`locker-subpanel${cosDir ? ` from-${cosDir}` : ''}`}>
        {body}
        {renderShop(tab)}
      </div>
    </div>;
  };

  return <div className="locker-view" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); switchSection('skins'); processFile(event.dataTransfer?.files?.[0]); }}>
    <header className="locker-header">
      <div>
        <h1 className="locker-title page-title">{t('locker.title') || 'LOCKER'}</h1>
        <p className="locker-subtitle">{t('locker.subtitle')}</p>
      </div>
      {localOnly ? (
        <div className="locker-local-note" role="note">
          <HardDrive size={14} aria-hidden="true" />
          <div>
            <strong>Saved on this PC only</strong>
            <span>You see your skin in game with the Native mod, but other players can't. Sign in with Microsoft or a Native account to share it.</span>
          </div>
        </div>
      ) : (
      <div className="locker-header-actions">
      {cloudAccount && (cloud === 'offline' || !online) && <span className="locker-sync-pill is-offline" role="status"><i/>Offline · showing your saved locker</span>}
      <button
        type="button"
        className="locker-sync-btn"
        onClick={handleCloudSync}
        disabled={syncing}
        title={t('locker.cloudNote')}
        aria-label={syncing ? t('locker.syncing') : t('locker.syncButton')}
      >
        <RefreshCw size={13} className={syncing ? 'is-spinning' : ''}/>
        <span>{syncing ? t('locker.syncing') : t('locker.syncButton')}</span>
      </button>
      </div>
      )}
    </header>
    <div className="locker-workspace">
      <section className="locker-stage" aria-label={t('locker.currentSkin')}>
        <div className="locker-stage-heading"><h2>{t('locker.currentSkin')}</h2><div className="locker-stage-toggles"><button type="button" className={showCape ? 'active' : ''} onClick={() => setShowCape((value) => !value)} title={showCape ? 'Hide cape' : 'Show cape'}>{showCape ? <Eye size={15}/> : <EyeOff size={15}/>}</button><button type="button" className={showLayers ? 'active' : ''} onClick={() => setShowLayers((value) => !value)} title={showLayers ? 'Hide outer layer' : 'Show outer layer'}><Layers size={15}/></button>{Object.keys(wearing || {}).length > 0 && <button type="button" className={showCosmetics ? 'active' : ''} onClick={() => setShowCosmetics((value) => !value)} title={showCosmetics ? 'Hide hats, glasses, wings and shoes' : 'Show hats, glasses, wings and shoes'}><Sparkles size={15}/></button>}</div></div>
        <div className="locker-stage-model" ref={stageRef}>{skeleton ? <span className="locker-skel locker-skel-model" aria-label="Loading skin"/> : <SkinViewer3D account={viewerAccount} cosmetics={wornCosmetics} width={330} height={430} animation={paused ? null : 'idle'} paused={paused} onViewer={(viewer) => { viewerRef.current = viewer; setViewerTick((n) => n + 1); }}/>}</div>
        {trySetBundle && !tryOn && section === 'cosmetics' && <div key={`tryset:${trySetBundle.id}`} className="locker-tryon is-set" role="status" style={{ '--bc': bundleColor(trySetBundle) }}>
          <div className="locker-tryon-text"><span>Previewing set</span><strong>{trySetBundle.name}</strong></div>
          <div className="locker-tryon-actions">
            <PixelIconButton size="sm" icon={<X size={14} strokeWidth={3}/>} label="Stop previewing" onClick={() => setTrySet(null)}/>
          </div>
        </div>}
        {tryOn && section === 'cosmetics' && <div key={`try:${tryOn.id}`} className="locker-tryon" role="status">
          <div className="locker-tryon-text"><span>Trying on</span><strong>{tryOn.name}</strong></div>
          <div className="locker-tryon-actions">
            {tryOn.exclusive
              ? <PixelButton size="sm" variant="exclusive" label="Event only" title="Not sold. You get it at Native events or with a code."/>
              : tryOn.paid
                ? <PixelButton size="sm" icon={<Store size={14}/>} label={`Get · ${priceLabel(tryOn)}`} title="Buy it in the Native Store" onClick={() => onOpenStore?.()}/>
                : <PixelButton size="sm" poof disabled={Boolean(storeBusy)} busy={storeBusy === `add:${tryOn.id}`} busyIcon={<RefreshCw size={14} className="is-spinning"/>} icon={<Plus size={14} strokeWidth={3}/>} label="Add & wear" title="Add it to your locker and put it on" onClick={addTryOn}/>}
            <PixelIconButton size="sm" icon={<X size={14} strokeWidth={3}/>} label="Stop trying on" onClick={() => setTryOn(null)}/>
          </div>
        </div>}
        <div className="locker-stage-actions"><div><button type="button" onClick={handleResetView} title="Reset view"><RotateCcw size={16}/></button><button type="button" onClick={() => zoomBy(1 / 1.25)} disabled={!zoomState.out} title="Zoom out"><ZoomOut size={16}/></button><button type="button" onClick={() => zoomBy(1.25)} disabled={!zoomState.in} title="Zoom in"><ZoomIn size={16}/></button></div><div><button type="button" onClick={handleExport} disabled={!(wardrobe?.active?.skinId || wardrobe?.activeSkin)} title="Download active texture"><Download size={16}/></button><button type="button" onClick={() => setPaused((value) => !value)} title={paused ? 'Play preview' : 'Pause preview'}>{paused ? <Play size={16}/> : <Pause size={16}/>}</button></div></div>
      </section>
      <main className="locker-library">
        <LockerSwitch value={section} onChange={switchSection} skinUrl={officialSkin?.url || wardrobe?.active?.skinUrl || null} capeUrl={wornCapeUrl} counts={{ skins: skinItems.length, cosmetics: storeCapes.length }}/>
        <div className="locker-panels">
          {leaving && leaving !== section && <div key={`out-${leaving}`} className={`locker-panel is-leaving to-${section === 'cosmetics' ? 'left' : 'right'}`} aria-hidden="true" onAnimationEnd={(event) => { if (event.target === event.currentTarget) setLeaving(null); }}>{leaving === 'skins' ? renderSkins() : renderCosmetics()}</div>}
          <div key={`in-${section}`} className={`locker-panel ${leaving ? `is-entering from-${section === 'cosmetics' ? 'right' : 'left'}` : ''}`} role="tabpanel">{section === 'skins' ? renderSkins() : renderCosmetics()}</div>
        </div>
      </main>
    </div>
    <input ref={fileInputRef} type="file" accept="image/png,.png" hidden onChange={(event) => { processFile(event.target.files?.[0]); event.target.value=''; }}/>
    {importOpen && importData && <div className="locker-modal-overlay" onClick={() => setImportOpen(false)}><div className="locker-import-modal" onClick={(event) => event.stopPropagation()}><button type="button" className="import-modal-close" onClick={() => setImportOpen(false)}><X size={16}/></button><div className="import-modal-preview"><SkinViewer3D account={{...account,skinUrl:importData.dataUrl,model:importData.model}} width={170} height={230} animation="idle" autoRotate/></div><div className="import-modal-form"><div className="import-modal-head"><h3>{t('locker.importTitle')}</h3><p>{t('locker.importSubtitle')}</p></div><label className="import-form-field"><span>{t('locker.fieldName')}</span><input value={importData.name} onChange={(event) => setImportData({...importData,name:event.target.value})}/></label><div className="import-form-field"><span>{t('locker.fieldFile')}</span><button type="button" className="import-file-display" onClick={() => fileInputRef.current?.click()}><span>{importData.fileName}</span><Folder size={14}/></button></div><div className="import-form-field"><span>{t('locker.model')}</span><div className="import-model-grid">{['classic','slim'].map((model) => <button key={model} type="button" className={`import-model-card${importData.model===model?' active':''}`} onClick={() => setImportData({...importData,model})}><ModelArmGlyph model={model}/><strong>{model==='classic'?t('locker.modelClassic'):t('locker.modelSlim')}</strong><small>{model==='classic'?t('locker.modelClassicDesc'):t('locker.modelSlimDesc')}</small>{importData.detected===model && <em className="import-model-detected">{t('locker.modelDetected')}</em>}{importData.model===model && <span className="import-model-check"><Check size={12}/></span>}</button>)}</div></div><button type="button" className="import-save-btn" onClick={saveImport} disabled={importSaving}><Check size={15}/>{importSaving?t('common.loading'):t('common.save')}</button></div></div></div>}
  </div>;
}

function LockerSearch({ value, onChange, label }) {
  return <label className={`locker-search ${value ? 'has-value' : ''}`}><Search size={13}/><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={label} aria-label={label}/>{value && <button type="button" onClick={() => onChange('')} aria-label="Clear search"><X size={12}/></button>}</label>;
}

function CarouselControls({ page, pages, setPage }) {
  return <div className="locker-carousel-controls"><button type="button" disabled={page<=0} onClick={() => setPage((value)=>Math.max(0,value-1))}><ChevronLeft size={16}/></button><span>{page+1} / {pages}</span><button type="button" disabled={page>=pages-1} onClick={() => setPage((value)=>Math.min(pages-1,value+1))}><ChevronRight size={16}/></button></div>;
}

/**
 * Explains why the official Minecraft cape list could not be loaded, choosing
 * the message by error code: 402 (no game licence), 401/403 (expired Microsoft
 * session — offer re-auth), or a generic fallback. The preset cape strip renders
 * below this so the account still has capes to use.
 */
function OfficialCapeError({ error, onRetry, onReauth, busy, t }) {
  const is402 = error?.code === 'NO_ENTITLEMENT' || error?.status === 402;
  const is401 = error?.code === 'AUTH_EXPIRED' || error?.status === 401 || error?.status === 403;
  const title = is402 ? t('locker.error402Title') : is401 ? t('locker.error401Title') : t('locker.errorGenericTitle');
  const body = is402 ? t('locker.error402Body') : is401 ? t('locker.error401Body') : (error?.message || '');
  return (
    <div className="locker-cape-error" role="alert">
      <strong>{title}</strong>
      {body && <p>{body}</p>}
      <div className="locker-cape-error-actions">
        <button type="button" onClick={onRetry} disabled={busy}>{t('locker.retry')}</button>
        {is401 && <button type="button" onClick={onReauth} disabled={busy}>{t('locker.reauth')}</button>}
      </div>
    </div>
  );
}

/**
 * A tiny pixel-art figure whose arm width tracks the model: Classic wears the
 * standard 4px arms, Slim the narrower 3px arms. It makes the otherwise abstract
 * "Classic vs Slim" choice legible at a glance in the import picker.
 */
function ModelArmGlyph({ model }) {
  const slim = model === 'slim';
  const armW = slim ? 3 : 4;
  const leftX = slim ? 5 : 4;
  return (
    <svg className="import-model-glyph" viewBox="0 0 24 24" width="34" height="34" aria-hidden="true" shapeRendering="crispEdges">
      <rect className="glyph-body" x="9" y="2" width="6" height="6" />
      <rect className="glyph-body" x="9" y="9" width="6" height="9" />
      <rect className="glyph-arm" x={leftX} y="9" width={armW} height="9" />
      <rect className="glyph-arm" x="16" y="9" width={armW} height="9" />
    </svg>
  );
}

/** Animated store cape front for a locker card: plays the strip, shows the still until it loads. */
function AnimatedCapeThumb({ item, fallback }) {
  const ref = useRef(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    let timer = null;
    (async () => {
      try {
        const res = await window.native?.store?.strip?.(item.id);
        if (!alive || !res?.ok) return;
        const image = await loadStripImage(res.url);
        if (!alive || !ref.current) return;
        const frames = Math.max(1, item.frames || 1);
        const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
        let index = 0;
        const paint = () => {
          if (!alive || !ref.current) return;
          try { drawCapeFront(ref.current, image, frames, index); } catch {}
          setReady(true);
          index = (index + 1) % frames;
          if (frames > 1 && !reduce) timer = setTimeout(paint, 1000 / Math.max(1, item.fps || 12));
        };
        paint();
      } catch { /* keep the still */ }
    })();
    return () => { alive = false; clearTimeout(timer); };
  }, [item.id, item.frames, item.fps]);
  return <span className="locker-cape-anim">
    {!ready && fallback && <span className="locker-cape-texture" style={{ backgroundImage: `url(${fallback})` }}/>}
    <canvas ref={ref} width={40} height={64} className="locker-cape-canvas" style={ready ? undefined : { display: 'none' }} aria-hidden="true"/>
  </span>;
}
