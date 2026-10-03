import React, { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Store, X } from 'lucide-react';
import { drawCapeFront, loadStripImage } from '../../lib/animatedCape.js';

/**
 * The Noctra cape store: every item is free, animated, and equips on the whole account at once
 * (launcher, website, and the in-game mod all update live).
 */
export default function CapeStoreModal({ account, equippedId, onClose, onEquipped, onNotify }) {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const canvases = useRef(new Map());
  const strips = useRef(new Map()); // id -> { image, frames, fps }

  useEffect(() => {
    let alive = true;
    window.native?.store?.catalog?.().then((res) => {
      if (!alive) return;
      if (res?.ok) setCatalog(res);
      else setError(res?.error || 'Couldn’t load the store.');
    }).catch(() => alive && setError('Couldn’t load the store.'));
    return () => { alive = false; };
  }, []);

  // Download each preview strip once, then animate every card from one shared loop.
  useEffect(() => {
    if (!catalog) return undefined;
    let alive = true;
    (async () => {
      for (const item of catalog.items) {
        if (!alive) return;
        try {
          const res = await window.native.store.strip(item.id);
          if (!res?.ok || !alive) continue;
          strips.current.set(item.id, { image: await loadStripImage(res.url), frames: item.frames, fps: item.fps });
        } catch { /* the card stays blank */ }
      }
    })();
    let raf = 0;
    const tick = (now) => {
      strips.current.forEach((entry, id) => {
        const canvas = canvases.current.get(id);
        if (canvas) drawCapeFront(canvas, entry.image, entry.frames, Math.floor((now * entry.fps) / 1000) % entry.frames);
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [catalog]);

  const equip = async (item) => {
    setBusyId(item.id || '__none');
    try {
      const res = await window.native.store.equip(account, item?.id || null);
      if (!res?.ok) throw new Error(res?.error || 'Couldn’t equip that cape.');
      onEquipped(res.state);
      onNotify?.('Store', item?.id ? `${item.name} is now your cape.` : 'Cape removed.');
    } catch (e) {
      onNotify?.('Store', e?.message || 'Couldn’t equip that cape.');
    } finally {
      setBusyId(null);
    }
  };

  const capes = (catalog?.items || []).filter((item) => item.section === 'capes');
  return (
    <div className="locker-modal-overlay" onClick={onClose}>
      <div className="capestore-modal" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="import-modal-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        <div className="capestore-head"><Store size={18} /><div><h3>Cape store</h3><p>Animated capes for your Noctra account. Free for everyone.</p></div></div>
        {error && <p className="animcape-note is-error" role="alert">{error}</p>}
        {!catalog && !error && <p className="animcape-note"><Loader2 size={14} className="is-spinning" /> Loading the store…</p>}
        {catalog && (
          <div className="capestore-grid">
            {capes.map((item) => {
              const on = equippedId === item.id;
              return (
                <article key={item.id} className={`capestore-card${on ? ' active' : ''}`}>
                  <canvas ref={(node) => { if (node) canvases.current.set(item.id, node); else canvases.current.delete(item.id); }} width={80} height={128} className="capestore-canvas" aria-hidden="true" />
                  <div className="capestore-meta"><strong>{item.name}</strong><small>{item.description}</small></div>
                  <button type="button" className="capestore-equip" disabled={busyId !== null || on} onClick={() => equip(item)}>
                    {busyId === item.id ? <Loader2 size={13} className="is-spinning" /> : on ? <Check size={13} /> : null}{on ? 'Equipped' : 'Equip'}
                  </button>
                </article>
              );
            })}
          </div>
        )}
        {equippedId && <button type="button" className="capestore-remove" disabled={busyId !== null} onClick={() => equip({ id: null })}>Take cape off</button>}
      </div>
    </div>
  );
}
