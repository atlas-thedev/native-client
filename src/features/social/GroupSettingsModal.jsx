import { useEffect, useMemo, useRef, useState } from 'react';
import { BellOff, Camera, Search, X } from 'lucide-react';
import RelayAvatar from './RelayAvatar';
import GroupAvatarBadge from './GroupAvatarBadge';
import './GroupSettings.css';

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: '' };
const rank = (role) => (role === 'owner' ? 3 : role === 'admin' ? 2 : 1);

/**
 * Group info as one calm page: icon, name and about at the top, a mute switch,
 * the member list with an inline "Add people" drawer, and leave/delete at the
 * bottom. Read-only text for members; admins edit in place.
 */
export function GroupSettingsModal({
  open,
  group,
  initialTab = 'overview',
  selfId,
  friends = [],
  muted = false,
  onToggleMute,
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
  const [name, setName] = useState(group?.name || '');
  const [description, setDescription] = useState(group?.description || '');
  const [adding, setAdding] = useState(initialTab === 'invite');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirm, setConfirm] = useState(null); // 'leave' | 'delete' | null

  useEffect(() => {
    setName(group?.name || '');
    setDescription(group?.description || '');
    setAdding(initialTab === 'invite');
    setQuery('');
    setError(null);
    setConfirm(null);
  }, [group?.id, group?.name, group?.description, initialTab, open]);

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
  const memberLabel = `${members.length} ${members.length === 1 ? 'member' : 'members'}`;

  const sortedMembers = [...members].sort(
    (a, b) => rank(b.role) - rank(a.role) || (a.name || '').localeCompare(b.name || '')
  );

  return (
    <div className="gs-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}>
      <div className="gs-sheet" role="dialog" aria-label="Group settings">
        <button type="button" className="gs-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <X size={16} />
        </button>

        <div className="gs-scroll">
          <header className="gs-hero" data-testid="group-settings-overview-tab">
            <button
              type="button"
              className="gs-avatar"
              onClick={() => fileInput.current?.click()}
              disabled={!canModerate || busy}
              title={canModerate ? 'Change group icon' : undefined}
              data-testid="group-settings-icon-picker"
            >
              <GroupAvatarBadge group={group} size={96} />
              {canModerate && <span className="gs-avatar-edit"><Camera size={18} /></span>}
            </button>
            <input ref={fileInput} type="file" accept="image/*" hidden onChange={changeImage} />
            {canModerate && group.iconUrl && (
              <button type="button" className="gs-link" onClick={() => run(() => onUpdateGroup?.(group.id, { iconUrl: null }))}>
                Remove icon
              </button>
            )}

            {canModerate ? (
              <input
                className="gs-name"
                value={name}
                maxLength={32}
                aria-label="Group name"
                placeholder="Group name"
                onChange={(event) => setName(event.target.value)}
              />
            ) : (
              <h2 className="gs-name-static">{group.name}</h2>
            )}
            <p className="gs-meta">{memberLabel}{!canModerate && myRole === 'member' ? '' : ` · you’re ${myRole === 'admin' ? 'an admin' : 'the owner'}`}</p>

            {canModerate ? (
              <textarea
                className="gs-about"
                value={description}
                maxLength={200}
                rows={1}
                aria-label="About"
                placeholder="Add a description"
                onChange={(event) => setDescription(event.target.value)}
              />
            ) : group.description ? (
              <p className="gs-about-static">{group.description}</p>
            ) : null}

            {canModerate && dirty && (
              <div className="gs-save">
                <button type="button" className="gs-link" disabled={busy} onClick={() => { setName(group.name || ''); setDescription(group.description || ''); }}>
                  Reset
                </button>
                <button
                  type="button"
                  className="gs-primary"
                  disabled={busy || !name.trim()}
                  onClick={() => run(() => onUpdateGroup?.(group.id, { name: name.trim(), description: description.trim() }))}
                >
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            )}
          </header>

          {error && <div className="gs-error" role="alert">{error}</div>}

          {onToggleMute && (
            <button type="button" className="gs-row gs-switch-row" role="switch" aria-checked={muted} onClick={onToggleMute}>
              <BellOff size={16} />
              <span>Mute notifications</span>
              <i className={`gs-switch${muted ? ' on' : ''}`} aria-hidden="true" />
            </button>
          )}

          <section className="gs-section">
            <div className="gs-section-head" data-testid="group-settings-members-tab">
              <h3>Members <span>{members.length}</span></h3>
              {canModerate && (
                <button type="button" className="gs-link" data-testid="group-settings-invite-tab" onClick={() => setAdding((v) => !v)}>
                  {adding ? 'Done' : 'Add people'}
                </button>
              )}
            </div>

            {adding && canModerate && (
              <div className="gs-add-panel">
                <label className="gs-search">
                  <Search size={14} />
                  <input value={query} placeholder="Search friends" autoFocus onChange={(event) => setQuery(event.target.value)} />
                  {query && <button type="button" onClick={() => setQuery('')} aria-label="Clear"><X size={12} /></button>}
                </label>
                {friends.length === 0 ? (
                  <p className="gs-empty">You have no friends to add yet.</p>
                ) : addableFriends.length === 0 ? (
                  <p className="gs-empty">{query ? 'No friends match that search.' : 'Everyone you know is already here.'}</p>
                ) : (
                  <ul className="gs-list gs-list--tight">
                    {addableFriends.map((friend) => (
                      <li key={friend.id} className="gs-person">
                        <RelayAvatar name={friend.name} skinUrl={friend.skinUrl} size={32} />
                        <div className="gs-person-text">
                          <strong>{friend.nickname || friend.name}</strong>
                          <small>{friend.status === 'in-game' ? (friend.activity || 'In-game') : friend.status === 'offline' ? 'Offline' : 'Online'}</small>
                        </div>
                        <button type="button" className="gs-add" disabled={busy} onClick={() => run(() => onAddMembers?.(group.id, [friend.id]))}>Add</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <ul className="gs-list">
              {sortedMembers.map((member) => {
                const isSelf = member.id === selfId;
                const canActOn = canModerate && !isSelf && rank(member.role) < rank(myRole);
                const role = ROLE_LABEL[member.role] || '';
                return (
                  <li key={member.id} className="gs-person">
                    <RelayAvatar name={member.name} size={36} status={member.status} showStatus />
                    <div className="gs-person-text">
                      <strong>{member.name}{isSelf ? ' (you)' : ''}</strong>
                      <small>{member.status === 'offline' ? 'Offline' : member.activity || 'Online'}</small>
                    </div>
                    <div className={`gs-person-end${isOwner && !isSelf || canActOn ? ' has-actions' : ''}`}>
                    {role && <em className="gs-role">{role}</em>}
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
                    </div>
                  </li>
                );
              })}
              {members.length === 0 && <li className="gs-empty">No one here yet.</li>}
            </ul>
          </section>

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
                    if (result?.ok !== false) onClose?.();
                    return result;
                  })}
                >
                  {confirm === 'delete' ? 'Delete' : 'Leave'}
                </button>
              </div>
            ) : (
              <>
                <button type="button" className="gs-row is-danger" onClick={() => setConfirm('leave')}>Leave group</button>
                {isOwner && <button type="button" className="gs-row is-danger" onClick={() => setConfirm('delete')}>Delete group</button>}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default GroupSettingsModal;
