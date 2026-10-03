import React from 'react';
import noctraLogo from '../../assets/noctra-icon.png';

/**
 * The Noctra+ mark, the same one the website uses (noctra-site components/plus/PlusMark.tsx):
 * the Noctra N (logo masked in the text colour) with the gold rounded "+" badge top-right.
 * `ring` is the colour of the cut-out around the badge; pass the background it sits on.
 */
export default function NoctraPlusIcon({ size = 16, className = '', title = null, ring = 'var(--bg, #0b0b0f)' }) {
  const plus = Math.round(size * 0.42);
  const mask = `url(${noctraLogo}) center / contain no-repeat`;
  return (
    <span
      className={`noctra-plus-icon ${className}`.trim()}
      role={title ? 'img' : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : 'true'}
      title={title || undefined}
      style={{ position: 'relative', display: 'inline-block', flex: 'none', width: size, height: size, verticalAlign: 'middle' }}
    >
      <span
        style={{
          position: 'absolute', left: 0, top: size * 0.14, width: size * 0.86, height: size * 0.86,
          backgroundColor: 'currentColor', WebkitMask: mask, mask
        }}
      />
      <span
        style={{
          position: 'absolute', right: 0, top: 0, width: plus, height: plus, borderRadius: '28%',
          display: 'grid', placeItems: 'center', fontWeight: 900, lineHeight: 1, fontSize: plus * 0.9,
          color: '#1b1405', background: 'linear-gradient(#ffe08a, #f2b632)',
          boxShadow: `0 0 0 ${Math.max(1, size / 24)}px ${ring}`
        }}
      >
        +
      </span>
    </span>
  );
}
