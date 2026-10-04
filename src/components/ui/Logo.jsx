import React from 'react';
import nativeLogo from '../../assets/native-icon.png';
import './Logo.css';

export function NativeMark({ size = 32, className = '', style }) {
  return (
    <img
      src={nativeLogo}
      alt="Native Client"
      width={size}
      height={size}
      className={`native-mark ${className}`.trim()}
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


export default function Logo({
  height = 32,
  variant = 'full',
  className = '',
  style,
  wordmark = 'Native Client'
}) {
  return (
    <span
      className={`native-logo native-logo-${variant} ${className}`.trim()}
      style={style}
    >
      <NativeMark size={height} />
      {variant === 'full' && (
        <span
          className="native-logo-text"
          style={{ fontSize: Math.round(height * 0.6) }}
        >
          {wordmark}
        </span>
      )}
    </span>
  );
}
