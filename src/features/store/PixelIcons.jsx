import React from 'react';

/* Native pixel glyphs (hand-made, crisp at any size). */
const px = { shapeRendering: 'crispEdges', fill: 'currentColor', 'aria-hidden': true };

/** A 4-point pixel star. */
export const PixelStar = ({ size = 12, ...props }) => (
  <svg viewBox="0 0 7 7" width={size} height={size} {...px} {...props}>
    <path d="M3 0h1v2H3zM2 2h3v1H2zM0 3h7v1H0zM2 4h3v1H2zM3 5h1v2H3z" />
  </svg>
);

/** A pixel cape with a star cut out of it. */
export const PixelCape = ({ size = 20, ...props }) => (
  <svg viewBox="0 0 12 14" width={Math.round(size * 12 / 14)} height={size} {...px} {...props}>
    <path fillRule="evenodd" d="M1 0h10v2h-1v10H7v1H5v-1H2V2H1zM6 3h2v1H6zM5 4h1v1H5zM4 5h1v3H4zM5 8h1v1H5zM6 9h2v1H6zM7 6h1v1H7z" />
  </svg>
);
