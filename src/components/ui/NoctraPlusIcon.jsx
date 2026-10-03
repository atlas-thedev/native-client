import React from 'react';

/**
 * The Noctra+ mark: the Noctra "N" with a gold plus (same artwork as the N+ app icon).
 * The N follows the text colour; the plus is always Noctra+ gold.
 */
export default function NoctraPlusIcon({ size = 16, className = '', title = null }) {
  return (
    <svg
      className={`noctra-plus-icon ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : 'true'}
      aria-label={title || undefined}
      focusable="false"
      style={{ flex: 'none', display: 'inline-block', verticalAlign: 'middle' }}
    >
      {title && <title>{title}</title>}
      <path fill="currentColor" d="M2 22.5V7.5h4.1l6.4 8.6V7.5h4v15h-4.1l-6.4-8.6v8.6z" />
      <path fill="#ffd68c" stroke="#b9852d" strokeWidth="0.6" strokeLinejoin="round" d="M17.6 0.8h2.8v3.1h3.1v2.8h-3.1v3.1h-2.8V6.7h-3.1V3.9h3.1z" />
    </svg>
  );
}
