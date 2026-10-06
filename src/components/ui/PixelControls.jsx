import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import PixelText from './PixelText.jsx';
import './PixelControls.css';

/*
 * Native pixel controls, in the style of the Locker's Skins / Cosmetics switch:
 *   <PixelButton icon={<Plus />} label="Add to locker" onClick={...} />
 *   <PixelButton variant="ghost|gold|danger|locked" size="sm|md|lg" block busy />
 *   <PixelIconButton icon={<X />} label="Close" />
 *   <PixelTabs items={[{ id, label, icon, count }]} value onChange size="sm|md" />
 */

const BURST = 12;
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

/** A little pixel poof at the click point, relative to `host`. */
function usePoof() {
  const [bursts, setBursts] = useState([]);
  const id = useRef(0);
  const poof = useCallback((host, event, count = BURST) => {
    if (!host || reduced()) return;
    const rect = host.getBoundingClientRect();
    const x = (event?.clientX || rect.left + rect.width / 2) - rect.left;
    const y = (event?.clientY || rect.top + rect.height / 2) - rect.top;
    const key = ++id.current;
    const pieces = Array.from({ length: count }, (_, i) => {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
      const dist = 22 + Math.random() * 30;
      return { dx: Math.cos(angle) * dist, dy: Math.sin(angle) * dist * 0.7 - 10, size: 3 + Math.round(Math.random() * 3), delay: Math.random() * 60 };
    });
    setBursts((list) => [...list, { key, x, y, pieces }]);
    setTimeout(() => setBursts((list) => list.filter((b) => b.key !== key)), 900);
  }, []);
  const node = bursts.map((burst) => (
    <span key={burst.key} className="px-burst" style={{ left: burst.x, top: burst.y }} aria-hidden="true">
      {burst.pieces.map((p, i) => <i key={i} style={{ '--dx': `${p.dx}px`, '--dy': `${p.dy}px`, '--s': `${p.size}px`, animationDelay: `${p.delay}ms` }} />)}
    </span>
  ));
  return [node, poof];
}

const SCALE = { sm: 2, md: 2, lg: 2 };

/** Chunky pixel slab button with a pixel-font label. */
export function PixelButton({
  label,
  icon = null,
  variant = 'primary',
  size = 'md',
  block = false,
  busy = false,
  busyIcon = null,
  disabled = false,
  poof = false,
  className = '',
  onClick,
  title,
  type = 'button',
  textScale,
  ...rest
}) {
  const ref = useRef(null);
  const [pop, setPop] = useState(false);
  const [bursts, burst] = usePoof();
  const locked = variant === 'locked' || variant === 'exclusive';
  const classes = [
    'pxb',
    variant !== 'primary' && `is-${variant === 'exclusive' ? 'locked is-exclusive' : variant}`,
    size !== 'md' && `is-${size}`,
    block && 'is-block',
    busy && 'is-busy',
    pop && 'is-pop',
    className
  ].filter(Boolean).join(' ');
  const handle = (event) => {
    if (locked) return;
    if (!reduced()) { setPop(false); requestAnimationFrame(() => setPop(true)); }
    if (poof) burst(ref.current, event, 10);
    onClick?.(event);
  };
  const scale = textScale || SCALE[size] || 2;
  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      disabled={disabled || busy}
      aria-disabled={locked || undefined}
      aria-busy={busy || undefined}
      aria-label={rest['aria-label'] || label}
      title={title}
      onClick={handle}
      onAnimationEnd={() => setPop(false)}
      {...rest}
    >
      <span className="pxb-face">
        {busy ? (busyIcon || icon) : icon}
        {label ? <PixelText text={label} scale={scale} /> : null}
      </span>
      {bursts}
    </button>
  );
}

/** Square pixel button for an icon. */
export function PixelIconButton({ icon, label, variant = 'ghost', size = 'sm', className = '', ...rest }) {
  return <PixelButton icon={icon} variant={variant} size={size} className={`is-icon ${className}`.trim()} aria-label={label} title={rest.title || label} {...rest} label={null} />;
}

/** Segmented tabs with the sliding, squashing pixel slab. */
export function PixelTabs({ items, value, onChange, size = 'md', fill = false, className = '', label: ariaLabel = 'Tabs' }) {
  const root = useRef(null);
  const tabs = useRef(new Map());
  const [slab, setSlab] = useState({ x: 0, w: 0, shown: false });
  const [motion, setMotion] = useState(null);
  const [bursts, burst] = usePoof();

  const measure = useCallback(() => {
    const el = tabs.current.get(value);
    if (!el || !root.current) { setSlab((s) => ({ ...s, shown: false })); return; }
    setSlab({ x: el.offsetLeft, w: el.offsetWidth, shown: true });
  }, [value]);
  useLayoutEffect(() => { measure(); }, [measure, items.length, items.map((item) => `${item.id}:${item.label}:${item.count}`).join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (!root.current || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => measure());
    ro.observe(root.current);
    return () => ro.disconnect();
  }, [measure]);

  const choose = (id, event) => {
    if (id === value) { setMotion(null); requestAnimationFrame(() => setMotion('nudge')); return; }
    setMotion('moving');
    burst(root.current, event, size === 'sm' ? 8 : 12);
    onChange?.(id);
  };
  const onKey = (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const at = items.findIndex((item) => item.id === value);
    const next = items[(at + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length];
    if (next) { choose(next.id, null); tabs.current.get(next.id)?.focus(); }
  };
  const scale = 2;
  return (
    <div ref={root} className={`pxt${size === 'sm' ? ' is-sm' : ''}${fill ? ' is-fill' : ''} ${className}`.trim()} role="tablist" aria-label={ariaLabel} onKeyDown={onKey}>
      <span
        className={`pxt-slab${slab.shown ? '' : ' is-hidden'}${motion ? ` is-${motion}` : ''}`}
        style={{ '--pxt-x': `${slab.x}px`, '--pxt-w': `${slab.w}px` }}
        onAnimationEnd={() => setMotion(null)}
        aria-hidden="true"
      />
      {items.map((item) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            ref={(node) => { if (node) tabs.current.set(item.id, node); else tabs.current.delete(item.id); }}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={item.count != null ? `${item.label} (${item.count})` : item.label}
            tabIndex={active ? 0 : -1}
            className={`pxt-tab${active ? ' is-active' : ''}`}
            onClick={(event) => choose(item.id, event)}
            title={item.title}
          >
            <span className="pxt-tab-inner">
              {item.icon ? <span className="pxt-icon">{item.icon}</span> : null}
              <PixelText text={item.label} scale={item.scale || scale} />
              {item.count != null && <span className="pxt-count">{item.count}</span>}
            </span>
          </button>
        );
      })}
      {bursts}
    </div>
  );
}

export default PixelButton;
