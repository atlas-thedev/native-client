import React, { useEffect, useRef, useState } from 'react';
import { drawCapeFront } from '../../lib/animatedCape.js';
import migratorCape from '../../assets/capes/migrator.png';
import './LockerSwitch.css';

/*
 * The Locker's two big tabs: Skins / Cosmetics.
 * A pixel-textured slab slides between them with squash & stretch, the label
 * pops, and a little burst of pixels flies out where you clicked.
 */

// Clean, bold label (was a pixel font).
function PixelWord({ word }) {
  return <span className="lsw-word">{word.charAt(0) + word.slice(1).toLowerCase()}</span>;
}

// The player's own face (8x8 + hat layer) cut from the skin texture.
function useSkinFace(skinUrl) {
  const [face, setFace] = useState(null);
  useEffect(() => {
    if (!skinUrl) { setFace(null); return undefined; }
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 8; canvas.height = 8;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 8, 8, 8, 8, 0, 0, 8, 8);
        ctx.drawImage(img, 40, 8, 8, 8, 0, 0, 8, 8);
        setFace(canvas.toDataURL());
      } catch { setFace(null); }
    };
    img.onerror = () => { if (!cancelled) setFace(null); };
    img.src = String(skinUrl).replace(/^http:\/\/textures\.minecraft\.net\//, 'https://textures.minecraft.net/');
    return () => { cancelled = true; };
  }, [skinUrl]);
  return face;
}

// The Cosmetics tab shows a real cape front: the cape you wear, or the Migrator cape.
function useCapeFront(capeUrl) {
  const [front, setFront] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const draw = (src, fallback) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        if (cancelled) return;
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 10; canvas.height = 16;
          drawCapeFront(canvas, img, 1, 0);
          setFront(canvas.toDataURL());
        } catch { if (fallback) draw(fallback, null); }
      };
      img.onerror = () => { if (!cancelled && fallback) draw(fallback, null); };
      img.src = String(src).replace(/^http:\/\/textures\.minecraft\.net\//, 'https://textures.minecraft.net/');
    };
    draw(capeUrl || migratorCape, capeUrl ? migratorCape : null);
    return () => { cancelled = true; };
  }, [capeUrl]);
  return front;
}

function CapeIcon({ capeUrl }) {
  const front = useCapeFront(capeUrl);
  return front
    ? <img className="lsw-icon lsw-icon-cape" src={front} alt="" />
    : <span className="lsw-icon lsw-icon-cape is-empty" />;
}

const BURST = 12;

export default function LockerSwitch({ value, onChange, skinUrl, capeUrl = null, counts = {} }) {
  const face = useSkinFace(skinUrl);
  const rootRef = useRef(null);
  const [motion, setMotion] = useState(null); // 'to-skins' | 'to-cosmetics'
  const [bursts, setBursts] = useState([]);
  const burstId = useRef(0);

  const choose = (next, event) => {
    if (next === value) {
      setMotion(null);
      requestAnimationFrame(() => setMotion('nudge'));
      return;
    }
    setMotion(next === 'skins' ? 'to-skins' : 'to-cosmetics');
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect && event) {
      const id = ++burstId.current;
      const x = (event.clientX || rect.left + rect.width / 2) - rect.left;
      const y = (event.clientY || rect.top + rect.height / 2) - rect.top;
      const pieces = Array.from({ length: BURST }, (_, i) => {
        const angle = (Math.PI * 2 * i) / BURST + Math.random() * 0.5;
        const dist = 26 + Math.random() * 34;
        return { dx: Math.cos(angle) * dist, dy: Math.sin(angle) * dist * 0.7 - 10, size: 3 + Math.round(Math.random() * 3), delay: Math.random() * 60 };
      });
      setBursts((list) => [...list, { id, x, y, pieces }]);
      setTimeout(() => setBursts((list) => list.filter((b) => b.id !== id)), 900);
    }
    onChange(next);
  };

  const onKey = (event) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      choose(value === 'skins' ? 'cosmetics' : 'skins', null);
    }
  };

  return (
    <div ref={rootRef} className={`lsw is-${value}`} role="tablist" aria-label="Locker sections" onKeyDown={onKey}>
      <span className={`lsw-slab ${motion ? `is-${motion}` : ''}`} onAnimationEnd={() => setMotion(null)} aria-hidden="true" />
      <button type="button" role="tab" aria-selected={value === 'skins'} tabIndex={value === 'skins' ? 0 : -1} className={`lsw-tab ${value === 'skins' ? 'is-active' : ''}`} onClick={(event) => choose('skins', event)}>
        <span className="lsw-tab-inner">
          {face ? <img className="lsw-icon lsw-icon-face" src={face} alt="" /> : <span className="lsw-icon lsw-icon-face is-empty" />}
          <PixelWord word="SKINS" />
          {counts.skins > 0 && <span className="lsw-count">{counts.skins}</span>}
        </span>
      </button>
      <button type="button" role="tab" aria-selected={value === 'cosmetics'} tabIndex={value === 'cosmetics' ? 0 : -1} className={`lsw-tab ${value === 'cosmetics' ? 'is-active' : ''}`} onClick={(event) => choose('cosmetics', event)}>
        <span className="lsw-tab-inner">
          <CapeIcon capeUrl={capeUrl} />
          <PixelWord word="COSMETICS" />
          {counts.cosmetics > 0 && <span className="lsw-count">{counts.cosmetics}</span>}
        </span>
      </button>
      {bursts.map((burst) => (
        <span key={burst.id} className="lsw-burst" style={{ left: burst.x, top: burst.y }} aria-hidden="true">
          {burst.pieces.map((p, i) => (
            <i key={i} style={{ '--dx': `${p.dx}px`, '--dy': `${p.dy}px`, '--s': `${p.size}px`, animationDelay: `${p.delay}ms` }} />
          ))}
        </span>
      ))}
    </div>
  );
}
