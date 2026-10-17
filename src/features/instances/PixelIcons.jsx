import React from 'react';

/**
 * Little Minecraft-style block icons, drawn here as 16x16 pixel art (original artwork, not game textures).
 * Used for the New instance steps: grass block = version, crafting table = loader, chest = extras.
 */
const ART = {
  grass: {
    palette: { G: '#5fa83b', g: '#4a8c2c', L: '#79c24c', D: '#866043', d: '#6b4a32', s: '#9a7450', k: '#55392a' },
    rows: [
      'LGGLGGGLGGLGGGLG',
      'GGgGGLGGgGGGLGgG',
      'GgGGgGGgGGgGGgGG',
      'gDgGDgGDgDgGDgDg',
      'DdDgDDsDDgDdDDgD',
      'DDsDDdDDDDsDDdDD',
      'DdDDDDDkDDDDDDsD',
      'sDDdDsDDDdDDkDDD',
      'DDDDDDDdDDsDDDdD',
      'DkDsDDdDDDDDdDDD',
      'DDDDdDDDsDDkDDDs',
      'DdDDDDkDDDDDDdDD',
      'DDsDDDDDdDsDDDDD',
      'kDDDdDDsDDDDdDkD',
      'DDdDDDDDDkDDDDDD',
      'DDDDsDdDDDDsDDdD'
    ]
  },
  table: {
    palette: { B: '#a0743e', b: '#7d5a2f', T: '#c8975a', t: '#b2834a', K: '#4d3519', W: '#8f8f8f', w: '#c4c4c4', R: '#6b4b27' },
    rows: [
      'KKKKKKKKKKKKKKKK',
      'KTTTTtTKTTTtTTTK',
      'KTtTTTTKTTTTTtTK',
      'KTTTTTTKTTtTTTTK',
      'KKKKKKKKKKKKKKKK',
      'KTTtTTTKTTTTtTTK',
      'KTTTTTTKTtTTTTTK',
      'KKKKKKKKKKKKKKKK',
      'KBbBBwWBBBRRRBBK',
      'KBBBwWwBBBRbRBbK',
      'KBbBBWBBbBRRRBBK',
      'KBBBBRBBBBBRBBBK',
      'KbBBBRBBBbBRBBbK',
      'KBBbBRBBBBBRBBBK',
      'KBBBBBBbBBBBBbBK',
      'KKKKKKKKKKKKKKKK'
    ]
  },
  chest: {
    palette: { O: '#2b1a0b', B: '#a86f2a', b: '#8a5a21', H: '#c58a3c', D: '#6b4316', Y: '#e8d27a', y: '#b8a04e', K: '#1a1a1a' },
    rows: [
      '................',
      '.OOOOOOOOOOOOOO.',
      '.OHHHHHHHHHHHHO.',
      '.OBBbBBBBBBbBBO.',
      '.OBBBBBBBBBBBBO.',
      '.ObBBBBYYBBBBbO.',
      '.OOOOOOYYOOOOOO.',
      '.OBBBBBYyBBBBBO.',
      '.OBbBBBKKBBBbBO.',
      '.OBBBBBBBBBBBBO.',
      '.ObBBBBBBBBBBbO.',
      '.OBBBbBBBBbBBBO.',
      '.OBBBBBBBBBBBBO.',
      '.ODDDDDDDDDDDDO.',
      '.OOOOOOOOOOOOOO.',
      '................'
    ]
  }
};

export default function PixelIcon({ name, size = 22, className = '' }) {
  const art = ART[name];
  if (!art) return null;
  const rects = [];
  art.rows.forEach((row, y) => {
    // merge runs of the same colour into one rect: fewer nodes, no hairline gaps
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === ch) end += 1;
      if (ch !== '.' && art.palette[ch]) rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={end - x} height={1} fill={art.palette[ch]} />);
      x = end;
    }
  });
  return (
    <svg className={`pixel-icon ${className}`.trim()} viewBox="0 0 16 16" width={size} height={size} shapeRendering="crispEdges" aria-hidden="true">
      {rects}
    </svg>
  );
}
