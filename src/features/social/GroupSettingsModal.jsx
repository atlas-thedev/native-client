import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import RelayAvatar from './RelayAvatar';
import GroupAvatarBadge from './GroupAvatarBadge';
import './GroupSettings.css';

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member' };
const rank = (role) => (role === 'owner' ? 3 : role === 'admin' ? 2 : 1);

/**
 * Group settings in one calm dialog: name/about/icon, the member list with
 * roles, and a place to add friends. Admins can rename, change the icon, add
 * and remove people; only the owner can change roles or delete the group.
 */
export function GroupSettingsModal({
  open,
  group,
  initialTab = 'overview',
  selfId,
  friends = [],
  onClose,
  onUpdateGroup,
  onAddMembers,
  onKickMember,
  onSetMemberRole,
  onLeaveGroup,
  onDeleteGroup,
  uploadMedia
}) {
  const fileInput = useRef(null);
  const [tab, setTab] = useState('overview');
  const [name, setName] = useState(group?.name || '');
  const [description, setDescription] = useState(group?.description || '');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirm, setConfirm] = useState(null); // 'leave' | 'delete' | null

  useEffect(() => {
    setTab(initialTab);
    setName(group?.name || '');
    setDescription(group?.description || '');
    setQuery('');
    setError(null);
    setConfirm(null);
  }, [group?.id, group?.name, group?.description, initialTab]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [open, onClose]);

  const members = group?.members || [];
  const myRole = members.find((member) => member.id === selfId)?.role || group?.role || 'member';
  const canModerate = rank(myRole) >= 2;
  const isOwner = myRole === 'owner';

  const addableFriends = useMemo(() => {
    const inGroup = new Set(members.map((member) => member.id));
    const term = query.trim().toLowerCase();
    return friends
      .filter((friend) => !inGroup.has(friend.id))
      .filter((friend) => !term || (friend.nickname || friend.name || '').toLowerCase().includes(term));
  }, [friends, members, query]);

  if (!open || !group) return null;

  const run = async (action) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      setBusy(false);
      if (result?.ok === false) setError(result.error || 'That action failed.');
      return result;
    } catch (err) {
      setBusy(false);
      setError(err.message || 'An error occurred.');
      return { ok: false, error: err.message };
    }
  };

  const changeImage = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await run(async () => {
      const upload = await uploadMedia?.(file);
      const url = upload?.url || upload?.mediaUrl;
      if (!url) return { ok: false, error: upload?.error || 'Upload failed.' };
      return onUpdateGroup?.(group.id, { iconUrl: url });
    });
  };

  const dirty = name.trim() !== (group.name || '') || description.trim() !== (group.description || '');
  const tabs = [
    ['overview', 'General'],
    ['members', 'Members', members.length],
    ...(canModerate ? [['invite', 'Add people']] : [])
  ];

  return (
    <div className="gs-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}>
      <div className="gs-dialog" role="dialog" aria-label="Group settings">
        <header className="gs-head">
          <button
            type="button"
            className="gs-icon"
            onClick={() => fileInput.current?.click()}
            disabled={!canModerate || busy}
            title={canModerate ? 'Change group icon' : undefined}
            data-testid="group-settings-icon-picker"
          >
            {group.iconUrl ? <img src={group.iconUrl} alt="" /> : <GroupAvatarBadge group={group} size={56} />}
            {canModerate && <span>Change</span>}
          </button>
          <input ref={fileInput} type="file" accept="image/*" hidden onChange={changeImage} />
          <div className="gs-title">
            <h2>{group.name}</h2>
            <p>{members.length} {members.length === 1 ? 'member' : 'members'} · you are {myRole === 'admin' ? 'an admin' : `the ${myRole}`}</p>
          </div>
          <button type="button" className="gs-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <X size={16} />
          </button>
        </header>

        <nav className="gs-tabs" aria-label="Group settings sections">
          {tabs.map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              className={tab === key ? 'active' : ''}
              aria-current={tab === key ? 'page' : undefined}
              onClick={() => setTab(key)}
              data-testid={`group-settings-${key}-tab`}
            >
              {label}{count != null && <span>{count}</span>}
            </button>
          ))}
        </nav>

        <div className="gs-body">
          {error && <div className="gs-error" role="alert">{error}</div>}

          {tab === 'overview' && (
            <>
              <label className="gs-field">
                <span>Group name</span>
                <input value={name} maxLength={32} disabled={!canModerate} onChange={(event) => setName(event.target.value)} />
              </label>
              <label className="gs-field">
                <span>About</span>
                <textarea
                  value={description}
                  maxLength={200}
                  rows={3}
                  disabled={!canModerate}
                  placeholder="What is this group for?"
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              {canModerate && (
                <div className="gs-row-actions">
                  {group.iconUrl ? (
                    <button type="button" className="gs-link" onClick={() => run(() => onUpdateGroup?.(group.id, { iconUrl: null }))}>
                      Remove icon
                    </button>
                  ) : <span />}
                  <button
                    type="button"
                    className="gs-primary"
                    disabled={!dirty || busy || !name.trim()}
                    onClick={() => run(() => onUpdateGroup?.(group.id, { name: name.trim(), description: description.trim() }))}
                  >
                    {busy ? 'Saving…' : 'Save changes'}
                  </button>
                </div>
              )}

              <div className="gs-danger">
                {confirm ? (
                  <div className="gs-confirm">
                    <span>{confirm === 'delete' ? 'Delete this group for everyone? This can’t be undone.' : 'Leave this group?'}</span>
                    <button type="button" className="gs-link" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
                    <button
                      type="button"
                      className="gs-danger-btn"
                      disabled={busy}
                      onClick={() => run(async () => {
                        const result = confirm === 'delete' ? await onDeleteGroup?.(group.id) : await onLeaveGroup?.(group.id);
                        onClose?.();
                        return result;
                      })}
                    >
                      {confirm === 'delete' ? 'Delete group' : 'Leave group'}
                    </button>
                  </div>
                ) : (
                  <>
                    <button type="button" className="gs-link is-danger" onClick={() => setConfirm('leave')}>Leave group</button>
                    {isOwner && <button type="button" className="gs-link is-danger" onClick={() => setConfirm('delete')}>Delete group</button>}
                  </>
                )}
              </div>
            </>
          )}

          {tab === 'members' && (
            <ul className="gs-list">
              {members.map((member) => {
                const isSelf = member.id === selfId;
                const canActOn = canModerate && !isSelf && rank(member.role) < rank(myRole);
                return (
                  <li key={member.id} className="gs-person">
                    <RelayAvatar name={member.name} size={34} status={member.status} showStatus />
                    <div className="gs-person-text">
                      <strong>{member.name}{isSelf ? ' (you)' : ''}</strong>
                      <small>{ROLE_LABEL[member.role] || member.role} · {member.status === 'offline' ? 'Offline' : member.activity || 'Online'}</small>
                    </div>
                    <div className="gs-person-actions">
                      {isOwner && !isSelf && member.role === 'member' && (
                        <button type="button" disabled={busy} onClick={() => run(() => onSetMemberRole?.(group.id, member.id, 'admin'))}>Make admin</button>
                      )}
                      {isOwner && !isSelf && member.role === 'admin' && (
                        <button type="button" disabled={busy} onClick={() => run(() => onSetMemberRole?.(group.id, member.id, 'member'))}>Remove admin</button>
                      )}
                      {canActOn && (
                        <button type="button" className="is-danger" disabled={busy} onClick={() => run(() => onKickMember?.(group.id, member.id))}>Remove</button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {tab === 'invite' && canModerate && (
            <>
              <label className="gs-search">
                <Search size={14} />
                <input value={query} placeholder="Search friends" onChange={(event) => setQuery(event.target.value)} />
                {query && <button type="button" onClick={() => setQuery('')} aria-label="Clear"><X size={12} /></button>}
              </label>
              {friends.length === 0 ? (
                <p className="gs-empty">You have no friends to add yet.</p>
              ) : addableFriends.length === 0 ? (
                <p className="gs-empty">{query ? 'No friends match that search.' : 'Everyone you know is already in this group.'}</p>
              ) : (
                <ul className="gs-list">
                  {addableFriends.map((friend) => (
                    <li key={friend.id} className="gs-person">
                      <RelayAvatar name={friend.name} skinUrl={friend.skinUrl} size={34} />
                      <div className="gs-person-text">
                        <strong>{friend.nickname || friend.name}</strong>
                        <small>{friend.status === 'in-game' ? (friend.activity || 'In-game') : friend.status === 'offline' ? 'Offline' : 'Online'}</small>
                      </div>
                      <button type="button" className="gs-add" disabled={busy} onClick={() => run(() => onAddMembers?.(group.id, [friend.id]))}>Add</button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default GroupSettingsModal;
