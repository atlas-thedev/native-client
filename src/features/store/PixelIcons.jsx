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

/** A pixel top hat. */
export const PixelHat = ({ size = 18, ...props }) => (
  <svg viewBox="0 0 14 12" width={Math.round(size * 14 / 12)} height={size} {...px} {...props}>
    <path d="M3 0h8v1H3zM3 1h1v6H3zM10 1h1v6h-1zM4 1h6v4H4zM4 5h6v1H4zM4 6h6v1H4zM0 8h14v2H0zM1 7h12v1H1zM1 10h12v1H1z" />
    <path d="M4 5h6v1H4z" opacity="0.45" />
  </svg>
);

/** Pixel sunglasses. */
export const PixelGlasses = ({ size = 18, ...props }) => (
  <svg viewBox="0 0 16 8" width={Math.round(size * 16 / 8 * 0.62)} height={Math.round(size * 0.62)} {...px} {...props}>
    <path fillRule="evenodd" d="M0 1h16v1h-1v3h-1v1h-3V5h-1V3H6v2H5v1H2V5H1V2H0zM2 2v3h3V2zM11 2v3h3V2z" />
    <path d="M2 2h3v3H2zM11 2h3v3h-3z" opacity="0.4" />
  </svg>
);

/** Pixel wings. */
export const PixelWings = ({ size = 18, ...props }) => (
  <svg viewBox="0 0 16 11" width={Math.round(size * 16 / 11)} height={size} {...px} {...props}>
    <path d="M0 0h2v1h1v1h1v1h2v1h1v3H6v1H5v1H3v1H1V9H0zM16 0h-2v1h-1v1h-1v1h-2v1H9v3h1v1h1v1h2v1h2V9h1z" />
    <path d="M7 4h2v4H7z" opacity="0.5" />
  </svg>
);

/** A pixel sneaker. */
export const PixelShoe = ({ size = 18, ...props }) => (
  <svg viewBox="0 0 14 9" width={Math.round(size * 14 / 9 * 0.8)} height={Math.round(size * 0.8)} {...px} {...props}>
    <path d="M1 0h5v1h1v1h2v1h2v1h2v1h1v2H0V1h1z" />
    <path d="M0 7h14v2H0z" opacity="0.5" />
  </svg>
);

/** Four pixel squares: everything. */
export const PixelGrid = ({ size = 14, ...props }) => (
  <svg viewBox="0 0 7 7" width={size} height={size} {...px} {...props}>
    <path d="M0 0h3v3H0zM4 0h3v3H4zM0 4h3v3H0zM4 4h3v3H4z" />
  </svg>
);
