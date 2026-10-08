import React, { useEffect, useRef, useState } from 'react';
import netherLoop from '../../assets/backgrounds/nether-loop.webm';
import netherAnim from '../../assets/backgrounds/nether-anim.webp';
import netherPoster from '../../assets/backgrounds/nether-poster.jpg';

/* Seamless 20s animated Nether (rendered with Remotion, see tools/nether-bg).
   Primary: a muted looping <video> (WebM) - decoded on the GPU, so it stays smooth.
   The old animated WebP was decoded frame-by-frame on the CPU (300 frames, 7 MB) and made Home laggy;
   it is now only a fallback for PCs where the video can't start. The still poster shows underneath
   until something is ready, and the video pauses while the window is hidden. */
export default function NetherBackdrop() {
  const videoRef = useRef(null);
  const [mode, setMode] = useState('video'); // 'video' | 'webp'
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (mode !== 'video') return undefined;
    const video = videoRef.current;
    if (!video) return undefined;
    const fallback = () => { setReady(false); setMode('webp'); };
    // If playback never starts (blocked autoplay / no decoder), switch to the WebP.
    const timer = setTimeout(() => { if (video.paused || video.readyState < 2) fallback(); }, 4000);
    const tryPlay = () => { const p = video.play(); if (p && p.catch) p.catch(fallback); };
    const onVisibility = () => { if (document.hidden) video.pause(); else tryPlay(); };
    tryPlay();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [mode]);

  return (
    <>
      <img className="home-bg-img home-bg-nether" src={netherPoster} alt="" draggable="false" aria-hidden="true" />
      {mode === 'video' ? (
        <video
          ref={videoRef}
          className={`home-bg-img home-bg-nether is-anim${ready ? ' is-ready' : ''}`}
          src={netherLoop}
          poster={netherPoster}
          muted
          loop
          autoPlay
          playsInline
          preload="auto"
          disablePictureInPicture
          aria-hidden="true"
          onPlaying={() => setReady(true)}
          onError={() => { setReady(false); setMode('webp'); }}
        />
      ) : (
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
