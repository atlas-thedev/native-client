import React, { useEffect, useMemo, useState } from 'react';
import SkinViewer3D from '../../components/ui/SkinViewer3D.jsx';
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
  const [assets, setAssets] = useState({});
  const [dyed, setDyed] = useState({});

  // Home remounts every time it is opened, so a dye or swap in the locker shows up straight away.
  useEffect(() => {
    if (!account) return undefined;
    const cached = readCache(account);
    setLook(cached);
    let alive = true;
    (async () => {
      const [me, prof] = await Promise.all([
        Promise.resolve(window.native?.store?.me?.(account)).catch(() => null),
        account.name ? Promise.resolve(window.native?.profiles?.get?.(account.name)).catch(() => null) : null
      ]);
      if (!alive) return;
      const p = prof?.ok ? (prof.profile?.look || {}) : null;
      const m = me?.ok ? me : null;
      if (!m && !p) return; // offline: keep the cached look
      const next = {
        wearing: (m ? m.wearing : p.wearing) || {},
        sides: (m ? m.sides : p.sides) || {},
        dyes: (m ? m.dyes : p.dyes) || {},
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
        if (alive && res?.ok) setAssets((current) => (current[id] ? current : { ...current, [id]: res }));
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
        if (alive && res?.ok && res.texture) setDyed((current) => ({ ...current, [key]: res.texture }));
      }).catch(() => {});
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
      return { ...asset, ...(texture ? { texture } : {}), side: look.sides?.[slot] || null };
    }).filter(Boolean);
    return list.length ? list : null;
  }, [look, assets, dyed]);

  const viewerAccount = useMemo(() => {
    if (!account) return null;
    const lookCape = look?.capeUrl || null;
    const capeUrl = lookCape || account.capeUrl || null;
    const capeAnim = lookCape && look?.capeAnimation?.url
      ? { stripUrl: look.capeAnimation.url, frames: look.capeAnimation.frames, fps: look.capeAnimation.fps }
      : null;
    return { ...account, capeUrl, hasCape: Boolean(capeUrl), capeAnim };
  }, [account, look]);

  if (!viewerAccount) return null;

  return (
    <div className="home-mascot" aria-hidden="true">
      <SkinViewer3D account={viewerAccount} cosmetics={cosmetics} width={560} height={520} animation="pose" zoom={0.68} />
      <div className="home-mascot-shadow" />
    </div>
  );
}
