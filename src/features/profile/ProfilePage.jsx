import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AtSign, ArrowLeft, CalendarDays, Clock3, Copy, Check, ExternalLink, Eye, Gamepad2, History, Link2, LoaderCircle,
  MessageSquare, Pencil, Plus, Shirt, Trash2, UserRound, Users, X
} from 'lucide-react';
import SkinViewer3D from '../../components/ui/SkinViewer3D.jsx';
import RelayAvatar from '../social/RelayAvatar.jsx';
import { BADGE_DEFS, getUserBadges, isPlusUser, PlusMark } from '../social/Badges.jsx';
import { formatPlaytime } from '../instances/playtimeStats.js';
import { PixelButton, PixelTabs } from '../../components/ui/PixelControls.jsx';
import './ProfilePage.css';

/** Anywhere in the app: window.dispatchEvent(new CustomEvent(OPEN_PROFILE_EVENT, { detail })) */
export const OPEN_PROFILE_EVENT = 'native:open-profile';
export function openProfile(detail) {
  if (!detail?.name) return;
  window.dispatchEvent(new CustomEvent(OPEN_PROFILE_EVENT, { detail }));
}

const MINECRAFT_NAME_URL = 'https://www.minecraft.net/en-us/msaprofile/mygames/editprofile';
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const LINK_TYPES = [
  ['website', 'Website'], ['youtube', 'YouTube'], ['twitch', 'Twitch'], ['tiktok', 'TikTok'],
  ['x', 'X'], ['instagram', 'Instagram'], ['discord', 'Discord'], ['github', 'GitHub']
];
const LINK_LABEL = Object.fromEntries(LINK_TYPES);

const formatDate = (stamp) => {
  if (!stamp) return null;
  const date = new Date(stamp);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
};

