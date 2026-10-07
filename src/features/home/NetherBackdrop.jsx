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
    const onPause = () => { if (!document.hidden) setTimeout(play, 400); };
    // some Windows builds stop at the end instead of looping: start over by hand
    const onEnded = () => { v.currentTime = 0; play(); };
    // watchdog: if the picture stops moving while visible, nudge it, then reload the source
    let last = -1, stuck = 0;
    const watch = setInterval(() => {
      if (document.hidden) return;
      if (v.currentTime !== last) { last = v.currentTime; stuck = 0; return; }
      stuck += 1;
      if (stuck === 1) play();
      else if (stuck === 3) { v.load(); play(); }
      else if (stuck > 3 && stuck % 5 === 0) { v.currentTime = 0; play(); }
    }, 1500);
    play();
    v.addEventListener('canplay', play);
    v.addEventListener('loadeddata', play);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onEnded);
    window.addEventListener('focus', play);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(watch);
      v.removeEventListener('canplay', play);
      v.removeEventListener('loadeddata', play);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onEnded);
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
