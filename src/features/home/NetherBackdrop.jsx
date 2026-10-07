import React, { useState } from 'react';
import netherAnim from '../../assets/backgrounds/nether-anim.webp';
import netherPoster from '../../assets/backgrounds/nether-poster.jpg';

/* Seamless 20s animated Nether (rendered with Remotion, see tools/nether-bg), shipped as an
   animated WebP: an image keeps animating where a <video> may not start (GPU video decode,
   autoplay and power-saving rules differ per Windows PC). It always plays; the still poster
   underneath only shows until the animation has loaded. */
export default function NetherBackdrop() {
  const [ready, setReady] = useState(false);
  return (
    <>
      <img className="home-bg-img home-bg-nether" src={netherPoster} alt="" draggable="false" aria-hidden="true" />
      <img
        className={`home-bg-img home-bg-nether is-anim${ready ? ' is-ready' : ''}`}
        src={netherAnim}
        alt=""
        draggable="false"
        decoding="async"
        aria-hidden="true"
        onLoad={() => setReady(true)}
      />
    </>
  );
}
