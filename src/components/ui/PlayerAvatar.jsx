import React, { useEffect, useMemo, useState } from 'react';
import { didAvatarFail, fallbackSkinFor, isAvatarReady, isLocalIdentity, preloadAvatar, skinIdentifier, skinRenderUrl } from '../../lib/skins.js';

/**
 * Cache of wardrobe-resolved skin data URLs, keyed by account. Local
 * (Native/offline) accounts have no premium texture on mc-heads, so their real
 * skin has to be pulled from the wardrobe. Successful lookups are cached module-
 * wide so reopening the account switcher shows the skin instantly, no flash.
 */
const wardrobeSkinCache = new Map(); // key -> { skinUrl }
const wardrobeSkinPending = new Map(); // key -> Promise<{ skinUrl } | null>

function wardrobeCacheKey(account) {
  return account?.id || account?.uuid || account?.name || null;
}

function resolveWardrobeSkin(account) {
  const key = wardrobeCacheKey(account);
  if (!key || !window.native?.wardrobe?.avatar) return Promise.resolve(null);
  if (wardrobeSkinCache.has(key)) return Promise.resolve(wardrobeSkinCache.get(key));
  if (wardrobeSkinPending.has(key)) return wardrobeSkinPending.get(key);

  const task = window.native.wardrobe.avatar(account)
    .then((res) => {
      const skinUrl = res?.skinUrl || null;
      if (!skinUrl) return null; // a miss isn't cached — the warm cache may fill in shortly
      const value = { skinUrl };
      wardrobeSkinCache.set(key, value);
      return value;
    })
    .catch(() => null)
    .finally(() => wardrobeSkinPending.delete(key));

  wardrobeSkinPending.set(key, task);
  return task;
}

/**
 * Official Mojang skins of Microsoft accounts, keyed by UUID. mc-heads caches
 * UUID lookups and can keep serving Steve after a skin change, so the real
 * texture is fetched from the session server in main and cropped locally.
 */
const officialSkinCache = new Map(); // uuid -> skinUrl | null
const officialSkinPending = new Map();

