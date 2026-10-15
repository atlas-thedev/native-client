import React, { useEffect, useMemo, useRef, useState } from 'react';
import SkinViewer3D from '../../components/ui/SkinViewer3D.jsx';
import { dyeTextures, cosmeticAssets } from '../../lib/dyeCache.js';
import './HomeMascot.css';

// Last known look per account, so Home still shows the full outfit offline.
const cacheKey = (account) => `native.home.look.${account?.id || account?.name || 'guest'}`;
const readCache = (account) => { try { return JSON.parse(localStorage.getItem(cacheKey(account)) || 'null'); } catch { return null; } };
const writeCache = (account, look) => { try { localStorage.setItem(cacheKey(account), JSON.stringify(look)); } catch { /* full storage */ } };

/**
 * The player's own character on Home, wearing their full Native look
 * (cape, every equipped 3D cosmetic, and the colours they dyed them).
 */
export default function HomeMascot({ account }) {
  const [look, setLook] = useState(() => readCache(account));
  const [assets, setAssets] = useState(() => Object.fromEntries(cosmeticAssets));
  const [dyed, setDyed] = useState(() => Object.fromEntries(dyeTextures));
  const [dyeFailed, setDyeFailed] = useState({});

  // Home remounts every time it is opened, so a dye or swap in the locker shows up straight away.
  useEffect(() => {
    if (!account) return undefined;
    const cached = readCache(account);
    setLook(cached);
    let alive = true;
    (async () => {
      const profileName = account.type === 'microsoft' ? (account.nativeLink?.name || account.name) : account.name;
      const [me, prof, ward] = await Promise.all([
        Promise.resolve(window.native?.store?.me?.(account)).catch(() => null),
        profileName ? Promise.resolve(window.native?.profiles?.get?.(profileName)).catch(() => null) : null,
        Promise.resolve(window.native?.wardrobe?.get?.(account)).catch(() => null)
      ]);
      if (!alive) return;
      const p = prof?.ok ? (prof.profile?.look || {}) : null;
      const m = me?.ok ? me : null;
      // The Native skin: what is active in the Locker, else the one on the Native profile.
      const current = prof?.ok ? prof.profile?.current : null;
      const skinUrl = ward?.active?.skinUrl || current?.url || null;
      const skinModel = ward?.active?.skinUrl ? ward.active.model : (current?.model || null);
      if (!m && !p && !skinUrl) return; // offline: keep the cached look
      const next = {
        skinUrl: skinUrl || cached?.skinUrl || null,
        skinModel: (skinUrl ? skinModel : cached?.skinModel) || null,
        wearing: (m ? m.wearing : p?.wearing) || cached?.wearing || {},
        sides: (m ? m.sides : p?.sides) || cached?.sides || {},
        dyes: (m ? m.dyes : p?.dyes) || cached?.dyes || {},
        capeUrl: p ? (p.capeUrl || null) : (cached?.capeUrl || null),
        capeAnimation: p ? (p.capeAnimation || null) : (cached?.capeAnimation || null)
      };
      setLook(next);
      writeCache(account, next);
    })();
    return () => { alive = false; };
  }, [account?.id, account?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const wornIds = useMemo(() => [...new Set(Object.values(look?.wearing || {}).filter(Boolean))].sort(), [look]);
  const wornKey = wornIds.join(',');
  useEffect(() => {
    let alive = true;
    for (const id of wornIds) {
      if (assets[id]) continue;
      Promise.resolve(window.native?.store?.cosmetic?.(id)).then((res) => {
        if (!res?.ok) return;
        cosmeticAssets.set(id, res);
        if (alive) setAssets((current) => (current[id] ? current : { ...current, [id]: res }));
      }).catch(() => {});
    }
    return () => { alive = false; };
  }, [wornKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const dyeKey = wornIds.map((id) => `${id}:${look?.dyes?.[id] || ''}`).join(',');
  useEffect(() => {
    let alive = true;
    for (const id of wornIds) {
      const color = look?.dyes?.[id];
      const key = `${id}|${color}`;
      if (!color || dyed[key]) continue;
      Promise.resolve(window.native?.store?.dyeTexture?.(id, color)).then((res) => {
        if (res?.ok && res.texture) {
          dyeTextures.set(key, res.texture);
          if (alive) setDyed((current) => ({ ...current, [key]: res.texture }));
        } else if (alive) setDyeFailed((current) => ({ ...current, [key]: true }));
      }).catch(() => { if (alive) setDyeFailed((current) => ({ ...current, [key]: true })); });
    }
    return () => { alive = false; };
  }, [dyeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const cosmetics = useMemo(() => {
    if (!look?.wearing) return null;
    const list = Object.entries(look.wearing).map(([slot, id]) => {
      const asset = assets[id];
      if (!asset) return null;
      const color = look.dyes?.[id];
      const texture = color && dyed[`${id}|${color}`];
      if (color && !texture && !dyeFailed[`${id}|${color}`]) return null;
      return { ...asset, ...(texture ? { texture } : {}), side: look.sides?.[slot] || null };
    }).filter(Boolean);
    return list.length ? list : null;
  }, [look, assets, dyed, dyeFailed]);

  const viewerAccount = useMemo(() => {
    if (!account) return null;
    const lookCape = look?.capeUrl || null;
    const capeUrl = lookCape || account.capeUrl || null;
    const capeAnim = lookCape && look?.capeAnimation?.url
      ? { stripUrl: look.capeAnimation.url, frames: look.capeAnimation.frames, fps: look.capeAnimation.fps }
      : null;
    const skin = look?.skinUrl ? { skinUrl: look.skinUrl, model: look.skinModel === 'slim' ? 'slim' : 'classic' } : {};
    return { ...account, ...skin, capeUrl, hasCape: Boolean(capeUrl), capeAnim };
  }, [account, look]);

  // The skin is sized from the hero area, so it grows and shrinks with the window (hidden when there is no room).
  const probeRef = useRef(null);
  const [size, setSize] = useState(null);
  useEffect(() => {
    const host = probeRef.current?.parentElement;
    if (!host || typeof ResizeObserver === 'undefined') { setSize({ w: 560, h: 520 }); return undefined; }
    const fit = () => {
      const { width, height } = host.getBoundingClientRect();
      if (width < 720 || height < 340) { setSize(null); return; }
      const h = Math.round(Math.max(300, Math.min(height * 0.86, width * 0.62, 680)));
      setSize((cur) => (cur && Math.abs(cur.h - h) < 4 ? cur : { w: Math.round(h * 0.85), h }));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    return () => ro.disconnect();
  }, [Boolean(viewerAccount)]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!viewerAccount || !size) return <div ref={probeRef} className="home-mascot-probe" aria-hidden="true" />;

  return (
    <div ref={probeRef} className="home-mascot-probe" aria-hidden="true">
    <div className="home-mascot" aria-hidden="true">
      <SkinViewer3D account={viewerAccount} cosmetics={cosmetics} width={size.w} height={size.h} animation="pose" zoom={0.68} />
      <div className="home-mascot-shadow" />
    </div>
    </div>
  );
}
