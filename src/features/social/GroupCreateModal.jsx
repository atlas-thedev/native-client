import { useMemo, useRef, useState } from 'react';
import { Camera, Check, Search, X } from 'lucide-react';
import RelayAvatar from './RelayAvatar';
import GroupAvatarBadge from './GroupAvatarBadge';
import './GroupSettings.css';

const MAX_NAME = 32;

/**
 * Create-group flow: a round of "icon + name", then tick the friends to invite.
 * The image is uploaded through the existing social upload pipeline so the
 * server only ever stores a URL.
 */
export function GroupCreateModal({ open, friends = [], onClose, onCreate, uploadMedia }) {
  const fileInput = useRef(null);
  const [name, setName] = useState('');
  const [iconUrl, setIconUrl] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [selected, setSelected] = useState([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const visibleFriends = useMemo(() => {
    const term = query.trim().toLowerCase();
    const list = term
      ? friends.filter((friend) => (friend.nickname || friend.name || '').toLowerCase().includes(term))
      : friends;
    return [...list].sort((a, b) => (a.nickname || a.name || '').localeCompare(b.nickname || b.name || ''));
  }, [friends, query]);

  if (!open) return null;

  const reset = () => {
    setName('');
    setIconUrl(null);
    setSelected([]);
    setQuery('');
    setError(null);
  };

  const handleClose = () => {
    reset();
    onClose?.();
  };

  const pickImage = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Group icon must be an image file.');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const result = await uploadMedia?.(file);
      const url = result?.url || result?.mediaUrl;
      if (!url) throw new Error(result?.error || 'Upload failed.');
      setIconUrl(url);
    } catch (uploadError) {
      setError(uploadError.message || 'Could not upload that image.');
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    const cleanName = name.trim();
    if (!cleanName) {
      setError('Please enter a group name.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await onCreate?.({
      name: cleanName,
      iconUrl,
      memberIds: selected
    });
    setBusy(false);
    if (result?.ok === false) {
      setError(result.error || 'Could not create the group.');
      return;
    }
    reset();
    onClose?.();
  };

  const toggleFriend = (friendId) => {
    setSelected((previous) =>
      previous.includes(friendId) ? previous.filter((id) => id !== friendId) : [...previous, friendId]
    );
  };

  const statusText = (friend) =>
    friend.status === 'in-game' ? (friend.activity || 'In-game') : friend.status === 'offline' ? 'Offline' : 'Online';

  return (
    <div className="gs-scrim" onMouseDown={(event) => event.target === event.currentTarget && handleClose()}>
      <div className="gs-sheet gs-sheet--create" role="dialog" aria-label="Create group">
        <button type="button" className="gs-close" onClick={handleClose} aria-label="Close" title="Close">
          <X size={16} />
        </button>

        <div className="gs-create-head">
          <h2>New group</h2>
        </div>

        <div className="gs-scroll">
          <div className="gs-hero gs-hero--create">
            <button
              type="button"
              className={`gs-avatar${iconUrl || name.trim() ? '' : ' gs-avatar--empty'}`}
              onClick={() => fileInput.current?.click()}
              disabled={uploading}
              title="Upload group icon"
            >
              {iconUrl ? (
                <>
                  <img src={iconUrl} alt="Group icon" />
                  <span className="gs-avatar-edit"><Camera size={18} /></span>
                </>
              ) : name.trim() ? (
                <>
                  <GroupAvatarBadge name={name} size={96} />
                  <span className="gs-avatar-edit"><Camera size={18} /></span>
                </>
              ) : (
                <>
                  <Camera size={20} />
                  <span>{uploading ? 'Uploading…' : 'Add icon'}</span>
                </>
              )}
            </button>
            <input ref={fileInput} type="file" accept="image/*" hidden onChange={pickImage} />
            <input
              className="gs-name gs-name--create"
              value={name}
              maxLength={MAX_NAME}
              placeholder="Group name"
              aria-label="Group name"
              autoFocus
              onChange={(event) => {
                setName(event.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit();
              }}
            />
          </div>

          <div className="gs-pick-head">
            <h3>Add friends</h3>
            <span>optional</span>
          </div>

          <label className="gs-search">
            <Search size={14} />
            <input value={query} placeholder="Search friends" onChange={(event) => setQuery(event.target.value)} />
            {query && <button type="button" onClick={() => setQuery('')} aria-label="Clear"><X size={12} /></button>}
          </label>

          <div className="gs-pick-list">
            {friends.length === 0 ? (
              <p className="gs-empty">You haven’t added any friends yet. You can invite people later.</p>
            ) : visibleFriends.length === 0 ? (
              <p className="gs-empty">No friends match “{query}”.</p>
            ) : (
              visibleFriends.map((friend) => {
                const isChecked = selected.includes(friend.id);
                return (
                  <button
                    key={friend.id}
                    type="button"
                    className={`gs-pick${isChecked ? ' is-selected' : ''}`}
                    aria-pressed={isChecked}
                    onClick={() => toggleFriend(friend.id)}
                  >
                    <RelayAvatar name={friend.name} skinUrl={friend.skinUrl} size={34} />
                    <div className="gs-person-text">
                      <strong>{friend.nickname || friend.name}</strong>
                      <small>{statusText(friend)}</small>
                    </div>
                    <span className="gs-check">{isChecked && <Check size={12} strokeWidth={3} />}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {error && <div className="gs-error" role="alert" style={{ margin: '0 22px 8px' }}>{error}</div>}

        <footer className="gs-create-foot">
          <span className="gs-count">{selected.length ? `${selected.length} selected` : ''}</span>
          <button type="button" className="gs-link" onClick={handleClose}>Cancel</button>
          <button type="button" className="gs-primary" onClick={submit} disabled={busy || uploading || !name.trim()}>
            {busy ? 'Creating…' : 'Create group'}
          </button>
        </footer>
      </div>
    </div>
  );
}

export default GroupCreateModal;
