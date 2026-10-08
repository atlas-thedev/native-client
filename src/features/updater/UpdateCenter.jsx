import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { X } from 'lucide-react';
import { marked } from 'marked';
import './UpdateCenter.css';

/**
 * Launcher updates, kept plain: version line, changelog, one progress bar and the buttons that matter.
 * Updates still download in the background and install when Native closes.
 * `UpdateCard` is the compact version used on the Settings page.
 */

const ACTIVE = ['available', 'preparing', 'downloading', 'paused', 'downloaded', 'installing'];
const RELEASE_API = 'https://api.github.com/repos/atlas-thedev/native-client/releases/tags/v';

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

  const current = status.currentVersion ?? window.native?.version ?? '';
  const hasUpdate = ACTIVE.includes(status.type) || (status.type === 'error' && status.operation === 'download');
  // the new version's notes when there is one, otherwise what's in the version you have
  const currentNotes = useCurrentNotes(open && !hasUpdate ? current : null);
  const notes = hasUpdate ? status.releaseNotes : currentNotes;

  if (!open) return null;
  return (
    <div className="uc-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="update-center" role="dialog" aria-modal="true" aria-label="Launcher update">
        <header className="uc-head">
          <h2>{hasUpdate ? 'Launcher update' : 'Updates'}</h2>
          <button type="button" className="uc-close" onClick={onClose} aria-label="Close" title="Close"><X size={16} /></button>
        </header>

        <div className="uc-body">
          <p className="uc-version">
            {hasUpdate && status.version
              ? <>Version <b>{current || '—'}</b> → <b>{status.version}</b>{status.prerelease ? ' (beta)' : ''}</>
              : <>Installed version <b>{current || '—'}</b></>}
          </p>

          <div className="uc-label">{`Changelog · ${hasUpdate && status.version ? status.version : current || ''}`}</div>
          <Changelog notes={notes} />

          <Progress status={status} />
          <p className={`uc-status${status.type === 'error' ? ' is-error' : ''}`}>{statusLine(status, current)}</p>
          <BetaChannel status={status} current={current} />
        </div>

        <footer className="uc-foot">
          <Actions status={status} onCheck={onCheck} onDownload={onDownload} onPause={onPause} onInstall={onInstall} onLater={onClose} />
        </footer>
      </section>
    </div>
  );
}

/** Compact status for the Settings page: one line, the bar while downloading and one button. */
export function UpdateCard({ status, onCheck, onDownload, onPause, onInstall, onDetails, className = '' }) {
  const current = status.currentVersion ?? window.native?.version ?? '';
  return (
    <div className={`uc-card ${className}`}>
      <div className="uc-card-row">
        <div className="uc-card-text">
          <strong>{cardTitle(status)}</strong>
          <span className={status.type === 'error' ? 'is-error' : ''}>{statusLine(status, current)}</span>
        </div>
        <div className="uc-card-actions">
          {onDetails && <button type="button" className="uc-btn" onClick={onDetails}>Changelog</button>}
          <Actions status={status} onCheck={onCheck} onDownload={onDownload} onPause={onPause} onInstall={onInstall} compact />
        </div>
      </div>
      <Progress status={status} />
      <BetaChannel status={status} current={current} />
    </div>
  );
}

/** Small "update ready" note (bottom right). */
export function UpdateToast({ status, onInstall, onOpen, onDismiss }) {
  if (status?.type !== 'downloaded') return null;
  return (
    <div className="uc-toast" role="status">
      <button type="button" className="uc-toast-text" onClick={onOpen}>
        <strong>Native {status.version} is ready</strong>
        <span>Installs when you close Native.</span>
      </button>
      <button type="button" className="uc-btn is-primary" onClick={onInstall}>Restart</button>
      <button type="button" className="uc-close" onClick={onDismiss} aria-label="Dismiss"><X size={14} /></button>
    </div>
  );
}

export function ReleaseNotes({ notes }) {
  return <Changelog notes={notes} />;
}

function Changelog({ notes }) {
  const html = useMemo(() => renderReleaseNotes(notes), [notes]);
  const openExternalLink = (event) => {
    const anchor = event.target.closest('a');
    if (!anchor?.href) return;
    event.preventDefault();
    window.native?.openExternal(anchor.href);
  };
  if (notes === undefined) return <div className="uc-log is-empty">Loading changelog…</div>;
  return html
    ? <div className="uc-log" onClick={openExternalLink} dangerouslySetInnerHTML={{ __html: html }} />
    : <div className="uc-log is-empty">Fixes and improvements.</div>;
}

