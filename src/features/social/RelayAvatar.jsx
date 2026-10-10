import React, { useEffect, useState } from 'react';
import './RelayAvatar.css';
import fallbackSkin from '../../assets/steve.png';

// Relay avatars resolve through the Native API (Native skin, else the linked Microsoft
// account's skin texture) and never contact head-rendering proxy services.
const nativeSkinCache = new Map();
const inFlightRequests = new Map();
const NEGATIVE_CACHE_TTL = 30_000;

function cachedSkin(key) {
  const cached = nativeSkinCache.get(key);
  if (!cached) return undefined;
  if (cached.url || Date.now() - cached.checkedAt < NEGATIVE_CACHE_TTL) return cached.url;
  nativeSkinCache.delete(key);
  return undefined;
}

export function resolveNativeSkin(name) {
  const key = String(name || '').toLowerCase().trim();
  if (!key || key === 'guest') return Promise.resolve(null);

  const cached = cachedSkin(key);
  if (cached !== undefined) return Promise.resolve(cached);
  if (inFlightRequests.has(key)) return inFlightRequests.get(key);

  const task = (async () => {
    const root = String(window.native?.wardrobeApi || 'https://api.playnative.fun').replace(/\/+$/, '');
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 3500);

    try {
      // Native skin, else the linked Microsoft account's skin (resolved by the Native API).
      const res = await fetch(`${root}/v1/social/face/${encodeURIComponent(key)}`, {
        signal: ctrl.signal,
        cache: 'no-cache'
      });
      if (!res.ok) throw new Error(`Custom skin lookup failed (${res.status})`);

      const data = await res.json();
      const skin = data.skin || null;
      nativeSkinCache.set(key, { url: skin, checkedAt: Date.now() });
      return skin;
    } catch {
      // Cache misses briefly so transient startup/network failures can self-heal.
      nativeSkinCache.set(key, { url: null, checkedAt: Date.now() });
      return null;
    } finally {
      window.clearTimeout(timer);
    }
  })().finally(() => inFlightRequests.delete(key));

  inFlightRequests.set(key, task);
  return task;
}

// Skin images already decoded once: the face can be drawn at once, without a flash.
const decodedSkins = new Set();
function preloadSkin(url) {
  if (!url || decodedSkins.has(url)) return Promise.resolve();
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = image.onerror = () => { decodedSkins.add(url); resolve(); };
    image.src = url;
  });
}

/**
 * True once every face in `faces` ([{ name, skinUrl }]) is looked up and its skin image is loaded (or after
 * `limitMs`, so a slow lookup never keeps a page on skeletons). `scope` restarts the wait (e.g. another chat).
 */
export function useAvatarsReady(faces, scope = '', limitMs = 2500) {
  const key = faces.map((face) => `${String(face?.name || '').toLowerCase()}|${face?.skinUrl || ''}`).join(',');
  const [readyScope, setReadyScope] = useState(null);
  // already known and decoded (e.g. a chat opened before): no wait at all
  const instant = faces.every((face) => {
    if (!face?.name && !face?.skinUrl) return true;
    const url = face.skinUrl || cachedSkin(String(face.name || '').toLowerCase().trim());
    return url === null || (url !== undefined && decodedSkins.has(url));
  });
  useEffect(() => {
    // once a chat is shown, new messages never bring the skeletons back
    if (readyScope === scope) return undefined;
    let alive = true;
    const finish = () => { if (alive) setReadyScope(scope); };
    const timer = window.setTimeout(finish, limitMs);
    Promise.all(faces.map(async (face) => {
      const url = face?.skinUrl || await resolveNativeSkin(face?.name);
      await preloadSkin(url);
    })).then(finish, finish);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [key, scope, readyScope]); // eslint-disable-line react-hooks/exhaustive-deps
  return readyScope === scope || instant;
}

export function SkinFaceLayer({ src, pixels, offset, onError, onLoad }) {
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
      onError={onError}
      onLoad={onLoad}
      style={{
        position: 'absolute',
        width: pixels * 8,
        height: pixels * 8,
        maxWidth: 'none',
        left: -pixels * offset,
        top: -pixels,
        imageRendering: 'pixelated',
        pointerEvents: 'none'
      }}
    />
  );
}

