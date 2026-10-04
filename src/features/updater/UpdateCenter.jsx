import { useEffect, useMemo, useRef } from 'react';
import DOMPurify from 'dompurify';
import { AlertCircle, ArrowRight, CheckCircle2, Download, RefreshCw, X } from 'lucide-react';
import { marked } from 'marked';
import './UpdateCenter.css';
import { useI18n } from '../../i18n/I18nProvider.jsx';

const BUSY_TYPES = new Set(['checking', 'preparing', 'downloading', 'installing']);

export default function UpdateCenter({ open, onClose, status, onCheck, onDownload, onCancel, onInstall }) {
  const { t } = useI18n();
  const checkedForOpen = useRef(false);

  useEffect(() => {
    if (!open) {
      checkedForOpen.current = false;
      return;
    }
    if (!checkedForOpen.current && status.type === 'idle') {
      checkedForOpen.current = true;
      onCheck?.();
    }
  }, [open, status.type, onCheck]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const notesHtml = useMemo(() => renderReleaseNotes(status.releaseNotes), [status.releaseNotes]);
  if (!open) return null;

  const percent = Math.round(status.percent ?? 0);
  const busy = BUSY_TYPES.has(status.type);
  const currentVersion = status.currentVersion ?? window.native?.version ?? '—';

  const openExternalLink = (event) => {
    const anchor = event.target.closest('a');
    if (!anchor?.href) return;
    event.preventDefault();
    window.native?.openExternal(anchor.href);
  };

  return (
    <div className="uc-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="update-center" role="dialog" aria-modal="true" aria-labelledby="uc-title">
        <header className="uc-head">
          <span className={`uc-head-icon is-${status.type}`} aria-hidden="true">
            {headIcon(status.type)}
          </span>
          <div className="uc-head-text">
            <h2 className="uc-title" id="uc-title">{headline(status, percent, t)}</h2>
            <p className="uc-subtitle">{subline(status, t)}</p>
          </div>
          <button type="button" className="uc-close" onClick={onClose} aria-label={t('update.close')} title={t('update.close')}>
            <X size={16} />
          </button>
        </header>

        <div className="uc-body">
          {['idle', 'checking', 'not-available', 'disabled', 'preparing', 'installing'].includes(status.type) && (
            <div className={`uc-status-card is-${status.type}`}>
              <div className="uc-status-visual" aria-hidden="true">
                <span className="uc-status-orbit" />
                <span className="uc-status-dot" />
              </div>
              <div className="uc-status-copy">
                <strong>{statusLabel(status, t)}</strong>
                <span>{statusDetail(status, currentVersion, t)}</span>
              </div>
            </div>
          )}

          {(status.type === 'available' || status.type === 'downloaded') && (
            <div className="uc-version-card">
              <div className="uc-version-column">
                <span>{t('update.currentVersion', { version: '' }).replace(/[:\s]+$/, '')}</span>
                <strong>v{currentVersion}</strong>
              </div>
              <span className="uc-version-sep" aria-hidden="true"><ArrowRight size={16} /></span>
              <div className="uc-version-column is-new">
                <span>{status.type === 'downloaded' ? 'Ready to install' : 'Available version'}</span>
                <strong>v{status.version ?? '—'}</strong>
              </div>
            </div>
          )}

          {status.type === 'downloading' && (
            <div className="uc-download">
              <div className="uc-download-top">
                <span>{status.optimized ? t('update.optimizedPatch') : t('update.package')}</span>
                <strong>{percent}%</strong>
              </div>
              <div
                className="uc-progress"
                role="progressbar"
                aria-valuenow={percent}
                aria-valuemin="0"
                aria-valuemax="100"
              >
                <div className="uc-progress-fill" style={{ width: `${percent}%` }} />
              </div>
              <div className="uc-download-meta">
                <span>{formatBytes(status.transferred)} / {formatBytes(status.total)}</span>
                <span>{formatSpeed(status.bytesPerSecond)}</span>
                <span>{getEta(status.total, status.transferred, status.bytesPerSecond, t)}</span>
              </div>
            </div>
          )}

          {(status.type === 'available' || status.type === 'downloaded') && (
            <section className="uc-notes">
              <h3 className="uc-notes-title">{t('update.whatsNew')}</h3>
              {notesHtml ? (
                <div
                  className="uc-notes-content"
                  onClick={openExternalLink}
                  dangerouslySetInnerHTML={{ __html: notesHtml }}
                />
              ) : (
                <p className="uc-notes-empty">{t('update.defaultNotes')}</p>
              )}
            </section>
          )}

          {status.type === 'error' && (
            <p className="uc-error">{status.message || t('update.couldNotComplete')}</p>
          )}
        </div>

        <footer className="uc-footer">
          <span className="uc-footer-version">{t('update.currentVersion', { version: currentVersion })}</span>

          <div className="uc-actions">
            {status.type === 'available' && (
              <>
                <button type="button" className="uc-btn" onClick={onClose}>{t('update.later')}</button>
                <button type="button" className="uc-btn uc-btn--primary" onClick={onDownload}>
                  {t('update.download')}
                </button>
              </>
            )}

            {status.type === 'downloaded' && (
              <>
                <button type="button" className="uc-btn" onClick={onClose}>{t('update.restartLater')}</button>
                <button type="button" className="uc-btn uc-btn--primary" onClick={onInstall}>
                  {t('update.restartInstall')}
                </button>
              </>
            )}

            {status.type === 'error' && (
              <>
                <button type="button" className="uc-btn" onClick={onClose}>{t('common.close')}</button>
                <button
                  type="button"
                  className="uc-btn uc-btn--primary"
                  onClick={status.operation === 'download' ? onDownload : onCheck}
                >
                  {t('common.retry')}
                </button>
              </>
            )}

            {['preparing', 'downloading'].includes(status.type) && (
              <button type="button" className="uc-btn" onClick={onCancel}>{t('update.cancelDownload')}</button>
            )}

            {status.type === 'installing' && (
              <button type="button" className="uc-btn uc-btn--primary" disabled>{t('update.applying')}</button>
            )}

            {['idle', 'checking', 'not-available', 'disabled'].includes(status.type) && (
              <button
                type="button"
                className="uc-btn uc-btn--primary"
                onClick={onCheck}
                disabled={busy || status.type === 'disabled'}
              >
                {status.type === 'checking' ? t('update.checking') : t('update.check')}
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}

function headIcon(type) {
  if (type === 'not-available') return <CheckCircle2 size={20} />;
  if (type === 'error') return <AlertCircle size={20} />;
  if (type === 'available' || type === 'downloaded' || type === 'downloading') return <Download size={20} />;
  return <RefreshCw size={20} className={['checking', 'preparing', 'installing'].includes(type) ? 'uc-spin' : ''} />;
}

function headline(status, percent, t) {
  switch (status.type) {
    case 'disabled': return t('update.desktopTitle');
    case 'checking': return t('update.checkingTitle');
    case 'not-available': return t('update.upToDate');
    case 'available': return t('update.readyTitle', { version: status.version });
    case 'preparing': return t('update.preparingTitle');
    case 'downloading': return t('update.downloadingPercent', { percent });
    case 'downloaded': return t('update.installReady');
    case 'installing': return t('update.restarting');
    case 'error': return t('update.interrupted');
    default: return t('update.title');
  }
}

function subline(status, t) {
  switch (status.type) {
    case 'disabled': return status.message || t('update.desktopText');
    case 'checking': return t('update.checkingText');
    case 'not-available': return t('update.newestVersion', { version: status.currentVersion ?? '' });
    case 'available': return t('update.readyText');
    case 'preparing': return t('update.preparingText');
    case 'downloading': return status.optimized ? t('update.changedOnly') : t('update.downloadingText');
    case 'downloaded': return t('update.verifiedRestart', { version: status.version });
    case 'installing': return t('update.applyingMoment');
    case 'error': return t('update.interruptedText');
    default: return t('update.autoText');
  }
}

function statusLabel(status, t) {
  switch (status.type) {
    case 'checking': return 'Contacting the update service';
    case 'not-available': return 'Your launcher is current';
    case 'preparing': return 'Preparing the download';
    case 'installing': return 'Applying the update';
    case 'disabled': return 'Desktop updater unavailable';
    default: return t('update.autoText');
  }
}

function statusDetail(status, currentVersion, t) {
  switch (status.type) {
    case 'checking': return 'Comparing your build with the latest stable release.';
    case 'not-available': return `Version ${currentVersion} is the newest stable release.`;
    case 'preparing': return 'Selecting the smallest compatible package for this device.';
    case 'installing': return 'Native will restart automatically when it is ready.';
    case 'disabled': return status.message || t('update.desktopText');
    default: return 'Updates are checked securely in the background.';
  }
}

function renderReleaseNotes(notes) {
  let raw = '';
  if (Array.isArray(notes)) {
    raw = notes.map((entry) => entry?.note ?? entry?.notes ?? '').filter(Boolean).join('\n\n');
  } else {
    raw = String(notes ?? '');
  }
  raw = raw.replace(/\\n/g, '\n').trim();
  if (!raw) return '';
  raw = raw.replace(/^([ \t]*)•[ \t]+/gm, '$1- ');
  return DOMPurify.sanitize(marked.parse(raw, { gfm: true, breaks: true }));
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / (1024 ** unit);
  return `${amount.toFixed(unit >= 2 ? 1 : 0)} ${units[unit]}`;
}

function formatSpeed(value) {
  return value > 0 ? `${formatBytes(value)}/s` : '—';
}

function getEta(total, transferred, speed, t) {
  if (!total || !speed) return t('update.estimating');
  const seconds = Math.max(0, Math.ceil((total - transferred) / speed));
  if (seconds < 60) return t('update.secondsRemaining', { count: seconds });
  return t('update.minutesRemaining', { count: Math.ceil(seconds / 60) });
}
