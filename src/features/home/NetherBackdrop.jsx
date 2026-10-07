import React, { useEffect, useState } from 'react';
import netherAnim from '../../assets/backgrounds/nether-anim.webp';
import netherPoster from '../../assets/backgrounds/nether-poster.jpg';

/* Seamless 20s animated Nether (rendered with Remotion, see tools/nether-bg), shipped as an
   animated WebP. An image keeps animating where a <video> may not start (GPU video decode,
   autoplay and power-saving rules differ per Windows PC). Only the launcher's own Animations
   switch (Settings > Appearance) shows the still poster instead. */
const wantsStill = () => document.documentElement.dataset.motion === 'reduced';

export default function NetherBackdrop() {
  const [still, setStill] = useState(wantsStill);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const mo = new MutationObserver(() => setStill(wantsStill()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
    return () => mo.disconnect();
  }, []);

  return (
    <>
      <img className="home-bg-img home-bg-nether" src={netherPoster} alt="" draggable="false" aria-hidden="true" />
      {!still && (
        <img
          className={`home-bg-img home-bg-nether is-anim${ready ? ' is-ready' : ''}`}
          src={netherAnim}
          alt=""
          draggable="false"
          decoding="async"
          aria-hidden="true"
          onLoad={() => setReady(true)}
        />
      )}
    </>
  );
}