export default function RelayAvatar({
  name,
  skinUrl: initialSkinUrl,
  size = 38,
  className = '',
  status = null,
  showStatus = false
}) {
  const pixels = Math.max(16, Math.round(size));
  const key = String(name || '').toLowerCase().trim();
  const [skinUrl, setSkinUrl] = useState(() => initialSkinUrl || cachedSkin(key) || null);
  const [hasError, setHasError] = useState(false);
  // still looking this player up: a soft placeholder, not Steve
  const [pending, setPending] = useState(() => !initialSkinUrl && Boolean(key) && cachedSkin(key) === undefined);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    setHasError(false);

    if (initialSkinUrl) {
      setSkinUrl(initialSkinUrl);
      if (key) nativeSkinCache.set(key, { url: initialSkinUrl, checkedAt: Date.now() });
      return () => { active = false; };
    }

    const cached = cachedSkin(key);
    setSkinUrl(cached || null);
    setPending(Boolean(key) && cached === undefined);
    if (key && cached === undefined) {
      resolveNativeSkin(key).then((url) => {
        if (active) { setSkinUrl(url); setPending(false); }
      });
    }

    return () => { active = false; };
  }, [initialSkinUrl, key]);

  const resolvedSkin = skinUrl && !hasError ? skinUrl : fallbackSkin;
  const shown = !pending && (loaded || decodedSkins.has(resolvedSkin));
  useEffect(() => { setLoaded(decodedSkins.has(resolvedSkin)); }, [resolvedSkin]);
  const statusColor = (status === 'in-game' || status === 'in-menus')
    ? '#d9a6da'
    : (status === 'in-launcher' || status === 'online')
      ? '#23a55a'
      : '#80848e';

  return (
    <div
      className={`relay-avatar-container ${className}`}
      style={{
        position: 'relative',
        width: pixels,
        height: pixels,
        flex: 'none',
        borderRadius: 'var(--radius-sm, 6px)',
        background: 'var(--component-bg, #19171e)',
        display: 'grid',
        placeItems: 'center'
      }}
    >
      <span
        role="img"
        aria-label={name || 'Avatar'}
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 'inherit',
          overflow: 'hidden',
          imageRendering: 'pixelated',
          opacity: shown ? 1 : 0,
          transition: 'opacity 0.16s ease'
        }}
      >
        {!pending && <>
          <SkinFaceLayer
            src={resolvedSkin}
            pixels={pixels}
            offset={1}
            onLoad={() => { decodedSkins.add(resolvedSkin); setLoaded(true); }}
            onError={() => {
              if (resolvedSkin !== fallbackSkin) setHasError(true);
            }}
          />
          <SkinFaceLayer src={resolvedSkin} pixels={pixels} offset={5} />
        </>}
      </span>
      {!shown && <span className="relay-avatar-skel" aria-hidden="true" style={{ position: 'absolute', inset: 0, borderRadius: 'inherit', background: 'rgba(255, 255, 255, 0.06)', animation: 'relay-avatar-pulse 1.2s ease-in-out infinite' }} />}

      {showStatus && status && (
        <span
          className={`relay-presence-badge ${status}`}
          style={{
            position: 'absolute',
            right: pixels >= 48 ? -3 : -2,
            bottom: pixels >= 48 ? -3 : -2,
            width: Math.max(9, Math.round(pixels * 0.26)),
            height: Math.max(9, Math.round(pixels * 0.26)),
            borderRadius: '50%',
            backgroundColor: statusColor,
            border: `${pixels >= 48 ? 3 : 2}px solid var(--page-elevated, #111013)`,
            boxShadow: status === 'in-game' ? '0 0 6px rgba(242, 63, 67, 0.7)' : (status === 'in-launcher' || status === 'online' ? '0 0 6px rgba(35, 165, 90, 0.5)' : 'none'),
            zIndex: 2
          }}
        />
      )}
    </div>
  );
}
