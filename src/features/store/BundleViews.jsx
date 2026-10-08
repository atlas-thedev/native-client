import React, { useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight, Clock, Layers, Lock, Sparkles } from 'lucide-react';
import { OutfitShot } from '../../lib/wornShot.jsx';
import './BundleViews.css';

/*
 * Store bundles, in the style of an in-game shop bundle: a big stage with the whole look worn on your own skin,
 * a rarity colour, a countdown for limited bundles, the pieces in a row, and one price that beats buying them
 * one by one.
 */

export const RARITY = {
  rare: { label: 'Rare', color: '#3d8bff' },
  epic: { label: 'Epic', color: '#a45cff' },
  legendary: { label: 'Legendary', color: '#ffb020' },
  mythic: { label: 'Mythic', color: '#ff3d6e' }
};
export const bundleColor = (bundle) => bundle?.accent || RARITY[bundle?.rarity]?.color || RARITY.epic.color;
const SLOT_NAMES = { hats: 'Headwear', glasses: 'Glasses', back: 'Back', shoes: 'Shoes', hand: 'In hand' };
export const pieceType = (item) => (item?.kind === 'cosmetic' ? SLOT_NAMES[item.slot] || 'Cosmetic' : 'Cloak');
const money = (value) => `$${(Number(value) || 0).toFixed(2)}`;

/** Ticks once a second (once a minute when the end is days away). */
function useNow(endsAt) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!endsAt) return undefined;
    const left = endsAt - Date.now();
    if (left <= 0) return undefined;
    const timer = setInterval(() => setNow(Date.now()), left > 2 * 86400000 ? 60_000 : 1000);
    return () => clearInterval(timer);
  }, [endsAt]);
  return now;
}

/** "2d 05h" · "5h 12m" · "12m 07s" · null (no end) · 'Ended' */
export function timeLeft(endsAt, now = Date.now()) {
  if (!endsAt) return null;
  const ms = endsAt - now;
  if (ms <= 0) return 'Ended';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  if (d > 0) return `${d}d ${pad(h)}h`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  return `${m}m ${pad(s % 60)}s`;
}

