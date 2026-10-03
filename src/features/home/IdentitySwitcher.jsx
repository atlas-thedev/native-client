import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import PlayerAvatar from '../../components/ui/PlayerAvatar.jsx';
import './IdentitySwitcher.css';

export function PlusTag({ className = '' }) {
  return <span className={`plus-tag ${className}`} title="Noctra+">N<b>+</b></span>;
}

const OPTIONS = [
  { id: 'premium', label: 'Premium', hint: 'Microsoft account · online servers' },
  { id: 'noctra', label: 'Noctra', hint: 'Noctra profile · Noctra skins & capes' }
];

/** The home greeting name doubles as a switch between a linked premium and Noctra identity. */
export default function IdentitySwitcher({ identity, isPlus = false, disabled = false, onSwitch }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const current = identity[identity.mode] || identity.premium;
  const currentOption = OPTIONS.find((option) => option.id === identity.mode) || OPTIONS[0];

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
        title={disabled ? 'Stop the game to switch identity' : 'Switch between your premium and Noctra name'}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="home-greeting-name idsw-name">{current?.name || 'Player'}</span>
        <span className={`idsw-mode is-${identity.mode}`}>{currentOption.label}</span>
        {isPlus && <PlusTag />}
        <ChevronDown size={16} className="idsw-chev" aria-hidden="true" />
      </button>

      {open && (
        <div className="idsw-menu" role="menu">
          <div className="idsw-menu-title">Play as</div>
          {OPTIONS.map((option) => {
            const entry = identity[option.id];
            const active = option.id === identity.mode;
            return (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={`idsw-item ${active ? 'is-active' : ''}`}
                onClick={() => pick(option.id)}
              >
                <PlayerAvatar account={entry?.account} name={entry?.name} size={34} radius={8} className="idsw-head" />
                <span className="idsw-item-text">
                  <span className="idsw-item-name">
                    {entry?.name || option.label}
                    <span className={`idsw-mode is-${option.id}`}>{option.label}</span>
                  </span>
                  <small>{option.hint}</small>
                </span>
                {active && <Check size={16} className="idsw-check" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
