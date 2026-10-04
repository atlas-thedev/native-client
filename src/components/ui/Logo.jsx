import React from 'react';
import noctraLogo from '../../assets/noctra-icon.png';
import './Logo.css';

export function NativeMark({ size = 32, className = '', style }) {
  return (
    <img
      src={noctraLogo}
      alt="Native Client"
      width={size}
      height={size}
      className={`noctra-mark native-mark ${className}`.trim()}
      style={{
        width: size,
        height: size,
        objectFit: 'contain',
        borderRadius: Math.max(4, Math.round(size * 0.22)),
        ...style
      }}
      draggable={false}
    />
  );
}

export const NoctraMark = NativeMark;

export default function Logo({
  height = 32,
  variant = 'full',
  className = '',
  style,
  wordmark = 'Native Client'
}) {
  return (
    <span
      className={`noctra-logo native-logo noctra-logo-${variant} native-logo-${variant} ${className}`.trim()}
      style={style}
    >
      <NativeMark size={height} />
      {variant === 'full' && (
        <span
          className="noctra-logo-text native-logo-text"
          style={{ fontSize: Math.round(height * 0.6) }}
        >
          {wordmark}
        </span>
      )}
    </span>
  );
}
