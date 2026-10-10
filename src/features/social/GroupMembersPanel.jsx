import React, { useMemo } from 'react';
import { Settings, ShieldCheck, UserPlus, Users, X } from 'lucide-react';
import GroupAvatarBadge from './GroupAvatarBadge.jsx';
import { openProfile } from '../profile/ProfileModal.jsx';
import RelayAvatar from './RelayAvatar.jsx';
import './GroupMembersPanel.css';

const ROLE_LABELS = { owner: 'Owner', admin: 'Admin', member: 'Member' };
const ROLE_ORDER = { owner: 0, admin: 1, member: 2 };

export default function GroupMembersPanel({ group, selfId, friendIds = null, onClose, onOpenSettings, onInvite }) {
  const members = useMemo(() => [...(group?.members || [])].sort((a, b) => {
    const aOnline = a.status !== 'offline';
    const bOnline = b.status !== 'offline';
    if (aOnline !== bOnline) return aOnline ? -1 : 1;
    const roleDifference = (ROLE_ORDER[a.role] ?? 3) - (ROLE_ORDER[b.role] ?? 3);
    return roleDifference || String(a.name || '').localeCompare(String(b.name || ''));
  }), [group?.members]);

  if (!group) return null;

  const onlineCount = members.filter((member) => member.status !== 'offline').length;
  const canInvite = group.role === 'owner' || group.role === 'admin';

  return (
    <aside className="relay-members-panel" role="complementary" aria-label={`${group.name} members`}>
      <div className="relay-members-panel__banner">
        <button type="button" className="relay-members-panel__close" onClick={onClose} aria-label="Close members panel" title="Close members panel">
          <X size={15} />
        </button>
      </div>

      <div className="relay-members-panel__avatar">
        <GroupAvatarBadge group={group} size={68} />
      </div>

      <div className="relay-members-panel__body">
        <div className="relay-members-panel__identity">
          <h3>{group.name}</h3>
          <span>{members.length} {members.length === 1 ? 'member' : 'members'} · {onlineCount} online</span>
          {group.description ? <p>{group.description}</p> : null}
        </div>

        <div className="relay-members-panel__actions">
          {canInvite ? (
            <button type="button" onClick={onInvite} data-testid="group-members-invite-btn">
              <UserPlus size={14} /> Invite people
            </button>
          ) : null}
          <button type="button" onClick={onOpenSettings} data-testid="group-members-settings-btn">
            <Settings size={14} /> Group settings
          </button>
        </div>

        <div className="relay-members-panel__divider" />

        <div className="relay-members-panel__heading">
          <span>Members</span>
          <strong>{members.length}</strong>
        </div>

        <div className="relay-members-panel__list">
          {members.map((member) => {
            const offline = member.status === 'offline';
            const isSelf = member.id === selfId;
            return (
              <div
                className={`relay-members-panel__row${offline ? ' is-offline' : ''}`}
                key={member.id}
                role="button"
                tabIndex={0}
                title={`View ${member.name}'s profile`}
                style={{ cursor: 'pointer' }}
                onClick={() => openProfile({ name: member.name, user: member, self: isSelf, canMessage: !isSelf && Boolean(friendIds?.has(member.id)) })}
                onKeyDown={(event) => { if (event.key === 'Enter') openProfile({ name: member.name, user: member, self: isSelf }); }}
              >
                <RelayAvatar name={member.name} skinUrl={member.skinUrl} size={34} status={member.status} showStatus />
                <div className="relay-members-panel__member-copy">
                  <div>
                    <strong>{member.name}{isSelf ? ' (you)' : ''}</strong>
                    {member.role !== 'member' ? (
                      <span className={`relay-members-panel__role is-${member.role}`} title={ROLE_LABELS[member.role]}>
                        <ShieldCheck size={11} />
                      </span>
                    ) : null}
                  </div>
                  <small>{offline ? 'Offline' : (member.activity || 'In Launcher')}</small>
                </div>
              </div>
            );
          })}
          {members.length === 0 ? (
            <div className="relay-members-panel__empty"><Users size={20} /><span>No members found.</span></div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
