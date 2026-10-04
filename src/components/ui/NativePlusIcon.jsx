import React from 'react';
import nativeLogo from '../../assets/native-icon.png';

/**
 * The Native+ mark (same as the website's PlusMark): the Native N in the text colour with a
 * gold "+" badge at the top-right. No tile, no border: the N is cut away around the badge
 * (a transparent gap, so it works on any background), and the badge is laid out on whole
 * pixels so the "+" is exactly centred at every size.
 */
export default function NativePlusIcon({ size = 16, className = '', title = null, style = null }) {
  const s = Math.max(10, Math.round(size));
  // Badge: whole pixels, with the bars' size matching its parity so they centre exactly.
  let badge = Math.max(7, Math.round(s * (s < 20 ? 0.5 : 0.46)));
  const bar = Math.max(1, Math.round(badge * 0.15));
  if ((badge - bar) % 2) badge += 1;
  let len = Math.round(badge * 0.58);
  if ((badge - len) % 2) len += 1;
  const gap = Math.max(1, Math.round(s * 0.07));
  const n = Math.round(s * 0.84); // the N's box, bottom-left
  const cut = encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><rect x="${s - badge - gap}" y="${-gap}" width="${badge + gap * 2}" height="${badge + gap * 2}" rx="${(badge + gap * 2) * 0.32}" fill="#000"/></svg>`
  );
  const mask = `url(${nativeLogo}) 0 ${s - n}px / ${n}px ${n}px no-repeat, url("data:image/svg+xml;utf8,${cut}") 0 0 / ${s}px ${s}px no-repeat`;
  const at = (badge - len) / 2;
  const across = (badge - bar) / 2;
  return (
    <span
      className={`native-plus-icon ${className}`.trim()}
      role={title ? 'img' : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : 'true'}
      title={title || undefined}
      style={{ position: 'relative', display: 'inline-block', flex: 'none', width: s, height: s, verticalAlign: 'middle', ...style }}
    >
      <span
        style={{
          position: 'absolute', inset: 0, backgroundColor: 'currentColor',
          WebkitMask: mask, mask, WebkitMaskComposite: 'source-out', maskComposite: 'subtract'
        }}
      />
      <span
        style={{
          position: 'absolute', right: 0, top: 0, width: badge, height: badge, borderRadius: Math.round(badge * 0.3),
          background: 'linear-gradient(160deg, #ffe08a, #f2b632)', boxShadow: 'inset 0 -1px 0 rgba(120, 72, 0, 0.25)'
        }}
      >
        <span style={{ position: 'absolute', left: at, top: across, width: len, height: bar, borderRadius: bar, background: '#1b1405' }} />
        <span style={{ position: 'absolute', left: across, top: at, width: bar, height: len, borderRadius: bar, background: '#1b1405' }} />
      </span>
    </span>
  );
}
