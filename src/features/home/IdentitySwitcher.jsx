import NoctraPlusIcon from '../../components/ui/NoctraPlusIcon.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import PlayerAvatar from '../../components/ui/PlayerAvatar.jsx';
import Logo from '../../components/ui/Logo.jsx';
import './IdentitySwitcher.css';

export function PlusTag({ className = '', size = 18 }) {
  return <NoctraPlusIcon size={size} className={`plus-tag ${className}`.trim()} title="Noctra+" />;
}

function MicrosoftLogo({ size = 14 }) {
  const s = size / 2 - 0.75;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <rect x="0" y="0" width={s} height={s} fill="#f25022" />
      <rect x={size - s} y="0" width={s} height={s} fill="#7fba00" />
      <rect x="0" y={size - s} width={s} height={s} fill="#00a4ef" />
      <rect x={size - s} y={size - s} width={s} height={s} fill="#ffb900" />
    </svg>
  );
}

function IdentityLogo({ id, size = 14 }) {
  return (
    <span className={`idsw-logo is-${id}`} title={id === 'premium' ? 'Microsoft' : 'Noctra'}>
      {id === 'premium' ? <MicrosoftLogo size={size} /> : <Logo height={size + 3} variant="mark" />}
    </span>
  );
}

/** The home greeting name doubles as a switch between a linked premium and Noctra identity. */
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
        <IdentityLogo id={identity.mode} size={15} />
        {isPlus && <PlusTag />}
        <ChevronDown size={16} className="idsw-chev" aria-hidden="true" />
      </button>

      {open && (
        <div className="idsw-menu" role="menu">
          {['premium', 'noctra'].map((id) => {
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
                <span className="idsw-item-name">{entry?.name}</span>
                <IdentityLogo id={id} size={13} />
                <span className="idsw-check">{active && <Check size={15} aria-hidden="true" />}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
