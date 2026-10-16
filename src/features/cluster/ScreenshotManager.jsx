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
  X
} from 'lucide-react';
import PlayerAvatar from '../../components/ui/PlayerAvatar.jsx';
import RelayAvatar from '../social/RelayAvatar.jsx';
import { GroupAvatarBadge } from '../social/GroupAvatarBadge.jsx';
import Badges, { isPlusUser, PlusMark } from '../social/Badges.jsx';
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

const displayName = (target) => target.nickname || target.name || (target.kind === 'group' ? 'Group' : 'Friend');

/** Same wording and colours as the Relay inbox, so a friend looks the same here as there. */
export function presenceOf(target) {
  if (target.kind === 'group') {
    const count = target.memberCount || target.members?.length || 0;
    return { status: 'group', rank: 3, text: `${count} member${count === 1 ? '' : 's'}`, color: '#23a55a' };
  }
  const status = String(target.status || 'offline').toLowerCase();
  if (status === 'in-game' || status === 'in-menus') return { status: 'in-game', rank: 0, text: target.activity || 'Playing Minecraft', color: '#d9a6da' };
  if (status === 'online' || status === 'in-launcher') return { status: 'online', rank: 1, text: 'In launcher', color: '#23a55a' };
  return { status: 'offline', rank: 2, text: target.lastSeen || 'Offline', color: '#80848e' };
}

/** A friend's real face (their Native or Minecraft skin) with a presence dot, or the group's picture. */
function TargetAvatar({ target, size = 36, dot = true }) {
  const presence = presenceOf(target);
  return (
    <span className={`sm-target-avatar is-${target.kind}`} style={{ width: size, height: size }}>
      {target.kind === 'group'
        ? <GroupAvatarBadge group={target} size={size}/>
        : <RelayAvatar name={target.name} skinUrl={target.skinUrl} size={size} className="sm-target-face"/>}
      {dot && target.kind !== 'group' && <span className="sm-target-presence" data-status={presence.status} style={{ backgroundColor: presence.color }}/>}
    </span>
  );
}

/** The data URL's file name: a picture that had to be saved as JPEG gets a .jpg name. */
function uploadName(name, dataUrl) {
  if (/^data:image\/jpeg/i.test(dataUrl) && !/\.jpe?g$/i.test(name)) return name.replace(/\.[^.]+$/, '') + '.jpg';
  return name;
}

/** Reads the picture (shrunk when it would be too big for the server) and uploads it once. */
export async function uploadScreenshot({ cluster, shot, social }) {
  const dataUrl = await window.native.instance.screenshotData(cluster.id, shot.name, { thumbnail: false, share: true });
  const name = uploadName(shot.name, dataUrl);
  const upload = await social.uploadMedia(dataUrl, name);
  if (!upload?.ok || !upload.url) throw new Error(upload?.error || 'Screenshot upload failed.');
  return { url: upload.url, name };
}

/**
 * Sends a screenshot to friends and groups. The picture is uploaded once (pass {@code upload} from an earlier try to
 * skip that) and one failing recipient never stops the others; the result says who got it and who did not.
 */
