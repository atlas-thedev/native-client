import React, { useState } from 'react';
import { Users } from 'lucide-react';
import { safeMediaUrl } from './safeMedia.js';
import './relay-groups.css';

/**
 * Clean, modern group avatar.
 * Displays the custom icon image if present; otherwise renders a sleek monogram
 * with the group's initials or a crisp Users icon on the theme brand background.
 * Never renders pixelated Steve heads.
 */
export function GroupAvatarBadge({ group, name, iconUrl, size = 36, className = '' }) {
  const [broken, setBroken] = useState(null);
  // Only Native-uploaded images; a group icon must not fetch third-party URLs.
  const requestedIcon = safeMediaUrl(iconUrl !== undefined ? iconUrl : group?.iconUrl);
  // A dead image URL falls back to initials instead of an empty square.
  const effectiveIcon = requestedIcon && broken !== requestedIcon ? requestedIcon : null;
  const effectiveName = (name !== undefined ? name : (group?.name || group?.nickname || '')).trim();

  if (effectiveIcon) {
    return (
      <div className={`relay-group-avatar-badge ${className}`} style={{ width: size, height: size }}>
        <img src={effectiveIcon} alt="" referrerPolicy="no-referrer" onError={() => setBroken(requestedIcon)} />
      </div>
    );
  }

  const words = effectiveName ? effectiveName.split(/\s+/) : [];
  let initials = '';
  if (words.length >= 2) {
    initials = (words[0][0] + words[1][0]).toUpperCase();
  } else if (words.length === 1 && words[0].length >= 2) {
    initials = words[0].slice(0, 2).toUpperCase();
  } else if (words.length === 1 && words[0].length === 1) {
    initials = words[0].toUpperCase();
  }

  const hue = [...effectiveName].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 360;
  const fontSize = Math.max(10, Math.round(size * 0.38));
  const iconSize = Math.max(14, Math.round(size * 0.48));

  return (
    <div
      className={`relay-group-avatar-badge ${className}`}
      style={{ width: size, height: size, fontSize, '--gb-hue': hue }}
      title={effectiveName || 'Group'}
      aria-label={effectiveName || 'Group'}
    >
      {initials ? <span>{initials}</span> : <Users size={iconSize} />}
    </div>
  );
}

export default GroupAvatarBadge;