function Progress({ status }) {
  const type = status.type;
  const shown = ['preparing', 'downloading', 'paused', 'downloaded', 'installing'].includes(type) || (type === 'error' && status.saved);
  if (!shown) return null;
  const percent = type === 'downloaded' || type === 'installing' ? 100 : clampPercent(status.percent ?? status.saved?.percent ?? 0);
  const detail = [];
  if (status.total && percent < 100) detail.push(`${formatBytes(status.transferred)} / ${formatBytes(status.total)}`);
  if (type === 'downloading' && status.bytesPerSecond > 0) detail.push(`${formatBytes(status.bytesPerSecond)}/s`, eta(status.total, status.transferred, status.bytesPerSecond));
  if (type === 'downloading' && status.throttled) detail.push('slowed while Minecraft runs');
  return (
    <div className="uc-progress">
      <div className={`uc-bar${type === 'paused' || type === 'error' ? ' is-paused' : ''}`} role="progressbar" aria-valuenow={percent} aria-valuemin="0" aria-valuemax="100">
        <i style={{ width: `${percent}%` }} />
      </div>
      <div className="uc-progress-text"><span>{percent}%</span><span>{detail.join(' · ')}</span></div>
    </div>
  );
}

function Actions({ status, onCheck, onDownload, onPause, onInstall, onLater, compact = false }) {
  const type = status.type;
  const Btn = ({ primary, children, ...rest }) => <button type="button" className={`uc-btn${primary ? ' is-primary' : ''}`} {...rest}>{children}</button>;
  return (
    <>
      {!compact && onLater && type !== 'installing' && <Btn onClick={onLater}>{type === 'downloaded' ? 'Later' : 'Close'}</Btn>}
      {type === 'available' && <Btn primary onClick={onDownload}>{status.saved ? 'Continue download' : 'Update'}</Btn>}
      {(type === 'downloading' || type === 'preparing') && <Btn onClick={onPause}>Pause</Btn>}
      {type === 'paused' && <Btn primary onClick={onDownload}>Resume</Btn>}
      {type === 'downloaded' && <Btn primary onClick={onInstall}>Restart and install</Btn>}
      {type === 'error' && <Btn primary onClick={status.operation === 'download' ? onDownload : onCheck}>{status.operation === 'download' && status.saved ? 'Continue' : 'Try again'}</Btn>}
      {['idle', 'checking', 'not-available'].includes(type) && <Btn onClick={onCheck} disabled={type === 'checking'}>Check for updates</Btn>}
      {type === 'installing' && <Btn primary disabled>Installing…</Btn>}
    </>
  );
}

function BetaChannel({ status, current }) {
  // Ask the Native server once whether this account is a beta tester.
  useEffect(() => { window.native?.updater?.channel?.().catch?.(() => {}); }, []);
  const [busy, setBusy] = useState(false);
  const onBeta = status.channel === 'beta';
  if (!status.betaTester) {
    return /-/.test(String(current)) ? <p className="uc-note">You’re on a beta build. You’ll move to the next stable release when it comes out.</p> : null;
  }
  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try { await window.native?.updater?.setBetaOptOut?.(!status.betaOptOut); } finally { setBusy(false); }
  };
  return (
    <label className="uc-check">
      <input type="checkbox" checked={onBeta} disabled={busy} onChange={toggle} />
      <span>Get beta builds early (you’re a beta tester; they can have bugs)</span>
    </label>
  );
}

function useCurrentNotes(version) {
  const [notes, setNotes] = useState({});
  useEffect(() => {
    if (!version || notes[version] !== undefined) return undefined;
    let alive = true;
    fetch(`${RELEASE_API}${encodeURIComponent(version)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((release) => { if (alive) setNotes((all) => ({ ...all, [version]: release?.body || '' })); })
      .catch(() => { if (alive) setNotes((all) => ({ ...all, [version]: '' })); });
    return () => { alive = false; };
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  return version ? notes[version] : '';
}

function cardTitle(status) {
  switch (status.type) {
    case 'available': return `Update ${status.version} available`;
    case 'preparing':
    case 'downloading': return `Downloading ${status.version ?? 'update'}`;
    case 'paused': return 'Download paused';
    case 'downloaded': return `Update ${status.version} ready`;
    case 'installing': return 'Installing update';
    case 'error': return status.operation === 'download' ? 'Download interrupted' : 'Update check failed';
    case 'not-available': return 'Up to date';
    case 'disabled': return 'Updates';
    default: return 'Launcher updates';
  }
}

function statusLine(status, current) {
  switch (status.type) {
    case 'checking': return 'Checking for updates…';
    case 'not-available': return `You have the latest version${current ? ` (${current})` : ''}.`;
    case 'available': return 'A new version is available. It downloads in the background.';
    case 'preparing': return 'Starting download…';
    case 'downloading': return status.optimized ? 'Downloading only what changed…' : 'Downloading…';
    case 'paused': return 'Paused. It picks up where it left off.';
    case 'downloaded': return 'Download complete. Installs when you close Native, or restart now.';
    case 'installing': return 'Installing. Native reopens when it’s done.';
    case 'error': return `${status.message || (status.operation === 'download' ? 'The download was interrupted.' : 'Could not check for updates.')}${status.retryAt ? ' It will try again by itself.' : ''}`;
    case 'disabled': return status.message || 'Updates work in the installed app.';
    default: return `Version ${current || '—'}. Checks on start and every few hours.`;
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
  if (!total || !speed) return '';
  const seconds = Math.max(0, Math.ceil((total - transferred) / speed));
  return seconds < 60 ? `${seconds}s left` : `${Math.ceil(seconds / 60)} min left`;
}
