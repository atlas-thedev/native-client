import React, { useEffect, useRef, useState } from 'react';
import { Gamepad2, Phone } from 'lucide-react';
import './CallInGameButton.css';

const SHOW_MS = 4200;

/**
 * Voice calls live in game (Relay in Minecraft), not in the launcher. The call button says so, with a little
 * animation, instead of starting a call nobody could hear.
 */
export default function CallInGameButton({ name, group = false }) {
  const [open, setOpen] = useState(false);
  const [nonce, setNonce] = useState(0); // replays the animation on every click
  const wrap = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(() => setOpen(false), SHOW_MS);
    const away = (event) => { if (!wrap.current?.contains(event.target)) setOpen(false); };
    const esc = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open, nonce]);

  const who = group ? 'this group' : name || 'your friend';
  return (
    <span className="cig" ref={wrap}>
      <button
        type="button"
        className={`relay-action-btn cig-btn${open ? ' is-ringing' : ''}`}
        data-testid="relay-call-btn"
        onClick={() => { setOpen(true); setNonce((n) => n + 1); }}
        title={group ? 'Start a group call' : 'Start a voice call'}
        aria-expanded={open}
      >
        <Phone key={nonce} size={16} className="cig-phone" />
      </button>
      {open && (
        <div key={nonce} className="cig-pop" role="status">
          <span className="cig-art" aria-hidden="true">
            <i className="cig-ring" /><i className="cig-ring is-late" />
            <Gamepad2 size={20} />
          </span>
          <span className="cig-text">
            <strong>Calls work in game</strong>
            <span>Open Relay in Minecraft with <kbd>Y</kbd> and press the phone to call {who}.</span>
          </span>
          <i className="cig-timer" style={{ animationDuration: `${SHOW_MS}ms` }} aria-hidden="true" />
        </div>
      )}
    </span>
  );
}
