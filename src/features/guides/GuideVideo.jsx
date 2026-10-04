import React, { useEffect, useRef, useState } from 'react';
import { Play, RotateCcw, VideoOff, WifiOff } from 'lucide-react';
import { formatDuration } from './guides.js';
import './GuideVideoStates.css';

const LOAD_TIMEOUT_MS = 15000;

/** Why a video failed: no connection at all, a missing file (404), or something else. */
async function classifyFailure(src) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  try {
    const response = await fetch(src, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(6000) });
    return response.status === 404 || response.status === 403 ? 'missing' : 'failed';
  } catch {
    // CORS can hide the status. Any answer to a no-cors request still proves the server is reachable.
    try {
      await fetch(src, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(6000) });
      return 'missing';
    } catch {
      return 'offline';
    }
  }
}

/**
 * Streams a how-to video from the Native server. Shows the poster with a play
 * button until started, then the native player; chapters seek the video.
 */
export default function GuideVideo({ video, title, autoPlay = false, compact = false }) {
  const ref = useRef(null);
  const [started, setStarted] = useState(autoPlay);
  const [failed, setFailed] = useState(null); // null | 'offline' | 'missing' | 'failed'
  const [ready, setReady] = useState(false);
  const [posterReady, setPosterReady] = useState(!video?.poster);
  const [current, setCurrent] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [duration, setDuration] = useState(video?.duration || null);
  const [posterBroken, setPosterBroken] = useState(false);

  useEffect(() => {
    setStarted(autoPlay);
    setFailed(null);
    setReady(false);
    setCurrent(0);
    setDuration(video?.duration || null);
    setPosterBroken(false);
  }, [video?.src, video?.poster, autoPlay]);

  /* Poster: show a skeleton until it has loaded. */
  useEffect(() => {
    if (!video?.poster) { setPosterReady(true); return undefined; }
    setPosterReady(false);
    const image = new Image();
    image.onload = () => setPosterReady(true);
    image.onerror = () => setPosterReady(true);
    image.src = video.poster;
    return () => { image.onload = null; image.onerror = null; };
  }, [video?.poster, attempt]);

  const fail = async () => {
    const kind = await classifyFailure(video.src);
    setFailed(kind);
  };

  /* Slow server: stop showing a skeleton forever. */
  useEffect(() => {
    if (!video?.src || ready || failed) return undefined;
    const timer = window.setTimeout(fail, LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [video?.src, ready, failed, attempt]);

  /* Back online: try again on its own. */
  useEffect(() => {
    if (failed !== 'offline') return undefined;
    const retry = () => { setFailed(null); setAttempt((value) => value + 1); };
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [failed]);

  if (!video) return null;
  if (video.pending) {
    return (
      <div className={`guide-video${compact ? ' is-compact' : ''}`}>
        <div className="guide-video-frame is-pending" aria-busy="true" />
      </div>
    );
  }

  // Guides that share one long walkthrough start at their own chapter.
  const startAt = Number(video.start) > 0 ? Number(video.start) : 0;
  const play = () => {
    setStarted(true);
    setFailed(null);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      if (startAt && el.currentTime < 0.5) el.currentTime = startAt;
      el.play?.().catch(() => {});
    });
  };

  const seek = (seconds) => {
    if (!ref.current) return;
    if (!started) setStarted(true);
    ref.current.currentTime = seconds;
    ref.current.play?.().catch(() => {});
  };

  const chapters = video.chapters || [];
  const activeChapter = chapters.reduce((active, chapter, index) => (current + 0.25 >= chapter.t ? index : active), -1);
  const length = formatDuration(duration);

  return (
    <div className={`guide-video${compact ? ' is-compact' : ''}`}>
      <div className={`guide-video-frame${started ? ' is-started' : ''}`}>
        {!failed && !(ready || posterReady) && <div className="guide-video-skeleton" aria-hidden="true" />}
        {failed ? (
          <div className="guide-video-error" role="status">
            {failed === 'missing' ? (
              <VideoOff size={22} strokeWidth={1.8} aria-hidden="true" />
            ) : (
              <WifiOff size={22} strokeWidth={1.8} aria-hidden="true" />
            )}
            {failed === 'missing' && <span className="guide-video-404">404</span>}
            <strong>
              {failed === 'offline' ? 'No connection' : failed === 'missing' ? 'Video not found' : 'Video unavailable'}
            </strong>
            <span>
              {failed === 'offline'
                ? 'Connect to the internet to watch this video. It will retry on its own.'
                : failed === 'missing'
                  ? 'This video has not been uploaded yet. The written steps still work.'
                  : 'Something went wrong while loading it. Try again.'}
            </span>
            <button type="button" onClick={() => { setFailed(null); setReady(false); setAttempt((value) => value + 1); setStarted(true); }}>
              <RotateCcw size={13} aria-hidden="true" /> Retry
            </button>
          </div>
        ) : (
          <video
            key={`${video.src}#${attempt}`}
            ref={ref}
            src={video.src}
            poster={video.poster}
            controls={started}
            preload="metadata"
            playsInline
            autoPlay={autoPlay}
            onLoadedData={() => setReady(true)}
            onLoadedMetadata={(event) => {
              setReady(true);
              setDuration(event.currentTarget.duration || null);
              // Seeking before playback replaces the poster with a video frame, so
              // only jump to the guide's chapter once the user has pressed play.
              if (started && startAt && event.currentTarget.currentTime < 0.5) event.currentTarget.currentTime = startAt;
            }}
            onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
            onPlay={() => setStarted(true)}
            onError={fail}
            aria-label={title ? `Video: ${title}` : 'How-to video'}
          >
            {video.captions && <track kind="captions" src={video.captions} srcLang="en" label="English" default />}
          </video>
        )}
        {!started && !failed && (ready || posterReady) && (
          <button type="button" className="guide-video-play" onClick={play} aria-label={title ? `Play: ${title}` : 'Play video'}>
            {video.poster && !posterBroken && (
              <img className="guide-video-poster" src={video.poster} alt="" draggable={false} onError={() => setPosterBroken(true)} />
            )}
            <span className="guide-video-play-btn"><Play size={20} fill="currentColor" strokeWidth={0} /></span>
            {length && <span className="guide-video-length">{length}</span>}
          </button>
        )}
      </div>
      {chapters.length > 0 && !compact && (
        <ol className="guide-chapters" aria-label="Chapters">
          {chapters.map((chapter, index) => (
            <li key={`${chapter.t}-${chapter.label}`}>
              <button
                type="button"
                className={index === activeChapter && started ? 'is-active' : ''}
                onClick={() => seek(chapter.t)}
              >
                <span className="guide-chapter-time">{formatDuration(chapter.t) || '0:00'}</span>
                <span className="guide-chapter-label">{chapter.label}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
