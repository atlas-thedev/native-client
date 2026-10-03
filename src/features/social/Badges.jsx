import React from 'react';
import developerBadge from '../../assets/badges/developer.png';
import earlySupporterBadge from '../../assets/badges/early-supporter.png';
import bugHunterBadge from '../../assets/badges/bug-hunter.png';
import staffBadge from '../../assets/badges/staff.png';
import './Badges.css';
import NoctraPlusIcon from '../../components/ui/NoctraPlusIcon.jsx';

/* Noctra+ badge: a gold pixel crown (inline so it works everywhere). */
const plusBadge = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect width="16" height="16" rx="4" fill="#ffd68c"/><path fill="#1a1306" d="M3 5h2v2h1V5h1V4h2v1h1v2h1V5h2v7H3z"/><path fill="#ffd68c" d="M5 10h6v1H5z"/></svg>')}`;

const badgeIcon = (src) => <img src={src} alt="" aria-hidden="true" draggable="false"/>;

export const BADGE_DEFS = {
  developer: {
    id: 'developer',
    name: 'Active Developer',
    description: 'Verified Noctra Core Developer',
    gradient: 'linear-gradient(135deg, #5865f2 0%, #3ba55d 100%)',
    icon: badgeIcon(developerBadge)
  },
  early_supporter: {
    id: 'early_supporter',
    name: 'Early Supporter',
    description: 'Supported Noctra Client in its earliest days',
    gradient: 'linear-gradient(135deg, #f47b67 0%, #faa61a 100%)',
    icon: badgeIcon(earlySupporterBadge)
  },
  bug_hunter: {
    id: 'bug_hunter',
    name: 'Bug Hunter',
    description: 'Found and reported crucial launcher bugs',
    gradient: 'linear-gradient(135deg, #3ba55d 0%, #57f287 100%)',
    icon: badgeIcon(bugHunterBadge)
  },
  staff: {
    id: 'staff',
    name: 'Noctra Staff',
    description: 'Official Noctra Client Staff Team',
    gradient: 'linear-gradient(135deg, #5865f2 0%, #eb459e 100%)',
    icon: badgeIcon(staffBadge)
  },
  plus: {
    id: 'plus',
    name: 'Noctra+',
    description: 'Noctra+ member',
    gradient: 'linear-gradient(135deg, #ffd68c 0%, #f5b94a 100%)',
    icon: badgeIcon(plusBadge)
  }
};

/** True when the server has granted the Noctra+ badge. */
export const isPlusUser = (user) => getUserBadges(user).includes('plus');

/** The Noctra+ mark shown next to members' names across Relay. */
export function PlusMark({ size = 14, className = '' }) {
  return <NoctraPlusIcon size={size} className={`noctra-plus-mark ${className}`.trim()} title="Noctra+ member" />;
}

/**
 * Returns badge IDs for a given user entity.
 * Badges are server-granted (admin panel); names never grant badges.
 */
export function getUserBadges(user) {
  // Badges come only from the server (granted in the admin panel). Never
  // award them by display name: anyone can register a lookalike name.
  const badgesSet = new Set();

  // Handle explicit badges from user data (array or JSON string)
  let rawBadges = user?.badges;
  if (typeof rawBadges === 'string') {
    try { rawBadges = JSON.parse(rawBadges); } catch { rawBadges = []; }
  }
  if (Array.isArray(rawBadges)) {
    for (const b of rawBadges) {
      if (BADGE_DEFS[b]) badgesSet.add(b);
    }
  }

  return Array.from(badgesSet);
}

export default function Badges({ user, size = 18, showEmpty = false }) {
  const badgeKeys = getUserBadges(user);
  if (!badgeKeys.length && !showEmpty) return null;

  return (
    <div className="noctra-badges-strip" role="group" aria-label="User Badges">
      {badgeKeys.map((key) => {
        const badge = BADGE_DEFS[key];
        if (!badge) return null;
        return (
          <div key={key} className="noctra-badge-item" title={`${badge.name} • ${badge.description}`}>
            <span className="noctra-badge-icon" style={{ width: size, height: size }}>
              {badge.icon}
            </span>
          </div>
        );
      })}
    </div>
  );
}
