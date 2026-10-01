import React, { useState, useMemo } from 'react';
import {
  Ban,
  Check,
  Clock,
  MessageSquare,
  MoreVertical,
  Search,
  Trash2,
  UserCheck,
  UserMinus,
  UserPlus,
  Users,
  X,
  XCircle
} from 'lucide-react';
import RelayAvatar from './RelayAvatar.jsx';
import Badges from './Badges.jsx';
import './FriendsHome.css';

export default function FriendsHome({
  social,
  selfId,
  initialTab = 'online',
  onOpenChat,
  onNotify
}) {
  const [activeTab, setActiveTab] = useState(initialTab); // 'online' | 'all' | 'pending' | 'blocked' | 'add'
  const [searchQuery, setSearchQuery] = useState('');
  const [addUsername, setAddUsername] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [actionNotice, setActionNotice] = useState(null);

  const friends = social?.friends || [];
  const requests = social?.requests || { received: [], sent: [] };
  const blocked = social?.blocked || [];

  const onlineFriends = useMemo(() => {
    return friends.filter((f) => {
      const s = String(f.status || 'offline').toLowerCase();
      return s === 'in-game' || s === 'online' || s === 'in-launcher' || s === 'in-menus';
    });
  }, [friends]);

  const filteredFriends = useMemo(() => {
    const list = activeTab === 'online' ? onlineFriends : friends;
    const q = searchQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter((f) => {
      const name = (f.nickname || f.name || '').toLowerCase();
      const activity = (f.activity || '').toLowerCase();
      return name.includes(q) || activity.includes(q);
    });
  }, [activeTab, onlineFriends, friends, searchQuery]);

  const handleSendRequest = async (e) => {
    e?.preventDefault();
    const target = addUsername.trim();
    if (!target) return;

    setBusyId('add');
    setActionNotice(null);
    try {
      const res = await social?.sendRequest?.(target);
      if (res?.ok) {
        setAddUsername('');
        setActionNotice({
          type: 'success',
          text: res.mutual ? `Success! ${target} is now your friend.` : `Friend request sent to ${target}!`
        });
      } else {
        setActionNotice({
          type: 'error',
          text: res?.error || `Could not send friend request to "${target}".`
        });
      }
    } catch (err) {
      setActionNotice({ type: 'error', text: err.message });
    } finally {
      setBusyId(null);
    }
  };

  const handleRespond = async (request, action) => {
    setBusyId(request.id);
    setActionNotice(null);
    try {
      const res = await social?.respondRequest?.(request.id, action);
      if (res?.ok) {
        if (action === 'accept') onNotify?.('Friend Added', `${request.name} is now your friend!`);
      } else {
        setActionNotice({ type: 'error', text: res?.error || 'Failed to update request.' });
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleUnfriend = async (friend) => {
    if (!window.confirm?.(`Remove ${friend.nickname || friend.name} from your friends?`)) return;
    await social?.unfriend?.(friend.id);
    onNotify?.('Friend Removed', `Removed ${friend.name}`);
  };

  const handleBlock = async (friend) => {
    if (!window.confirm?.(`Block ${friend.nickname || friend.name}?`)) return;
    await social?.block?.(friend.id);
    onNotify?.('User Blocked', `Blocked ${friend.name}`);
  };

  const handleUnblock = async (user) => {
    await social?.unblock?.(user.id);
    onNotify?.('User Unblocked', `Unblocked ${user.name}`);
  };

  return (
    <div className="noctra-embedded-friends">
      {/* Discord-style Top Tabs Bar */}
      <div className="noctra-friends-tab-bar">
        <div className="noctra-friends-brand">
          <Users size={18} className="text-muted" />
          <span>Friends</span>
        </div>

        <div className="noctra-friends-tabs-right">
          <button
            type="button"
            className={`noctra-friend-tab ${activeTab === 'online' ? 'is-active' : ''}`}
            onClick={() => { setActiveTab('online'); setActionNotice(null); }}
          >
            Online <b>{onlineFriends.length}</b>
          </button>

          <button
            type="button"
            className={`noctra-friend-tab ${activeTab === 'all' ? 'is-active' : ''}`}
            onClick={() => { setActiveTab('all'); setActionNotice(null); }}
          >
            All <b>{friends.length}</b>
          </button>

          <button
            type="button"
            className={`noctra-friend-tab ${activeTab === 'pending' ? 'is-active' : ''}`}
            onClick={() => { setActiveTab('pending'); setActionNotice(null); }}
          >
            Pending
            {(requests.received.length + requests.sent.length) > 0 && (
              <em className="noctra-pending-badge">{requests.received.length + requests.sent.length}</em>
            )}
          </button>

          <button
            type="button"
            className={`noctra-friend-tab ${activeTab === 'blocked' ? 'is-active' : ''}`}
            onClick={() => { setActiveTab('blocked'); setActionNotice(null); }}
          >
            Blocked <b>{blocked.length}</b>
          </button>

          <div className="noctra-tab-divider" />

          <button
            type="button"
            className={`noctra-friend-tab-btn ${activeTab === 'add' ? 'is-active' : ''}`}
            onClick={() => { setActiveTab('add'); setActionNotice(null); }}
          >
            <UserPlus size={14} />
            <span>Add Friend</span>
          </button>
        </div>
      </div>

      {/* Main Body */}
      <div className="noctra-friends-body">
        {actionNotice && (
          <div className={`noctra-friends-notice ${actionNotice.type}`}>
            <span>{actionNotice.text}</span>
            <button type="button" onClick={() => setActionNotice(null)}><X size={14} /></button>
          </div>
        )}

        {activeTab === 'add' ? (
          <div className="noctra-add-friend-panel">
            <h3>ADD FRIEND</h3>
            <p>You can add friends with their exact Noctra or Minecraft username.</p>
            <form className="noctra-add-friend-form" onSubmit={handleSendRequest}>
              <div className="noctra-add-input-wrap">
                <input
                  type="text"
                  placeholder="You can add friends with their username"
                  value={addUsername}
                  onChange={(e) => setAddUsername(e.target.value)}
                  autoFocus
                />
                <button
                  type="submit"
                  disabled={!addUsername.trim() || busyId === 'add'}
                  className="noctra-btn-send-req"
                >
                  Send Friend Request
                </button>
              </div>
            </form>
          </div>
        ) : activeTab === 'pending' ? (
          <div className="noctra-requests-panel">
            <span className="noctra-list-section-title">
              PENDING — {requests.received.length + requests.sent.length}
            </span>
            {requests.received.length === 0 && requests.sent.length === 0 && (
              <div className="noctra-empty-friends">
                <Users size={40} className="text-muted" />
                <p>There are no pending friend requests.</p>
              </div>
            )}

            {requests.received.map((req) => (
              <div key={req.id} className="noctra-request-row">
                <RelayAvatar name={req.name} skinUrl={req.skinUrl} size={40} />
                <div className="noctra-req-info">
                  <strong>{req.name}</strong>
                  <span>Incoming Friend Request</span>
                </div>
                <div className="noctra-req-actions">
                  <button
                    type="button"
                    className="btn-req-accept"
                    disabled={busyId === req.id}
                    onClick={() => handleRespond(req, 'accept')}
                    title="Accept"
                  >
                    <Check size={18} />
                  </button>
                  <button
                    type="button"
                    className="btn-req-decline"
                    disabled={busyId === req.id}
                    onClick={() => handleRespond(req, 'decline')}
                    title="Decline"
                  >
                    <X size={18} />
                  </button>
                </div>
              </div>
            ))}

            {requests.sent.map((req) => (
              <div key={req.id} className="noctra-request-row">
                <RelayAvatar name={req.name} skinUrl={req.skinUrl} size={40} />
                <div className="noctra-req-info">
                  <strong>{req.name}</strong>
                  <span>Outgoing Friend Request</span>
                </div>
                <div className="noctra-req-actions">
                  <button
                    type="button"
                    className="btn-req-cancel"
                    disabled={busyId === req.id}
                    onClick={() => handleRespond(req, 'cancel')}
                    title="Cancel Request"
                  >
                    <XCircle size={15} />
                    <span>Cancel</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : activeTab === 'blocked' ? (
          <div className="noctra-blocked-panel">
            <span className="noctra-list-section-title">BLOCKED USERS — {blocked.length}</span>
            {blocked.length === 0 ? (
              <div className="noctra-empty-friends">
                <Ban size={40} className="text-muted" />
                <p>You haven't blocked anyone.</p>
              </div>
            ) : (
              blocked.map((u) => (
                <div key={u.id} className="noctra-friend-row">
                  <RelayAvatar name={u.name} size={40} />
                  <div className="noctra-friend-row-info">
                    <strong>{u.name}</strong>
                    <span>Blocked</span>
                  </div>
                  <button
                    type="button"
                    className="btn-unblock"
                    onClick={() => handleUnblock(u)}
                  >
                    Unblock
                  </button>
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="noctra-friends-list-panel">
            {/* Search filter bar */}
            <div className="noctra-friends-search-box">
              <Search size={15} className="text-muted" />
              <input
                type="text"
                placeholder="Search friends"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button type="button" onClick={() => setSearchQuery('')}><X size={14} /></button>
              )}
            </div>

            <span className="noctra-list-section-title">
              {activeTab === 'online' ? `ONLINE — ${filteredFriends.length}` : `ALL FRIENDS — ${filteredFriends.length}`}
            </span>

            {filteredFriends.length === 0 ? (
              <div className="noctra-empty-friends">
                <Users size={40} className="text-muted" />
                <p>{searchQuery ? 'No friends found matching your search.' : (activeTab === 'online' ? 'No one is online right now.' : 'You have no friends yet.')}</p>
              </div>
            ) : (
              filteredFriends.map((friend) => {
                const status = String(friend.status || 'offline').toLowerCase();
                const isPlaying = status === 'in-game';
                return (
                  <div
                    key={friend.id}
                    className="noctra-friend-card"
                    onClick={() => onOpenChat?.(friend.id)}
                  >
                    <RelayAvatar
                      name={friend.name}
                      skinUrl={friend.skinUrl}
                      size={40}
                      status={status}
                      showStatus
                    />
                    <div className="noctra-friend-card-info">
                      <div className="noctra-friend-card-name-row">
                        <strong className="noctra-friend-name">{friend.nickname || friend.name}</strong>
                        <span className="noctra-friend-handle">@{friend.name}</span>
                        <Badges user={friend} size={15} />
                      </div>
                      <span className={`noctra-friend-activity ${isPlaying ? 'is-playing' : ''}`}>
                        {friend.activity || (status === 'offline' ? 'Offline' : 'In Launcher')}
                      </span>
                    </div>

                    <div className="noctra-friend-card-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className="noctra-friend-icon-btn"
                        onClick={() => onOpenChat?.(friend.id)}
                        title="Message"
                      >
                        <MessageSquare size={17} />
                      </button>
                      <button
                        type="button"
                        className="noctra-friend-icon-btn"
                        onClick={() => handleUnfriend(friend)}
                        title="Remove Friend"
                      >
                        <UserMinus size={16} />
                      </button>
                      <button
                        type="button"
                        className="noctra-friend-icon-btn is-danger"
                        onClick={() => handleBlock(friend)}
                        title="Block"
                      >
                        <Ban size={15} />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}
