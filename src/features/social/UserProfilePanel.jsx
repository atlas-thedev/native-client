import React, { useEffect, useState } from 'react';
import { BadgeCheck, Ban, CalendarDays, Check, Copy, Server, Users, Trash2, UserMinus, X } from 'lucide-react';
import RelayAvatar from './RelayAvatar.jsx';
import Badges, { getUserBadges, isPlusUser, PlusMark } from './Badges.jsx';
import PlayerAvatar from '../../components/ui/PlayerAvatar.jsx';
import './UserProfilePanel.css';

const formatMemberDate = (stamp) => {
  if (!stamp) return 'Early Member';
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return 'Early Member';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
};

export default function UserProfilePanel({
  user,
  presence,
  isGroup = false,
  onClose,
  onUnfriend,
  onBlock,
  onClearHistory
}) {
  const [confirmUnfriend, setConfirmUnfriend] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const [mutual, setMutual] = useState(Array.isArray(user?.mutualFriends) ? user.mutualFriends : []);
  const userId = user?.id;

  useEffect(() => {
    setMutual(Array.isArray(user?.mutualFriends) ? user.mutualFriends : []);
    if (!userId || isGroup || (typeof navigator !== 'undefined' && navigator.onLine === false)) return undefined;
    let cancelled = false;
    const api = window.noctra?.social;
    api?.getMutualFriends?.(userId)
      .then((res) => {
        if (!cancelled && res?.ok && Array.isArray(res.mutual)) setMutual(res.mutual);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [userId, isGroup]);

  if (!user) return null;

  const status = presence?.status || 'offline';
  const isPlaying = status === 'in-game' || status === 'in-menus';
  const isOnline = status === 'in-launcher' || status === 'online';
  const statusColor = presence?.color || (isPlaying ? '#d9a6da' : isOnline ? '#23a55a' : '#80848e');
  const bio = user.bio || user.about || '';
  const badgeCount = getUserBadges(user).length;

  return (
    <aside className="np-panel" role="complementary" aria-label="User Profile">
      <button
        type="button"
        className="np-close"
        onClick={onClose}
        aria-label="Close Profile"
        title="Close Profile"
      >
        <X size={15} />
      </button>

      {/* Avatar */}
      <div className="np-avatar-wrap" style={{ '--np-ring': statusColor }}>
        <RelayAvatar
          name={user.name}
          skinUrl={user.skinUrl}
          size={74}
          status={status}
          showStatus
          className="np-avatar"
        />
      </div>

      <div className="np-body">
        {/* Identity */}
        <div className="np-identity">
          <div className="np-name-row">
            <h3 className="np-name">{user.nickname || user.name}</h3>
            {isPlusUser(user) && <PlusMark size={18} />}
          </div>
          <span className="np-handle">@{user.name}</span>

          {badgeCount > 0 && (
            <div className="np-profile-badges">
              <span>Badges</span>
              <Badges user={user} size={22} />
            </div>
          )}

          {bio ? <p className="np-bio">{bio}</p> : null}
        </div>

        <div className="np-divider" />

        {user.minecraft?.name && <ConnectionsBlock minecraft={user.minecraft} />}

        {/* Activity */}
        <div className="np-block">
          <span className="np-label">Activity</span>
          <div className={`np-card np-activity ${isPlaying ? 'is-playing' : ''}`}>
                        <div className="np-activity-text">
              <strong>{isPlaying ? (presence?.text || 'In-game') : (isOnline ? 'In Launcher' : 'Not playing')}</strong>
              {isPlaying && presence?.serverAddress ? (
                <span className="np-activity-sub">
                  <Server size={11} />
                  {presence.serverAddress}
                </span>
              ) : (
                <span className="np-activity-sub">{isPlaying ? 'Minecraft' : 'No active game'}</span>
              )}
            </div>
          </div>
        </div>

        {/* Details */}
        <div className="np-block">
          <span className="np-label">Details</span>
          <div className="np-card np-details">
            <div className="np-detail-row"><span className="np-detail-key">Member since</span><span className="np-detail-val">{formatMemberDate(user.memberSince || user.createdAt)}</span></div>
            {user.friendsSince && (
              <div className="np-detail-row"><span className="np-detail-key">Friends since</span><span className="np-detail-val">{formatMemberDate(user.friendsSince)}</span></div>
            )}
          </div>
        </div>

        {/* Mutual friends */}
        {!isGroup && (
          <div className="np-block">
            <span className="np-label">Mutual friends{mutual.length ? ` — ${mutual.length}` : ''}</span>
            <div className="np-card np-mutual">
              {mutual.length === 0 ? (
                <span className="np-mutual-empty"><Users size={13} /> No mutual friends</span>
              ) : (
                mutual.map((friend, i) => (
                  <div className="np-mutual-row" key={friend.id || friend.name || i}>
                    <RelayAvatar name={friend.name} skinUrl={friend.skinUrl} size={24} />
                    <span className="np-mutual-name">{friend.nickname || friend.name}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Actions */}
        {!isGroup && (
          <div className="np-actions">
            {confirmClear ? (
              <div className="np-confirm">
                <span>Clear chat history?</span>
                <div className="np-confirm-btns">
                  <button
                    type="button"
                    className="np-confirm-yes"
                    onClick={() => {
                      setConfirmClear(false);
                      onClearHistory?.(user.id);
                    }}
                  >
                    Clear
                  </button>
                  <button type="button" className="np-confirm-no" onClick={() => setConfirmClear(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="np-action" onClick={() => setConfirmClear(true)}>
                <Trash2 size={15} />
                <span>Clear chat history</span>
              </button>
            )}

            {confirmUnfriend ? (
              <div className="np-confirm">
                <span>Remove @{user.name}?</span>
                <div className="np-confirm-btns">
                  <button
                    type="button"
                    className="np-confirm-yes is-danger"
                    onClick={() => {
                      setConfirmUnfriend(false);
                      onUnfriend?.(user.id);
                    }}
                  >
                    Unfriend
                  </button>
                  <button type="button" className="np-confirm-no" onClick={() => setConfirmUnfriend(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="np-action" onClick={() => setConfirmUnfriend(true)}>
                <UserMinus size={15} />
                <span>Remove friend</span>
              </button>
            )}

            {confirmBlock ? (
              <div className="np-confirm">
                <span>Block @{user.name}?</span>
                <div className="np-confirm-btns">
                  <button
                    type="button"
                    className="np-confirm-yes is-danger"
                    onClick={() => {
                      setConfirmBlock(false);
                      onBlock?.(user.id);
                    }}
                  >
                    Block
                  </button>
                  <button type="button" className="np-confirm-no" onClick={() => setConfirmBlock(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="np-action is-danger" onClick={() => setConfirmBlock(true)}>
                <Ban size={15} />
                <span>Block user</span>
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

/** Linked premium Minecraft account, visible to friends. */
function ConnectionsBlock({ minecraft }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    try { navigator.clipboard?.writeText(minecraft.name); } catch {}
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <div className="np-block">
      <span className="np-label">Connections</span>
      <div className="np-card np-connection">
        <PlayerAvatar uuid={minecraft.uuid} name={minecraft.name} size={36} radius={8} className="np-connection-head" />
        <div className="np-connection-text">
          <span className="np-connection-name">
            {minecraft.name}
            <BadgeCheck size={14} className="np-connection-verified" aria-label="Verified" />
          </span>
          <span className="np-connection-sub">Minecraft · Premium</span>
        </div>
        <button type="button" className="np-connection-copy" onClick={copy} title={copied ? 'Copied' : 'Copy username'} aria-label="Copy username">
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  );
}
