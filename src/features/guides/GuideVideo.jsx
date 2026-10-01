import React, { useEffect, useRef, useState } from 'react';
import { Play, RotateCcw, WifiOff } from 'lucide-react';
import { formatDuration } from './guides.js';

/**
 * Streams a how-to video from the Noctra server. Shows the poster with a play
 * button until started, then the native player; chapters seek the video.
 */
export default function GuideVideo({ video, title, autoPlay = false, compact = false }) {
  const ref = useRef(null);
  const [started, setStarted] = useState(autoPlay);
  const [failed, setFailed] = useState(false);
  const [current, setCurrent] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [duration, setDuration] = useState(video?.duration || null);

  useEffect(() => {
    setStarted(autoPlay);
    setFailed(false);
    setCurrent(0);
    setDuration(video?.duration || null);
  }, [video?.src, autoPlay]);

  if (!video) return null;

  // Guides that share one long walkthrough start at their own chapter.
  const startAt = Number(video.start) > 0 ? Number(video.start) : 0;
  const play = () => {
    setStarted(true);
    setFailed(false);
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
        {failed ? (
          <div className="guide-video-error" role="status">
            <WifiOff size={22} strokeWidth={1.8} aria-hidden="true" />
            <strong>Video unavailable</strong>
            <span>Check your connection and try again.</span>
            <button type="button" onClick={() => { setFailed(false); setAttempt((value) => value + 1); setStarted(true); }}>
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
            onLoadedMetadata={(event) => {
              setDuration(event.currentTarget.duration || null);
              if (startAt && event.currentTarget.currentTime < 0.5) event.currentTarget.currentTime = startAt;
            }}
            onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
            onPlay={() => setStarted(true)}
            onError={() => setFailed(true)}
            aria-label={title ? `Video: ${title}` : 'How-to video'}
          >
            {video.captions && <track kind="captions" src={video.captions} srcLang="en" label="English" default />}
          </video>
        )}
        {!started && !failed && (
          <button type="button" className="guide-video-play" onClick={play} aria-label={title ? `Play: ${title}` : 'Play video'}>
            <span className="guide-video-play-btn"><Play size={22} fill="currentColor" strokeWidth={0} /></span>
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
