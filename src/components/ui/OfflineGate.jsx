import React from 'react';
import { WifiOff } from 'lucide-react';
import mascotImg from '../../assets/native-account-required.png';
import './NativeAccountGate.css';

const COPY = {
  locker: ['Locker is locked', 'Connect to the internet to use your Locker.'],
  relay: ['Relay is locked', 'Connect to the internet to chat with friends.'],
  discover: ['Discover is locked', 'Connect to the internet to browse mods, modpacks and shaders.'],
  store: ['Store is locked', 'Connect to the internet to browse the Store.']
};

export default function OfflineGate({ feature = 'store', onRetry, onBackHome }) {
  const [title, subtitle] = COPY[feature] || COPY.store;
  return (
    <div className="native-account-gate" role="region" aria-label="No internet connection">
      <div className="gate-content">
        <img src={mascotImg} alt="" className="gate-mascot" draggable="false" width={182} height={193} />
        <h2 className="gate-title">{title}</h2>
        <p className="gate-subtitle">
          <WifiOff size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} aria-hidden="true" />
          {subtitle} It unlocks by itself once you are back online.
        </p>
        <div className="gate-actions">
          {onRetry && <button type="button" className="gate-btn-signin" onClick={onRetry}>Try again</button>}
          {onBackHome && <button type="button" className="gate-btn-home" onClick={onBackHome}>Back to Home</button>}
        </div>
      </div>
    </div>
  );
}
