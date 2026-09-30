import React from 'react';
import mascotImg from '../../assets/noctra-account-required.png';
import './NoctraAccountGate.css';

const COPY = {
  locker: {
    label: 'Locker',
    subtitle: 'Sign in with a Noctra account to customize your skins and capes.'
  },
  relay: {
    label: 'Relay',
    subtitle: 'Sign in with a Noctra account to chat with friends.'
  },
  profile: {
    label: 'Profile',
    subtitle: 'Sign in with a Noctra account to customize your public profile.'
  }
};

export default function NoctraAccountGate({ feature = 'locker', onOpenAccountSwitcher, onBackHome }) {
  const copy = COPY[feature] || COPY.profile;

  return (
    <div className="noctra-account-gate" role="region" aria-label="Noctra account required">
      <section className="gate-card">
        <div className="gate-body">
          <span className="gate-label">{copy.label}</span>
          <h2 className="gate-title">Noctra account required</h2>
          <p className="gate-subtitle">{copy.subtitle}</p>

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

        <div className="gate-art" aria-hidden="true">
          <img src={mascotImg} alt="" className="gate-mascot" draggable="false" width={182} height={193} />
        </div>
      </section>
    </div>
  );
}