export function Countdown({ endsAt, className = '' }) {
  const now = useNow(endsAt);
  const label = timeLeft(endsAt, now);
  if (!label) return null;
  const urgent = label !== 'Ended' && endsAt - now < 24 * 3600 * 1000;
  return (
    <span className={`bdl-timer${urgent ? ' is-urgent' : ''}${label === 'Ended' ? ' is-ended' : ''} ${className}`.trim()} title={new Date(endsAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}>
      <Clock size={11} strokeWidth={2.6} aria-hidden="true" />{label === 'Ended' ? 'Ended' : <>Ends in <b>{label}</b></>}
    </span>
  );
}

export function RarityTag({ bundle, children }) {
  return <span className="bdl-rarity" style={{ '--bc': bundleColor(bundle) }}><Sparkles size={10} strokeWidth={2.6} aria-hidden="true" />{children || `${RARITY[bundle.rarity]?.label || 'Epic'} bundle`}</span>;
}

/** Price block: crossed-out worth, the save tag and the bundle price (or what's left to pay for your missing pieces). */
export function BundlePrice({ bundle, mine, size = 'md' }) {
  const partial = mine && !mine.complete && mine.owned > 0 && mine.dueFull > 0 && mine.dueFull < bundle.fullPrice;
  const now = partial ? mine.due : bundle.price;
  const was = partial ? mine.dueFull : bundle.fullPrice;
  if (!bundle.paid) return <div className={`bdl-price is-${size}`}><strong>Free</strong></div>;
  return (
    <div className={`bdl-price is-${size}`}>
      {was > now && <s>{money(was)}</s>}
      <strong>{money(now)}</strong>
      {bundle.savePercent > 0 && <em>-{bundle.savePercent}%</em>}
    </div>
  );
}

/** Owned 3/5 bar. */
export function SetProgress({ mine, color }) {
  if (!mine) return null;
  const pct = mine.total ? Math.round((mine.owned / mine.total) * 100) : 0;
  return (
    <div className={`bdl-progress${mine.complete ? ' is-done' : ''}`} style={{ '--bc': color }}>
      <span>{mine.complete ? <><Check size={12} strokeWidth={3} />Complete set</> : <>You own <b>{mine.owned}</b> of {mine.total}</>}</span>
      <i><b style={{ width: `${pct}%` }} /></i>
    </div>
  );
}

/**
 * A bundle tile for grids and shelves: the whole look on the player's skin over the rarity colour
 * (or the bundle's own art), with name, piece count, price and countdown.
 */
export function BundleCard({ bundle, pieces, mine, outfit, onOpen, active = false, index = 0 }) {
  const color = bundleColor(bundle);
  const ended = bundle.phase === 'ended';
  return (
    <article
      className={`bdl-card${active ? ' is-active' : ''}${ended ? ' is-ended' : ''}${mine?.complete ? ' is-owned' : ''}`}
      style={{ '--bc': color, '--i': Math.min(index, 12) }}
      tabIndex={0}
      role="button"
      aria-label={`${bundle.name} bundle, ${pieces.length} items`}
      onClick={onOpen}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(); } }}
    >
      <div className="bdl-card-head">
        <div className="bdl-card-name">
          <strong>{bundle.name}</strong>
          <small>{bundle.tagline || `${pieces.length} items`}</small>
        </div>
        <RarityTag bundle={bundle}>{RARITY[bundle.rarity]?.label || 'Epic'}</RarityTag>
      </div>
      <div className="bdl-card-art">
        {bundle.artUrl ? <img className="bdl-card-bg" src={bundle.artUrl} alt="" draggable={false} /> : <span className="bdl-card-glow" aria-hidden="true" />}
        <OutfitShot {...outfit} className="bdl-card-shot" alt={`${bundle.name}: every piece worn`} />
        {bundle.isNew && !ended && <span className="bdl-new bdl-card-new">New</span>}
        {mine?.complete && <span className="bdl-card-owned"><Check size={11} strokeWidth={3} />Owned</span>}
      </div>
      <div className="bdl-card-meta">
        <small className="bdl-card-info"><Layers size={11} strokeWidth={2.4} aria-hidden="true" />{pieces.length} items{bundle.endsAt && !ended ? <> · <Countdown endsAt={bundle.endsAt} className="is-inline" /></> : null}</small>
        {ended ? <span className="bdl-card-ended">Ended</span> : <BundlePrice bundle={bundle} mine={mine} size="sm" />}
      </div>
    </article>
  );
}

/**
 * The bundles page: the picked bundle on a big stage (live 3D, the pieces in a row) next to what's inside and the
 * buy panel, then every bundle as a card.
 */
