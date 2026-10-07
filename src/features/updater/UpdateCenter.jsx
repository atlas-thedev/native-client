import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { AlertCircle, Check, ChevronDown, Download, Pause, Play, RefreshCw, RotateCcw, X } from 'lucide-react';
import { marked } from 'marked';
import './UpdateCenter.css';

/**
 * Updates. They download by themselves in the background (in parts that survive pauses, lost
 * connections and restarts) and install when Native closes. `UpdateCard` is the live status
 * (also used on the Settings page); `UpdateCenter` is the window with the release notes.
 */

const ACTIVE = ['available', 'preparing', 'downloading', 'paused', 'downloaded', 'installing'];

export default function UpdateCenter({ open, onClose, status, onCheck, onDownload, onPause, onInstall }) {
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

  if (!open) return null;
  const hasNotes = ACTIVE.includes(status.type) || (status.type === 'error' && status.operation === 'download');

  return (
    <div className="uc-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="update-center" role="dialog" aria-modal="true" aria-label="Updates">
        <header className="uc-top">
          <span className="uc-top-title">Updates</span>
          <span className="uc-chip">v{status.currentVersion ?? window.native?.version ?? '—'}</span>
          <button type="button" className="uc-close" onClick={onClose} aria-label="Close" title="Close"><X size={16} /></button>
        </header>
        <div className="uc-scroll">
          <UpdateCard status={status} onCheck={onCheck} onDownload={onDownload} onPause={onPause} onInstall={onInstall} onLater={onClose} />
          {hasNotes && <ReleaseNotes notes={status.releaseNotes} open />}
        </div>
        <footer className="uc-foot">New versions download quietly and install when you close Native.</footer>
      </section>
    </div>
  );
}

/** The live update status: an animated badge, what is happening, progress and the one action that matters. */
export function UpdateCard({ status, onCheck, onDownload, onPause, onInstall, onLater, onDetails, className = '' }) {
  const type = status?.type || 'idle';
  const percent = clampPercent(status.percent ?? status.saved?.percent ?? 0);
  const busy = type === 'downloading' || type === 'preparing' || (type === 'error' && status.saved);
  const showBar = ['preparing', 'downloading', 'paused'].includes(type) || (type === 'error' && status.saved);
  const current = status.currentVersion ?? window.native?.version ?? '—';
  const flash = useFlash(type); // replays the badge animation each time the state changes

  return (
    <div className={`uc-card is-${type} ${className}`}>
      <div className="uc-card-row">
        <Badge type={type} percent={percent} key={flash} />
        <div className="uc-card-text">
          <strong className="uc-card-title">{title(status, percent)}</strong>
          <span className="uc-card-sub">{sub(status, current)}</span>
        </div>
        <div className="uc-card-actions">
          {type === 'available' && <Btn primary icon={<Download size={15} />} onClick={onDownload}>{status.saved ? `Continue · ${status.saved.percent}%` : 'Download'}</Btn>}
          {(type === 'downloading' || type === 'preparing') && <Btn icon={<Pause size={15} />} onClick={onPause}>Pause</Btn>}
          {type === 'paused' && <Btn primary icon={<Play size={15} />} onClick={onDownload}>Resume</Btn>}
          {type === 'downloaded' && (
            <>
              {onLater && <Btn onClick={onLater}>Later</Btn>}
              <Btn primary icon={<RotateCcw size={15} />} onClick={onInstall}>Restart now</Btn>
            </>
          )}
          {type === 'error' && <Btn primary icon={<RefreshCw size={15} />} onClick={status.operation === 'download' ? onDownload : onCheck}>{status.operation === 'download' && status.saved ? 'Continue' : 'Try again'}</Btn>}
          {['idle', 'checking', 'not-available', 'disabled'].includes(type) && (
            <Btn icon={<RefreshCw size={15} className={type === 'checking' ? 'uc-spin' : ''} />} onClick={onCheck} disabled={type === 'checking' || type === 'disabled'}>
              {type === 'checking' ? 'Checking…' : 'Check now'}
            </Btn>
          )}
          {type === 'installing' && <Btn primary disabled>Restarting…</Btn>}
        </div>
      </div>

      {showBar && (
        <div className="uc-progress-wrap">
          <div className={`uc-bar${type === 'paused' || type === 'error' ? ' is-paused' : ''}${busy && !percent ? ' is-indeterminate' : ''}`} role="progressbar" aria-valuenow={percent} aria-valuemin="0" aria-valuemax="100">
            <i style={{ width: `${Math.max(percent, busy ? 2 : 0)}%` }} />
          </div>
          <div className="uc-meta">
            <span>{status.total ? `${formatBytes(status.transferred)} of ${formatBytes(status.total)}` : status.saved ? `${status.saved.doneParts} of ${status.saved.parts} parts saved` : status.optimized ? 'Only what changed' : 'Starting…'}</span>
            {type === 'downloading' && status.bytesPerSecond > 0 && <span>{formatBytes(status.bytesPerSecond)}/s · {eta(status.total, status.transferred, status.bytesPerSecond)}</span>}
            {type === 'downloading' && status.throttled && <span>Slowed while Minecraft runs</span>}
          </div>
        </div>
      )}

      {status.version && ACTIVE.includes(type) && (
        <div className="uc-versions">
          <span>v{current}</span>
          <span className="uc-versions-line"><i /></span>
          <span className="is-new">v{status.version}</span>
          {onDetails && <button type="button" className="uc-link" onClick={onDetails}>What’s new</button>}
        </div>
      )}
      {type === 'error' && status.message && <p className="uc-error">{status.message}{status.retryAt ? ' It will try again by itself.' : ''}</p>}
    </div>
  );
}

