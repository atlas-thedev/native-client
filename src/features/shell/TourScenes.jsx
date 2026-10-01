import React from 'react';
import {
  Boxes, Check, Compass, Download, Gamepad2, Home, Layers, MessagesSquare, Play,
  Settings, Shirt, UserRound, Users
} from 'lucide-react';
import Logo from '../../components/ui/Logo.jsx';

/*
 * Motion vignettes for the quick tour. Each one is a tiny, looping
 * illustration of what the highlighted part of the launcher does. They are
 * pure CSS/SVG (no images, no libraries), drawn with the theme tokens, and
 * collapse to a still frame when reduced motion is on.
 */

const ICON = { size: 15, strokeWidth: 1.75 };

function WelcomeScene() {
  const orbit = [Boxes, Compass, Shirt, MessagesSquare];
  return (
    <div className="ts ts-welcome" aria-hidden="true">
      <span className="ts-ring ts-ring-1" />
      <span className="ts-ring ts-ring-2" />
      <span className="ts-ring ts-ring-3" />
      <div className="ts-orbit">
        {orbit.map((Icon, index) => (
          <span key={index} className="ts-orbit-node" style={{ '--i': index }}>
            <span className="ts-orbit-icon"><Icon {...ICON} /></span>
          </span>
        ))}
      </div>
      <span className="ts-welcome-mark"><Logo height={34} variant="mark" /></span>
    </div>
  );
}

function NavScene() {
  const icons = [Home, Layers, Compass, Shirt, MessagesSquare];
  return (
    <div className="ts ts-nav" aria-hidden="true">
      <div className="ts-rail">
        <span className="ts-rail-plate" />
        <span className="ts-rail-bar" />
        {icons.map((Icon, index) => (
          <span key={index} className="ts-rail-icon" style={{ '--i': index }}><Icon {...ICON} /></span>
        ))}
      </div>
      <div className="ts-nav-pages">
        {['Home', 'Instances', 'Discover', 'Locker', 'Relay'].map((label, index) => (
          <span key={label} className="ts-nav-page" style={{ '--i': index }}>
            <span className="ts-label">{label}</span>
            <span className="ts-line w-70" />
            <span className="ts-line w-45" />
          </span>
        ))}
      </div>
    </div>
  );
}

function InstancesScene() {
  const cards = [
    { name: 'Survival', meta: 'Fabric 1.21.4' },
    { name: 'Modded', meta: 'NeoForge 1.21.1' },
    { name: 'PvP', meta: 'Vanilla 1.8.9' }
  ];
  return (
    <div className="ts ts-instances" aria-hidden="true">
      {cards.map((card, index) => (
        <div key={card.name} className="ts-inst" style={{ '--i': index }}>
          <span className="ts-inst-art"><Boxes {...ICON} /></span>
          <span className="ts-inst-text">
            <b>{card.name}</b>
            <small>{card.meta}</small>
          </span>
        </div>
      ))}
      <div className="ts-inst ts-inst-new" style={{ '--i': 3 }}>
        <span className="ts-plus">+</span>
        <span className="ts-inst-text"><b>New instance</b></span>
      </div>
    </div>
  );
}

function VersionsScene() {
  const versions = ['1.8.9', '1.12.2', '1.16.5', '1.20.4', '1.21.4', '25w14a', '1.21.4', '1.20.4'];
  return (
    <div className="ts ts-versions" aria-hidden="true">
      <div className="ts-ticker">
        {[...versions, ...versions].map((version, index) => (
          <span key={index} className="ts-chip">{version}</span>
        ))}
      </div>
      <span className="ts-select-frame"><span className="ts-label">Latest release</span></span>
    </div>
  );
}