export function BundlesPage({
  bundles, selectedId, onSelect, piecesOf, mineOf, outfitOf, stage, renderPieceArt, renderActions, ownedIds, onOpenItem, signedIn
}) {
  const live = bundles.filter((b) => b.phase !== 'ended');
  const current = bundles.find((b) => b.id === selectedId) || live[0] || bundles[0] || null;
  const pieces = useMemo(() => (current ? piecesOf(current) : []), [current, piecesOf]);
  if (!current) {
    return (
      <div className="bdl-empty">
        <span><Layers size={20} /></span>
        <h2>No bundles right now</h2>
        <p>Bundles are full looks — a cloak, headwear, wings and more — for less than buying each piece. New ones drop here.</p>
      </div>
    );
  }
  const color = bundleColor(current);
  const mine = mineOf(current);
  const ended = current.phase === 'ended';
  return (
    <div className="bdl-page" style={{ '--bc': color }}>
      <section className="bdl-hero" key={`hero:${current.id}`} aria-label={`${current.name} bundle`}>
        <div className="bdl-stage">
          {current.artUrl ? <img className="bdl-stage-art" src={current.artUrl} alt="" draggable={false} /> : null}
          <span className="bdl-stage-rays" aria-hidden="true" />
          <span className="bdl-stage-floor" aria-hidden="true" />
          <div className="bdl-stage-model">{stage(current)}</div>
          <div className="bdl-stage-top">
            <RarityTag bundle={current} />
            {current.isNew && !ended && <span className="bdl-new">New</span>}
            <span className="bdl-stage-spacer" />
            {current.endsAt && <Countdown endsAt={current.endsAt} />}
          </div>
          <div className="bdl-stage-title">
            <h2>{current.name}</h2>
            {current.tagline && <p>{current.tagline}</p>}
          </div>
        </div>
        <div className="bdl-panel">
          <span className="bdl-kicker"><Layers size={12} strokeWidth={2.4} />Bundle · {pieces.length} items</span>
          <h3 className="bdl-panel-name">{current.name}</h3>
          {current.description && <p className="bdl-panel-desc">{current.description}</p>}
          <ul className="bdl-list">
            {pieces.map((item) => {
              const have = signedIn && ownedIds.has(item.id);
              return (
                <li key={item.id}>
                  <button type="button" className={`bdl-row${have ? ' is-owned' : ''}`} onClick={() => onOpenItem(item.id)}>
                    <span className="bdl-row-art">{renderPieceArt(item, 'bdl-row-img', `row:${current.id}`)}</span>
                    <span className="bdl-row-text"><strong>{item.name}</strong><small>{pieceType(item)}</small></span>
                    <span className="bdl-row-end">{have ? <span className="bdl-row-own"><Check size={11} strokeWidth={3} />Owned</span> : item.exclusive ? 'Event' : item.paid ? <s>{money(item.salePrice ?? item.price)}</s> : 'Free'}</span>
                    <ChevronRight size={14} className="bdl-row-go" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="bdl-buy">
            {ended ? (
              <div className="bdl-ended-note"><Lock size={14} />This bundle has ended. Pieces you got stay in your locker.</div>
            ) : (
              <>
                <div className="bdl-buy-top">
                  <BundlePrice bundle={current} mine={mine} size="lg" />
                  {current.paid && current.fullPrice > current.price && !(mine?.complete) && <span className="bdl-save">You save {money((mine && mine.owned && mine.dueFull < current.fullPrice ? mine.dueFull - mine.due : current.fullPrice - current.price))}</span>}
                </div>
                {signedIn && <SetProgress mine={mine} color={color} />}
              </>
            )}
            <div className="bdl-actions">{renderActions(current)}</div>
            {!ended && current.paid && signedIn && mine && mine.owned > 0 && !mine.complete && <p className="bdl-fine">Pieces you already own are left out of the price.</p>}
          </div>
        </div>
      </section>

      {bundles.length > 1 && (
        <section className="bdl-more" aria-label="All bundles">
          <div className="store-cat-head"><strong>All bundles</strong><span className="bdl-more-n">{bundles.length}</span></div>
          <div className="bdl-grid">
            {bundles.map((bundle, index) => (
              <BundleCard key={bundle.id} index={index} bundle={bundle} pieces={piecesOf(bundle)} mine={mineOf(bundle)} outfit={outfitOf(bundle)} active={bundle.id === current.id} onOpen={() => onSelect(bundle.id)} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** "Bundles" shelf at the top of the store's All view. */
export function BundleShelf({ bundles, piecesOf, mineOf, outfitOf, onOpen, onViewAll }) {
  const shown = bundles.filter((b) => b.phase !== 'ended').slice(0, 4);
  if (!shown.length) return null;
  return (
    <section className="store-cat-shelf bdl-shelf" aria-label="Bundles">
      <div className="store-cat-head">
        <strong>Bundles</strong>
        <span className="bdl-shelf-sub">Full looks for less</span>
        {bundles.length > 0 && <button type="button" className="store-cat-more" onClick={onViewAll}>View all<ChevronRight size={13} /></button>}
      </div>
      <div className="bdl-grid">
        {shown.map((bundle, index) => <BundleCard key={bundle.id} index={index} bundle={bundle} pieces={piecesOf(bundle)} mine={mineOf(bundle)} outfit={outfitOf(bundle)} onOpen={() => onOpen(bundle.id)} />)}
      </div>
    </section>
  );
}