function officialKey(account) {
  if (!account || !(account.type === 'microsoft' || account.isMicrosoft === true)) return null;
  const uuid = String(account.uuid || '').replace(/-/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(uuid) ? uuid : null;
}

function resolveOfficialSkin(account) {
  const key = officialKey(account);
  if (!key || !window.native?.wardrobe?.officialSkin) return Promise.resolve(null);
  if (officialSkinCache.has(key)) return Promise.resolve(officialSkinCache.get(key));
  if (officialSkinPending.has(key)) return officialSkinPending.get(key);
  const task = window.native.wardrobe.officialSkin(account)
    .then((res) => { const url = res?.skinUrl || null; if (res) officialSkinCache.set(key, url); return url; })
    .catch(() => null)
    .finally(() => officialSkinPending.delete(key));
  officialSkinPending.set(key, task);
  return task;
}

/**
 * Renders a player avatar. Uploaded wardrobe textures are cropped locally from
 * the canonical 64×64 skin atlas; otherwise mc-heads resolves the official skin.
 */
export default function PlayerAvatar({ account, uuid, name, kind = 'avatar', size = 32, radius, className = '', title, alt }) {
  const pixels = Math.max(16, Math.round(size));
  const renderSize = Math.min(256, pixels * 2);

  // A skin passed in directly (active account, locker previews) is authoritative.
  const providedSkinUrl = account?.skinUrl || null;
  // Otherwise, local accounts self-heal their wardrobe skin (the switcher list
  // hands us raw account records with no skinUrl, which would render as Steve).
  const shouldResolveWardrobe = !providedSkinUrl && isLocalIdentity(account);
  const cacheKey = wardrobeCacheKey(account);
  const [wardrobeSkinUrl, setWardrobeSkinUrl] = useState(() =>
    (shouldResolveWardrobe && cacheKey ? wardrobeSkinCache.get(cacheKey)?.skinUrl || null : null));

  // Microsoft accounts without a provided skin: crop the official Mojang texture.
  const officialSkinKey = !providedSkinUrl ? officialKey(account) : null;
  const canResolveOfficial = Boolean(officialSkinKey && typeof window !== 'undefined' && window.native?.wardrobe?.officialSkin);
  const [officialSkin, setOfficialSkin] = useState(() => (officialSkinKey && officialSkinCache.has(officialSkinKey)
    ? { key: officialSkinKey, url: officialSkinCache.get(officialSkinKey), done: true }
    : { key: officialSkinKey, url: null, done: !canResolveOfficial }));
  useEffect(() => {
    if (!canResolveOfficial) { setOfficialSkin({ key: officialSkinKey, url: null, done: true }); return undefined; }
    let cancelled = false;
    if (officialSkinCache.has(officialSkinKey)) { setOfficialSkin({ key: officialSkinKey, url: officialSkinCache.get(officialSkinKey), done: true }); return undefined; }
    setOfficialSkin({ key: officialSkinKey, url: null, done: false });
    resolveOfficialSkin(account).then((url) => { if (!cancelled) setOfficialSkin({ key: officialSkinKey, url, done: true }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [officialSkinKey, canResolveOfficial]);
  const officialSkinUrl = officialSkin.key === officialSkinKey ? officialSkin.url : null;
  const officialPending = canResolveOfficial && !(officialSkin.key === officialSkinKey && officialSkin.done);

  const directSkinUrl = providedSkinUrl || wardrobeSkinUrl || officialSkinUrl;
  const [directFailed, setDirectFailed] = useState(false);

  const identifier = useMemo(() => skinIdentifier(account, uuid, name), [account, uuid, name]);
  const url = useMemo(() => skinRenderUrl(kind, identifier, renderSize), [kind, identifier, renderSize]);
  const [resolved, setResolved] = useState(() => (isAvatarReady(url) ? url : null));

  useEffect(() => setDirectFailed(false), [directSkinUrl]);

  // Resolve the wardrobe skin for local accounts that arrived without one. A
  // miss can just be warm-cache latency (the texture is still being fetched
  // server-side), so retry once shortly after before giving up on Steve.
  useEffect(() => {
    if (!shouldResolveWardrobe || !cacheKey) { setWardrobeSkinUrl(null); return undefined; }
    let cancelled = false;
    let retry = null;
    const attempt = (allowRetry) => {
      resolveWardrobeSkin(account).then((res) => {
        if (cancelled) return;
        if (res?.skinUrl) { setWardrobeSkinUrl(res.skinUrl); return; }
        if (allowRetry) retry = setTimeout(() => attempt(false), 1500);
      });
    };
    attempt(true);
    return () => { cancelled = true; if (retry) clearTimeout(retry); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, shouldResolveWardrobe]);

  useEffect(() => {
    let cancelled = false;
    if (isAvatarReady(url)) { setResolved(url); return undefined; }
    setResolved(null);
    preloadAvatar(url).then((ok) => {
      if (cancelled) return;
      if (ok) { setResolved(url); return; }
      const fallback = fallbackSkinFor(kind, renderSize);
      if (fallback === url || didAvatarFail(fallback)) return;
      preloadAvatar(fallback).then((fallbackOk) => { if (!cancelled && fallbackOk) setResolved(fallback); });
    });
    return () => { cancelled = true; };
  }, [url, kind, renderSize]);

  const label = account?.name || name || 'Player';
  const initial = label.slice(0, 1).toUpperCase();
  const cornerRadius = radius === undefined ? Math.round(pixels * 0.28) : radius;
  const boxStyle = {
    position: 'relative', width: pixels, height: pixels, flex: 'none', borderRadius: cornerRadius,
    overflow: 'hidden', background: 'var(--page-sunken, #12161d)', display: 'grid', placeItems: 'center'
  };

  const showDirect = Boolean(directSkinUrl && !directFailed);
  // Don't flash mc-heads' (possibly stale) render while the official skin loads.
  const showRendered = Boolean(resolved && !officialPending);

  return (
    <span className={`player-avatar ${className}`.trim()} style={boxStyle} title={title || label}>
      {!showDirect && !showRendered && <span aria-hidden="true" style={{ fontFamily: 'var(--font-sans)', fontSize: Math.max(10, Math.round(pixels * 0.42)), fontWeight: 700, color: 'var(--fg-muted, #5c6273)', userSelect: 'none' }}>{initial}</span>}

      {showDirect && (
        <span aria-label={alt || label} role="img" style={{ position: 'absolute', inset: 0, overflow: 'hidden', imageRendering: 'pixelated' }}>
          <SkinFaceLayer src={directSkinUrl} pixels={pixels} offset={1} onError={() => setDirectFailed(true)} />
          <SkinFaceLayer src={directSkinUrl} pixels={pixels} offset={5} />
        </span>
      )}

      {!showDirect && showRendered && <img src={resolved} alt={alt || label} draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', imageRendering: 'pixelated', animation: 'fadeIn 0.18s ease both' }} />}
    </span>
  );
}

function SkinFaceLayer({ src, pixels, offset, onError }) {
  return <img src={src} alt="" aria-hidden="true" draggable={false} onError={onError} style={{ position: 'absolute', width: pixels * 8, height: pixels * 8, maxWidth: 'none', left: -pixels * offset, top: -pixels, imageRendering: 'pixelated', pointerEvents: 'none' }} />;
}
