import React from 'react';

/*
 * Hand-made pixel emblems for bundle rarities and the "owned" seal.
 * Each emblem is a 12×12 grid; letters pick a colour from the rarity palette.
 *   o outline · d dark · m mid · l light · w shine · r/y flame/jewel accents
 */
const GRIDS = {
  rare: [ // a cut sapphire
    '............',
    '...oooooo...',
    '..owlllmmo..',
    '.owllllmmdo.',
    'oooooooooooo',
    'olwllmmmmddo',
    '.olllmmmddo.',
    '..ollmmmdo..',
    '...olmmdo...',
    '....omdo....',
    '.....oo.....',
    '............'
  ],
  epic: [ // an amethyst crystal cluster
    '.....oo.....',
    '....owlo....',
    '....owlo..o.',
    '.o..olmo.olo',
    'olo.olmo.olo',
    'olmoolmdoomo',
    'olmoolmdoomo',
    'olmdolmddomo',
    '.omdolmddoo.',
    '.oooommdooo.',
    '..oooooooo..',
    '............'
  ],
  legendary: [ // a golden crown
    '............',
    '.w....w...w.',
    '.o...ooo..o.',
    '.oo..olo.oo.',
    '.olo.olo.olo',
    '.olloollolo.',
    '.ollllllllo.',
    '.ommmmmmmmo.',
    '.omrmmymrmo.',
    '.oddddddddo.',
    '.oooooooooo.',
    '............'
  ],
  mythic: [ // a living flame
    '.....o......',
    '....oro.....',
    '...orrro....',
    '...orrro.o..',
    '..orryrooro.',
    '..orryyrrro.',
    '.orryyyyrro.',
    '.oryywwyyro.',
    '.orywwwwyro.',
    '.oryywwyyro.',
    '..orryyrro..',
    '...oooooo...'
  ]
};
const PALETTES = {
  rare: { o: '#08142e', d: '#1546a8', m: '#2f78ff', l: '#7cb4ff', w: '#ffffff' },
  epic: { o: '#1a0833', d: '#5b1fa8', m: '#9a4dff', l: '#d2a8ff', w: '#ffffff' },
  legendary: { o: '#2e1800', d: '#a35f00', m: '#ffb020', l: '#ffe07a', w: '#fff6c9', r: '#ff3d6e', y: '#3dd6ff' },
  mythic: { o: '#2a0010', r: '#ff2d55', y: '#ffb020', w: '#fff3b0', d: '#a3002a', m: '#ff3d6e', l: '#ff9ab0' }
};
export const RARITY_IDS = ['rare', 'epic', 'legendary', 'mythic'];
export const RARITY_LABELS = { rare: 'Rare', epic: 'Epic', legendary: 'Legendary', mythic: 'Mythic' };

/** The pixel emblem of one rarity as crisp SVG. */
export function RarityEmblem({ rarity = 'epic', size = 14, className = '' }) {
  const id = GRIDS[rarity] ? rarity : 'epic';
  const palette = PALETTES[id];
  const rects = [];
  GRIDS[id].forEach((row, y) => {
    for (let x = 0; x < Math.min(row.length, 12); x += 1) {
      const fill = palette[row[x]];
      if (fill) rects.push(<rect key={`${x}:${y}`} x={x} y={y} width="1.02" height="1.02" fill={fill} />);
    }
  });
  return (
    <svg className={`rarity-emblem ${className}`.trim()} width={size} height={size} viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden="true">{rects}</svg>
  );
}

/** The rarity badge: emblem + name on a bevelled plate in the rarity colour (Legendary and Mythic shine). */
export function RarityBadge({ rarity = 'epic', label, size = 'md', className = '', style }) {
  const id = GRIDS[rarity] ? rarity : 'epic';
  return (
    <span className={`rarity-badge is-${id} is-${size} ${className}`.trim()} style={style} title={`${RARITY_LABELS[id]} bundle`}>
      <RarityEmblem rarity={id} size={size === 'lg' ? 18 : size === 'sm' ? 12 : 14} />
      <b>{label || RARITY_LABELS[id]}</b>
    </span>
  );
}

/** A pixel check seal, for things already in your locker. */
export function OwnedSeal({ size = 14 }) {
  const grid = [
    '..oooooo..',
    '.oggggggo.',
    'oggggggwgo',
    'ogggggwwgo',
    'ogwggwwggo',
    'ogwwwwgggo',
    'oggwwggggo',
    'oggggggggo',
    '.oggggggo.',
    '..oooooo..'
  ];
  const fill = { o: '#063d1f', g: '#1fbf63', w: '#ffffff' };
  const rects = [];
  grid.forEach((row, y) => { for (let x = 0; x < row.length; x += 1) if (fill[row[x]]) rects.push(<rect key={`${x}:${y}`} x={x} y={y} width="1.02" height="1.02" fill={fill[row[x]]} />); });
  return <svg className="owned-seal" width={size} height={size} viewBox="0 0 10 10" shapeRendering="crispEdges" aria-hidden="true">{rects}</svg>;
}

/** "In your locker" mark: the seal plus a short label (or the seal alone). */
export function OwnedMark({ label = 'In locker', compact = false, className = '' }) {
  return (
    <span className={`owned-mark${compact ? ' is-compact' : ''} ${className}`.trim()} title="In your locker">
      <OwnedSeal size={compact ? 14 : 13} />
      {!compact && <b>{label}</b>}
    </span>
  );
}
