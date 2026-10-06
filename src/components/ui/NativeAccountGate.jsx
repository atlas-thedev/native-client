import React from 'react';
import mascotImg from '../../assets/native-account-required.png';
import './NativeAccountGate.css';

const SUBTITLE = {
  locker: 'Sign in with a Native account to customize your skins and capes.',
  relay: 'Sign in with a Native account to chat with friends.',
  profile: 'Sign in with a Native account to customize your public profile.'
};

const PREMIUM_SUBTITLE = {
  relay: 'Your Microsoft account is your Native account, but we couldn’t sign it in just now. Check your connection and try again.'
};

export default function NativeAccountGate({ feature = 'locker', premium = false, onConnectPremium, onOpenAccountSwitcher, onBackHome }) {
  const canConnect = premium && onConnectPremium && PREMIUM_SUBTITLE[feature];
  return (
    <div className="native-account-gate" role="region" aria-label="Native account required">
      <div className="gate-content">
        <img src={mascotImg} alt="" className="gate-mascot" draggable="false" width={182} height={193} />
        <h2 className="gate-title">{canConnect ? 'Signing in to Native' : 'Native account required'}</h2>
        <p className="gate-subtitle">{canConnect ? PREMIUM_SUBTITLE[feature] : (SUBTITLE[feature] || SUBTITLE.profile)}</p>
        <div className="gate-actions">
          {canConnect ? (
            <button type="button" className="gate-btn-signin" onClick={onConnectPremium}>
              Try again
            </button>
          ) : (
            <button type="button" className="gate-btn-signin" onClick={onOpenAccountSwitcher}>
              Sign in
            </button>
          )}
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
