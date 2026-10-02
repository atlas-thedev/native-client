import React from 'react';

/**
 * Glyphs drawn for the content-health card (updates, problems, review list).
 * Two-tone on a 24 grid: a soft `currentColor` plate under a bold stroke, so
 * they read as one family and don't look like stock outline icons.
 */
const Svg = ({ size = 16, className = '', children }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
    {children}
  </svg>
);
const stroke = { stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
const plate = <rect x="2.5" y="2.5" width="19" height="19" rx="6.5" fill="currentColor" opacity="0.16" />;

/** Rising chevron over a base line: "a newer build is ready". */
export const GlyphUpdate = (p) => (
  <Svg {...p}>
    {plate}
    <path d="M7.8 12.6 12 8.4l4.2 4.2" {...stroke} />
    <path d="M12 8.9v7.3" {...stroke} />
    <path d="M8.6 17.6h6.8" {...stroke} strokeWidth="1.6" opacity="0.55" />
  </Svg>
);

/** Plate with a check: everything is current. */
export const GlyphUpToDate = (p) => (
  <Svg {...p}>
    {plate}
    <path d="m8 12.3 2.7 2.7L16.2 9.4" {...stroke} />
  </Svg>
);

/** Soft triangle with a bold mark: a problem that needs attention. */
export const GlyphProblem = (p) => (
  <Svg {...p}>
    <path d="M10.3 3.9a2 2 0 0 1 3.4 0l7.6 13.2a2 2 0 0 1-1.7 3H4.4a2 2 0 0 1-1.7-3z" fill="currentColor" opacity="0.18" />
    <path d="M12 9v4.4" {...stroke} />
    <circle cx="12" cy="16.6" r="1.2" fill="currentColor" />
  </Svg>
);

/** Broken link: the update check couldn't reach Modrinth. */
export const GlyphOffline = (p) => (
  <Svg {...p}>
    {plate}
    <path d="M10.4 8.6 9.3 7.5a2.6 2.6 0 0 0-3.7 3.7l1.4 1.4" {...stroke} />
    <path d="m13.6 15.4 1.1 1.1a2.6 2.6 0 0 0 3.7-3.7L17 11.4" {...stroke} />
    <path d="m9.8 14.2 4.4-4.4" {...stroke} opacity="0.45" />
  </Svg>
);

/** Two-segment ring; spin it with CSS. */
export const GlyphSpinner = ({ className = '', ...p }) => (
  <Svg {...p} className={`hg-spin ${className}`.trim()}>
    <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2.4" opacity="0.18" />
    <path d="M12 4a8 8 0 0 1 8 8" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
  </Svg>
);

/** Arrow dropping into a tray: download / install. */
export const GlyphDownload = (p) => (
  <Svg {...p}>
    <path d="M12 4.5v9.2" {...stroke} />
    <path d="m8.3 10.2 3.7 3.7 3.7-3.7" {...stroke} />
    <path d="M5.5 15.5v1.7a2.3 2.3 0 0 0 2.3 2.3h8.4a2.3 2.3 0 0 0 2.3-2.3v-1.7" {...stroke} />
  </Svg>
);

/** Small rising arrow for the inline per-file pill. */
export const GlyphBump = (p) => (
  <Svg {...p}>
    <path d="M7 14.5 12 9.5l5 5" {...stroke} strokeWidth="2.6" />
  </Svg>
);

/** Double chevron with a faded tail: old version → new version. */
export const GlyphFromTo = (p) => (
  <Svg {...p}>
    <path d="m6.5 7.5 4.5 4.5-4.5 4.5" {...stroke} opacity="0.4" />
    <path d="m12.5 7.5 4.5 4.5-4.5 4.5" {...stroke} />
  </Svg>
);

export const GlyphChevron = ({ open, className = '', ...p }) => (
  <Svg {...p} className={`hg-chev ${open ? 'is-open' : ''} ${className}`.trim()}>
    <path d="m7.5 10 4.5 4.5 4.5-4.5" {...stroke} />
  </Svg>
);

export const GlyphRefresh = (p) => (
  <Svg {...p}>
    <path d="M18.6 9.2A7 7 0 0 0 6 7.6L4.8 9" {...stroke} />
    <path d="M4.6 5.2V9h3.8" {...stroke} />
    <path d="M5.4 14.8A7 7 0 0 0 18 16.4l1.2-1.4" {...stroke} />
    <path d="M19.4 18.8V15h-3.8" {...stroke} />
  </Svg>
);

export const GlyphClose = (p) => (
  <Svg {...p}>
    <path d="m7.5 7.5 9 9m0-9-9 9" {...stroke} />
  </Svg>
);

/** Stand-in tile for a mod without an icon: a little block. */
export const GlyphBlock = (p) => (
  <Svg {...p}>
    <path d="m12 3.8 7.2 4.1v8.2L12 20.2l-7.2-4.1V7.9z" fill="currentColor" opacity="0.2" />
    <path d="m12 3.8 7.2 4.1v8.2L12 20.2l-7.2-4.1V7.9z" {...stroke} strokeWidth="1.6" />
    <path d="M4.8 7.9 12 12l7.2-4.1M12 12v8.2" {...stroke} strokeWidth="1.6" opacity="0.6" />
  </Svg>
);

/** Custom checkbox: a rounded tile that fills with the accent when on. */
export function Tick({ checked, disabled, onChange, label }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`hg-tick ${checked ? 'is-on' : ''}`}
      onClick={onChange}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="m5.5 12.5 4.3 4.3 8.7-9.6" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