export async function shareScreenshot({ cluster, shot, social, recipients, caption = '', upload = null }) {
  const uploaded = upload || await uploadScreenshot({ cluster, shot, social });
  const message = caption.trim().slice(0, 2000) || `Screenshot from ${cluster.name || cluster.mc_version || cluster.version || 'Minecraft'}`;
  const media = {
    mediaUrl: uploaded.url,
    mediaName: uploaded.name,
    mediaKind: 'image',
    isMedia: true
  };
  const results = await Promise.all(recipients.map(async (target) => {
    try {
      const result = target.kind === 'group'
        ? await window.native.relay.sendGroupMessage(target.id, { content: message, ...media })
        : await social.sendMessage(target.id, message, media);
      return { target, ok: Boolean(result?.ok), error: result?.ok ? '' : (result?.error || 'Not delivered') };
    } catch (reason) {
      return { target, ok: false, error: reason?.message || 'Not delivered' };
    }
  }));
  const failedTargets = results.filter((entry) => !entry.ok).map(({ target, error }) => ({ key: targetKey(target), name: displayName(target), error }));
  const sentTargets = results.filter((entry) => entry.ok).map(({ target }) => targetKey(target));
  return { sent: sentTargets.length, failed: failedTargets.length, total: results.length, failedTargets, sentTargets, upload: uploaded };
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
  const [sentKeys, setSentKeys] = useState(() => new Set());
  const [failedMap, setFailedMap] = useState({});
  const uploadRef = useRef(null);

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

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return targets
      .filter((target) => `${target.nickname || ''} ${target.name || ''}`.toLowerCase().includes(needle))
      .sort((a, b) => presenceOf(a).rank - presenceOf(b).rank || displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base' }));
  }, [targets, query]);
  const friendRows = visible.filter((target) => target.kind === 'friend');
  const groupRows = visible.filter((target) => target.kind === 'group');
  const chosen = targets.filter((target) => selected.has(targetKey(target)) && !sentKeys.has(targetKey(target)));

  const toggle = (target) => {
    const key = targetKey(target);
    if (sentKeys.has(key)) return;
    setFailedMap((current) => { if (!current[key]) return current; const next = { ...current }; delete next[key]; return next; });
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const share = async () => {
    const recipients = chosen;
    if (!recipients.length || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await shareScreenshot({ cluster, shot, social, recipients, caption, upload: uploadRef.current });
      uploadRef.current = result.upload; // a retry sends the same upload instead of uploading again
      const nowSent = new Set([...sentKeys, ...result.sentTargets]);
      setSentKeys(nowSent);
      if (result.failed) {
        const map = {};
        result.failedTargets.forEach((entry) => { map[entry.key] = entry.error; });
        setFailedMap(map);
        setError(`Sent to ${nowSent.size}, but not to ${result.failedTargets.map((entry) => entry.name).join(', ')}. Press Retry to try them again.`);
        return;
      }
      onShared(nowSent.size);
    } catch (reason) {
      setError(reason?.message || 'Could not share this screenshot.');
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      share();
    }
  };

  const message = caption.trim() || `Screenshot from ${cluster.name || cluster.mc_version || cluster.version || 'Minecraft'}`;

  const renderRow = (target) => {
    const key = targetKey(target);
    const active = selected.has(key);
    const sent = sentKeys.has(key);
    const failed = failedMap[key];
    const presence = presenceOf(target);
    return (
      <button key={key} className={`${active ? 'is-selected' : ''} ${sent ? 'is-sent' : ''} ${failed ? 'is-failed' : ''}`} onClick={() => toggle(target)} disabled={busy || sent}>
        <TargetAvatar target={target}/>
        <span>
          <strong>{displayName(target)}{target.kind === 'friend' && isPlusUser(target) && <PlusMark size={12}/>}</strong>
          <small style={failed ? undefined : { color: target.kind === 'friend' && presence.status !== 'offline' ? presence.color : undefined }}>
            {sent ? 'Sent' : failed ? `Failed: ${failed}` : presence.text}
          </small>
        </span>
        <i>{(active || sent) && <Check size={13}/>}</i>
      </button>
    );
  };

  return (
    <div className="sm-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section ref={dialogRef} className="sm-share-dialog" role="dialog" aria-modal="true" aria-label={`Share ${shot.name}`} tabIndex={-1} onKeyDown={onKeyDown}>
        <header>
          <div><span className="sm-kicker">RELAY SHARE</span><h2>Share screenshot</h2></div>
          <button onClick={onClose} disabled={busy} aria-label="Close share dialog"><X size={17}/></button>
        </header>

        <div className="sm-share-body">
          <div className="sm-share-preview" aria-label="How it will look in chat">
            <PlayerAvatar account={currentUser} size={34} />
            <div className="sm-share-bubble">
              <span className="sm-share-sender-label">Sharing as</span>
              <div className="sm-share-sender-name-row">
                <strong className="sm-share-sender-name">{currentUser.name || currentUser.username || 'You'}</strong>
                <Badges user={currentUser} size={14} />
                <small>now</small>
              </div>
              <p>{message}</p>
              <div className="sm-share-image"><ScreenshotThumbnail instanceId={cluster.id} shot={shot}/></div>
              <small className="sm-share-file">{shot.name} · {formatSize(shot.size)} · {formatDate(shot.modified)}</small>
            </div>
          </div>

          <input
            className="sm-caption"
            value={caption}
            maxLength={2000}
            onChange={(event) => setCaption(event.target.value)}
            placeholder="Add a message (optional)…"
            disabled={busy}
          />

          {chosen.length > 0 && (
            <div className="sm-chips" aria-label="Sending to">
              {chosen.map((target) => (
                <button key={targetKey(target)} className="sm-chip" onClick={() => toggle(target)} disabled={busy} title="Remove">
                  <TargetAvatar target={target} size={20} dot={false}/>
                  <span>{displayName(target)}</span>
                  <X size={11}/>
                </button>
              ))}
            </div>
          )}

          <label className="sm-recipient-search">
            <span>Send to</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find friends or groups…"/>
          </label>

          <div className="sm-target-list">
            {friendRows.length > 0 && <div className="sm-section-label">Friends</div>}
            {friendRows.map(renderRow)}
            {groupRows.length > 0 && <div className="sm-section-label">Groups</div>}
            {groupRows.map(renderRow)}
            {!visible.length && <div className="sm-no-targets">{loadingGroups ? 'Loading your groups…' : targets.length ? 'No friends or groups match.' : 'Add friends in Relay to share screenshots with them.'}</div>}
          </div>
        </div>

        {error && <p className="sm-share-error" role="alert">{error}</p>}
        <footer>
          <span>{chosen.length ? `${chosen.length} selected · Ctrl+Enter to send` : sentKeys.size ? `${sentKeys.size} sent` : 'Choose at least one recipient'}</span>
          <button className="sm-send" disabled={!chosen.length || busy} onClick={share}>
            {busy ? <LoaderCircle className="is-spinning" size={15}/> : <Send size={15}/>} {busy ? 'Sending…' : Object.keys(failedMap).length ? `Retry ${chosen.length}` : 'Share'}
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