function Badge({ type, percent }) {
  const R = 19, C = 2 * Math.PI * R;
  const ring = ['downloading', 'paused', 'preparing'].includes(type) || type === 'error';
  return (
    <span className={`uc-badge is-${type}`} aria-hidden="true">
      {(type === 'checking' || type === 'installing' || type === 'preparing') && <span className="uc-badge-spinner" />}
      {ring && (
        <svg className="uc-badge-ring" viewBox="0 0 44 44">
          <circle cx="22" cy="22" r={R} className="uc-ring-track" />
          <circle cx="22" cy="22" r={R} className="uc-ring-fill" strokeDasharray={C} strokeDashoffset={C * (1 - percent / 100)} />
        </svg>
      )}
      {type === 'downloaded' && <span className="uc-badge-halo" />}
      <span className="uc-badge-icon">
        {type === 'not-available' || type === 'downloaded' ? <Check size={20} strokeWidth={2.6} />
          : type === 'error' ? <AlertCircle size={19} />
          : type === 'paused' ? <Pause size={16} />
          : type === 'downloading' ? <span className="uc-badge-pct">{percent}<small>%</small></span>
          : type === 'available' ? <Download size={18} className="uc-bob" />
          : <RefreshCw size={18} className={type === 'checking' || type === 'installing' ? 'uc-spin' : ''} />}
      </span>
    </span>
  );
}

function Btn({ primary, icon, children, ...rest }) {
  return <button type="button" className={`uc-btn${primary ? ' is-primary' : ''}`} {...rest}>{icon}{children}</button>;
}

export function ReleaseNotes({ notes, open: openInitially = false }) {
  const [open, setOpen] = useState(openInitially);
  const html = useMemo(() => renderReleaseNotes(notes), [notes]);
  const openExternalLink = (event) => {
    const anchor = event.target.closest('a');
    if (!anchor?.href) return;
    event.preventDefault();
    window.native?.openExternal(anchor.href);
  };
  return (
    <section className={`uc-notes${open ? ' is-open' : ''}`}>
      <button type="button" className="uc-notes-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>What’s new</span><ChevronDown size={15} />
      </button>
      {open && (html
        ? <div className="uc-notes-content" onClick={openExternalLink} dangerouslySetInnerHTML={{ __html: html }} />
        : <p className="uc-notes-content is-empty">Fixes and improvements.</p>)}
    </section>
  );
}

/** Small, non-blocking "update ready" card (bottom right). */
export function UpdateToast({ status, onInstall, onOpen, onDismiss }) {
  if (status?.type !== 'downloaded') return null;
  return (
    <div className="uc-toast" role="status">
      <span className="uc-badge is-downloaded is-small" aria-hidden="true"><span className="uc-badge-halo" /><span className="uc-badge-icon"><Check size={16} strokeWidth={2.6} /></span></span>
      <button type="button" className="uc-toast-text" onClick={onOpen}>
        <strong>Native {status.version} is ready</strong>
        <span>Installs when you close Native.</span>
      </button>
      <button type="button" className="uc-btn is-primary" onClick={onInstall}>Restart</button>
      <button type="button" className="uc-toast-close" onClick={onDismiss} aria-label="Dismiss"><X size={14} /></button>
    </div>
  );
}

function useFlash(type) {
  const [n, setN] = useState(0);
  const last = useRef(type);
  useEffect(() => { if (last.current !== type) { last.current = type; setN((v) => v + 1); } }, [type]);
  return n;
}

function title(status, percent) {
  switch (status.type) {
    case 'disabled': return 'Updates run in the desktop app';
    case 'checking': return 'Checking for updates…';
    case 'not-available': return 'You’re up to date';
    case 'available': return `Native ${status.version} is out`;
    case 'preparing': return 'Starting download…';
    case 'downloading': return `Downloading ${status.version ?? 'update'} · ${percent}%`;
    case 'paused': return 'Download paused';
    case 'downloaded': return `Native ${status.version} is ready`;
    case 'installing': return 'Installing the update…';
    case 'error': return status.operation === 'download' ? 'Download interrupted' : 'Couldn’t check for updates';
    default: return 'Automatic updates are on';
  }
}

function sub(status, current) {
  switch (status.type) {
    case 'checking': return 'Looking for the newest release.';
    case 'not-available': return `Version ${current} is the newest.`;
    case 'available': return 'Downloads in the background while you play.';
    case 'preparing':
    case 'downloading': return status.optimized ? 'Only downloading what changed.' : 'Keeps going if you close Native.';
    case 'paused': return 'Picks up where it left off.';
    case 'downloaded': return 'Installs when you close Native, or restart now.';
    case 'installing': return 'Native reopens when it’s done.';
    case 'error': return status.operation === 'download' ? 'What’s downloaded so far is kept.' : 'Check your connection and try again.';
    case 'disabled': return status.message || 'Update checks are available in packaged builds.';
    default: return `Version ${current}. Checks on start and every few hours.`;
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

const clampPercent = (value) => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** unit)).toFixed(unit >= 2 ? 1 : 0)} ${units[unit]}`;
}

function eta(total, transferred, speed) {
  if (!total || !speed) return 'estimating…';
  const seconds = Math.max(0, Math.ceil((total - transferred) / speed));
  return seconds < 60 ? `${seconds}s left` : `${Math.ceil(seconds / 60)} min left`;
}