const relative = (stamp) => {
  if (!stamp) return null;
  const diff = Date.now() - stamp;
  if (diff < 60_000) return 'just now';
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days}d ago`;
  return formatDate(stamp);
};

function Stat({ icon: Icon, label, value, hint }) {
  return (
    <div className="pp-stat" title={hint || undefined}>
      <span className="pp-stat-icon"><Icon size={15} /></span>
      <div className="pp-stat-text">
        <span className="pp-stat-label">{label}</span>
        <strong className="pp-stat-value">{value ?? '—'}</strong>
      </div>
    </div>
  );
}

function AboutEditor({ about, onCancel, onSaved }) {
  const [bio, setBio] = useState(about.bio || '');
  const [links, setLinks] = useState(() => (about.links || []).map((l) => ({ ...l })));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    const clean = links.map((l) => ({ type: l.type, url: String(l.url || '').trim() })).filter((l) => l.url);
    const res = await window.native?.profiles?.saveAbout?.({ bio: bio.trim(), links: clean }).catch(() => null);
    setSaving(false);
    if (res?.ok) onSaved({ bio: res.bio ?? bio.trim(), links: res.links ?? clean });
    else setError(res?.error || 'Could not save your profile.');
  };

  return (
    <div className="pf-editor">
      <label className="pf-field">
        <span>About me</span>
        <textarea value={bio} maxLength={280} rows={3} placeholder="Say something about yourself" onChange={(e) => setBio(e.target.value)} />
        <small>{bio.length}/280</small>
      </label>
      <div className="pf-field">
        <span>Links</span>
        {links.map((link, index) => (
          <div className="pf-link-row" key={index}>
            <select value={link.type} onChange={(e) => setLinks((prev) => prev.map((l, i) => (i === index ? { ...l, type: e.target.value } : l)))}>
              {LINK_TYPES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
            <input value={link.url} maxLength={200} placeholder={link.type === 'discord' ? 'username' : 'https://'} onChange={(e) => setLinks((prev) => prev.map((l, i) => (i === index ? { ...l, url: e.target.value } : l)))} />
            <button type="button" className="pf-icon-btn" aria-label="Remove link" onClick={() => setLinks((prev) => prev.filter((_, i) => i !== index))}><Trash2 size={14} /></button>
          </div>
        ))}
        {links.length < 8 && (
          <button type="button" className="pf-ghost-btn" onClick={() => setLinks((prev) => [...prev, { type: 'website', url: '' }])}><Plus size={13} />Add link</button>
        )}
      </div>
      {error && <p className="pf-error">{error}</p>}
      <div className="pf-editor-actions">
        <button type="button" className="pf-ghost-btn" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="button" className="pf-primary-btn" onClick={save} disabled={saving}>{saving ? <LoaderCircle size={14} className="is-spinning" /> : <Check size={14} />}Save</button>
      </div>
    </div>
  );
}

function NameEditor({ account, profile, onRenamed }) {
  const [value, setValue] = useState(profile?.name || account?.name || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const isNativeAccount = account?.type === 'native' && !account?.linkedPremium;
  const canRename = isNativeAccount && profile?.canRename !== false;

  if (!canRename) {
    return (
      <div className="pf-name-note">
        <Gamepad2 size={16} />
        <div>
          <strong>Your name comes from Minecraft</strong>
          <span>{account?.type === 'microsoft' ? 'This is a Microsoft account.' : 'This account is merged with a Minecraft account.'} Change the name on minecraft.net, then sign in again here.</span>
        </div>
        <button type="button" className="pf-ghost-btn" onClick={() => window.native?.openExternal?.(MINECRAFT_NAME_URL)}><ExternalLink size={13} />minecraft.net</button>
      </div>
    );
  }

  const trimmed = value.trim();
  const valid = NAME_RE.test(trimmed);
  const unchanged = trimmed === (profile?.name || account?.name);
  const save = async () => {
    if (!valid || unchanged) return;
    setBusy(true);
    setError(null);
    const res = await window.native?.accounts?.renameNative?.(account.id, trimmed).catch(() => null);
    setBusy(false);
    if (res?.ok) onRenamed(res.name);
    else setError(res?.error || 'Could not change your name.');
  };

  return (
    <div className="pf-field">
      <span>Username</span>
      <div className="pf-rename-row">
        <AtSign size={14} className="pf-rename-at" />
        <input value={value} maxLength={16} spellCheck={false} onChange={(e) => { setValue(e.target.value); setError(null); }} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
        <button type="button" className="pf-primary-btn" disabled={busy || !valid || unchanged} onClick={save}>{busy ? <LoaderCircle size={14} className="is-spinning" /> : <Check size={14} />}Change</button>
      </div>
      <small className={error || (!valid && trimmed) ? 'is-error' : ''}>
        {error || (!valid && trimmed ? '3-16 letters, numbers or underscores.' : 'Your friends see the new name right away. You can change it 3 times a day.')}
      </small>
    </div>
  );
}

export default function ProfilePage({ target, account, selfStats, onClose, onMessage, onAccountsChanged }) {
  const [profile, setProfile] = useState(null);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('overview');
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState(target?.name);
  const dialogRef = useRef(null);
  const seed = target?.user || null;
  const isSelf = Boolean(target?.self);

  const load = useCallback(async (who) => {
    setStatus('loading');
    setError(null);
    const res = await window.native?.profiles?.get?.(who).catch(() => null);
    if (res?.ok && res.profile) {
      setProfile(res.profile);
      setStatus('ready');
    } else {
      setProfile(null);
      setStatus('error');
      setError(res?.offline ? 'You are offline.' : (res?.error || 'Could not load this profile.'));
    }
  }, []);

  useEffect(() => { setName(target?.name); setTab('overview'); setEditing(false); }, [target?.name, target?.nonce]);
  useEffect(() => {
    if (!name) return;
    load(name);
    if (!isSelf) window.native?.profiles?.view?.(name)?.catch?.(() => {});
  }, [name, isSelf, load]);

  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true });
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const merged = useMemo(() => ({ ...(seed || {}), ...(profile || {}), badges: profile?.badges?.length ? profile.badges : (seed?.badges || []) }), [seed, profile]);
  const badges = getUserBadges(merged);
  const plus = isPlusUser(merged);
  const displayName = profile?.name || seed?.name || name;
  const nickname = !isSelf && seed?.nickname && seed.nickname !== displayName ? seed.nickname : null;
  // Your own look comes from the launcher (freshest); others' from the server.
  const skinUrl = (isSelf && seed?.skinUrl) || profile?.current?.url || seed?.skinUrl || null;
  const model = (profile?.current?.model || seed?.model) === 'slim' ? 'slim' : 'classic';

  // Your own playtime is counted here and is always the freshest number.
  const playtimeSecs = isSelf && selfStats ? Math.max(selfStats.playtimeSecs || 0, profile?.playtimeSecs || 0) : profile?.playtimeSecs;
  const sessions = isSelf && selfStats ? Math.max(selfStats.sessionCount || 0, profile?.sessions || 0) : profile?.sessions;
  const lastPlayed = isSelf && selfStats ? Math.max(selfStats.lastPlayed || 0, profile?.lastPlayed || 0) : profile?.lastPlayed;
  const accountKind = profile ? (profile.native ? (profile.authType === 'merged' ? 'Merged' : profile.premium ? 'Premium' : 'Native') : 'Minecraft') : null;

  const copyUuid = () => {
    if (!profile?.uuid) return;
    navigator.clipboard?.writeText(profile.uuid).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => {});
  };

  const viewerAccount = useMemo(
    () => ({ id: `profile:${displayName}`, name: displayName, type: profile?.premium ? 'microsoft' : 'native', skinUrl, model, capeUrl: (isSelf && seed?.capeUrl) || profile?.mojangCape || null }),
    [displayName, skinUrl, model, profile?.premium, profile?.mojangCape, isSelf, seed?.capeUrl]
  );

  const onRenamed = (next) => {
    onAccountsChanged?.();
    setName(next);
  };

  const tabs = [
    { id: 'overview', label: 'Overview', icon: <UserRound size={14} /> },
    { id: 'names', label: 'Name history', icon: <History size={14} />, count: profile?.names?.length > 1 ? profile.names.length : null },
    { id: 'skins', label: 'Skins', icon: <Shirt size={14} />, count: profile?.skins?.length || null }
  ];

  return (
    <div className="pp-view" role="region" aria-label={`${displayName} profile`} tabIndex={-1} ref={dialogRef}>
      <header className="pp-header">
        <div className="pp-header-copy">
          <button type="button" className="pp-back" onClick={onClose}><ArrowLeft size={14} />Back</button>
          <h1 className="pp-title page-title">{isSelf ? 'My profile' : 'Profile'}</h1>
          <p className="pp-subtitle">{isSelf ? 'What your friends see when they open your profile.' : `@${displayName} on Native.`}</p>
        </div>
        <div className="pp-header-actions">
          {profile?.uuid && <PixelButton variant="ghost" icon={copied ? <Check size={15} /> : <Copy size={15} />} label={copied ? 'Copied' : 'Copy UUID'} title={profile.uuid} onClick={copyUuid} />}
          {isSelf && profile?.native && <PixelButton variant={editing ? 'primary' : 'ghost'} icon={editing ? <Check size={15} /> : <Pencil size={15} />} label={editing ? 'Done' : 'Edit profile'} onClick={() => { setTab('overview'); setEditing((v) => !v); }} />}
          {!isSelf && onMessage && target?.canMessage && <PixelButton icon={<MessageSquare size={15} />} label="Message" onClick={() => onMessage(target)} />}
        </div>
      </header>

      <div className="pp-workspace">
        <section className="pp-card pp-identity" aria-label="Player">
          <div className="pp-stage">
            {skinUrl || profile ? (
              <SkinViewer3D key={skinUrl || displayName} account={viewerAccount} cosmetics={isSelf ? target?.cosmetics || null : null} width={260} height={330} animation="idle" zoom={0.78} />
            ) : (
              <RelayAvatar name={displayName} size={96} />
            )}
          </div>
          <div className="pp-names">
            <div className="pp-name-row">
              <h2 title={nickname || displayName}>{nickname || displayName}</h2>
              {plus && <PlusMark size={18} />}
            </div>
            <div className="pp-sub-row">
              <span className="pp-handle">@{displayName}</span>
              {accountKind && <span className={`pp-chip is-${accountKind.toLowerCase()}`}>{accountKind}</span>}
              {isSelf && <span className="pp-chip is-self">You</span>}
            </div>
          </div>
          {badges.length > 0 && (
            <div className="pp-badges">
              {badges.map((key) => (
                <span key={key} className="pp-badge" title={BADGE_DEFS[key].description} style={{ '--pp-badge': BADGE_DEFS[key].gradient }}>
                  <span className="pp-badge-icon">{BADGE_DEFS[key].icon}</span>
                  {BADGE_DEFS[key].name}
                </span>
              ))}
            </div>
          )}
        </section>

        <div className="pp-main">
          <section className="pp-card pp-stats" aria-label="Stats">
            {status === 'loading' && !profile
              ? Array.from({ length: 6 }, (_, i) => <span key={i} className="pp-stat is-skeleton" style={{ animationDelay: `${i * 90}ms` }} />)
              : (
                <>
                  <Stat icon={Clock3} label="Playtime" value={playtimeSecs != null ? formatPlaytime(playtimeSecs) : null} hint={isSelf ? 'Counted by the launcher' : 'Reported by their launcher'} />
                  <Stat icon={Gamepad2} label="Sessions" value={sessions != null ? sessions.toLocaleString() : null} />
                  <Stat icon={History} label="Last played" value={relative(lastPlayed) || '—'} />
                  <Stat icon={CalendarDays} label="Member since" value={formatDate(profile?.joinedAt || seed?.memberSince) || (profile?.native ? 'Early member' : '—')} />
                  <Stat icon={Users} label="Friends" value={profile?.native ? (profile?.friends ?? 0).toLocaleString() : '—'} />
                  <Stat icon={Eye} label="Profile views" value={(profile?.views ?? 0).toLocaleString()} />
                </>
              )}
          </section>

          <div className="pp-tabs"><PixelTabs fill size="sm" label="Profile sections" value={tab} onChange={(id) => { setTab(id); if (id !== 'overview') setEditing(false); }} items={tabs} /></div>

          <section className="pp-card pp-body">
            {status === 'loading' && !profile ? (
              <div className="pp-skeleton" aria-label="Loading profile"><span /><span className="is-short" /></div>
            ) : status === 'error' ? (
              <div className="pp-empty">
                <p>{error}</p>
                <PixelButton variant="ghost" label="Try again" onClick={() => load(name)} />
              </div>
            ) : tab === 'overview' ? (
              editing && isSelf ? (
                <div className="pf-edit-stack">
                  <NameEditor account={account} profile={profile} onRenamed={onRenamed} />
                  <AboutEditor about={profile || {}} onCancel={() => setEditing(false)} onSaved={(about) => { setProfile((p) => ({ ...p, ...about })); setEditing(false); }} />
                </div>
              ) : (
                <>
                  <div className="pp-section">
                    <h3 className="pp-label">About me</h3>
                    {profile?.bio ? <p className="pp-bio">{profile.bio}</p> : <p className="pp-muted">{isSelf ? 'Add a few words about yourself with Edit profile.' : 'Nothing here yet.'}</p>}
                  </div>
                  {profile?.links?.length > 0 && (
                    <div className="pp-section">
                      <h3 className="pp-label">Links</h3>
                      <div className="pp-links">
                        {profile.links.map((link, i) => (
                          /^https?:/i.test(link.url) ? (
                            <button key={i} type="button" className="pp-link" onClick={() => window.native?.openExternal?.(link.url)}><Link2 size={13} />{LINK_LABEL[link.type] || 'Link'}<ExternalLink size={11} className="pp-link-out" /></button>
                          ) : (
                            <span key={i} className="pp-link is-static"><AtSign size={13} />{link.url}</span>
                          )
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )
            ) : tab === 'names' ? (
              profile?.names?.length ? (
                <ol className="pp-names-list">
                  {profile.names.map((entry, i) => (
                    <li key={`${entry.name}-${entry.at}`} className={i === 0 ? 'is-current' : ''}>
                      <strong>{entry.name}</strong>
                      <span>{i === 0 ? 'Current' : formatDate(entry.at)}</span>
                    </li>
                  ))}
                </ol>
              ) : <p className="pp-muted">No earlier names.</p>
            ) : (
              profile?.skins?.length ? (
                <div className="pp-skins">
                  {profile.skins.map((skin) => (
                    <div key={skin.hash} className={`pp-skin${skin.hash === profile.current?.hash ? ' is-current' : ''}`} title={`Worn ${formatDate(skin.firstSeen) || ''}`}>
                      <RelayAvatar name={`${displayName}:${skin.hash}`} skinUrl={skin.url} size={52} />
                      <span>{skin.hash === profile.current?.hash ? 'Current' : relative(skin.lastSeen)}</span>
                    </div>
                  ))}
                </div>
              ) : <p className="pp-muted">No skins recorded yet.</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
