import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  FolderOpen,
  Image as ImageIcon,
  LoaderCircle,
  Plus,
  RefreshCw,
  Send,
  Share2,
  Trash2,
  UserRound,
  UsersRound,
  X
} from 'lucide-react';
import PlayerAvatar from '../../components/ui/PlayerAvatar.jsx';
import Badges from '../social/Badges.jsx';
import './ScreenshotManager.css';

const formatSize = (bytes = 0) => {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

const formatDate = (stamp) => {
  const date = new Date(stamp || 0);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
};

const targetKey = (target) => `${target.kind}:${target.id}`;

function useEscapeClose(onClose, disabled = false) {
  useEffect(() => {
    const handleKey = (event) => {
      if (event.key !== 'Escape' || disabled) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [disabled, onClose]);
}

function ScreenshotThumbnail({ instanceId, shot, eager = false }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    window.native?.instance?.screenshotData?.(instanceId, shot.name, { thumbnail: !eager })
      .then((value) => { if (!cancelled) setUrl(value); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [instanceId, shot.name, eager]);

  if (failed) return <span className="sm-thumb-fallback"><ImageIcon size={30}/></span>;
  if (!url) return <span className="sm-thumb-loading" aria-label={`Loading ${shot.name}`}/>;
  return <img src={url} alt={shot.name} draggable="false"/>;
}

function TargetAvatar({ target }) {
  const name = target.nickname || target.name || (target.kind === 'group' ? 'Group' : 'Friend');
  const image = target.kind === 'group' ? target.iconUrl : null;
  return (
    <span className={`sm-target-avatar is-${target.kind}`}>
      {image ? <img src={image} alt=""/> : target.kind === 'group' ? <UsersRound size={16}/> : <UserRound size={16}/>} 
      <span className="sm-target-presence" data-status={target.status || 'offline'}/>
    </span>
  );
}

export async function shareScreenshot({ cluster, shot, social, recipients, caption = '' }) {
  const dataUrl = await window.native.instance.screenshotData(cluster.id, shot.name, { thumbnail: false });
  const upload = await social.uploadMedia(dataUrl, shot.name);
  if (!upload?.ok || !upload.url) throw new Error(upload?.error || 'Screenshot upload failed.');

  const message = caption.trim().slice(0, 2000) || `Screenshot from ${cluster.name || cluster.mc_version || cluster.version || 'Minecraft'}`;
  const media = {
    mediaUrl: upload.url,
    mediaName: shot.name,
    mediaKind: 'image',
    isMedia: true
  };
  const results = await Promise.all(recipients.map(async (target) => {
    if (target.kind === 'group') {
      return window.native.relay.sendGroupMessage(target.id, { content: message, ...media });
    }
    return social.sendMessage(target.id, message, media);
  }));
  const failed = results.filter((result) => !result?.ok).length;
  return { sent: results.length - failed, failed, total: results.length };
}

export function ShareScreenshotDialog({ cluster, shot, social, account, onClose, onShared }) {
  const dialogRef = useRef(null);
  const [activeAccount, setActiveAccount] = useState(account || null);
  const [groups, setGroups] = useState([]);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEscapeClose(onClose, busy);

  useEffect(() => { dialogRef.current?.focus(); }, []);

  useEffect(() => {
    if (account) {
      setActiveAccount(account);
      return;
    }
    let cancelled = false;
    Promise.resolve(window.native?.accounts?.list?.())
      .then((res) => {
        if (cancelled) return;
        const active = res?.accounts?.find((a) => a.id === res?.activeId) || res?.accounts?.[0];
        if (active) setActiveAccount(active);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [account]);

  const currentUser = activeAccount || {
    name: social?.selfId || 'You',
    id: social?.selfId
  };

  useEffect(() => {
    let cancelled = false;
    Promise.resolve(window.native?.relay?.getGroups?.())
      .then((result) => { if (!cancelled) setGroups(result?.ok ? result.groups || [] : []); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingGroups(false); });
    return () => { cancelled = true; };
  }, []);

  const targets = useMemo(() => [
    ...(social?.friends || []).map((friend) => ({ ...friend, kind: 'friend' })),
    ...groups.map((group) => ({ ...group, kind: 'group' }))
  ], [groups, social?.friends]);

  const visible = targets.filter((target) =>
    `${target.nickname || ''} ${target.name || ''}`.toLowerCase().includes(query.trim().toLowerCase()));

  const toggle = (target) => {
    const key = targetKey(target);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const share = async () => {
    const recipients = targets.filter((target) => selected.has(targetKey(target)));
    if (!recipients.length || busy) return;
    setBusy(true);
    setError('');
    try {
      const { sent, failed } = await shareScreenshot({ cluster, shot, social, recipients, caption });
      if (failed) {
        setError(`Shared with ${sent} recipient${sent === 1 ? '' : 's'}; ${failed} failed.`);
        return;
      }
      onShared(recipients.length);
    } catch (reason) {
      setError(reason?.message || 'Could not share this screenshot.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sm-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section ref={dialogRef} className="sm-share-dialog" role="dialog" aria-modal="true" aria-label={`Share ${shot.name}`} tabIndex={-1}>
        <header>
          <div><span className="sm-kicker">RELAY SHARE</span><h2>Share screenshot</h2></div>
          <button onClick={onClose} disabled={busy} aria-label="Close share dialog"><X size={17}/></button>
        </header>

        <div className="sm-share-sender">
          <PlayerAvatar account={currentUser} size={32} />
          <div className="sm-share-sender-info">
            <span className="sm-share-sender-label">Sharing as</span>
            <div className="sm-share-sender-name-row">
              <strong className="sm-share-sender-name">{currentUser.name || currentUser.username || 'You'}</strong>
              <Badges user={currentUser} size={15} />
            </div>
          </div>
        </div>

        <div className="sm-share-shot">
          <div><ScreenshotThumbnail instanceId={cluster.id} shot={shot}/></div>
          <span><strong>{shot.name}</strong><small>{formatSize(shot.size)} · {formatDate(shot.modified)}</small></span>
        </div>

        <input
          className="sm-caption"
          value={caption}
          maxLength={2000}
          onChange={(event) => setCaption(event.target.value)}
          placeholder={`Add a message about ${shot.name}…`}
        />
        <label className="sm-recipient-search">
          <span>Send to</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find friends or groups…"/>
        </label>

        <div className="sm-target-list">
          {visible.map((target) => {
            const key = targetKey(target);
            const active = selected.has(key);
            return (
              <button key={key} className={active ? 'is-selected' : ''} onClick={() => toggle(target)}>
                <TargetAvatar target={target}/>
                <span><strong>{target.nickname || target.name}</strong><small>{target.kind === 'group' ? `${target.memberCount || target.members?.length || 0} members` : target.status || 'offline'}</small></span>
                <i>{active && <Check size={13}/>}</i>
              </button>
            );
          })}
          {!visible.length && <div className="sm-no-targets">{loadingGroups ? 'Loading your groups…' : 'No friends or groups match.'}</div>}
        </div>

        {error && <p className="sm-share-error" role="alert">{error}</p>}
        <footer>
          <span>{selected.size ? `${selected.size} selected` : 'Choose at least one recipient'}</span>
          <button className="sm-send" disabled={!selected.size || busy} onClick={share}>
            {busy ? <LoaderCircle className="is-spinning" size={15}/> : <Send size={15}/>} {busy ? 'Sharing…' : 'Share'}
          </button>
        </footer>
      </section>
    </div>
  );
}

export default function ScreenshotManager({ cluster, query = '', sortAlphabetically = false, social, account, onNotify }) {
  const previewRef = useRef(null);
  const [shots, setShots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);
  const [shareShot, setShareShot] = useState(null);
  const [busyName, setBusyName] = useState(null);

  useEscapeClose(() => setPreview(null), !preview || Boolean(shareShot));

  useEffect(() => { if (preview) previewRef.current?.focus(); }, [preview]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await window.native?.instance?.screenshotList?.(cluster.id);
      setShots(Array.isArray(result) ? result : []);
    } catch (reason) {
      setError(reason?.message || 'Could not load screenshots.');
    } finally {
      setLoading(false);
    }
  }, [cluster.id]);

  useEffect(() => { load(); }, [load]);

  const visible = useMemo(() => {
    const filtered = shots.filter((shot) => shot.name.toLowerCase().includes(query.trim().toLowerCase()));
    return filtered.sort((a, b) => sortAlphabetically ? a.name.localeCompare(b.name) : b.modified - a.modified);
  }, [query, shots, sortAlphabetically]);

  const remove = async (shot) => {
    if (!window.confirm(`Delete “${shot.name}”? This screenshot cannot be recovered.`)) return;
    setBusyName(shot.name);
    try {
      await window.native.instance.deleteScreenshot(cluster.id, shot.name);
      setPreview(null);
      await load();
      onNotify?.('Screenshot deleted', shot.name);
    } catch (reason) {
      setError(reason?.message || 'Could not delete screenshot.');
    } finally {
      setBusyName(null);
    }
  };

  const reveal = async (shot) => {
    try { await window.native.instance.revealScreenshot(cluster.id, shot.name); }
    catch (reason) { setError(reason?.message || 'Could not reveal screenshot.'); }
  };

  const openFolder = async () => {
    try { await window.native?.instance?.openFolder?.(cluster.id, 'screenshots'); }
    catch (reason) { setError(reason?.message || 'Could not open screenshots folder.'); }
  };

  const canShare = Boolean(social?.isNative && social?.uploadMedia && social?.sendMessage);
  const requestShare = (shot) => {
    if (!canShare) {
      onNotify?.('Native account required', 'Sign in to Native to share screenshots with Relay friends and groups.');
      return;
    }
    setPreview(null);
    setShareShot(shot);
  };

  const modalRoot = typeof document !== 'undefined' && document.body?.appendChild ? document.body : null;

  const previewModal = preview ? (
    <div className="sm-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreview(null); }}>
      <section ref={previewRef} className="sm-preview-dialog" role="dialog" aria-modal="true" aria-label={`Preview ${preview.name}`} tabIndex={-1}>
        <header><span><strong>{preview.name}</strong><small>{formatDate(preview.modified)} · {formatSize(preview.size)}</small></span><button onClick={() => setPreview(null)} aria-label="Close preview"><X size={18}/></button></header>
        <div className="sm-preview-image"><ScreenshotThumbnail instanceId={cluster.id} shot={preview} eager/></div>
        <footer><button onClick={() => reveal(preview)}><FolderOpen size={15}/> Show in folder</button><button onClick={() => requestShare(preview)}><Share2 size={15}/> Share</button><button className="is-danger" onClick={() => remove(preview)}><Trash2 size={15}/> Delete</button></footer>
      </section>
    </div>
  ) : null;

  const shareModal = shareShot ? (
    <ShareScreenshotDialog
      cluster={cluster}
      shot={shareShot}
      social={social}
      account={account}
      onClose={() => setShareShot(null)}
      onShared={(count) => {
        setShareShot(null);
        setPreview(null);
        onNotify?.('Screenshot shared', `Sent ${shareShot.name} to ${count} recipient${count === 1 ? '' : 's'}.`);
      }}
    />
  ) : null;

  return (
    <div className="im-content sm-manager">
      <div className="im-count" aria-live="polite">
        {loading ? 'Scanning screenshots…' : `${shots.length} screenshot${shots.length === 1 ? '' : 's'}${shots.length > 0 ? ` · ${sortAlphabetically ? 'A–Z' : 'Newest first'}` : ''}`}
      </div>

      <div className="im-panel sm-panel">
        <header className="im-upload-banner sm-upload-banner">
          <button
            type="button"
            className="sm-upload-banner-main"
            onClick={openFolder}
            title="Open screenshots folder"
            aria-label="Open screenshots folder"
          >
            <span className="im-upload-banner-icon">
              <Plus size={20}/>
            </span>
            <span className="im-upload-banner-info">
              <span className="im-upload-banner-title">Screenshots</span>
              <span className="im-upload-banner-subtitle">Preview and share your captures.</span>
            </span>
          </button>
          <button
            className="im-heading-refresh"
            onClick={load}
            disabled={loading}
            title="Refresh screenshots"
            aria-label="Refresh screenshots"
          >
            <RefreshCw size={14} className={loading ? 'is-spinning' : ''}/>
          </button>
        </header>

        {error && <div className="im-error" role="alert"><span>{error}</span><button onClick={load}><RefreshCw size={13}/> Retry</button></div>}

        {loading ? (
          <div className="sm-grid sm-loading-grid">{[0, 1, 2, 3, 4, 5].map((item) => <i key={item}/>)}</div>
        ) : visible.length ? (
          <div className="sm-grid">
            {visible.map((shot) => (
              <article className="sm-card" key={shot.name}>
                <button className="sm-card-preview" onClick={() => setPreview(shot)} aria-label={`Preview ${shot.name}`}>
                  <ScreenshotThumbnail instanceId={cluster.id} shot={shot}/>
                </button>
                <div className="sm-card-gradient"/>
                <div className="sm-card-info"><strong title={shot.name}>{shot.name}</strong><small>{formatDate(shot.modified)} · {formatSize(shot.size)}</small></div>
                <div className="sm-card-actions">
                  <button onClick={() => requestShare(shot)} title={canShare ? 'Share to Relay' : 'Sign in to Native to share'}><Share2 size={14}/></button>
                  <button onClick={() => reveal(shot)} title="Show in folder"><FolderOpen size={14}/></button>
                  <button className="is-danger" disabled={busyName === shot.name} onClick={() => remove(shot)} title="Delete screenshot"><Trash2 size={14}/></button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="im-empty">
            {shots.length ? 'No matches. Try another search or clear the filter.' : 'No screenshots found yet.'}
            {!shots.length && <span className="sm-empty-hint">Press F2 in Minecraft and your captures will appear here.</span>}
            {!shots.length && (
              <div className="im-empty-actions">
                <button type="button" className="im-empty-action-btn" onClick={openFolder}>Open screenshots folder</button>
              </div>
            )}
          </div>
        )}
      </div>

      {previewModal && (modalRoot ? createPortal(previewModal, modalRoot) : previewModal)}
      {shareModal && (modalRoot ? createPortal(shareModal, modalRoot) : shareModal)}
    </div>
  );
}
