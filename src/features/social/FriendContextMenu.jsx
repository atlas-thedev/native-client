import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Play, MessageSquare, Layers, Star, Tag, Copy, UserMinus, Ban } from 'lucide-react';
import './FriendContextMenu.css';
import { canJoinServer } from './presence.js';

export default function FriendContextMenu({ context, onClose, onJoinServer, onOpenChat, onToggleBestFriend, onSetNickname, onUnfriend, onBlock }) {
  const menuRef = useRef(null);
  const [position, setPosition] = useState({ left: context?.x || 12, top: context?.y || 12 });

  useEffect(() => {
    const handleOutsideClick = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) onClose(); };
    const handleKeyDown = (e) => { if (e.key === 'Escape') onClose(); };
    const handleResize = () => onClose();
    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleResize);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleResize);
    };
  }, [onClose]);

  useLayoutEffect(() => {
    if (!context?.friend || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    setPosition({
      left: Math.max(12, Math.min(context.x, window.innerWidth - rect.width - 12)),
      top: Math.max(12, Math.min(context.y, window.innerHeight - rect.height - 12))
    });
  }, [context]);

  if (!context?.friend) return null;
  const { friend } = context;
  const isServerJoinable = canJoinServer(friend);
  const run = (action) => { action(); onClose(); };

  return (
    <div ref={menuRef} className="friend-context-menu" style={position} onClick={(e) => e.stopPropagation()} role="menu">
      <button type="button" className={`context-menu-item item-join-server${isServerJoinable ? '' : ' is-disabled'}`} disabled={!isServerJoinable} onClick={() => run(() => onJoinServer(friend))}><Play size={14} className="icon-join" fill="currentColor" /><span>Join Server</span></button>
      {onOpenChat && <button type="button" className="context-menu-item" onClick={() => run(() => onOpenChat(friend))}><MessageSquare size={14} /><span>Send Message</span></button>}
      {onOpenChat && <button type="button" className="context-menu-item is-disabled" disabled title="Groups coming soon"><Layers size={14} /><span>Add to Group</span></button>}
      <button type="button" className="context-menu-item" onClick={() => run(() => onToggleBestFriend(friend))}><Star size={14} fill={friend.isBestFriend ? 'currentColor' : 'none'} color={friend.isBestFriend ? '#fbbf24' : 'currentColor'} /><span>{friend.isBestFriend ? 'Remove Best Friend' : 'Add Best Friend'}</span></button>
      <button type="button" className="context-menu-item" onClick={() => run(() => onSetNickname(friend))}><Tag size={14} /><span>Set Nickname</span></button>
      <button type="button" className="context-menu-item" onClick={() => run(() => navigator.clipboard?.writeText(friend.name))}><Copy size={14} /><span>Copy IGN</span></button>
      <div className="context-menu-divider" />
      <button type="button" className="context-menu-item item-danger" onClick={() => run(() => onUnfriend(friend))}><UserMinus size={14} /><span>Unfriend</span></button>
      <button type="button" className="context-menu-item item-danger" onClick={() => run(() => onBlock(friend))}><Ban size={14} /><span>Block</span></button>
    </div>
  );
}
