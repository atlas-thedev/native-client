import React from 'react';
import Logo from './Logo.jsx';

export function MicrosoftLogo({ size = 14 }) {
  const s = size / 2 - 0.75;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <rect x="0" y="0" width={s} height={s} fill="#f25022" />
      <rect x={size - s} y="0" width={s} height={s} fill="#7fba00" />
      <rect x="0" y={size - s} width={s} height={s} fill="#00a4ef" />
      <rect x={size - s} y={size - s} width={s} height={s} fill="#ffb900" />
    </svg>
  );
}

/** The Microsoft or Native mark, used wherever an identity needs its provider next to it. */
export default function ProviderLogo({ kind, size = 14, className = '' }) {
  const microsoft = kind === 'microsoft' || kind === 'premium';
  return (
    <span className={`idsw-logo ${microsoft ? 'is-premium' : 'is-native'} ${className}`.trim()} title={microsoft ? 'Microsoft' : 'Native'}>
      {microsoft ? <MicrosoftLogo size={size} /> : <Logo height={size + 3} variant="mark" />}
    </span>
  );
}
