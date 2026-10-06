import React, { useEffect, useMemo, useRef, useState } from 'react';
import './LockerSwitch.css';

/*
 * The Locker's two big tabs: Skins / Cosmetics.
 * A pixel-textured slab slides between them with squash & stretch, the label
 * pops, and a little burst of pixels flies out where you clicked.
 */

// 5x7 pixel font, just the letters the two labels need.
const GLYPHS = {
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  I: ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '###'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..']
};

function wordPixels(word) {
  const pixels = [];
  let x = 0;
  for (const letter of word) {
    const glyph = GLYPHS[letter];
    if (!glyph) { x += 4; continue; }
    glyph.forEach((row, y) => [...row].forEach((cell, dx) => { if (cell === '#') pixels.push([x + dx, y]); }));
    x += glyph[0].length + 1;
  }
  return { pixels, width: Math.max(1, x - 1) };
}

function PixelWord({ word }) {
  const { pixels, width } = useMemo(() => wordPixels(word), [word]);
  const path = pixels.map(([x, y]) => `M${x} ${y}h1v1h-1z`).join('');
  return (
    <svg className="lsw-word" viewBox={`0 0 ${width + 1} 8`} style={{ width: (width + 1) * 3, height: 24 }} aria-hidden="true" shapeRendering="crispEdges">
      <path d={path} className="lsw-word-shadow" transform="translate(1 1)" />
      <path d={path} className="lsw-word-face" />
    </svg>
  );
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

const CAPE_ICON = [
  '##########',
  '#........#',
  '.#......#.',
  '.#......#.',
  '.#......#.',
  '.#......#.',
  '.#......#.',
  '.#......#.',
  '.#......#.',
  '.##....##.',
  '..######..'
];

function CapeGlyph() {
  const fill = [];
  const edge = [];
  CAPE_ICON.forEach((row, y) => [...row].forEach((cell, x) => {
    if (cell === '#') edge.push(`M${x} ${y}h1v1h-1z`);
    else if (y > 0 && x > (y > 1 ? 1 : 0) && x < row.length - (y > 1 ? 2 : 1) && y < CAPE_ICON.length - 1) fill.push(`M${x} ${y}h1v1h-1z`);
  }));
  return (
    <svg className="lsw-icon lsw-icon-cape" viewBox="0 0 10 11" aria-hidden="true" shapeRendering="crispEdges">
      <path d={fill.join('')} className="lsw-cape-fill" />
      <path d={edge.join('')} className="lsw-cape-edge" />
    </svg>
  );
}

const BURST = 12;

export default function LockerSwitch({ value, onChange, skinUrl, counts = {} }) {
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
          <CapeGlyph />
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
