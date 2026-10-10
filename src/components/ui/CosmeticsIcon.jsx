import React from 'react';

/**
 * Native "cosmetics" mark: a big curved four-point sparkle with a small one and a twinkle,
 * two-tone (soft fill + outline) so it reads as an icon of its own next to lucide's set.
 */
export default function CosmeticsIcon({ size = 16, strokeWidth = 1.8, className = '', title }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={`cosmetics-icon ${className}`.trim()}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title || undefined}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <path d="M10 4.6c.7 4.3 2.6 6.2 6.9 6.9-4.3.7-6.2 2.6-6.9 6.9-.7-4.3-2.6-6.2-6.9-6.9 4.3-.7 6.2-2.6 6.9-6.9Z" fill="currentColor" fillOpacity="0.2" />
      <path d="M18.2 2.8c.3 1.6.95 2.25 2.55 2.55-1.6.3-2.25.95-2.55 2.55-.3-1.6-.95-2.25-2.55-2.55 1.6-.3 2.25-.95 2.55-2.55Z" fill="currentColor" />
      <path d="M18.6 16.2v3.4M16.9 17.9h3.4" />
    </svg>
  );
}
