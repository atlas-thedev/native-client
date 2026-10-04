import React from 'react';
import { MessageSquare, Search, UserRoundPlus } from 'lucide-react';
import PlayerAvatar from '../../components/ui/PlayerAvatar.jsx';
import './SocialDrawer.css';

function FriendRow({ item, offline = false }) {
  const { name, status, tone = 'offline', unread } = item;
  return <div className={`friend-row ${offline ? 'is-offline' : ''}`}>
    <div className="friend-avatar"><PlayerAvatar name={name} size={29} kind="avatar" radius={5}/><i className={tone}/></div>
    <span><b>{name}</b><small className={tone}>{status}</small></span>
    <MessageSquare size={13} strokeWidth={1.6}/>{unread ? <i className="message-alert"/> : null}
  </div>;
}

export default function SocialDrawer({ friends, account }) {
  const visibleFriends = friends || (account?.name ? [{ id: account.id, name: account.name, status: 'In Launcher', tone: 'launcher', online: true }] : []);
  const online = visibleFriends.filter(friend => friend.online);
  const offline = visibleFriends.filter(friend => !friend.online);
  return <aside className="social-drawer">
    <div className="social-tabs"><b>Friends</b><span>|</span><button>Requests <i/></button></div>
    <div className="social-search"><Search size={12}/><input aria-label="Find a player" placeholder="Find a player..."/><button aria-label="Add friend"><UserRoundPlus size={14}/></button></div>
    <div className="social-rule"/>
    <div className="friend-scroll">
      {online.length ? <><small className="social-count">{online.length} Online</small>{online.map(item => <FriendRow key={item.id || item.name} item={item}/>)}</> : null}
      {offline.length ? <><small className="social-count offline-count">{offline.length} Offline</small>{offline.map(item => <FriendRow key={item.id || item.name} item={item} offline/>)}</> : null}
      {!visibleFriends.length ? <div className="social-empty"><UserRoundPlus size={20}/><p>Native Friends will appear here.</p></div> : null}
    </div>
    {visibleFriends.length ? <div className="friend-scrollbar"/> : null}
  </aside>;
}
