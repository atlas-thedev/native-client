import React, { useEffect, useState } from 'react';
import NativeIcon from '../../components/ui/NativeIcon.jsx';
import { adPlayerShot, lastAdPlayerShot } from '../../lib/adPlayerShot.js';
import './AdCard.css';

/* Small sponsored card on Home (Feather-style). Ads come from the Native backend; the main
   process downloads each banner once and serves it from disk afterwards (electron/ads.js). */

const ROTATE_MS = 12_000;
const HIDE_KEY = 'native.home.hiddenAds.v1';
const HIDE_FOR = 3 * 86_400_000;

const openExternal = (url) =>
  window.native?.openExternal ? window.native.openExternal(url) : window.open(url, '_blank', 'noopener');

function hiddenAds() {
  try {
    const map = JSON.parse(localStorage.getItem(HIDE_KEY) || '{}');
    const now = Date.now();
    return Object.fromEntries(Object.entries(map).filter(([, until]) => until > now));
  } catch {
    return {};
  }
}

/* Older feeds only have url + cta; newer ones carry up to two buttons (link / join server). */
function buttonsOf(ad) {
  if (Array.isArray(ad.buttons)) return ad.buttons.slice(0, 2);
  return ad.cta ? [{ label: ad.cta, action: 'url', value: ad.url }] : [];
}

export default function AdCard({ account = null, onJoinServer = null }) {
  const [ads, setAds] = useState(null);
  const [hidden, setHidden] = useState(hiddenAds);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = window.native?.ads?.list;
    if (!load) { setAds([]); return undefined; }
    load()
      .then((result) => !cancelled && setAds(Array.isArray(result?.ads) ? result.ads : []))
      .catch(() => !cancelled && setAds([]));
    return () => { cancelled = true; };
  }, []);

  const visible = (ads || []).filter((ad) => !hidden[ad.id]);
  const count = visible.length;

  // "Player" ads draw the signed-in player's own skin into the banner.
  const wantsPlayer = visible.some((ad) => ad.player);
  const [playerShot, setPlayerShot] = useState(lastAdPlayerShot);
  const accountKey = account ? `${account.id || account.uuid || account.name}|${account.skinUrl || ''}` : '';
  useEffect(() => {
    if (!wantsPlayer) return undefined;
    let cancelled = false;
    adPlayerShot(account).then((url) => { if (!cancelled && url) setPlayerShot(url); });
    return () => { cancelled = true; };
  }, [wantsPlayer, accountKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The in-game title screen shows the same card; it reads this picture from disk.
  useEffect(() => {
    if (playerShot) window.native?.ads?.savePlayer?.(playerShot)?.catch?.(() => {});
  }, [playerShot]);

  useEffect(() => {
    if (count < 2 || paused) return undefined;
    const timer = setInterval(() => setIndex((value) => (value + 1) % count), ROTATE_MS);
    return () => clearInterval(timer);
  }, [count, paused]);

  if (!count) return null;
  const ad = visible[index % count];

  const buttons = buttonsOf(ad);
  const primary = buttons[0] || (ad.url ? { action: 'url', value: ad.url } : null);
  const run = (button) => {
    if (!button) return;
    if (button.action === 'server') onJoinServer?.(button.value);
    else openExternal(button.value);
  };

  const hide = (event) => {
    event.stopPropagation();
    const next = { ...hiddenAds(), [ad.id]: Date.now() + HIDE_FOR };
    try { localStorage.setItem(HIDE_KEY, JSON.stringify(next)); } catch { /* not remembered */ }
    setHidden(next);
    setIndex(0);
  };

  return (
    <section
      className="ad-card"
      aria-label="Sponsored"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div
        className="ad-hit"
        role="link"
        tabIndex={0}
        onClick={() => run(primary)}
        onKeyDown={(event) => { if (event.key === 'Enter') run(primary); }}
        title={primary?.action === 'server' ? `Join ${primary.value}` : (primary?.value || ad.url)}
      >
        <span className="ad-media">
          <img key={ad.id} className="ad-img" src={ad.image} alt={ad.title} draggable={false} />
          {ad.player && playerShot && <img key={`p:${ad.id}`} className="ad-player" src={playerShot} alt="" draggable={false} />}
        </span>
        {(ad.title || buttons.length > 0) && (
          <span className="ad-foot">
            <span className="ad-text">
              <span className="ad-tag">{ad.tag ? `Ad · ${ad.tag}` : 'Ad'}</span>
              <span className="ad-title">{ad.title}</span>
              {ad.body && <span className="ad-body">{ad.body}</span>}
            </span>
            {buttons.length > 0 && (
              <span className="ad-actions">
                {buttons.map((button, i) => (
                  <button
                    key={`${button.action}:${button.value}`}
                    type="button"
                    className={`ad-cta${i > 0 ? ' is-ghost' : ''}`}
                    onClick={(event) => { event.stopPropagation(); run(button); }}
                    title={button.action === 'server' ? `Join ${button.value}` : button.value}
                  >
                    {button.action === 'server' && <NativeIcon name="play" size={11} />}
                    {button.label}
                    {button.action !== 'server' && <NativeIcon name="arrow-up-right" size={13} />}
                  </button>
                ))}
              </span>
            )}
          </span>
        )}
      </div>
      <button type="button" className="ad-close" onClick={hide} title="Hide this ad for 3 days" aria-label="Hide ad">
        <NativeIcon name="close" size={12} />
      </button>
      {count > 1 && (
        <span className="ad-dots" role="tablist" aria-label="Ads">
          {visible.map((item, i) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={i === index % count}
              className={`ad-dot${i === index % count ? ' is-active' : ''}`}
              onClick={() => setIndex(i)}
            />
          ))}
        </span>
      )}
    </section>
  );
}
