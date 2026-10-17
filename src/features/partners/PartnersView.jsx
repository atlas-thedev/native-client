import React, { useCallback, useEffect, useState } from 'react';
import { Mail, RefreshCw } from 'lucide-react';
import Honeycomb from '../../components/ui/Honeycomb.jsx';
import PartnerCard, { BUILT_IN_PARTNERS } from './PartnerCard.jsx';
import './Partners.css';

const PARTNER_PAGE = 'https://playnative.net/partners#become-a-partner';
const CACHE_KEY = 'native.partners.cache.v1';
const CACHE_TTL = 10 * 60_000;

let memoryCache = null;

function readCachedPartners() {
  if (memoryCache && Array.isArray(memoryCache.partners)) return memoryCache;
  try {
    const raw = JSON.parse(window?.localStorage?.getItem?.(CACHE_KEY) || 'null');
    if (raw && Array.isArray(raw.partners)) {
      memoryCache = { partners: raw.partners, offline: false, at: Number(raw.at) || 0 };
      return memoryCache;
    }
  } catch { /* storage unavailable */ }
  return null;
}

function writeCachedPartners(partners, offline = false) {
  const entry = { partners, offline: Boolean(offline), at: Date.now() };
  memoryCache = entry;
  try {
    window?.localStorage?.setItem?.(CACHE_KEY, JSON.stringify({ partners, at: entry.at }));
  } catch { /* storage unavailable */ }
}

export function invalidatePartnersCache() {
  memoryCache = null;
  try { window?.localStorage?.removeItem?.(CACHE_KEY); } catch { /* ignore */ }
}

/** Brands Native works with. The list (and each card's motion) is edited in Admin → Partners. */
export default function PartnersView() {
  const cached = readCachedPartners();
  const [partners, setPartners] = useState(() => cached?.partners ?? BUILT_IN_PARTNERS);
  const [offline, setOffline] = useState(() => Boolean(cached?.offline));
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (force = false) => {
    const result = await window.native?.partners?.list?.({ force }).catch(() => null);
    const list = Array.isArray(result?.partners) ? result.partners : null;
    const isOffline = !result?.ok;
    const next = list ?? readCachedPartners()?.partners ?? BUILT_IN_PARTNERS;
    if (list) writeCachedPartners(list, isOffline);
    setOffline(isOffline);
    setPartners(next);
  }, []);

  useEffect(() => {
    const current = readCachedPartners();
    if (current && Date.now() - current.at < CACHE_TTL) return;
    load(false);
  }, [load]);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await load(true); } finally { setRefreshing(false); }
  };

  const featured = (partners || []).filter((pt) => pt.tier === 'featured');
  const rest = (partners || []).filter((pt) => pt.tier !== 'featured');

  return (
    <div className="pt-view">
      <Honeycomb glow testId="partners-honeycomb-bg" />
      <header className="pt-header">
        <div className="pt-heading">
          <h1 className="page-title">Partners</h1>
          <p className="pt-subtitle">
            The people who help keep Native running.{offline ? ' Showing the last list we saved.' : ''}
          </p>
        </div>
        <button type="button" className={`pt-refresh${refreshing ? ' is-busy' : ''}`} onClick={refresh} disabled={refreshing}>
          <RefreshCw size={14} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      <div className="pt-body">
        {partners && partners.length === 0 && <p className="pt-note">No partners right now. Check back soon.</p>}

        {featured.map((pt, index) => (
          <div key={pt.id} className="pt-enter" style={{ '--i': index }}>
            <PartnerCard partner={pt} size="hero" />
          </div>
        ))}

        {rest.length > 0 && (
          <>
            <span className="pt-section-label">More partners</span>
            <div className="pt-grid">
              {rest.map((pt, index) => (
                <div key={pt.id} className="pt-enter" style={{ '--i': featured.length + index }}>
                  <PartnerCard partner={pt} />
                </div>
              ))}
            </div>
          </>
        )}

        <div className="pt-pitch pt-enter" style={{ '--i': (partners || []).length }}>
          <div>
            <strong>Want to partner with Native?</strong>
            <span>Hosting, servers, creators and brands: we'd love to hear from you.</span>
          </div>
          <button type="button" className="pt-refresh" onClick={() => window.native?.openExternal?.(PARTNER_PAGE)}>
            <Mail size={14} />
            Get in touch
          </button>
        </div>
      </div>
    </div>
  );
}
