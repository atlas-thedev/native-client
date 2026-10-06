import React from 'react';
import './shop.css';

/* Shared pieces of the Store / Locker look: sky hero backdrop, tab strip, segmented switch. */

const CLOUDS = [
  { size: 9, left: '6%', top: 34, delay: -12 },
  { size: 13, left: '34%', top: 18, delay: -31 },
  { size: 10, left: '61%', top: 52, delay: -47 },
  { size: 12, left: '84%', top: 26, delay: -5 }
];

/** Pixel clouds drifting over a slanted ground stripe. */
export function SpotBackdrop() {
  return (
    <div className="store-spot-backdrop" aria-hidden="true">
      {CLOUDS.map((cloud, index) => (
        <span key={index} className="store-cloud" style={{ fontSize: cloud.size, left: cloud.left, top: cloud.top, animationDelay: `${cloud.delay}s` }} />
      ))}
      <svg className="store-spot-ground" viewBox="0 0 1200 112" preserveAspectRatio="none">
        <polygon points="0,4 1200,74 1200,90 0,20" className="is-top" />
        <polygon points="0,20 1200,90 1200,96 0,26" className="is-edge" />
        <polygon points="0,26 1200,96 1200,112 0,112" className="is-base" />
      </svg>
    </div>
  );
}

/** Tab strip: a bevelled well with a white key under the picked tab. items: { id, label, icon?, count?, title? } */
export function ShopTabs({ items, value, onChange, label = 'Tabs', size = 'md', fill = false, className = '' }) {
  return (
    <div className={`shop-tabs is-${size}${fill ? ' is-fill' : ''} ${className}`.trim()} role="tablist" aria-label={label}>
      {items.map((item) => (
        <button key={item.id} type="button" role="tab" title={item.title} aria-selected={value === item.id} className={`shop-tab${value === item.id ? ' is-on' : ''}`} onClick={() => onChange(item.id)}>
          {item.icon}
          <span className="shop-tab-label">{item.label}</span>
          {item.count != null && <span className="shop-tab-n">{item.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Small segmented switch (sort order). items: { id, label, icon? } */
export function ShopSeg({ items, value, onChange, label = 'Sort' }) {
  return (
    <div className="shop-seg" role="tablist" aria-label={label}>
      {items.map((item) => (
        <button key={item.id} type="button" role="tab" aria-selected={value === item.id} className={value === item.id ? 'is-on' : ''} onClick={() => onChange(item.id)}>
          {item.icon}<span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Four-block colour strip across the top of a buy panel. */
export function ShopStrip({ color = '#ffffff' }) {
  return <div className="shop-strip" style={{ '--c': color }} aria-hidden="true"><i /><i /><i /><i /></div>;
}
