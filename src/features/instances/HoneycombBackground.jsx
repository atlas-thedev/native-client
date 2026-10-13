import React, { useEffect, useState } from 'react';

/** Static hex grid + one light sweep moved by transform only (compositor, no repaints); paused while the window is hidden or blurred. */
export default function HoneycombBackground() {
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

  return (
    <div className={`instances-honeycomb${awake ? '' : ' is-paused'}`} aria-hidden="true" data-testid="instances-honeycomb-bg">
      <div className="instances-honeycomb-grid" />
      <div className="instances-honeycomb-light">
        <span className="instances-honeycomb-sweep" />
      </div>
    </div>
  );
}