function DiscoverScene() {
  return (
    <div className="ts ts-discover" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <span key={index} className={`ts-tile${index === 4 ? ' is-installing' : ''}`} style={{ '--i': index }}>
          <span className="ts-tile-art" />
          <span className="ts-line w-70" />
          <span className="ts-line w-45" />
          {index === 4 && (
            <span className="ts-tile-install">
              <span className="ts-tile-bar"><i /></span>
              <span className="ts-tile-check"><Check size={11} strokeWidth={2.5} /></span>
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

function HomeScene() {
  return (
    <div className="ts ts-home" aria-hidden="true">
      <div className="ts-launch">
        <span className="ts-launch-fill" />
        <span className="ts-launch-label is-ready"><Play size={14} strokeWidth={2.25} fill="currentColor" /> LAUNCH</span>
        <span className="ts-launch-label is-downloading"><Download size={13} strokeWidth={2} /> Fetching game files…</span>
        <span className="ts-launch-label is-running"><Gamepad2 size={14} strokeWidth={2} /> Running</span>
      </div>
      <div className="ts-launch-meta">
        <span className="ts-mono">fabric-loader-0.16.10.jar</span>
        <span className="ts-mono ts-tabular">1.21.4</span>
      </div>
    </div>
  );
}

function LockerScene() {
  return (
    <div className="ts ts-locker" aria-hidden="true">
      <div className="ts-stage">
        <div className="ts-cube">
          <span className="ts-face f-front"><i className="eye l" /><i className="eye r" /></span>
          <span className="ts-face f-back" />
          <span className="ts-face f-left" />
          <span className="ts-face f-right" />
          <span className="ts-face f-top" />
          <span className="ts-face f-bottom" />
        </div>
        <span className="ts-shadow" />
      </div>
      <div className="ts-locker-swatches">
        {[0, 1, 2].map((index) => <span key={index} className="ts-swatch" style={{ '--i': index }} />)}
      </div>
    </div>
  );
}

function RelayScene() {
  return (
    <div className="ts ts-relay" aria-hidden="true">
      <div className="ts-friend">
        <span className="ts-avatar"><UserRound {...ICON} /><i className="ts-presence" /></span>
        <span className="ts-friend-text"><b>Alex</b><small>In-game: Singleplayer</small></span>
      </div>
      <div className="ts-chat">
        <span className="ts-bubble is-them" style={{ '--i': 0 }}>Join my world?</span>
        <span className="ts-bubble is-me" style={{ '--i': 1 }}>On my way</span>
        <span className="ts-bubble is-them is-typing" style={{ '--i': 2 }}><i /><i /><i /></span>
      </div>
    </div>
  );
}

function AccountsScene() {
  return (
    <div className="ts ts-accounts" aria-hidden="true">
      <div className="ts-acct-track">
        <span className="ts-acct is-a"><UserRound {...ICON} /><span><b>Steve</b><small>Microsoft</small></span></span>
        <span className="ts-acct is-b"><Users {...ICON} /><span><b>Alex</b><small>Noctra</small></span></span>
      </div>
      <span className="ts-acct-switch"><span className="ts-label">Active</span></span>
    </div>
  );
}

function SettingsScene() {
  return (
    <div className="ts ts-settings" aria-hidden="true">
      <div className="ts-set-row">
        <span className="ts-label">Memory</span>
        <span className="ts-badge ts-tabular">
          <span className="v v1">4 GB</span><span className="v v2">6 GB</span><span className="v v3">8 GB</span>
          <span className="of"> / 16 GB</span>
        </span>
      </div>
      <div className="ts-slider"><span className="ts-slider-fill" /><span className="ts-slider-thumb" /></div>
      <div className="ts-set-row">
        <span className="ts-label">Auto-update</span>
        <span className="ts-toggle"><i /></span>
      </div>
      <span className="ts-gear"><Settings size={44} strokeWidth={1.25} /></span>
    </div>
  );
}

function DoneScene() {
  return (
    <div className="ts ts-done" aria-hidden="true">
      <svg className="ts-check" viewBox="0 0 64 64" width="64" height="64">
        <circle className="ts-check-ring" cx="32" cy="32" r="28" />
        <path className="ts-check-tick" d="M20 33 L28.5 41 L44 24" />
      </svg>
      {Array.from({ length: 12 }, (_, index) => (
        <span key={index} className="ts-spark" style={{ '--i': index }} />
      ))}
    </div>
  );
}

const SCENES = {
  welcome: WelcomeScene,
  nav: NavScene,
  instances: InstancesScene,
  versions: VersionsScene,
  discover: DiscoverScene,
  home: HomeScene,
  locker: LockerScene,
  relay: RelayScene,
  accounts: AccountsScene,
  settings: SettingsScene,
  done: DoneScene
};

export default function TourScene({ name }) {
  const Scene = SCENES[name];
  return Scene ? <Scene /> : null;
}

export const SCENE_NAMES = Object.keys(SCENES);
