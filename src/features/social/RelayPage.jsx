import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { canJoinServer } from './presence.js';
import {
  BellOff,
  Bell,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Pin,
  Plus,
  Search,
  Send,
  Smile,
  Sparkles,
  Trash2,
  Upload,
  Users,
  UserMinus,
  UserPlus,
  UserSquare2,
  Ban,
  X
} from 'lucide-react';
import { openProfile } from '../profile/ProfilePage.jsx';
import RelayAvatar from './RelayAvatar.jsx';
import GroupAvatarBadge from './GroupAvatarBadge.jsx';
import useRelayGroups from './useRelayGroups.js';
import GroupCreateModal from './GroupCreateModal.jsx';
import GroupSettingsModal from './GroupSettingsModal.jsx';
import MessageRow from './MessageRow.jsx';
import ThreadRow from './ThreadRow.jsx';
import { ReplyComposerBar } from './ReplyPreview.jsx';
import Badges, { isPlusUser } from './Badges.jsx';
import UserProfilePanel from './UserProfilePanel.jsx';
import { activityLine } from './PresenceCard.jsx';
import GroupMembersPanel from './GroupMembersPanel.jsx';
import FriendsHome from './FriendsHome.jsx';
import { EmojiPicker, GifPicker, useDismiss } from './ComposerPickers.jsx';
import './RelayPage.css';
import './relay-groups.css';
import './RelayMessages.css';

const RELAY_STORAGE_KEY = 'native_relay_store_v5';
const MESSAGE_MAX = 2000;
const MAX_ATTACHMENT = 25 * 1024 * 1024;

const formatTime = (stamp) => {
  if (!stamp) return '';
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
};

