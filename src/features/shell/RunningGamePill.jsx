import React, { useEffect, useRef, useState } from 'react';
import { Square } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import './RunningGamePill.css';

function clock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/**
 * Titlebar indicator for a running game: a live dot, the instance name and an
 * uptime clock. Click for the instance and a stop button.
 */
export default function RunningGamePill({ game, onStop, onOpen }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const rootRef = useRef(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => { if (!rootRef.current?.contains(event.target)) setOpen(false); };
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => { if (!game) setOpen(false); }, [game]);

  if (!game) return null;
  const uptime = clock(now - (game.since || now));

  return (
    <div className="running-game" ref={rootRef}>
      <button
        type="button"
        className={`running-game-pill${open ? ' is-open' : ''}`}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('game.running')}
      >
        <i className="running-game-dot" aria-hidden="true" />
        <span className="running-game-name">{game.name}</span>
        <span className="running-game-time">{uptime}</span>
      </button>
      {open && (
        <div className="running-game-menu" role="dialog" aria-label={t('game.running')}>
          <div className="running-game-head">
            <strong>{game.name}</strong>
            <span>{[game.version, game.loader && game.loader !== 'Vanilla' ? game.loader : null].filter(Boolean).join(' \u00b7 ')}</span>
          </div>
          <div className="running-game-row"><span>{t('game.status')}</span><b>{t('game.running')}</b></div>
          <div className="running-game-row"><span>{t('game.uptime')}</span><b>{uptime}</b></div>
          <div className="running-game-actions">
            {onOpen && <button type="button" onClick={() => { setOpen(false); onOpen(); }}>{t('game.openInstance')}</button>}
            <button type="button" className="is-danger" onClick={() => { setOpen(false); onStop?.(); }}>
              <Square size={10} fill="currentColor" /> {t('game.stop')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
