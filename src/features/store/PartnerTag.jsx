import React from 'react';

/** "Aurex" with the partner's logo: marks a Store item made with a Native partner. */
export default function PartnerTag({ partner, large = false }) {
  if (!partner?.name) return null;
  const short = partner.name.replace(/\s+(hosting|host|network|studios?)$/i, '');
  return (
    <span className={`store-partner-tag${large ? ' is-large' : ''}`} style={{ '--partner': partner.accent || '#8b5cf6' }} title={`Made with ${partner.name}, a Native partner`}>
      {partner.logo && <img src={partner.logo} alt="" draggable="false" />}
      <span>{large ? `${short} × Native` : short}</span>
    </span>
  );
}
