import React, { useEffect, useRef, useState } from 'react';
import './Honeycomb.css';

/**
 * Hex grid + light sweep (+ optional glow that follows the mouse), drawn behind its parent.
 * Everything moves with transform / opacity only, so it stays on the compositor; paused while the window is hidden or blurred.
 */
export default function Honeycomb({ className = '', glow = false, testId = 'honeycomb-bg' }) {
  const rootRef = useRef(null);
  const blobRef = useRef(null);
  const [awake, setAwake] = useState(() => !document.hidden && document.hasFocus());

  useEffect(() => {
    const update = () => setAwake(!document.hidden && document.hasFocus());
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  useEffect(() => {
    const host = rootRef.current?.parentElement;
    const blob = blobRef.current;
    if (!glow || !host || !blob) return undefined;
    let frame = 0;
    let x = 0;
    let y = 0;
    const paint = () => {
      frame = 0;
      blob.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    };
    const move = (event) => {
      const box = rootRef.current.getBoundingClientRect();
      x = event.clientX - box.left;
      y = event.clientY - box.top;
      blob.classList.add('is-on');
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const leave = () => blob.classList.remove('is-on');
    host.addEventListener('pointermove', move, { passive: true });
    host.addEventListener('pointerleave', leave);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerleave', leave);
    };
  }, [glow]);

  return (
    <div ref={rootRef} className={`honeycomb ${className}${awake ? '' : ' is-paused'}`} aria-hidden="true" data-testid={testId}>
      <div className="honeycomb-grid" />
      <div className="honeycomb-light">
        <span className="honeycomb-sweep" />
        {glow && <span ref={blobRef} className="honeycomb-glow" />}
      </div>
    </div>
  );
}
