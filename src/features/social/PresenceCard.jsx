import React, { useEffect, useMemo, useState } from 'react';
import { Copy, Check, Globe2, Play, Users } from 'lucide-react';
import { serverName, useServerStatus } from '../home/HomeSidePanel.jsx';
import vanillaIcon from '../../assets/icons/vanilla.png';
import './PresenceCard.css';

const numberFormat = new Intl.NumberFormat();

/** "In-game: Hypixel" + serverAddress -> what the friend is doing. */
export function readActivity(user = {}) {
  const status = String(user.status || 'offline').toLowerCase();
  const raw = String(user.activity || '').trim();
  const label = raw.replace(/^in-game:\s*/i, '').trim();
  const address = user.serverAddress || null;
  if (status !== 'in-game' && status !== 'in-menus') return { kind: status === 'offline' ? 'offline' : 'launcher' };
  if (address) return { kind: 'server', address, label: label && !/^(multiplayer|server)$/i.test(label) ? label : serverName(address) };
  if (/^singleplayer$/i.test(label)) return { kind: 'singleplayer', label: 'Singleplayer world' };
  if (/^realms$/i.test(label)) return { kind: 'realms', label: 'Minecraft Realms' };
  if (/^menus?$/i.test(label) || status === 'in-menus') return { kind: 'menus', label: 'In the menus' };
  return { kind: 'playing', label: label || 'Minecraft' };
}

/** Short one-liner for chat headers and lists: "Playing on Hypixel". */
export function activityLine(user = {}) {
  const a = readActivity(user);
  switch (a.kind) {
    case 'server': return `Playing on ${a.label}`;
    case 'singleplayer': return 'Playing singleplayer';
    case 'realms': return 'Playing on Realms';
    case 'menus': return 'Playing Minecraft · menus';
    case 'playing': return a.label === 'Minecraft' ? 'Playing Minecraft' : `Playing ${a.label}`;
    default: return null;
  }
}

function ServerIcon({ src, name }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (src && !broken) return <img className="pc-icon" src={src} alt="" draggable={false} onError={() => setBroken(true)} />;
  return <span className="pc-icon is-letter" aria-hidden="true">{String(name || '?').trim().charAt(0).toUpperCase()}</span>;
}

/**
 * Rich presence, like Discord's "Playing" card: for a server, its icon, name, address and live player
 * count with a Join button; for other states, what the friend is doing in Minecraft.
 */
export default function PresenceCard({ user, onJoin, compact = false }) {
  const activity = readActivity(user);
  const addresses = useMemo(() => (activity.kind === 'server' ? [activity.address] : []), [activity.kind, activity.address]);
  const live = useServerStatus(addresses)[activity.address];
  const [copied, setCopied] = useState(false);

  if (activity.kind === 'offline' || activity.kind === 'launcher') return null;

  const copy = () => {
    navigator.clipboard?.writeText(activity.address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1300); }).catch(() => {});
  };

  if (activity.kind !== 'server') {
    return (
      <div className={`pc-card is-${activity.kind}${compact ? ' is-compact' : ''}`}>
        <span className="pc-kicker">Playing Minecraft</span>
        <div className="pc-row">
          <img className="pc-icon" src={vanillaIcon} alt="" draggable={false} />
          <div className="pc-text">
            <strong>{activity.label}</strong>
            <span>{activity.kind === 'menus' ? 'Picking a world or server' : activity.kind === 'realms' ? 'On a Realm' : activity.kind === 'singleplayer' ? 'Playing on their own' : 'In game'}</span>
          </div>
        </div>
      </div>
    );
  }

  const online = live?.online;
  const players = live?.players;
  const shownAddress = String(activity.address).replace(/:25565$/, '');
  return (
    <div className={`pc-card is-server${compact ? ' is-compact' : ''}`}>
      <span className="pc-kicker">Playing on a server</span>
      <div className="pc-row">
        <ServerIcon src={live?.favicon} name={activity.label} />
        <div className="pc-text">
          <strong title={activity.label}>{activity.label}</strong>
          <button type="button" className="pc-address" onClick={copy} title="Copy address">
            <Globe2 size={11} /><span>{shownAddress}</span>{copied ? <Check size={11} /> : <Copy size={11} className="pc-copy" />}
          </button>
          <span className={`pc-players${online ? ' is-online' : online === false ? ' is-offline' : ''}`}>
            <i aria-hidden="true" />
            {online
              ? <><Users size={11} />{numberFormat.format(players?.online ?? 0)}{players?.max ? ` / ${numberFormat.format(players.max)}` : ''} online</>
              : online === false && !live?.stale ? 'Server not reachable' : 'Checking…'}
          </span>
        </div>
      </div>
      {onJoin && (
        <button type="button" className="pc-join" onClick={() => onJoin(user)} data-testid="presence-join">
          <Play size={13} fill="currentColor" />Join server
        </button>
      )}
    </div>
  );
}

/** One line for friend lists: server icon, "Playing on Hypixel" and the live player count. */
export function PresenceInline({ user }) {
  const activity = readActivity(user);
  const addresses = useMemo(() => (activity.kind === 'server' ? [activity.address] : []), [activity.kind, activity.address]);
  const live = useServerStatus(addresses)[activity.address];
  const line = activityLine(user);
  if (!line) return null;
  return (
    <span className="pc-inline">
      {activity.kind === 'server'
        ? (live?.favicon ? <img src={live.favicon} alt="" className="pc-inline-icon" draggable={false} /> : <span className="pc-inline-icon is-letter">{activity.label.charAt(0).toUpperCase()}</span>)
        : <img src={vanillaIcon} alt="" className="pc-inline-icon" draggable={false} />}
      <span className="pc-inline-text">{line}</span>
      {activity.kind === 'server' && live?.online && <span className="pc-inline-players"><i />{numberFormat.format(live.players?.online ?? 0)} online</span>}
    </span>
  );
}
