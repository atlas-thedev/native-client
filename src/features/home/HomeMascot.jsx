import React, { useEffect, useMemo, useState } from 'react';
import SkinViewer3D from '../../components/ui/SkinViewer3D.jsx';
import './HomeMascot.css';

/**
 * The player's own character in the middle of Home, wearing their full
 * Native look (cape + every equipped 3D cosmetic) and waving hi.
 */
export default function HomeMascot({ account }) {
  const name = account?.name || '';
  const [look, setLook] = useState(null);
  const [assets, setAssets] = useState({});

  useEffect(() => {
    setLook(null);
    if (!name) return undefined;
    let alive = true;
    window.native?.profiles?.get?.(name)
      .then((res) => { if (alive && res?.ok) setLook(res.profile?.look || null); })
      .catch(() => {});
    return () => { alive = false; };
  }, [name]);

  const wornKey = look?.wearing ? Object.entries(look.wearing).map(([slot, id]) => `${slot}:${id}`).sort().join(',') : '';
  useEffect(() => {
    if (!wornKey) return undefined;
    let alive = true;
    for (const id of new Set(Object.values(look.wearing))) {
      window.native?.store?.cosmetic?.(id).then((res) => {
        if (alive && res?.ok) setAssets((current) => (current[id] ? current : { ...current, [id]: res }));
      }).catch(() => {});
    }
    return () => { alive = false; };
  }, [wornKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const cosmetics = useMemo(() => {
    if (!look?.wearing) return null;
    const list = Object.entries(look.wearing)
      .map(([slot, id]) => (assets[id] ? { ...assets[id], side: look.sides?.[slot] || null } : null))
      .filter(Boolean);
    return list.length ? list : null;
  }, [look, assets]);

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
      <div className="home-mascot-bubble">Hi{name ? `, ${name}` : ''}! <span className="home-mascot-wave">👋</span></div>
      <SkinViewer3D account={viewerAccount} cosmetics={cosmetics} width={280} height={380} animation="wave" zoom={0.8} />
      <div className="home-mascot-shadow" />
    </div>
  );
}
