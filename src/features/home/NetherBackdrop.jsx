import React, { useEffect, useRef, useState } from 'react';
import netherLoop from '../../assets/backgrounds/nether-loop.webm';
import netherPoster from '../../assets/backgrounds/nether-poster.jpg';

/* Seamless 20s animated Nether (rendered with Remotion, see the nether project). Stills only
   when the user asked for reduced motion; paused while the window is hidden to save GPU. */
const wantsStill = () =>
  document.documentElement.dataset.reducedMotion === 'true' ||
  window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

export default function NetherBackdrop() {
  const ref = useRef(null);
  const [still, setStill] = useState(wantsStill);

  useEffect(() => {
    const sync = () => setStill(wantsStill());
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduced-motion'] });
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    mq?.addEventListener?.('change', sync);
    return () => { mo.disconnect(); mq?.removeEventListener?.('change', sync); };
  }, []);

  useEffect(() => {
    const v = ref.current;
    if (!v) return undefined;
    const onVis = () => { if (document.hidden) v.pause(); else v.play().catch(() => {}); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [still]);

  if (still) return <img className="home-bg-img home-bg-nether" src={netherPoster} alt="" draggable="false" />;
  return (
    <video
      ref={ref}
      className="home-bg-img home-bg-nether"
      src={netherLoop}
      poster={netherPoster}
      autoPlay
      muted
      loop
      playsInline
      disablePictureInPicture
      aria-hidden="true"
    />
  );
}
