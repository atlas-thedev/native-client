import React, { useRef, useState } from 'react';
import { ArrowUpRight, Check, Copy, Sparkles } from 'lucide-react';
import aurexLogo from '../../assets/partners/aurex-logo-v1.webp';
import aurexHero from '../../assets/partners/aurex-hero-v1.webp';
import aurexCrystal from '../../assets/partners/aurex-crystal-v1.webp';
import './Partners.css';

/** Motion presets the admin can pick for a partner card. */
export const PARTNER_ANIMATIONS = [
  ['aurora', 'Aurora', 'Soft colour clouds drifting behind the card'],
  ['orbit', 'Orbit', 'A ring of light circling the logo'],
  ['glitch', 'Glitch', 'RGB split, scanlines and a jittery logo'],
  ['float', 'Float', 'Art bobbing in zero gravity with rising sparks'],
  ['shine', 'Shine', 'A light sweep across a glassy card'],
  ['pulse', 'Pulse', 'Shock-wave rings from the logo'],
  ['grid', 'Grid', 'Synthwave floor rolling into the horizon'],
  ['none', 'Still', 'No motion']
];

/** Shown when the API can't be reached (and as the seed on first run). */
export const BUILT_IN_PARTNERS = [{
  id: 'aurex01',
  name: 'Aurex Hosting',
  tagline: 'Sri Lanka’s #1 game hosting provider.',
  description: 'Minecraft, FiveM, MTA, Rust and Hytale servers on AMD Ryzen 7 nodes in Singapore, around 60 ms from Colombo. Instant setup, NVMe storage and always-on DDoS protection.',
  website: 'https://www.aurex.lk/en',
  cta: 'Get a server',
  logo: aurexLogo,
  background: aurexHero,
  art: aurexCrystal,
  accent: '#8b5cf6',
  accent2: '#c07eff',
  animation: 'aurora',
  speed: 1,
  intensity: 70,
  perks: ['Ryzen 7 nodes', 'NVMe storage', 'Always-on DDoS protection', 'From LKR 400/mo'],
  code: '',
  tier: 'featured'
}];

/* Bundled copies of the seeded art, so the Aurex card never shows a broken image. */
const LOCAL_ART = {
  'aurex-logo-v1.webp': aurexLogo,
  'aurex-hero-v1.webp': aurexHero,
  'aurex-crystal-v1.webp': aurexCrystal
};
export function artSrc(value) {
  const raw = String(value || '');
  const name = raw.split('/').pop();
  if (raw.includes('/v1/site/partners/media/') && LOCAL_ART[name]) return LOCAL_ART[name];
  // Admin settings keep bundled art as a server path; the public feed sends full links.
  return raw.startsWith('/v1/') ? `https://api.playnative.net${raw}` : raw;
}

const openLink = (url) => {
  if (window.native?.openExternal) window.native.openExternal(url);
  else window.open(url, '_blank', 'noopener');
};

function Motion({ animation }) {
  if (animation === 'none') return null;
  return (
    <div className={`pt-motion pt-motion-${animation}`} aria-hidden="true">
      {animation === 'aurora' && <><i /><i /><i /></>}
      {animation === 'orbit' && <><i /><i /><b /><b /><b /></>}
      {animation === 'glitch' && <><i /><i /></>}
      {animation === 'float' && Array.from({ length: 14 }, (_, index) => <i key={index} style={{ '--n': index }} />)}
      {animation === 'shine' && <i />}
      {animation === 'pulse' && <><i /><i /><i /></>}
      {animation === 'grid' && <><i /><b /></>}
    </div>
  );
}

/**
 * One partner, drawn with its own colours and motion preset.
 * `size` is "hero" (full-width spotlight) or "tile" (grid card).
 */
export default function PartnerCard({ partner, size = 'tile', preview = false, onVisit }) {
  const ref = useRef(null);
  const [copied, setCopied] = useState(false);
  const pt = partner || {};
  const animation = pt.animation || 'aurora';
  const style = {
    '--pt-accent': pt.accent || '#ffffff',
    '--pt-accent2': pt.accent2 || pt.accent || '#ffffff',
    '--pt-speed': String(Math.max(0.25, Number(pt.speed) || 1)),
    '--pt-intensity': String(Math.max(0, Math.min(100, Number(pt.intensity ?? 60))) / 100)
  };

  // Gentle 3D tilt that follows the pointer.
  const onMove = (event) => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width - 0.5;
    const y = (event.clientY - box.top) / box.height - 0.5;
    el.style.setProperty('--pt-rx', `${(-y * (size === 'hero' ? 4 : 7)).toFixed(2)}deg`);
    el.style.setProperty('--pt-ry', `${(x * (size === 'hero' ? 5 : 9)).toFixed(2)}deg`);
    el.style.setProperty('--pt-mx', `${((x + 0.5) * 100).toFixed(1)}%`);
    el.style.setProperty('--pt-my', `${((y + 0.5) * 100).toFixed(1)}%`);
  };
  const onLeave = () => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty('--pt-rx', '0deg');
    el.style.setProperty('--pt-ry', '0deg');
  };

  const visit = () => {
    if (preview || !pt.website) return;
    onVisit?.(pt);
    openLink(pt.website);
  };
  const copy = async (event) => {
    event.stopPropagation();
    try { await navigator.clipboard.writeText(pt.code); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* clipboard blocked */ }
  };

  const background = artSrc(pt.background);
  const art = artSrc(pt.art);
  const logo = artSrc(pt.logo);

  return (
    <article
      ref={ref}
      className={`pt-card is-${size} pt-anim-${animation}${preview ? ' is-preview' : ''}`}
      style={style}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
    >
      <div className="pt-card-inner">
        {background && <img className="pt-bg" src={background} alt="" draggable="false" />}
        <div className="pt-shade" />
        <Motion animation={animation} />
        <div className="pt-glare" />
        {art && <img className="pt-art" src={art} alt="" draggable="false" />}

        <div className="pt-content">
          <div className="pt-id">
            <span className="pt-logo">{logo ? <img src={logo} alt="" draggable="false" /> : <Sparkles size={18} />}</span>
            <span className="pt-tier">{pt.tier === 'featured' ? 'Featured partner' : pt.tier === 'sponsor' ? 'Sponsor' : 'Partner'}</span>
          </div>
          <h3 className="pt-name">{pt.name || 'Partner name'}</h3>
          {pt.tagline && <p className="pt-tagline">{pt.tagline}</p>}
          {size === 'hero' && pt.description && <p className="pt-desc">{pt.description}</p>}
          {Array.isArray(pt.perks) && pt.perks.length > 0 && (
            <ul className="pt-perks">
              {pt.perks.slice(0, size === 'hero' ? 6 : 3).map((perk) => <li key={perk}>{perk}</li>)}
            </ul>
          )}
          <div className="pt-actions">
            <button type="button" className="pt-cta" onClick={visit} disabled={!pt.website}>
              <span>{pt.cta || 'Visit'}</span>
              <ArrowUpRight size={15} />
            </button>
            {pt.code && (
              <button type="button" className={`pt-code${copied ? ' is-copied' : ''}`} onClick={copy} title="Copy code">
                <span>Code</span>
                <strong>{pt.code}</strong>
                {copied ? <Check size={13} /> : <Copy size={13} />}
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
