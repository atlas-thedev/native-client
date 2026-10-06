import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Download, Eye, EyeOff, Folder, HardDrive, Layers, Lock, Pause, Play, Plus, RefreshCw, RotateCcw, Search, Star, Store, Trash2, X } from 'lucide-react';
import SkinViewer3D from '../../components/ui/SkinViewer3D.jsx';
import LockerSwitch from './LockerSwitch.jsx';
import { CAPE_PRESETS, presetTextureDataUrl } from './capePresets.js';
import { drawCapeFront, loadStripImage } from '../../lib/animatedCape.js';
import useOfficialCapes from './useOfficialCapes.js';
import { detectSkinModel, readFileAsDataUrl } from '../../lib/skins.js';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import './LockerView.css';
import './LockerLocal.css';

const SKINS_PER_PAGE = 9;
const SECTION_KEY = 'native.locker.section';

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
  // The two big tabs: 'skins' or 'cosmetics' (cloaks + capes). `leaving` is the
  // section animating out while the new one bounces in.
  const [section, setSection] = useState(() => {
    try { return localStorage.getItem(SECTION_KEY) === 'cosmetics' ? 'cosmetics' : 'skins'; } catch { return 'skins'; }
  });
  const [leaving, setLeaving] = useState(null);
  const switchSection = (next) => {
    if (next === section) return;
    setLeaving(section);
    setSection(next);
    try { localStorage.setItem(SECTION_KEY, next); } catch {}
  };
  const viewerRef = useRef(null);
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
      const [catalog, mine] = await Promise.all([
        window.native?.store?.catalog?.({}),
        window.native?.store?.me?.(account)
      ]);
      if (run !== storeSeq.current || !catalog?.ok || !mine?.ok) return;
      const byId = new Map((catalog.items || []).map((item) => [item.id, item]));
      setStoreCapes((mine.owned || []).filter((entry) => byId.has(entry.id)).map((entry) => ({ item: byId.get(entry.id), acquiredAt: entry.acquiredAt })));
      setPremiumEquipped(premiumLinked ? (mine.equipped || null) : null);
    } catch {}
  };
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
  const previewCapeUrl = showCape
    ? (showOfficialCards ? (premiumCapeItem?.stillUrl || official.activeCape?.url || null) : (wardrobe?.active?.capeUrl || null))
    : null;
  // Animated Store capes animate in the preview on premium accounts too (the strip repaints the still).
  const premiumCapeAnim = premiumCapeItem?.animated && premiumCapeItem.stripUrl && previewCapeUrl === premiumCapeItem.stillUrl
    ? { stripUrl: premiumCapeItem.stripUrl, frames: premiumCapeItem.frames, fps: premiumCapeItem.fps }
    : null;
  const previewCapeAnim = previewCapeUrl ? (showOfficialCards ? premiumCapeAnim : (wardrobe?.active?.capeAnim || null)) : null;
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
    return [none, ...storeCapes.map(({ item }) => ({
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
    const target = section === 'cosmetics' ? Math.PI * 0.85 : 0;
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
  }, [section]);

  const handleResetView = () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    // Orbiting moves the camera, not the model, so restore the camera pose
    // (angle and distance) as well as the model's rotation and joints.
    try {
      viewer.resetCameraPose?.();
      viewer.controls?.update?.();
      viewer.playerObject?.rotation.set(0, section === 'cosmetics' ? Math.PI * 0.85 : 0, 0);
      viewer.playerObject?.resetJoints?.();
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

  const renderCosmetics = () => <div className="locker-cosmetics">
    <div className="locker-cosmetics-bar">
      <LockerSearch value={capeQuery} onChange={setCapeQuery} label="Search cloaks and capes"/>
      {!localOnly && <button type="button" className="locker-store-btn" onClick={() => onOpenStore?.()} title="Get cloaks in the Native Store"><Store size={13}/>Native Store</button>}
    </div>
    <section className="locker-row locker-capes-row">
      <div className="locker-row-header"><div><span className="locker-kicker">Native Store</span><h2>Cloaks</h2></div></div>
      {localOnly ? <p className="locker-cape-hint">Cloaks come from the Native Store. Sign in with Microsoft or a Native account to get them.</p> : <>
        <div className="locker-cape-grid">{shownCloaks.map(capeCard)}</div>
        {capeQuery.trim() && !shownCloaks.length && <p className="locker-cape-hint">No cloak matches “{capeQuery.trim()}”.</p>}
        {!storeCapes.length && !capeQuery.trim() && <p className="locker-cape-hint">No cloaks yet. Get one in the Native Store; everyone playing with Native sees it in game.</p>}
        {officialMode && wornStoreId && <p className="locker-cape-hint">Native players see your cloak instead of your Minecraft cape.</p>}
      </>}
    </section>
    <section className="locker-row locker-capes-row">
      <div className="locker-row-header"><div><span className="locker-kicker">{showOfficialCards ? 'Official Minecraft' : 'Minecraft'}</span><h2>{t('locker.capes') || 'Capes'}</h2></div></div>
      {capesSkeleton && <div className="locker-cape-grid" aria-label={t('locker.officialLoading')}>{[0, 1, 2, 3, 4].map((n) => <div key={`cskel-${n}`} className="locker-skel locker-skel-cape" style={{ animationDelay: `${n * 100}ms` }}/>)}</div>}
      {officialMode && !official.loading && official.error && <OfficialCapeError error={official.error} onRetry={official.reload} onReauth={official.reauth} busy={official.loading} t={t}/>}
      {!capesSkeleton && <>
        <div className="locker-cape-grid">{shownCapes.map(capeCard)}</div>
        {capeQuery.trim() && !shownCapes.length && <p className="locker-cape-hint">No cape matches “{capeQuery.trim()}”.</p>}
        {showOfficialCards && <p className="locker-cape-hint">These are your real Minecraft capes. Changing one changes it on your Minecraft profile, on every server.</p>}
      </>}
    </section>
  </div>;

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
        <div className="locker-stage-heading"><h2>{t('locker.currentSkin')}</h2><div className="locker-stage-toggles"><button type="button" className={showCape ? 'active' : ''} onClick={() => setShowCape((value) => !value)} title={showCape ? 'Hide cape' : 'Show cape'}>{showCape ? <Eye size={15}/> : <EyeOff size={15}/>}</button><button type="button" className={showLayers ? 'active' : ''} onClick={() => setShowLayers((value) => !value)} title={showLayers ? 'Hide outer layer' : 'Show outer layer'}><Layers size={15}/></button></div></div>
        <div className="locker-stage-model">{skeleton ? <span className="locker-skel locker-skel-model" aria-label="Loading skin"/> : <SkinViewer3D account={viewerAccount} width={330} height={430} animation={paused ? null : 'idle'} paused={paused} onViewer={(viewer) => { viewerRef.current = viewer; }}/>}</div>
        <div className="locker-stage-actions"><button type="button" onClick={handleResetView} title="Reset view"><RotateCcw size={16}/></button><div><button type="button" onClick={handleExport} disabled={!(wardrobe?.active?.skinId || wardrobe?.activeSkin)} title="Download active texture"><Download size={16}/></button><button type="button" onClick={() => setPaused((value) => !value)} title={paused ? 'Play preview' : 'Pause preview'}>{paused ? <Play size={16}/> : <Pause size={16}/>}</button></div></div>
      </section>
      <main className="locker-library">
        <LockerSwitch value={section} onChange={switchSection} skinUrl={officialSkin?.url || wardrobe?.active?.skinUrl || null} counts={{ skins: skinItems.length, cosmetics: storeCapes.length }}/>
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
