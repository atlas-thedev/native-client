import NativePlusIcon from '../../components/ui/NativePlusIcon.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import PlayerAvatar from '../../components/ui/PlayerAvatar.jsx';
import ProviderLogo from '../../components/ui/ProviderLogo.jsx';
import './IdentitySwitcher.css';

export function PlusTag({ className = '', size = 18 }) {
  return <NativePlusIcon size={size} className={`plus-tag ${className}`.trim()} title="Native+" />;
}

/** The home greeting name doubles as a switch between a linked premium and Native identity. */
export default function IdentitySwitcher({ identity, isPlus = false, disabled = false, onSwitch }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const current = identity[identity.mode] || identity.premium;

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => { if (!rootRef.current?.contains(event.target)) setOpen(false); };
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const pick = (mode) => {
    setOpen(false);
    if (mode !== identity.mode) onSwitch?.(mode);
  };

  return (
    <div className={`idsw ${open ? 'is-open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="idsw-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="idsw-name">{current?.name || 'Player'}</span>
        <span className="idsw-pair" aria-label={identity.mode === 'premium' ? 'Playing as Microsoft account' : 'Playing as Native account'}>
          <span className={`idsw-pair-seg ${identity.mode === 'premium' ? 'is-on' : ''}`}><ProviderLogo kind="premium" size={13} /></span>
          <span className={`idsw-pair-seg ${identity.mode === 'native' ? 'is-on' : ''}`}><ProviderLogo kind="native" size={13} /></span>
        </span>
        {isPlus && <PlusTag />}
        <ChevronDown size={16} className="idsw-chev" aria-hidden="true" />
      </button>

      {open && (
        <div className="idsw-menu" role="menu">
          {['premium', 'native'].map((id) => {
            const entry = identity[id];
            const active = id === identity.mode;
            return (
              <button
                key={id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={`idsw-item ${active ? 'is-active' : ''}`}
                onClick={() => pick(id)}
              >
                <PlayerAvatar account={entry?.account} name={entry?.name} size={28} radius={6} className="idsw-head" />
                <span className="idsw-item-text">
                  <span className="idsw-item-name">{entry?.name}</span>
                  <small>{id === 'premium' ? 'Microsoft account' : 'Native account'}</small>
                </span>
                <ProviderLogo kind={id} size={13} />
                <span className="idsw-check">{active && <Check size={15} aria-hidden="true" />}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
