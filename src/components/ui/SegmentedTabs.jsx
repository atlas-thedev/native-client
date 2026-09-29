import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import NativeIcon from './NativeIcon.jsx';
import './SegmentedTabs.css';

/**
 * Segmented tab switcher with a single travelling indicator.
 *
 * The indicator is one absolutely positioned element that is animated between
 * the measured bounds of the active button, so switching tabs reads as one
 * continuous movement instead of two independent fades. Measurement runs
 * through a ResizeObserver, which keeps the pill aligned when the window,
 * the font or the label set changes.
 *
 * Roving tabindex + arrow keys follow the WAI-ARIA tabs pattern.
 *
 * items: [{ id, label, icon?, count?, disabled? }]
 */
/* Layout effects are client-only; server rendering falls back to useEffect so
   the component never warns during SSR snapshots. */
const useIsoLayoutEffect =
  typeof document !== 'undefined' && typeof document.createElement === 'function'
    ? useLayoutEffect
    : useEffect;

export default function SegmentedTabs({
  items = [],
  value,
  onChange,
  size = 'md', // 'sm' | 'md'
  iconSize,
  ariaLabel = 'Tabs',
  className = ''
}) {
  const listRef = useRef(null);
  const buttonRefs = useRef(new Map());
  const [indicator, setIndicator] = useState(null);
  const [ready, setReady] = useState(false);

  const measure = useCallback(() => {
    const list = listRef.current;
    const active = buttonRefs.current.get(value);
    if (!list || !active) {
      setIndicator(null);
      return;
    }
    const listBox = list.getBoundingClientRect();
    const box = active.getBoundingClientRect();
    if (box.width === 0) return;
    setIndicator({ x: box.left - listBox.left, width: box.width });
  }, [value]);

  useIsoLayoutEffect(() => {
    measure();
  }, [measure, items]);

  useEffect(() => {
    // Skip the entry animation on first paint: the pill should appear in place.
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    if (listRef.current) observer.observe(listRef.current);
    buttonRefs.current.forEach((node) => node && observer.observe(node));
    return () => observer.disconnect();
  }, [measure, items]);

  useEffect(() => {
    if (!document.fonts?.ready) return;
    document.fonts.ready.then(measure).catch(() => {});
  }, [measure]);

  const enabled = items.filter((item) => !item.disabled);

  const handleKeyDown = (event) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const index = enabled.findIndex((item) => item.id === value);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % enabled.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + enabled.length) % enabled.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = enabled.length - 1;
    const target = enabled[next];
    if (!target) return;
    onChange?.(target.id);
    buttonRefs.current.get(target.id)?.focus();
  };

  const glyph = iconSize || (size === 'sm' ? 14 : 16);

  return (
    <div
      className={`seg-tabs seg-${size} ${className}`.trim()}
      role="tablist"
      aria-label={ariaLabel}
      ref={listRef}
      onKeyDown={handleKeyDown}
    >
      {indicator && (
        <span
          className={`seg-indicator${ready ? ' is-animated' : ''}`}
          aria-hidden="true"
          style={{ transform: `translateX(${indicator.x}px)`, width: `${indicator.width}px` }}
        />
      )}

      {items.map((item) => {
        const isActive = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`seg-tab-${item.id}`}
            ref={(node) => {
              if (node) buttonRefs.current.set(item.id, node);
              else buttonRefs.current.delete(item.id);
            }}
            className={`seg-tab${isActive ? ' is-active' : ''}`}
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onChange?.(item.id)}
          >
            {item.icon && <NativeIcon name={item.icon} size={glyph} strokeWidth={1.6} className="seg-tab-icon" />}
            <span className="seg-tab-label">{item.label}</span>
            {typeof item.count === 'number' && (
              <span className="seg-tab-count">{item.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