const dayKeyOf = (stamp) => {
  const date = new Date(stamp || Date.now());
  if (Number.isNaN(date.getTime())) return 'unknown';
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

const dayLabelOf = (stamp) => {
  const date = new Date(stamp || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (dayKeyOf(date.getTime()) === dayKeyOf(today.getTime())) return 'Today';
  if (dayKeyOf(date.getTime()) === dayKeyOf(yesterday.getTime())) return 'Yesterday';
  return date.toLocaleDateString([], { day: 'numeric', month: 'long' });
};

/** "Last seen today at 14:30" / "… yesterday at …" / "… on 12 Sep at …". */
const formatLastSeen = (stamp, now = Date.now()) => {
  if (!stamp) return 'Offline';
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return 'Offline';
  // Recent: a live, relative time ("Last seen 4m ago"), refreshed every 30s.
  const ago = Math.max(0, now - date.getTime());
  if (ago < 60_000) return 'Last seen just now';
  if (ago < 60 * 60_000) return `Last seen ${Math.floor(ago / 60_000)}m ago`;

  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (dayKeyOf(date.getTime()) === dayKeyOf(today.getTime())) return `Last seen today at ${time}`;
  if (dayKeyOf(date.getTime()) === dayKeyOf(yesterday.getTime())) return `Last seen yesterday at ${time}`;
  return `Last seen on ${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} at ${time}`;
};

const REACTION_PALETTE = ['\u2764\uFE0F', '\u{1F602}', '\u{1F525}', '\u{1F44D}', '\u{1F62E}', '\u{1F622}', '\u{1F389}', '\u{1F480}'];

function loadPersistedState() {
  try {
    const raw = localStorage.getItem(RELAY_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Group member lists come from a one-off fetch, but presence changes every few
 * seconds. Overlay what we know live: friends from the realtime friend list and
 * ourselves from the launcher's own presence.
 */
/** Placeholder message rows while a conversation's first page loads. */
function MessageSkeletons() {
  const rows = [[62, 2], [44, 1], [70, 3], [38, 1], [56, 2]];
  return (
    <div className="relay-stream-skeleton" aria-hidden="true" data-testid="relay-stream-skeleton">
      {rows.map(([width, lines], i) => (
        <div className="relay-msg-skel" key={i} style={{ animationDelay: `${i * 90}ms` }}>
          <span className="relay-skel-avatar" />
          <span className="relay-msg-skel-body">
            <span className="relay-msg-skel-name" />
            {Array.from({ length: lines }, (_, l) => (
              <span key={l} className="relay-msg-skel-line" style={{ width: `${Math.max(24, width - l * 14)}%` }} />
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Placeholder inbox rows shown while threads are still loading. */
function ThreadSkeletons({ count = 3 }) {
  return (
    <div className="relay-thread-skeletons" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div className="relay-thread-skeleton" key={i} style={{ animationDelay: `${i * 110}ms` }}>
          <span className="relay-skel-avatar" />
          <span className="relay-skel-lines"><span /><span /></span>
        </div>
      ))}
    </div>
  );
}

export function withLivePresence(group, friends, selfId, selfPresence) {
  if (!group?.members?.length) return group;
  const byId = new Map((friends || []).map((friend) => [friend.id, friend]));
  let changed = false;
  const members = group.members.map((member) => {
    let live = null;
    if (member.id === selfId && selfPresence?.status) live = selfPresence;
    else if (byId.has(member.id)) live = byId.get(member.id);
    if (!live || !live.status) return member;
    const status = live.status;
    const offline = status === 'offline';
    const next = {
      ...member,
      status,
      activity: offline ? null : (live.activity || null),
      serverAddress: offline ? null : (live.serverAddress || null)
    };
    if (next.status !== member.status || next.activity !== member.activity || next.serverAddress !== member.serverAddress) changed = true;
    return next;
  });
  return changed ? { ...group, members } : group;
}

export default function RelayPage({ account, isPlus = false, social, onJoinServer, onNotify, onActiveThreadChange, openRequest = null }) {
  const persisted = useMemo(() => loadPersistedState(), []);
  const selfId = social?.selfId || account?.id || null;

  const relayGroups = useRelayGroups({ selfId, selfName: account?.name || 'You' });

  // The launcher's own presence (In Launcher / In-game: …), straight from the
  // main process. Group member lists are fetched snapshots, so without this
  // your own row would stay on whatever the server had at fetch time.
  const [selfPresence, setSelfPresence] = useState(null);
  useEffect(() => {
    const api = window.native?.social;
    if (!api) return undefined;
    let alive = true;
    api.getPresence?.().then((value) => { if (alive && value) setSelfPresence(value); }).catch(() => {});
    const off = api.onPresenceUpdated?.((value) => { if (value) setSelfPresence(value); });
    return () => { alive = false; off?.(); };
  }, []);
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState('overview');
  const plusIds = useMemo(
    () => new Set((social?.friends || []).filter(isPlusUser).map((friend) => friend.id)),
    [social?.friends]
  );
  const [friendsHomeRequest, setFriendsHomeRequest] = useState({ tab: 'online', nonce: 0 });

  const [selectedId, setSelectedId] = useState(null);
  const [mutedIds, setMutedIds] = useState(() => persisted?.mutedIds || {});
  const [pinnedIds, setPinnedIds] = useState(() => persisted?.pinnedIds || {});
  const [uploads, setUploads] = useState({});

  const [inboxQuery, setInboxQuery] = useState('');
  const [composerText, setComposerText] = useState('');
  const [stagedFile, setStagedFile] = useState(null);
  const [collapsed, setCollapsed] = useState({ pinned: false, groups: false, direct: false });

  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [showMenuDropdown, setShowMenuDropdown] = useState(false);
  const [previewMediaModal, setPreviewMediaModal] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  // The right-hand profile panel is part of the default Relay layout, so it
  // starts open instead of hiding behind the toolbar toggle.
  const [showProfilePanel, setShowProfilePanel] = useState(true);
  const [showSelfProfile, setShowSelfProfile] = useState(false);

  const [sending, setSending] = useState(false);

  const messageStreamRef = useRef(null);
  const fileInputRef = useRef(null);
  const composerRef = useRef(null);
  const atBottomRef = useRef(true);
  const dragDepthRef = useRef(0);
  const menuRef = useRef(null);
  const scrollStateRef = useRef({ chatId: null, firstId: null, height: 0, top: 0 });

  useEffect(() => {
    return social?.subscribe?.((event) => relayGroups.handleSocialEvent(event));
  }, [social, relayGroups]);

  useEffect(() => {
    if (social?.activeChatFriend?.id && social.activeChatFriend.id !== selectedId) {
      setSelectedId(social.activeChatFriend.id);
    }
  }, [social?.activeChatFriend?.id, selectedId]);

  useEffect(() => {
    try {
      localStorage.setItem(RELAY_STORAGE_KEY, JSON.stringify({ lastSelectedId: selectedId, mutedIds, pinnedIds }));
    } catch {}
  }, [selectedId, mutedIds, pinnedIds]);

  useEffect(() => {
    if (!previewMediaModal) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') setPreviewMediaModal(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewMediaModal]);

  // ── Inbox data ──────────────────────────────────────────────────────

  // Ticks so "Last seen 4m ago" stays true while the page is open.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const mergedFriends = useMemo(() => {
    const live = social?.friends || [];
    const conversations = social?.conversations || {};

    return live.map((friend) => {
      const thread = conversations[friend.id];
      const lastMsg = thread?.messages?.length ? thread.messages[thread.messages.length - 1] : null;

      let snippet = 'No messages yet';
      let isMine = friend.lastMessageSenderId === selfId;
      let time = friend.lastMessageTime ? formatTime(friend.lastMessageTime) : '';
      let isAttachment = Boolean(friend.lastMessageIsMedia);
      let lastIsRead = false;
      let lastPending = false;
      let lastFailed = false;

      if (lastMsg) {
        isMine = lastMsg.senderId === selfId;
        const label = lastMsg.mediaName || 'Attachment';
        if (lastMsg.isDeleted) {
          snippet = 'Message deleted';
        } else if (lastMsg.isMedia || lastMsg.mediaUrl) {
          snippet = isMine ? `You: ${label}` : label;
          isAttachment = true;
        } else {
          snippet = isMine ? `You: ${lastMsg.content || ''}` : (lastMsg.content || '');
        }
        time = formatTime(lastMsg.createdAt);
        lastIsRead = Boolean(lastMsg.isRead);
        lastPending = Boolean(lastMsg.pending);
        lastFailed = Boolean(lastMsg.failed);
      } else if (friend.lastMessageContent) {
        snippet = isMine ? `You: ${friend.lastMessageContent}` : friend.lastMessageContent;
      }

      const status = String(friend.status || 'offline').toLowerCase();
      const lastSeenAt = friend.lastSeen || friend.lastMessageTime || 0;
      const pinned = pinnedIds[friend.id] ?? Boolean(friend.pinned);
      const muted = mutedIds[friend.id] ?? Boolean(friend.muted);

      return {
        id: friend.id,
        kind: 'dm',
        name: friend.name,
        nickname: friend.nickname || friend.name,
        uuid: friend.uuid,
        skinUrl: friend.skinUrl || null,
        model: friend.model || 'classic',
        badges: friend.badges || [],
        minecraft: friend.minecraft || null,
        isVerified: Boolean(friend.isVerified),
        memberSince: friend.memberSince || null,
        status,
        pinned,
        muted,
        activity:
          friend.activity ||
          (status === 'in-game'
            ? `In-game: ${friend.serverAddress || 'Server'}`
            : status === 'offline' ? 'Offline' : 'In Launcher'),
        serverAddress: friend.serverAddress,
        lastSeenAt,
        lastSeen: formatLastSeen(lastSeenAt, clock),
        lastMessage: snippet,
        lastTime: time,
        lastStamp: lastMsg?.createdAt || friend.lastMessageTime || 0,
        isAttachment,
        isMine,
        lastIsRead,
        lastPending,
        lastFailed,
        isTyping: Boolean(social?.typingBy?.[friend.id]),
        unread: muted ? 0 : (friend.unreadCount || 0)
      };
    });
  }, [social?.friends, social?.conversations, social?.typingBy, selfId, mutedIds, pinnedIds, clock]);

  const formattedGroups = useMemo(() => {
    return (relayGroups.groups || []).map((group) => {
      let snippet;
      if (group.lastMessage) {
        if (group.lastMessage.isSystem) {
          snippet = group.lastMessage.content;
        } else {
          const isMine = group.lastMessage.senderId === selfId;
          snippet = isMine
            ? `You: ${group.lastMessage.content || 'Sent attachment'}`
            : `${group.lastMessage.senderName || 'Member'}: ${group.lastMessage.content || 'Sent attachment'}`;
        }
      } else {
        snippet = `${group.memberCount || group.members?.length || 0} members`;
      }

      const pinned = pinnedIds[group.id] ?? Boolean(group.pinned);
      const muted = mutedIds[group.id] ?? Boolean(group.muted);

      return {
        ...group,
        kind: 'group',
        nickname: group.name,
        pinned,
        muted,
        lastStamp: group.lastMessage?.createdAt || group.createdAt || 0,
        lastTime: formatTime(group.lastMessage?.createdAt || group.createdAt),
        lastMessage: snippet,
        unread: muted ? 0 : (group.unreadCount || 0)
      };
    });
  }, [relayGroups.groups, selfId, mutedIds, pinnedIds]);

  const allThreads = useMemo(() => {
    const dms = [...mergedFriends].sort((a, b) => (b.lastStamp || 0) - (a.lastStamp || 0));
    const combined = [...formattedGroups, ...dms];
    return combined.sort((a, b) => {
      const aPinned = Boolean(a.pinned);
      const bPinned = Boolean(b.pinned);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      return (b.lastStamp || 0) - (a.lastStamp || 0);
    });
  }, [formattedGroups, mergedFriends]);

  const activeEntity = useMemo(() => {
    if (!selectedId) return null;
    return allThreads.find((thread) => thread.id === selectedId) || null;
  }, [allThreads, selectedId]);

  // Opening a chat puts the cursor straight in the message box.
  const activeChatId = activeEntity?.id || null;
  useEffect(() => {
    if (!activeChatId) return undefined;
    const t = window.setTimeout(() => composerRef.current?.focus({ preventScroll: true }), 60);
    return () => window.clearTimeout(t);
  }, [activeChatId]);

  const isGroupThread = activeEntity?.kind === 'group';

  useEffect(() => {
    if (selectedId && !allThreads.some((thread) => thread.id === selectedId)) {
      setSelectedId(null);
    }
  }, [selectedId, allThreads]);

  useEffect(() => {
    if (activeEntity?.kind === 'group' && relayGroups.activeGroupId !== activeEntity.id) {
      relayGroups.openGroup(activeEntity.id);
    }
  }, [activeEntity?.id, activeEntity?.kind, relayGroups]);

  const setActiveChatFriend = social?.setActiveChatFriend;
  useEffect(() => {
    if (!setActiveChatFriend) return;
    if (activeEntity && activeEntity.kind !== 'group') {
      if (social?.activeChatId !== activeEntity.id) setActiveChatFriend(activeEntity);
    } else if (social?.activeChatId) {
      setActiveChatFriend(null);
    }
  }, [activeEntity, social?.activeChatId, setActiveChatFriend]);

  const loadThread = social?.loadThread;
  useEffect(() => {
    if (!loadThread || !activeEntity || activeEntity.kind === 'group') return;
    loadThread(activeEntity.id);
  }, [loadThread, activeEntity?.id]);

  useEffect(() => {
    onActiveThreadChange?.(activeEntity?.id || null);
  }, [activeEntity?.id, onActiveThreadChange]);

  useEffect(() => () => onActiveThreadChange?.(null), [onActiveThreadChange]);

  // ── Presence & filtering ────────────────────────────────────────────

  const getPresence = useCallback((entity) => {
    if (!entity) return { status: 'offline', text: 'Offline', color: '#80848e' };
    if (entity.kind === 'group') {
      const count = entity.memberCount || entity.members?.length || 0;
      return { status: 'in-launcher', text: `${count} members`, color: '#23a55a' };
    }
    if (entity.isTyping) return { status: 'in-launcher', text: 'typing…', color: '#23a55a' };

    const status = String(entity.status || 'offline').toLowerCase();
    if (status === 'in-game' || status === 'in-menus') {
      return {
        status: 'in-game',
        text: activityLine(entity) || 'Playing Minecraft',
        serverAddress: entity.serverAddress || null,
        color: '#d9a6da'
      };
    }
    if (status === 'online' || status === 'in-launcher') {
      return { status: 'in-launcher', text: entity.activity || 'In Launcher', color: '#23a55a' };
    }
    return {
      status: 'offline',
      text: entity.lastSeen || 'Offline',
      color: '#80848e'
    };
  }, []);

  const filterList = useCallback((list) => {
    const query = inboxQuery.trim().toLowerCase();
    if (!query) return list;
    return list.filter((item) => {
      const name = (item.nickname || item.name || '').toLowerCase();
      const snippet = (item.lastMessage || '').toLowerCase();
      return name.includes(query) || snippet.includes(query);
    });
  }, [inboxQuery]);

  const pinnedList = filterList(allThreads.filter((thread) => thread.pinned));
  const groupList = filterList(formattedGroups.filter((group) => !group.pinned));
  const directList = filterList(mergedFriends
    .filter((friend) => !friend.pinned)
    .sort((a, b) => (b.lastStamp || 0) - (a.lastStamp || 0)));

  // ── Messages ────────────────────────────────────────────────────────

  const currentMessages = useMemo(() => {
    if (!activeEntity?.id) return [];
    const pendingUploads = (uploads[activeEntity.id] || []);

    if (isGroupThread) {
      const list = (relayGroups.messages || []).map((message) => ({
        ...message,
        id: String(message.id),
        senderName: message.senderId === selfId ? 'You' : (message.senderName || 'Member'),
        time: formatTime(message.createdAt),
        isMine: message.senderId === selfId
      }));
      return [...list, ...pendingUploads];
    }

    const thread = social?.conversations?.[activeEntity.id];
    const list = (thread?.messages || []).map((message) => {
      const isMine = message.senderId === selfId;
      return {
        id: String(message.id),
        senderId: message.senderId,
        senderName: isMine ? 'You' : (activeEntity.nickname || activeEntity.name),
        content: message.content || '',
        mediaUrl: message.mediaUrl || null,
        mediaName: message.mediaName || null,
        mediaKind: message.mediaKind || null,
        isMedia: Boolean((message.isMedia || message.mediaUrl) && message.mediaKind !== 'audio'),
        isVoice: message.mediaKind === 'audio',
        duration: message.mediaKind === 'audio' ? (message.content || '') : null,
        reactions: Array.isArray(message.reactions) ? message.reactions : [],
        reply: message.reply || null,
        replyTo: message.replyTo || null,
        editedAt: message.editedAt || null,
        isDeleted: Boolean(message.isDeleted),
        isRead: Boolean(message.isRead),
        pending: Boolean(message.pending),
        failed: Boolean(message.failed),
        createdAt: message.createdAt,
        time: formatTime(message.createdAt),
        isMine
      };
    });

    return [...list, ...pendingUploads];
  }, [activeEntity, isGroupThread, uploads, social?.conversations, selfId, relayGroups.messages]);

  const filteredMessages = currentMessages;

  const renderedItems = useMemo(() => {
    const items = [];
    let lastKey = null;
    filteredMessages.forEach((message, index) => {
      const key = dayKeyOf(message.createdAt);
      if (key !== lastKey) {
        items.push({ isDivider: true, id: `divider-${key}-${index}`, date: dayLabelOf(message.createdAt) });
        lastKey = key;
      }
      const previous = filteredMessages[index - 1];
      const next = filteredMessages[index + 1];
      const canGroup = (first, second) => Boolean(
        first && second &&
        !first.isSystem && !second.isSystem &&
        first.senderId === second.senderId &&
        dayKeyOf(first.createdAt) === dayKeyOf(second.createdAt) &&
        Math.abs((second.createdAt || 0) - (first.createdAt || 0)) <= 5 * 60_000 &&
        !second.reply &&
        !first.isDeleted
      );
      items.push({
        ...message,
        groupedWithPrevious: canGroup(previous, message),
        groupedWithNext: canGroup(message, next)
      });
    });
    return items;
  }, [filteredMessages]);

  const isTypingHere = Boolean(!isGroupThread && activeEntity && social?.typingBy?.[activeEntity.id]);

  // Scrolling: a chat always opens at its newest message (set before paint, no
  // animation), older pages load in above without moving what you are reading,
  // and new messages only pull you down when you were already at the bottom.
  useLayoutEffect(() => {
    const node = messageStreamRef.current;
    if (!node) return;
    const memo = scrollStateRef.current;
    const chatId = activeEntity?.id || null;
    const firstId = renderedItems.find((item) => !item.isDivider)?.id || null;
    if (memo.chatId !== chatId) {
      atBottomRef.current = true;
      node.scrollTop = node.scrollHeight;
    } else if (memo.firstId && firstId && memo.firstId !== firstId && !atBottomRef.current) {
      node.scrollTop = memo.top + (node.scrollHeight - memo.height);
    } else if (atBottomRef.current) {
      node.scrollTop = node.scrollHeight;
    }
    scrollStateRef.current = { chatId, firstId, height: node.scrollHeight, top: node.scrollTop };
  }, [renderedItems, isTypingHere, activeEntity?.id]);

  // Images/GIFs finish loading after layout: stay pinned to the bottom.
  const handleStreamMediaLoad = () => {
    const node = messageStreamRef.current;
    if (node && atBottomRef.current) node.scrollTop = node.scrollHeight;
    if (node) scrollStateRef.current = { ...scrollStateRef.current, height: node.scrollHeight, top: node.scrollTop };
  };

  const handleStreamScroll = (event) => {
    const node = event.currentTarget;
    atBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60;
    scrollStateRef.current = { ...scrollStateRef.current, height: node.scrollHeight, top: node.scrollTop };
    if (node.scrollTop >= 240 || !activeEntity?.id) return;

    if (isGroupThread) {
      if (!relayGroups.loadingThread && relayGroups.hasMoreMessages) relayGroups.loadOlder(activeEntity.id);
    } else {
      const thread = social?.conversations?.[activeEntity.id];
      if (!thread?.loading && (thread?.hasMore || !thread?.loaded)) social?.loadOlder?.(activeEntity.id);
    }
  };

  // ── Actions ─────────────────────────────────────────────────────────

  const closePopovers = () => {
    setShowMenuDropdown(false);
    setShowEmojiPicker(false);
    setShowGifPicker(false);
  };
  const closeMenu = useCallback(() => setShowMenuDropdown(false), []);
  const closeEmoji = useCallback(() => setShowEmojiPicker(false), []);
  const closeGif = useCallback(() => setShowGifPicker(false), []);
  useDismiss(menuRef, showMenuDropdown, closeMenu);

  const focusComposer = useCallback(() => {
    window.requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
  }, []);

  // Replying puts the cursor in the message box.
  const handleReply = useCallback((message) => {
    relayGroups.setReplyTarget(message);
    focusComposer();
  }, [relayGroups, focusComposer]);

  const insertEmoji = useCallback((emoji) => {
    const input = composerRef.current;
    setComposerText((previous) => {
      const start = input && typeof input.selectionStart === 'number' ? input.selectionStart : previous.length;
      const end = input && typeof input.selectionEnd === 'number' ? input.selectionEnd : previous.length;
      const next = (previous.slice(0, start) + emoji + previous.slice(end)).slice(0, MESSAGE_MAX);
      window.requestAnimationFrame(() => {
        if (!input) return;
        input.focus({ preventScroll: true });
        const caret = Math.min(next.length, start + emoji.length);
        try { input.setSelectionRange(caret, caret); } catch { /* ignore */ }
      });
      return next;
    });
  }, []);

  const handleSelectThread = (thread) => {
    if (thread.id === selectedId) return;
    setSelectedId(thread.id);
    setStagedFile(null);
    closePopovers();
    relayGroups.clearReply();

    if (thread.kind === 'group') {
      social?.setActiveChatFriend?.(null);
      relayGroups.openGroup(thread.id);
    } else {
      social?.setActiveChatFriend?.(thread);
      relayGroups.closeGroup();
    }
  };
  // A notification was clicked: open that chat as soon as it is in the inbox
  // (on a cold start the lists may still be loading).
  const pendingOpenRef = useRef(null);
  useEffect(() => {
    if (openRequest?.nonce) pendingOpenRef.current = { ...openRequest, at: Date.now() };
  }, [openRequest?.nonce]);
  useEffect(() => {
    const request = pendingOpenRef.current;
    if (!request) return;
    if (!request.id) {
      pendingOpenRef.current = null;
      setSelectedId(null);
      setFriendsHomeRequest((previous) => ({ tab: request.tab || 'online', nonce: previous.nonce + 1 }));
      return;
    }
    if (Date.now() - request.at > 30_000) { pendingOpenRef.current = null; return; }
    const thread = allThreads.find((item) => item.id === request.id);
    if (!thread) return;
    pendingOpenRef.current = null;
    if (thread.id === selectedId) return;
    handleSelectThread(thread);
  });



  const handleDeselectChat = useCallback(() => {
    setSelectedId(null);
    setStagedFile(null);
    closePopovers();
    relayGroups.clearReply();
    social?.setActiveChatFriend?.(null);
    relayGroups.closeGroup();
  }, [relayGroups, social]);

  const handleClearChat = useCallback(async (friendId) => {
    if (!friendId) return;
    if (social?.conversations?.[friendId]) {
      social.conversations[friendId].messages = [];
    }
    onNotify?.('Chat Cleared', 'Conversation history cleared');
  }, [social, onNotify]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        if (showMenuDropdown || showEmojiPicker || showGifPicker) {
          closePopovers();
        } else if (selectedId) {
          handleDeselectChat();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, showMenuDropdown, showEmojiPicker, showGifPicker, handleDeselectChat]);

  const handleTogglePin = (entity) => {
    if (!entity) return;
    setShowMenuDropdown(false);
    const next = !entity.pinned;
    setPinnedIds((previous) => ({ ...previous, [entity.id]: next }));

    const request = entity.kind === 'group'
      ? relayGroups.setGroupPrefs(entity.id, { pinned: next })
      : social?.updateFriend?.(entity.id, { pinned: next });
    Promise.resolve(request).catch(() => {});
  };

  const handleToggleMute = (entity) => {
    if (!entity) return;
    setShowMenuDropdown(false);
    const next = !entity.muted;

    // Local state + localStorage win immediately so a friends/groups refresh
    // can never flip the toggle back while the request is in flight.
    setMutedIds((previous) => ({ ...previous, [entity.id]: next }));

    const request = entity.kind === 'group'
      ? relayGroups.setGroupPrefs(entity.id, { muted: next })
      : social?.updateFriend?.(entity.id, { muted: next });
    Promise.resolve(request).catch(() => {});
  };

  const handleGroupLeave = async (group) => {
    if (!group?.id) return;
    setShowMenuDropdown(false);
    const result = await relayGroups.leaveGroup(group.id);
    if (result?.ok) {
      if (selectedId === group.id) {
        setSelectedId(null);
      }
      onNotify?.('Group left', `You left ${group.name || 'the group'}`);
    } else {
      onNotify?.('Error', result?.error || 'Failed to leave group');
    }
  };

  const handleGroupDelete = async (group) => {
    if (!group?.id) return;
    setShowMenuDropdown(false);
    const result = await relayGroups.deleteGroup(group.id);
    if (result?.ok) {
      if (selectedId === group.id) {
        setSelectedId(null);
      }
      onNotify?.('Group deleted', `Deleted ${group.name || 'the group'}`);
    } else {
      onNotify?.('Error', result?.error || 'Failed to delete group');
    }
  };

  const handleToggleReaction = async (messageId, emoji) => {
    if (!messageId || !emoji || !activeEntity) return;
    if (String(messageId).startsWith('upload-')) return;
    if (isGroupThread) await relayGroups.toggleReaction(activeEntity.id, messageId, emoji);
    else await social?.setMessageReaction?.(messageId, emoji);
  };

  const handleEditMessage = async (messageId, content) => {
    const result = isGroupThread
      ? await relayGroups.editGroupMessage(messageId, content)
      : await social?.editMessage?.(messageId, content);
    if (result && result.ok === false && result.error) onNotify?.('Edit failed', result.error);
  };

  const handleDeleteMessage = async (messageId) => {
    const result = isGroupThread
      ? await relayGroups.deleteGroupMessage(messageId)
      : await social?.deleteMessage?.(messageId);
    if (result && result.ok === false && result.error) onNotify?.('Delete failed', result.error);
  };

  const handleComposerChange = (event) => {
    setComposerText(event.target.value);
    if (!activeEntity?.id) return;
    if (isGroupThread) relayGroups.notifyGroupTyping(activeEntity.id);
    else if (event.target.value) social?.notifyTyping?.(activeEntity.id);
  };

  const replyPayload = (target) => {
    if (!target?.id) return {};
    return {
      replyTo: target.id,
      reply: {
        id: target.id,
        senderId: target.isMine ? selfId : target.senderId,
        senderName: target.senderName,
        content: target.content,
        mediaName: target.mediaName
      }
    };
  };

  const dispatchMessage = useCallback(async (entity, text, options) => {
    if (entity.kind === 'group') {
      return relayGroups.sendGroupMessage(entity.id, text, {
        mediaUrl: options.mediaUrl || null,
        mediaName: options.mediaName || null,
        mediaKind: options.mediaKind || null,
        isMedia: Boolean(options.isMedia),
        replyTo: options.replyTo || null
      });
    }
    return social?.sendMessage?.(entity.id, text, options);
  }, [relayGroups, social]);

  const uploadAndSend = useCallback(async (entity, text, file, reply) => {
    const tempId = `upload-${Date.now()}`;
    const placeholder = {
      id: tempId,
      senderId: selfId,
      senderName: 'You',
      content: text,
      mediaUrl: file.dataUrl,
      mediaName: file.name,
      isMedia: file.isImage,
      isUploading: true,
      createdAt: Date.now(),
      time: formatTime(Date.now()),
      isMine: true,
      file,
      reply: reply?.reply || null
    };

    setUploads((previous) => ({ ...previous, [entity.id]: [...(previous[entity.id] || []), placeholder] }));

    try {
      const upload = await social?.uploadMedia?.(file.dataUrl, file.name);
      if (!upload?.ok || !upload.url) throw new Error(upload?.error || 'Upload failed');

      const result = await dispatchMessage(entity, text, {
        mediaUrl: upload.url,
        mediaName: file.name,
        mediaKind: file.isImage ? 'image' : 'file',
        isMedia: file.isImage,
        ...reply
      });
      if (result && result.ok === false) throw new Error(result.error || 'Message failed');

      setUploads((previous) => ({
        ...previous,
        [entity.id]: (previous[entity.id] || []).filter((item) => item.id !== tempId)
      }));
    } catch (error) {
      setUploads((previous) => ({
        ...previous,
        [entity.id]: (previous[entity.id] || []).map((item) => (
          item.id === tempId ? { ...item, isUploading: false, uploadFailed: true } : item
        ))
      }));
      onNotify?.('Upload failed', error?.message || 'Could not upload the attachment.');
    }
  }, [dispatchMessage, onNotify, selfId, social]);

  const handleSendMessage = async (event) => {
    event?.preventDefault();
    const text = composerText.trim().slice(0, MESSAGE_MAX);
    if ((!text && !stagedFile) || sending || !activeEntity) return;

    setSending(true);
    const file = stagedFile;
    const reply = replyPayload(relayGroups.replyTarget);
    setComposerText('');
    setStagedFile(null);
    closePopovers();
    relayGroups.clearReply();
    atBottomRef.current = true;

    if (isGroupThread) relayGroups.stopGroupTyping(activeEntity.id);
    else social?.stopTyping?.(activeEntity.id);

    if (file) {
      await uploadAndSend(activeEntity, text, file, reply);
    } else if (text) {
      const result = await dispatchMessage(activeEntity, text, reply);
      if (result && result.ok === false && result.error) onNotify?.('Message failed', result.error);
    }

    setSending(false);
  };

  const handleRetry = async (message) => {
    if (!activeEntity) return;
    if (String(message.id).startsWith('upload-')) {
      setUploads((previous) => ({
        ...previous,
        [activeEntity.id]: (previous[activeEntity.id] || []).filter((item) => item.id !== message.id)
      }));
      const reply = message.reply ? { replyTo: message.reply.id, reply: message.reply } : {};
      await uploadAndSend(activeEntity, message.content || '', message.file, reply);
      return;
    }
    if (isGroupThread) {
      await relayGroups.sendGroupMessage(activeEntity.id, message.content || '', {
        mediaUrl: message.mediaUrl,
        mediaName: message.mediaName,
        mediaKind: message.mediaKind,
        isMedia: Boolean(message.isMedia),
        replyTo: message.replyTo || null
      });
      return;
    }
    await social?.retryMessage?.(activeEntity.id, message);
  };

  const stageFile = (file) => {
    if (!file) return;
    if (file.size > MAX_ATTACHMENT) {
      onNotify?.('Attachment too large', 'Files must be under 25MB.');
      return;
    }

    const reader = new FileReader();
    const isImage = file.type.startsWith('image/');
    setStagedFile({
      name: file.name,
      size: `${Math.round(file.size / 1024)} KB`,
      dataUrl: null,
      isImage,
      progress: 0
    });
    reader.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const progress = Math.round((event.loaded / event.total) * 100);
      setStagedFile((previous) => (previous ? { ...previous, progress } : previous));
    };
    reader.onload = (event) => {
      setStagedFile((previous) => (
        previous ? { ...previous, dataUrl: event.target?.result, progress: 100 } : previous
      ));
    };
    reader.onerror = () => {
      setStagedFile(null);
      onNotify?.('Attachment failed', 'Could not read that file.');
    };
    reader.readAsDataURL(file);
  };

  // Ctrl+V with a picture on the clipboard (screenshot, copied image) attaches it.
  const pastedImage = (clipboard) => {
    const items = Array.from(clipboard?.items || []);
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          const ext = (item.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
          return file.name && file.name !== 'image.png' ? file : new File([file], `pasted-${Date.now()}.${ext}`, { type: item.type });
        }
      }
    }
    const files = Array.from(clipboard?.files || []);
    return files.find((file) => file.type.startsWith('image/')) || files[0] || null;
  };

  const handleComposerPaste = (event) => {
    const file = pastedImage(event.clipboardData);
    if (!file) return;
    event.preventDefault();
    stageFile(file);
  };

  // Pasting a picture while the chat is open but the box isn't focused works too.
  const stageFileRef = useRef(null);
  stageFileRef.current = stageFile;
  const hasChat = Boolean(activeEntity);
  useEffect(() => {
    if (!hasChat) return undefined;
    const onPaste = (event) => {
      const target = event.target;
      if (target === composerRef.current) return;
      if (target?.closest?.('input, textarea, [contenteditable="true"]')) return;
      const file = pastedImage(event.clipboardData);
      if (!file) return;
      event.preventDefault();
      stageFileRef.current?.(file);
      composerRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [hasChat]);

  const handleFileChange = (event) => {
    stageFile(event.target.files?.[0]);
    event.target.value = '';
  };

  const handleDragEnter = (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  };

  const handleDragLeave = (event) => {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  };

  const handleDrop = (event) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    stageFile(event.dataTransfer?.files?.[0]);
  };

  const handleSendGif = async (gif) => {
    setShowGifPicker(false);
    if (!activeEntity) return;
    atBottomRef.current = true;
    const reply = replyPayload(relayGroups.replyTarget);
    relayGroups.clearReply();

    await dispatchMessage(activeEntity, '', {
      mediaUrl: gif.url,
      mediaName: `${String(gif.title || gif.label || 'GIF').replace(/[^\w .-]+/g, '').trim().slice(0, 60) || 'GIF'}.gif`,
      mediaKind: 'image',
      isMedia: true,
      ...reply
    });
  };

  const scrollToMessage = useCallback((targetId) => {
    const element = document.getElementById(`msg-${targetId}`);
    if (!element) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.classList.add('relay-msg-highlight');
    setTimeout(() => element.classList.remove('relay-msg-highlight'), 1800);
  }, []);

  const activePresence = getPresence(activeEntity);
  const activeThreadState = isGroupThread
    ? relayGroups.threads?.[activeEntity?.id]
    : social?.conversations?.[activeEntity?.id];
  // Skeletons until the first page of this chat has arrived (never another chat's messages).
  const isLoadingThread = Boolean(activeEntity) && !activeThreadState?.loaded && !(activeThreadState?.messages?.length);
  const isLoadingOlder = Boolean(activeThreadState?.loaded && activeThreadState?.loading && activeThreadState?.hasMore);



  const sections = [
    { key: 'pinned', label: 'Pinned', list: pinnedList, empty: null, grouped: true },
    { key: 'groups', label: 'Groups', list: groupList, empty: 'No matching groups', grouped: true },
    { key: 'direct', label: 'Direct messages', list: directList, empty: 'No direct messages', grouped: false }
  ];

  // Your own profile, rendered through the same panel the friend view uses.
  const selfUser = useMemo(() => {
    if (!account) return null;
    return {
      ...account,
      id: selfId || account.id,
      name: account.name || account.username || 'You',
      nickname: account.nickname || account.displayName || account.name || 'You',
      skinUrl: account.skinUrl || account.avatarUrl || null,
      memberSince: account.memberSince || account.createdAt || null
    };
  }, [account, selfId]);

  const friendIdSet = useMemo(() => new Set((social?.friends || []).map((friend) => friend.id)), [social?.friends]);
  const hasProfilePanel = Boolean((activeEntity && showProfilePanel) || (showSelfProfile && selfUser));
  const liveActiveGroup = useMemo(
    () => withLivePresence(relayGroups.activeGroup, social?.friends || [], selfId, selfPresence),
    [relayGroups.activeGroup, social?.friends, selfId, selfPresence]
  );
  const settingsGroupEntity = relayGroups.activeGroup
    ? formattedGroups.find((group) => group.id === relayGroups.activeGroup.id) || null
    : null;
  const openGroupSettings = (initialTab = 'overview') => {
    setSettingsInitialTab(initialTab);
    setSettingsOpen(true);
  };

  if (social && social.isNative === false) {
    return (
      <div className="relay-page relay-page-gate">
        <div className="relay-empty-chat">
          <div className="relay-empty-icon"><MessageSquare size={38} strokeWidth={1.6} /></div>
          <h3 className="relay-empty-title">Native account required</h3>
          <p className="relay-empty-desc">
            Sign in with your Native account to use Relay messaging, friends and presence.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className={`relay-page ${hasProfilePanel ? 'has-profile-panel' : ''}`} data-testid="relay-page">
      <aside className="relay-inbox">
        <div className="relay-inbox-header">
          <div className="relay-inbox-title-row">
            <h2 className="relay-inbox-title page-title">Relay</h2>
            <span
              className={`relay-live-dot ${social?.isRealtime ? 'is-live' : ''}`}
              title={social?.isRealtime ? 'Realtime connected' : `Realtime ${social?.streamStatus || 'offline'}`}
              data-testid="relay-live-indicator"
            />
            <button
              type="button"
              className={`relay-inbox-btn relay-self-btn ${showSelfProfile ? 'is-active' : ''}`}
              data-testid="relay-self-profile-btn"
              onClick={() => setShowSelfProfile((open) => !open)}
              title={showSelfProfile ? 'Hide your profile' : 'Your profile'}
              aria-pressed={showSelfProfile}
            >
              <UserSquare2 size={15} />
            </button>
            <button
              type="button"
              className="relay-inbox-btn"
              data-testid="relay-create-group-btn"
              onClick={() => setCreateOpen(true)}
              title="New group"
            >
              <Plus size={15} />
            </button>
          </div>
          <div className="relay-inbox-search-bar">
            <Search size={13} className="relay-search-icon" aria-hidden="true" />
            <input
              type="text"
              value={inboxQuery}
              onChange={(event) => setInboxQuery(event.target.value)}
              placeholder="Search conversations"
              className="relay-inbox-input"
              data-testid="relay-inbox-search"
            />
          </div>
        </div>

        <div className="relay-inbox-scroll">
          {allThreads.length === 0 && (social?.initialLoading || relayGroups.loadingGroups) ? (
            <>
              <section className="relay-section"><div className="relay-section-header"><span>Groups</span></div><ThreadSkeletons count={2} /></section>
              <section className="relay-section"><div className="relay-section-header"><span>Direct messages</span></div><ThreadSkeletons count={4} /></section>
            </>
          ) : allThreads.length === 0 ? (
            <div className="relay-empty-inbox">
              <div className="relay-empty-icon"><UserSquare2 size={38} strokeWidth={1.6} /></div>
              <div className="relay-empty-title">Nothing here yet</div>
              <div className="relay-empty-desc">
                Add friends by Minecraft username, or start a group to get the crew together.
              </div>
              <button type="button" className="relay-empty-btn" onClick={() => {
                setSelectedId(null);
                setFriendsHomeRequest((previous) => ({ tab: 'add', nonce: previous.nonce + 1 }));
              }}>
                <UserPlus size={13} />
                <span>Add friend</span>
              </button>
              <button type="button" className="relay-empty-btn relay-empty-btn--secondary" onClick={() => setCreateOpen(true)}>
                <Plus size={13} />
                <span>Create group</span>
              </button>
            </div>
          ) : (
            sections.map((section) => {
              if (section.key === 'pinned' && section.list.length === 0) return null;
              if (section.key === 'groups' && formattedGroups.length === 0 && !relayGroups.loadingGroups) return null;
              const isCollapsed = collapsed[section.key];
              return (
                <section className="relay-section" key={section.key}>
                  <button
                    type="button"
                    className="relay-section-header"
                    data-testid={`relay-section-${section.key}`}
                    onClick={() => setCollapsed((previous) => ({ ...previous, [section.key]: !previous[section.key] }))}
                  >
                    {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    <span>{section.label}</span>
                    <span className="relay-section-count">{section.list.length}</span>
                  </button>
                  {!isCollapsed && (
                    <div className="relay-threads-list">
                      {section.list.length === 0 ? (
                        (section.key === 'groups' && relayGroups.loadingGroups) || (section.key === 'direct' && social?.initialLoading)
                          ? <ThreadSkeletons count={section.key === 'groups' ? 2 : 3} />
                          : section.key === 'direct' && social?.socialError && !(social?.friends || []).length
                            ? (
                              <div className="relay-section-empty relay-section-error">
                                <span>Couldn’t load your chats.</span>
                                <button type="button" className="relay-retry-btn" onClick={() => social?.refresh?.()}>Retry</button>
                              </div>
                            )
                            : <div className="relay-section-empty">{section.empty}</div>
                      ) : (
                        section.list.map((thread, index) => (
                          <ThreadRow
                            key={thread.id}
                            thread={thread}
                            index={index}
                            active={thread.id === activeEntity?.id}
                            presence={getPresence(thread)}
                            isGroup={thread.kind === 'group'}
                            onClick={() => handleSelectThread(thread)}
                            onTogglePin={(e) => {
                              e?.stopPropagation();
                              handleTogglePin(thread);
                            }}
                            onToggleMute={(e) => {
                              e?.stopPropagation();
                              handleToggleMute(thread);
                            }}
                            onOpenSettings={(t) => {
                              setSelectedId(t.id);
                              openGroupSettings();
                            }}
                            onLeaveGroup={handleGroupLeave}
                            onDeleteGroup={handleGroupDelete}
                          />
                        ))
                      )}
                    </div>
                  )}
                </section>
              );
            })
          )}
        </div>
      </aside>

      <main
        className={`relay-chat-main ${dragActive ? 'is-dropping' : ''}`}
        onDragEnter={handleDragEnter}
        onDragOver={(event) => {
          if (event.dataTransfer?.types?.includes('Files')) event.preventDefault();
        }}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {activeEntity ? (
          <>
            <header className="relay-chat-header">
              <div
                className="relay-peer-info"
                onClick={() => isGroupThread && openGroupSettings()}
                title={isGroupThread ? 'Group settings & members' : undefined}
                data-testid="relay-peer-info"
              >
                <div className="relay-peer-avatar-wrapper">
                  {isGroupThread ? (
                    <GroupAvatarBadge group={activeEntity} size={40} className="relay-peer-avatar" />
                  ) : (
                    <RelayAvatar
                      name={activeEntity?.name}
                      skinUrl={activeEntity?.skinUrl}
                      size={40}
                      className="relay-peer-avatar"
                    />
                  )}
                  <span
                    className={`relay-peer-presence-dot ${activePresence.status}`}
                    style={{ backgroundColor: activePresence.color }}
                  />
                </div>

                <div className="relay-peer-meta">
                  <div className="relay-peer-name-row">
                    <span className="relay-peer-name">{activeEntity?.nickname || activeEntity?.name || 'Chat'}</span>
                    {activeEntity?.muted && <BellOff size={12} className="relay-peer-flag" />}
                  </div>
                  <div className="relay-peer-status-row">
                    <span className={`relay-peer-status-text ${activePresence.status}`}>{activePresence.text}</span>
                    {canJoinServer(activeEntity) && !isGroupThread && (
                      <button
                        type="button"
                        className="relay-join-inline"
                        data-testid="relay-join-server-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          onJoinServer?.(activeEntity);
                        }}
                        title={`Join ${activeEntity.serverAddress}`}
                      >
                        Join
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <div className="relay-header-actions">
                {isGroupThread && (
                  <button
                    type="button"
                    className={`relay-action-btn ${showProfilePanel ? 'is-active' : ''}`}
                    data-testid="relay-group-members-toggle-btn"
                    onClick={() => setShowProfilePanel((visible) => !visible)}
                    title={showProfilePanel ? 'Hide group members' : 'Show group members'}
                  >
                    <Users size={16} />
                  </button>
                )}
                <button
                  type="button"
                  className={`relay-action-btn ${activeEntity.muted ? 'is-active' : ''}`}
                  data-testid="relay-mute-btn"
                  onClick={() => handleToggleMute(activeEntity)}
                  title={activeEntity.muted ? 'Unmute conversation' : 'Mute conversation'}
                >
                  {activeEntity.muted ? <BellOff size={16} /> : <Bell size={16} />}
                </button>
                <button
                  type="button"
                  className={`relay-action-btn ${activeEntity.pinned ? 'is-active' : ''}`}
                  data-testid="relay-pin-btn"
                  onClick={() => handleTogglePin(activeEntity)}
                  title={activeEntity.pinned ? 'Unpin conversation' : 'Pin conversation'}
                >
                  <Pin size={16} />
                </button>

                <div className="relay-menu-wrapper" ref={menuRef}>
                  <button
                    type="button"
                    className={`relay-action-btn ${showMenuDropdown ? 'is-active' : ''}`}
                    data-testid="relay-more-actions-btn"
                    onClick={() => setShowMenuDropdown((open) => !open)}
                    title="More actions"
                  >
                    <MoreHorizontal size={16} />
                  </button>

                  {showMenuDropdown && (
                    <div className="relay-dropdown-menu" data-testid="relay-actions-menu">
                      <button type="button" onClick={() => handleTogglePin(activeEntity)}>
                        <Pin size={13} />
                        <span>{activeEntity.pinned ? 'Unpin conversation' : 'Pin conversation'}</span>
                      </button>
                      <button type="button" onClick={() => handleToggleMute(activeEntity)}>
                        {activeEntity.muted ? <Bell size={13} /> : <BellOff size={13} />}
                        <span>{activeEntity.muted ? 'Unmute conversation' : 'Mute conversation'}</span>
                      </button>
                      {isGroupThread ? (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              openGroupSettings();
                              setShowMenuDropdown(false);
                            }}
                          >
                            <Users size={13} />
                            <span>Group settings</span>
                          </button>
                          <div className="relay-context-divider" />
                          {activeEntity.role === 'owner' ? (
                            <button
                              type="button"
                              className="is-danger"
                              onClick={() => handleGroupDelete(activeEntity)}
                            >
                              <Trash2 size={13} />
                              <span>Delete group</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="is-danger"
                              onClick={() => handleGroupLeave(activeEntity)}
                            >
                              <LogOut size={13} />
                              <span>Leave group</span>
                            </button>
                          )}
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              if (activeEntity?.name) {
                                navigator.clipboard?.writeText(activeEntity.name);
                                onNotify?.('Copied', `Copied username ${activeEntity.name}`);
                              }
                              setShowMenuDropdown(false);
                            }}
                          >
                            <UserSquare2 size={13} />
                            <span>Copy username</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              social?.setNicknameModalFriend?.(activeEntity);
                              setShowMenuDropdown(false);
                            }}
                          >
                            <FileText size={13} />
                            <span>Set nickname</span>
                          </button>
                          <div className="relay-context-divider" />
                          <button
                            type="button"
                            onClick={() => {
                              handleClearChat(activeEntity.id);
                              setShowMenuDropdown(false);
                            }}
                          >
                            <Trash2 size={13} />
                            <span>Clear chat history</span>
                          </button>
                          <button
                            type="button"
                            className="is-danger"
                            onClick={async () => {
                              setShowMenuDropdown(false);
                              if (window.confirm(`Remove ${activeEntity.nickname || activeEntity.name} from friends?`)) {
                                await social?.unfriend?.(activeEntity.id);
                                setSelectedId(null);
                                onNotify?.('Friend Removed', `Removed ${activeEntity.name}`);
                              }
                            }}
                          >
                            <UserMinus size={13} />
                            <span>Remove friend</span>
                          </button>
                          <button
                            type="button"
                            className="is-danger"
                            onClick={async () => {
                              setShowMenuDropdown(false);
                              if (window.confirm(`Block ${activeEntity.nickname || activeEntity.name}?`)) {
                                await social?.block?.(activeEntity.id);
                                setSelectedId(null);
                                onNotify?.('User Blocked', `Blocked ${activeEntity.name}`);
                              }
                            }}
                          >
                            <Ban size={13} />
                            <span>Block user</span>
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>

                {!isGroupThread && (
                  <button
                    type="button"
                    className={`relay-action-btn ${showProfilePanel ? 'is-active' : ''}`}
                    data-testid="relay-profile-toggle-btn"
                    onClick={() => setShowProfilePanel((p) => !p)}
                    title={showProfilePanel ? 'Hide profile' : 'Show profile'}
                  >
                    <UserSquare2 size={16} />
                  </button>
                )}
                <button
                  type="button"
                  className="relay-action-btn"
                  data-testid="relay-close-chat-btn"
                  onClick={handleDeselectChat}
                  title="Close conversation (Esc)"
                >
                  <X size={17} />
                </button>
              </div>
            </header>

            <div ref={messageStreamRef} className="relay-message-stream" onScroll={handleStreamScroll} onLoadCapture={handleStreamMediaLoad}>
              {isLoadingThread && <MessageSkeletons />}
              {isLoadingOlder && (
                <div className="relay-older-loading" aria-label="Loading older messages"><span className="relay-typing-dots"><i /><i /><i /></span></div>
              )}

              {isLoadingThread ? null : renderedItems.length === 0 ? (
                isLoadingThread ? null : (
                  <div className="relay-empty-stream">
                    <div className="relay-empty-stream-avatar">
                      <RelayAvatar name={activeEntity?.name} skinUrl={activeEntity?.skinUrl} size={56} />
                    </div>
                    <h3 className="relay-empty-stream-name">{activeEntity?.nickname || activeEntity?.name}</h3>
                    <p className="relay-empty-stream-text">
                      This is the very beginning of your conversation history.
                    </p>
                  </div>
                )
              ) : (
                renderedItems.map((item) => {
                  if (item.isDivider) {
                    return (
                      <div key={item.id} className="relay-date-divider">
                        <span className="relay-date-pill">{item.date}</span>
                      </div>
                    );
                  }
                  if (item.isSystem) {
                    return (
                      <div key={item.id} id={`msg-${item.id}`} className="relay-system-message">
                        {item.content}
                      </div>
                    );
                  }
                  return (
                    <MessageRow
                      key={item.id}
                      msg={item}
                      isGroup={isGroupThread}
                      selfId={selfId}
                      authorPlus={item.isMine ? isPlus : plusIds.has(item.senderId)}
                      selfName={account?.name || 'You'}
                      palette={REACTION_PALETTE}
                      canModerate={Boolean(relayGroups.canModerate)}
                      readAt={isGroupThread ? relayGroups.activeReadAt : 0}
                      onReply={handleReply}
                      onReact={handleToggleReaction}
                      onEdit={handleEditMessage}
                      onDelete={handleDeleteMessage}
                      onRetry={handleRetry}
                      onOpenMedia={setPreviewMediaModal}
                      onJump={scrollToMessage}
                    />
                  );
                })
              )}

              {isTypingHere && (
                <div className="relay-typing-indicator">
                  <span className="relay-typing-dots"><i /><i /><i /></span>
                  <span>{activeEntity.nickname || activeEntity.name} is typing</span>
                </div>
              )}
              {isGroupThread && relayGroups.typingNames?.length > 0 && (
                <div className="relay-typing-indicator">
                  <span className="relay-typing-dots"><i /><i /><i /></span>
                  <span>
                    {relayGroups.typingNames.length === 1
                      ? `${relayGroups.typingNames[0]} is typing`
                      : `${relayGroups.typingNames.slice(0, 2).join(', ')} are typing`}
                  </span>
                </div>
              )}
            </div>

            {dragActive && (
              <div className="relay-drop-overlay" data-testid="relay-drop-overlay">
                <div className="relay-drop-card">
                  <Upload size={22} />
                  <span className="relay-drop-title">Drop to attach</span>
                  <span className="relay-drop-hint">Images and files up to 25MB</span>
                </div>
              </div>
            )}

            <form className="relay-composer-form" onSubmit={handleSendMessage}>
              <ReplyComposerBar target={relayGroups.replyTarget} selfId={selfId} onCancel={relayGroups.clearReply} />

              {stagedFile && (
                <div className="relay-staged-preview" data-testid="relay-staged-attachment">
                  <div className="relay-staged-thumbnail">
                    {stagedFile.isImage && stagedFile.dataUrl ? (
                      <img src={stagedFile.dataUrl} alt="preview" />
                    ) : (
                      <FileText size={16} />
                    )}
                  </div>
                  <div className="relay-staged-details">
                    <span className="relay-staged-name">{stagedFile.name}</span>
                    <span className="relay-staged-size">{stagedFile.size}</span>
                    {stagedFile.progress < 100 && (
                      <span className="relay-progress-track">
                        <i className="relay-progress-fill" style={{ width: `${stagedFile.progress}%` }} />
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="relay-staged-remove"
                    onClick={() => setStagedFile(null)}
                    title="Remove attachment"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}

              {showGifPicker && <GifPicker onPick={handleSendGif} onClose={closeGif} />}

              {showEmojiPicker && <EmojiPicker onPick={insertEmoji} onClose={closeEmoji} />}

              <input ref={fileInputRef} type="file" accept="image/*,.txt,.log,.zip" hidden onChange={handleFileChange} />

              <div className="relay-composer-container">
                <input
                  ref={composerRef}
                  type="text"
                  value={composerText}
                  onChange={handleComposerChange}
                  onPaste={handleComposerPaste}
                  onBlur={() => {
                    if (!activeEntity?.id) return;
                    if (isGroupThread) relayGroups.stopGroupTyping(activeEntity.id);
                    else social?.stopTyping?.(activeEntity.id);
                  }}
                  placeholder={`Message ${activeEntity.nickname || activeEntity.name}`}
                  className="relay-composer-input"
                  data-testid="relay-composer-input"
                  maxLength={MESSAGE_MAX}
                />

                {composerText.length > MESSAGE_MAX - 200 && (
                  <span className="relay-composer-counter">{MESSAGE_MAX - composerText.length}</span>
                )}

                <div className="relay-composer-actions">
                  <button
                    type="button"
                    className={`relay-composer-btn ${showGifPicker ? 'is-active' : ''}`}
                    data-picker-toggle="gif"
                    data-testid="relay-gif-btn"
                    onClick={() => {
                      setShowGifPicker((open) => !open);
                      setShowEmojiPicker(false);
                    }}
                    title="GIFs"
                  >
                    <span className="relay-gif-label">GIF</span>
                  </button>
                  <button
                    type="button"
                    className={`relay-composer-btn ${showEmojiPicker ? 'is-active' : ''}`}
                    data-picker-toggle="emoji"
                    data-testid="relay-emoji-btn"
                    onClick={() => {
                      setShowEmojiPicker((open) => !open);
                      setShowGifPicker(false);
                    }}
                    title="Emoji"
                  >
                    <Smile size={17} />
                  </button>
                  <button
                    type="button"
                    className="relay-composer-btn"
                    data-testid="relay-attach-btn"
                    onClick={() => fileInputRef.current?.click()}
                    title="Attach file"
                  >
                    <Paperclip size={17} />
                  </button>
                  <button
                    type="submit"
                    className="relay-send-btn"
                    data-testid="relay-send-btn"
                    disabled={(!composerText.trim() && !stagedFile) || sending || (stagedFile && stagedFile.progress < 100)}
                    title="Send"
                  >
                    <Send size={15} />
                  </button>
                </div>
              </div>
            </form>
          </>
        ) : (
          <FriendsHome
            key={friendsHomeRequest.nonce}
            initialTab={friendsHomeRequest.tab}
            social={social}
            selfId={selfId}
            onOpenChat={(friendId) => handleSelectThread({ id: friendId, kind: 'dm' })}
            onNotify={onNotify}
            onJoinServer={onJoinServer}
          />
        )}
      </main>

      {showSelfProfile && selfUser ? (
        <UserProfilePanel
          user={selfUser}
          presence={selfPresence}
          isSelf
          onClose={() => setShowSelfProfile(false)}
          onOpenProfile={(user) => openProfile({ name: user.name, user, self: true })}
        />
      ) : activeEntity && isGroupThread && showProfilePanel ? (
        <GroupMembersPanel
          group={liveActiveGroup || activeEntity}
          selfId={selfId}
          friendIds={friendIdSet}
          onClose={() => setShowProfilePanel(false)}
          onOpenSettings={() => openGroupSettings()}
          onInvite={() => openGroupSettings('invite')}
        />
      ) : activeEntity && !isGroupThread && showProfilePanel ? (
        <UserProfilePanel
          user={activeEntity}
          presence={activePresence}
          isGroup={isGroupThread}
          onClose={() => setShowProfilePanel(false)}
          onOpenProfile={(user) => openProfile({ name: user.name, user, self: false })}
          onJoinServer={onJoinServer ? (user) => onJoinServer(user) : undefined}
          onUnfriend={async (id) => {
            await social?.unfriend?.(id);
            setSelectedId(null);
            onNotify?.('Friend Removed', `Removed ${activeEntity.name}`);
          }}
          onBlock={async (id) => {
            await social?.block?.(id);
            setSelectedId(null);
            onNotify?.('User Blocked', `Blocked ${activeEntity.name}`);
          }}
          onClearHistory={handleClearChat}
        />
      ) : null}

      <GroupCreateModal
        open={createOpen}
        friends={social?.friends || []}
        uploadMedia={social?.uploadMedia}
        onClose={() => setCreateOpen(false)}
        onCreate={async (payload) => {
          const result = await relayGroups.createGroup(payload);
          if (result?.ok && result.group?.id) {
            setSelectedId(result.group.id);
            relayGroups.openGroup(result.group.id);
            setCreateOpen(false);
          }
          return result;
        }}
      />

      <GroupSettingsModal
        open={settingsOpen}
        group={liveActiveGroup}
        initialTab={settingsInitialTab}
        muted={Boolean(settingsGroupEntity?.muted)}
        onToggleMute={() => settingsGroupEntity && handleToggleMute(settingsGroupEntity)}
        selfId={selfId}
        friends={social?.friends || []}
        uploadMedia={social?.uploadMedia}
        onClose={() => setSettingsOpen(false)}
        onUpdateGroup={relayGroups.updateGroup}
        onAddMembers={relayGroups.addMembers}
        onKickMember={relayGroups.kickMember}
        onSetMemberRole={relayGroups.setMemberRole}
        onLeaveGroup={async (id) => {
          const result = await relayGroups.leaveGroup(id);
          if (result?.ok) {
            setSettingsOpen(false);
            if (selectedId === id) setSelectedId(null);
          }
          return result;
        }}
        onDeleteGroup={async (id) => {
          const result = await relayGroups.deleteGroup(id);
          if (result?.ok) {
            setSettingsOpen(false);
            if (selectedId === id) setSelectedId(null);
          }
          return result;
        }}
      />

      {previewMediaModal &&
        createPortal(
          <div className="relay-lightbox-backdrop" onClick={() => setPreviewMediaModal(null)}>
            <button
              type="button"
              className="relay-lightbox-close"
              onClick={() => setPreviewMediaModal(null)}
              title="Close (Esc)"
              aria-label="Close preview"
            >
              <X size={20} />
            </button>
            <div className="relay-lightbox-content" onClick={(event) => event.stopPropagation()}>
              <img src={previewMediaModal} alt="Preview" className="relay-lightbox-img" />
              <div className="relay-lightbox-toolbar">
                <a href={previewMediaModal} download="attachment.png" className="relay-lightbox-btn">
                  <Download size={15} />
                  <span>Download original</span>
                </a>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
