import React, { useEffect, useRef, useState } from 'react';
import netherLoop from '../../assets/backgrounds/nether-loop.webm';
import netherPoster from '../../assets/backgrounds/nether-poster.jpg';

/* Seamless 20s animated Nether (rendered with Remotion, see tools/nether-bg). Only the launcher's
   own Animations switch (Settings > Appearance) turns it into a still: the Windows "animation
   effects" setting is off on many PCs and must not freeze the home screen. Paused while hidden. */
const wantsStill = () => document.documentElement.dataset.motion === 'reduced';

export default function NetherBackdrop() {
  const ref = useRef(null);
  const [still, setStill] = useState(wantsStill);

  useEffect(() => {
    const mo = new MutationObserver(() => setStill(wantsStill()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    const v = ref.current;
    if (!v) return undefined;
    v.muted = true; // autoplay needs it set as a property too
    const play = () => { if (!document.hidden) v.play().catch(() => {}); };
    const onVis = () => (document.hidden ? v.pause() : play());
    play();
    v.addEventListener('canplay', play);
    v.addEventListener('pause', () => { if (!document.hidden) setTimeout(play, 400); });
    window.addEventListener('focus', play);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      v.removeEventListener('canplay', play);
      window.removeEventListener('focus', play);
      document.removeEventListener('visibilitychange', onVis);
    };
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
      preload="auto"
      disablePictureInPicture
      aria-hidden="true"
    />
  );
}
