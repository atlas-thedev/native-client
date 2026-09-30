import React from 'react';
import mascotImg from '../../assets/noctra-account-required.png';
import './NoctraAccountGate.css';

const SUBTITLE = {
  locker: 'Sign in with a Noctra account to customize your skins and capes.',
  relay: 'Sign in with a Noctra account to chat with friends.',
  profile: 'Sign in with a Noctra account to customize your public profile.'
};

export default function NoctraAccountGate({ feature = 'locker', onOpenAccountSwitcher, onBackHome }) {
  return (
    <div className="noctra-account-gate" role="region" aria-label="Noctra account required">
      <div className="gate-content">
        <img src={mascotImg} alt="" className="gate-mascot" draggable="false" width={182} height={193} />
        <h2 className="gate-title">Noctra account required</h2>
        <p className="gate-subtitle">{SUBTITLE[feature] || SUBTITLE.profile}</p>
        <div className="gate-actions">
          <button type="button" className="gate-btn-signin" onClick={onOpenAccountSwitcher}>
            Sign in
          </button>
          {onBackHome && (
            <button type="button" className="gate-btn-home" onClick={onBackHome}>
              Back to Home
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
