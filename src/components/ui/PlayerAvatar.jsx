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

  const directSkinUrl = providedSkinUrl || wardrobeSkinUrl;
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

  return (
    <span className={`player-avatar ${className}`.trim()} style={boxStyle} title={title || label}>
      {!showDirect && !resolved && <span aria-hidden="true" style={{ fontFamily: 'var(--font-sans)', fontSize: Math.max(10, Math.round(pixels * 0.42)), fontWeight: 700, color: 'var(--fg-muted, #5c6273)', userSelect: 'none' }}>{initial}</span>}

      {showDirect && (
        <span aria-label={alt || label} role="img" style={{ position: 'absolute', inset: 0, overflow: 'hidden', imageRendering: 'pixelated' }}>
          <SkinFaceLayer src={directSkinUrl} pixels={pixels} offset={1} onError={() => setDirectFailed(true)} />
          <SkinFaceLayer src={directSkinUrl} pixels={pixels} offset={5} />
        </span>
      )}

      {!showDirect && resolved && <img src={resolved} alt={alt || label} draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', imageRendering: 'pixelated', animation: 'fadeIn 0.18s ease both' }} />}
    </span>
  );
}

function SkinFaceLayer({ src, pixels, offset, onError }) {
  return <img src={src} alt="" aria-hidden="true" draggable={false} onError={onError} style={{ position: 'absolute', width: pixels * 8, height: pixels * 8, maxWidth: 'none', left: -pixels * offset, top: -pixels, imageRendering: 'pixelated', pointerEvents: 'none' }} />;
}
