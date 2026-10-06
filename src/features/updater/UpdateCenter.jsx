import { useEffect, useMemo, useRef } from 'react';
import DOMPurify from 'dompurify';
import { AlertCircle, ArrowRight, CheckCircle2, Download, Pause, Play, RefreshCw, X } from 'lucide-react';
import { marked } from 'marked';
import './UpdateCenter.css';
import { useI18n } from '../../i18n/I18nProvider.jsx';

/**
 * Update center. Updates download on their own in the background (in parts that
 * survive pauses, lost connections and restarts) and install when Native closes,
 * so this is mostly a window onto what's already happening.
 */
export default function UpdateCenter({ open, onClose, status, onCheck, onDownload, onPause, onInstall }) {
  const { t } = useI18n();
  const checkedForOpen = useRef(false);

  useEffect(() => {
    if (!open) { checkedForOpen.current = false; return; }
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

  const type = status.type;
  const percent = Math.round(status.percent ?? status.saved?.percent ?? 0);
  const currentVersion = status.currentVersion ?? window.native?.version ?? '—';
  const showNotes = ['available', 'downloading', 'paused', 'downloaded'].includes(type) || (type === 'error' && status.operation === 'download');

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
          <span className={`uc-head-icon is-${type}`} aria-hidden="true">{headIcon(type)}</span>
          <div className="uc-head-text">
            <h2 className="uc-title" id="uc-title">{headline(status, percent, t)}</h2>
            <p className="uc-subtitle">{subline(status)}</p>
          </div>
          <button type="button" className="uc-close" onClick={onClose} aria-label={t('update.close')} title={t('update.close')}>
            <X size={16} />
          </button>
        </header>

        <div className="uc-body">
          {status.version && ['available', 'downloading', 'paused', 'downloaded', 'error', 'installing'].includes(type) && (
            <div className="uc-version-card">
              <div className="uc-version-column">
                <span>Installed</span>
                <strong>v{currentVersion}</strong>
              </div>
              <span className="uc-version-sep" aria-hidden="true"><ArrowRight size={16} /></span>
              <div className="uc-version-column is-new">
                <span>{type === 'downloaded' ? 'Ready' : 'New'}</span>
                <strong>v{status.version}</strong>
              </div>
            </div>
          )}

          {['downloading', 'paused'].includes(type) || (type === 'error' && status.saved) ? (
            <div className="uc-download">
              <div className="uc-download-top">
                <span>{downloadLabel(status)}</span>
                <strong>{percent}%</strong>
              </div>
              <PartsBar status={status} percent={percent} />
              <div className="uc-download-meta">
                <span>{status.total ? `${formatBytes(status.transferred)} / ${formatBytes(status.total)}` : status.saved ? `${status.saved.doneParts} of ${status.saved.parts} parts saved` : formatBytes(status.fullSize)}</span>
                {type === 'downloading' && <span>{formatSpeed(status.bytesPerSecond)}</span>}
                {type === 'downloading' && <span>{getEta(status.total, status.transferred, status.bytesPerSecond, t)}</span>}
              </div>
            </div>
          ) : null}

          {['idle', 'checking', 'not-available', 'disabled', 'installing'].includes(type) && (
            <div className={`uc-status-card is-${type}`}>
              <div className="uc-status-visual" aria-hidden="true">
                <span className="uc-status-orbit" />
                <span className="uc-status-dot" />
              </div>
              <div className="uc-status-copy">
                <strong>{statusLabel(type)}</strong>
                <span>{statusDetail(status, currentVersion)}</span>
              </div>
            </div>
          )}

          {type === 'error' && <p className="uc-error">{status.message || t('update.couldNotComplete')}{status.retryAt ? ' It will try again by itself.' : ''}</p>}

          {showNotes && (
            <section className="uc-notes">
              <h3 className="uc-notes-title">{t('update.whatsNew')}</h3>
              {notesHtml
                ? <div className="uc-notes-content" onClick={openExternalLink} dangerouslySetInnerHTML={{ __html: notesHtml }} />
                : <p className="uc-notes-empty">{t('update.defaultNotes')}</p>}
            </section>
          )}
        </div>

        <footer className="uc-footer">
          <span className="uc-footer-version">{footerNote(status)}</span>
          <div className="uc-actions">
            {type === 'available' && (
              <button type="button" className="uc-btn uc-btn--primary" onClick={onDownload}>
                <Download size={15} /> {status.saved ? `Continue (${status.saved.percent}%)` : t('update.download')}
              </button>
            )}
            {type === 'downloading' && (
              <button type="button" className="uc-btn" onClick={onPause}><Pause size={15} /> Pause</button>
            )}
            {type === 'paused' && (
              <button type="button" className="uc-btn uc-btn--primary" onClick={onDownload}><Play size={15} /> Resume</button>
            )}
            {type === 'downloaded' && (
              <>
                <button type="button" className="uc-btn" onClick={onClose}>When I close Native</button>
                <button type="button" className="uc-btn uc-btn--primary" onClick={onInstall}>Restart now</button>
              </>
            )}
            {type === 'error' && (
              <button type="button" className="uc-btn uc-btn--primary" onClick={status.operation === 'download' ? onDownload : onCheck}>
                <RefreshCw size={15} /> {status.operation === 'download' && status.saved ? 'Continue now' : t('common.retry')}
              </button>
            )}
            {type === 'installing' && <button type="button" className="uc-btn uc-btn--primary" disabled>{t('update.applying')}</button>}
            {['idle', 'checking', 'not-available', 'disabled'].includes(type) && (
              <button type="button" className="uc-btn uc-btn--primary" onClick={onCheck} disabled={type === 'checking' || type === 'disabled'}>
                {type === 'checking' ? t('update.checking') : t('update.check')}
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}

/** One segment per downloaded part; falls back to a plain bar when parts aren't known. */
function PartsBar({ status, percent }) {
  const map = status.map;
  if (Array.isArray(map) && map.length > 1 && map.length <= 96) {
    const active = status.type === 'downloading';
    return (
      <div className="uc-parts" role="progressbar" aria-valuenow={percent} aria-valuemin="0" aria-valuemax="100">
        {map.map((done, i) => <span key={i} className={`uc-part${done ? ' is-done' : ''}${active && !done ? ' is-pending' : ''}`} />)}
      </div>
    );
  }
  return (
    <div className="uc-progress" role="progressbar" aria-valuenow={percent} aria-valuemin="0" aria-valuemax="100">
      <div className={`uc-progress-fill${status.type === 'paused' ? ' is-paused' : ''}`} style={{ width: `${percent}%` }} />
    </div>
  );
}

/** Small, non-blocking "update ready" card (bottom right). */
export function UpdateToast({ status, onInstall, onOpen, onDismiss }) {
  if (status?.type !== 'downloaded') return null;
  return (
    <div className="uc-toast" role="status">
      <span className="uc-toast-icon" aria-hidden="true"><Download size={16} /></span>
      <button type="button" className="uc-toast-text" onClick={onOpen}>
        <strong>Update {status.version} downloaded</strong>
        <span>Installs when you close Native.</span>
      </button>
      <button type="button" className="uc-btn uc-btn--primary uc-toast-btn" onClick={onInstall}>Restart</button>
      <button type="button" className="uc-toast-close" onClick={onDismiss} aria-label="Dismiss"><X size={14} /></button>
    </div>
  );
}

function downloadLabel(status) {
  if (status.type === 'paused') return 'Paused';
  if (status.type === 'error') return 'Interrupted';
  if (status.throttled) return 'Limited while Minecraft is running';
  if (status.resumed) return 'Resumed';
  if (status.parts) return `${status.doneParts ?? 0} of ${status.parts} parts`;
  return status.optimized ? 'Downloading only what changed' : 'Downloading';
}

function footerNote(status) {
  switch (status.type) {
    case 'downloading': return '';
    case 'paused': return 'Paused.';
    case 'downloaded': return 'Checksum verified.';
    case 'available': return status.saved ? `${status.saved.percent}% already downloaded.` : '';
    default: return `Version ${status.currentVersion ?? window.native?.version ?? '—'}`;
  }
}

function headIcon(type) {
  if (type === 'not-available') return <CheckCircle2 size={20} />;
  if (type === 'error') return <AlertCircle size={20} />;
  if (type === 'downloaded') return <CheckCircle2 size={20} />;
  if (type === 'paused') return <Pause size={20} />;
  if (type === 'available' || type === 'downloading') return <Download size={20} />;
  return <RefreshCw size={20} className={['checking', 'installing'].includes(type) ? 'uc-spin' : ''} />;
}

function headline(status, percent, t) {
  switch (status.type) {
    case 'disabled': return t('update.desktopTitle');
    case 'checking': return t('update.checkingTitle');
    case 'not-available': return t('update.upToDate');
    case 'available': return `Version ${status.version} available`;
    case 'preparing': return 'Starting download';
    case 'downloading': return `Downloading update · ${percent}%`;
    case 'paused': return 'Update paused';
    case 'downloaded': return `Version ${status.version} downloaded`;
    case 'installing': return t('update.restarting');
    case 'error': return status.operation === 'download' ? 'Download interrupted' : t('update.interrupted');
    default: return t('update.title');
  }
}

function subline(status) {
  switch (status.type) {
    case 'checking': return 'Looking for the newest stable release…';
    case 'not-available': return `Native Client ${status.currentVersion ?? ''} is the newest version.`;
    case 'available': return 'Downloads in the background while you use Native.';
    case 'preparing':
    case 'downloading': return 'Saved in parts. If you close Native or lose connection, it continues later.';
    case 'paused': return 'Continues from the parts already downloaded.';
    case 'downloaded': return 'Installs when you close Native, or restart now.';
    case 'installing': return 'Native Client reopens when it is done.';
    case 'error': return status.operation === 'download' ? 'The parts downloaded so far are kept.' : 'Check your connection and try again.';
    case 'disabled': return status.message || 'Update checks are available in packaged builds.';
    default: return 'Checks for updates on start and every few hours.';
  }
}

function statusLabel(type) {
  switch (type) {
    case 'checking': return 'Contacting the update service';
    case 'not-available': return 'Your launcher is current';
    case 'installing': return 'Applying the update';
    case 'disabled': return 'Desktop updater unavailable';
    default: return 'Automatic updates are on';
  }
}

function statusDetail(status, currentVersion) {
  switch (status.type) {
    case 'checking': return 'Comparing your build with the latest stable release.';
    case 'not-available': return `Version ${currentVersion}. New versions download in the background and install when you close Native.`;
    case 'installing': return 'Native restarts automatically when it is ready.';
    case 'disabled': return status.message || 'Update checks are available in packaged builds.';
    default: return 'New versions download in the background and install when you close Native.';
  }
}

function renderReleaseNotes(notes) {
  let raw = '';
  if (Array.isArray(notes)) raw = notes.map((entry) => entry?.note ?? entry?.notes ?? '').filter(Boolean).join('\n\n');
  else raw = String(notes ?? '');
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
  return `${(bytes / (1024 ** unit)).toFixed(unit >= 2 ? 1 : 0)} ${units[unit]}`;
}

function formatSpeed(value) { return value > 0 ? `${formatBytes(value)}/s` : '—'; }

function getEta(total, transferred, speed, t) {
  if (!total || !speed) return t('update.estimating');
  const seconds = Math.max(0, Math.ceil((total - transferred) / speed));
  if (seconds < 60) return t('update.secondsRemaining', { count: seconds });
  return t('update.minutesRemaining', { count: Math.ceil(seconds / 60) });
}
