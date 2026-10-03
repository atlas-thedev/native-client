import React, { useState } from 'react';
import { Bell, BellOff, Check, CheckCheck, LogOut, Paperclip, Pin, Settings, Trash2 } from 'lucide-react';
import RelayAvatar from './RelayAvatar.jsx';
import GroupAvatarBadge from './GroupAvatarBadge.jsx';
import { isPlusUser, PlusMark } from './Badges.jsx';

/** One inbox row: avatar, presence, name, snippet, delivery state and quick actions. */
export function ThreadRow({
  thread,
  active,
  presence,
  isGroup = false,
  index = 0,
  onClick,
  onTogglePin,
  onToggleMute,
  onOpenSettings,
  onLeaveGroup,
  onDeleteGroup
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      className={`relay-thread-item-wrapper ${active ? 'is-active' : ''}`}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen((prev) => !prev);
      }}
    >
      <button
        type="button"
        data-testid={`relay-thread-${thread.id}`}
        className={`relay-thread-item ${active ? 'is-active' : ''}`}
        style={{ animationDelay: `${Math.min(index, 12) * 22}ms` }}
        onClick={onClick}
      >
        <div className="relay-thread-avatar-wrapper">
          {isGroup ? (
            <GroupAvatarBadge group={thread} size={36} />
          ) : (
            <RelayAvatar name={thread.name} skinUrl={thread.skinUrl} size={36} className="relay-thread-avatar" />
          )}
          <span className={`relay-thread-dot ${presence.status}`} style={{ backgroundColor: presence.color }} />
        </div>

        <div className="relay-thread-info">
          <div className="relay-thread-top-row">
            <span className="relay-thread-name">{thread.nickname || thread.name}</span>
            {!isGroup && isPlusUser(thread) && <PlusMark size={12} />}
            {thread.pinned && <Pin size={10} className="relay-thread-flag is-pinned" title="Pinned" />}
            {thread.muted && <BellOff size={10} className="relay-thread-flag is-muted" title="Muted" />}
            <span className="relay-thread-time">{thread.lastTime || ''}</span>
          </div>
          <div className="relay-thread-bottom-row">
            {thread.isTyping ? (
              <span className="relay-thread-snippet is-typing">typing…</span>
            ) : (
              <>
                {thread.isAttachment && <Paperclip size={11} className="relay-snippet-icon" />}
                <span className="relay-thread-snippet">{thread.lastMessage || 'No messages'}</span>
                {thread.isMine && !thread.lastPending && !thread.lastFailed && (
                  thread.lastIsRead
                    ? <CheckCheck size={11} className="relay-snippet-checks is-read" title="Read" />
                    : <Check size={11} className="relay-snippet-checks" title="Delivered" />
                )}
              </>
            )}
            {thread.unread > 0 && (
              <span className="relay-unread-badge">{thread.unread > 9 ? '9+' : thread.unread}</span>
            )}
          </div>
        </div>
      </button>

      {/* Context menu on right click */}
      {menuOpen && (
        <>
          <div className="relay-thread-menu-backdrop" onClick={() => setMenuOpen(false)} />
          <div className="relay-thread-context-menu" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={(e) => {
                setMenuOpen(false);
                onTogglePin?.(e);
              }}
            >
              <Pin size={13} />
              <span>{thread.pinned ? 'Unpin conversation' : 'Pin conversation'}</span>
            </button>
            <button
              type="button"
              onClick={(e) => {
                setMenuOpen(false);
                onToggleMute?.(e);
              }}
            >
              {thread.muted ? <Bell size={13} /> : <BellOff size={13} />}
              <span>{thread.muted ? 'Unmute notifications' : 'Mute notifications'}</span>
            </button>
            {isGroup && (
              <>
                <div className="relay-context-divider" />
                <button
                  type="button"
                  onClick={(e) => {
                    setMenuOpen(false);
                    onOpenSettings?.(thread);
                  }}
                >
                  <Settings size={13} />
                  <span>Group settings</span>
                </button>
                {thread.role === 'owner' ? (
                  <button
                    type="button"
                    className="is-danger"
                    onClick={(e) => {
                      setMenuOpen(false);
                      onDeleteGroup?.(thread);
                    }}
                  >
                    <Trash2 size={13} />
                    <span>Delete group</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="is-danger"
                    onClick={(e) => {
                      setMenuOpen(false);
                      onLeaveGroup?.(thread);
                    }}
                  >
                    <LogOut size={13} />
                    <span>Leave group</span>
                  </button>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default ThreadRow;
