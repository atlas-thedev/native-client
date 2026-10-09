import React, { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import NativeIcon from '../../components/ui/NativeIcon.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import './SettingsPanels.css';

const PRIMARY_RELEASES_API =
  'https://api.github.com/repos/atlas-thedev/native-client-releases/releases?per_page=12';
const LEGACY_RELEASES_API =
  'https://api.github.com/repos/ohllama0909-alt/native-client/releases?per_page=12';

const CACHE_KEY = 'native.changelog.cache';
function readCache() {
  try {
    const value = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

function cleanVersion(tag) {
  return String(tag || '').replace(/^v/i, '');
}

function sanitizeHtml(dirtyHtml) {
  if (typeof DOMPurify?.sanitize === 'function') {
    return DOMPurify.sanitize(dirtyHtml);
  }
  if (typeof window !== 'undefined' && typeof DOMPurify === 'function') {
    try {
      return DOMPurify(window).sanitize(dirtyHtml);
    } catch {
      // fall through to plain text
    }
  }
  // Fail closed: without a sanitizer, show the notes as escaped text.
  return String(dirtyHtml)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Rich markdown renderer for GitHub changelogs and release notes */
function formatChangelogMarkdown(body) {
  let raw = String(body || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return '';
  // Normalize unicode bullets to standard markdown bullets
  raw = raw.replace(/^([ \t]*)•[ \t]+/gm, '$1- ');
  const parsed = marked.parse(raw, { gfm: true, breaks: true });
  return sanitizeHtml(parsed);
}

export default function ChangelogPanel({ onOpenUpdater }) {
  const { t, formatDate } = useI18n();
  const [releases, setReleases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);

  const currentVersion = window.native?.version || '';

  useEffect(() => {
    let cancelled = false;

    const fetchReleases = async () => {
      try {
        let res = await fetch(PRIMARY_RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
        let json = res.ok ? await res.json() : null;
        if (!Array.isArray(json) || json.length === 0) {
          const fallbackRes = await fetch(LEGACY_RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
          if (fallbackRes.ok) {
            const fallbackJson = await fallbackRes.json();
            if (Array.isArray(fallbackJson) && fallbackJson.length > 0) {
              json = fallbackJson;
            }
          }
        }
        if (cancelled) return;
        if (!json || !Array.isArray(json)) {
          const cached = readCache();
          if (cached.length) { setReleases(cached); setOpenId(cached[0]?.id ?? null); } else setError(t('changelog.error'));
          return;
        }
        const mapped = json
          .filter((entry) => !entry.draft)
          .map((entry) => ({
            id: entry.id,
            tag: entry.tag_name,
            version: cleanVersion(entry.tag_name),
            name: entry.name || entry.tag_name,
            date: entry.published_at || entry.created_at,
            prerelease: entry.prerelease,
            body: entry.body || '',
            url: entry.html_url
          }));
        setReleases(mapped);
        setOpenId(mapped[0]?.id ?? null);
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(mapped)); } catch { /* quota */ }
      } catch {
        // Offline: show the notes saved the last time we were online.
        const cached = readCache();
        if (cached.length) {
          if (!cancelled) { setReleases(cached); setOpenId(cached[0]?.id ?? null); }
        } else if (!cancelled) setError(t('changelog.error'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchReleases();

    return () => {
      cancelled = true;
    };
  }, []);

  const latest = releases[0] || null;
  const upToDate = useMemo(
    () => Boolean(latest && cleanVersion(latest.tag) === currentVersion),
    [latest, currentVersion]
  );

  const openExternal = (url) => {
    if (!url) return;
    if (window.native?.openExternal) {
      window.native.openExternal(url);
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  const handleBodyClick = (event) => {
    const anchor = event.target.closest('a');
    if (!anchor?.href) return;
    event.preventDefault();
    openExternal(anchor.href);
  };

  return (
    <div className="cl-panel">
      <div className={'cl-status ' + (upToDate ? 'ok' : 'update')}>
        <div className="cl-status-icon">
          <NativeIcon name={upToDate ? 'check-circle' : 'download'} size={18} />
        </div>

        <div className="cl-status-text">
          <span className="cl-status-title">
            {loading
              ? t('changelog.checking')
              : upToDate
                ? t('changelog.upToDate')
                : latest
                  ? t('changelog.available', { version: latest.version })
                  : t('changelog.notes')}
          </span>
          <span className="cl-status-sub">
            {currentVersion ? t('changelog.running', { version: currentVersion }) : t('changelog.localBuild')}
          </span>
        </div>

        <div className="cl-status-actions">
          {onOpenUpdater && (
            <button type="button" className="sp-ghost-btn" onClick={onOpenUpdater}>
              <NativeIcon name="refresh" size={13} />
              <span>{t('settings.checkUpdates')}</span>
            </button>
          )}
        </div>
      </div>

      {loading && <p className="sp-empty">{t('changelog.loading')}</p>}
      {!loading && error && <p className="sp-empty">{error}</p>}
      {!loading && !error && releases.length === 0 && (
        <p className="sp-empty">{t('changelog.noReleases')}</p>
      )}

      <div className="cl-timeline">
        {releases.map((release) => {
          const open = openId === release.id;
          const isCurrent = release.version === currentVersion;

          return (
            <article key={release.id} className={'cl-entry ' + (open ? 'open' : '')}>
              <button
                type="button"
                className="cl-entry-head"
                onClick={() => setOpenId(open ? null : release.id)}
              >
                <span className="cl-dot" />
                <span className="cl-entry-version">{release.version}</span>

                {release.prerelease && <span className="cl-tag beta">{t('changelog.beta')}</span>}
                {isCurrent && <span className="cl-tag current">{t('changelog.installed')}</span>}
                {release === latest && !isCurrent && <span className="cl-tag new">{t('changelog.latest')}</span>}

                <span className="cl-entry-title">{release.name}</span>
                <span className="sp-row-spacer" />
                <span className="cl-entry-date">
                  {release.date ? formatDate(new Date(release.date)) : ''}
                </span>
                <NativeIcon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
              </button>

              {open && (
                <div className="cl-entry-body">
                  {release.body ? (
                    <div
                      className="cl-markdown"
                      onClick={handleBodyClick}
                      dangerouslySetInnerHTML={{ __html: formatChangelogMarkdown(release.body) }}
                    />
                  ) : (
                    <p className="cl-body-text">{t('changelog.noNotes')}</p>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
