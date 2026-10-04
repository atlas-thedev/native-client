import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Relay social state.
 *
 * Everything is event driven: one Server-Sent-Events connection in the main
 * process pushes `social:event` frames here, and every conversation is
 * preloaded up front so switching threads is instant and unread badges are
 * always accurate. HTTP polling only runs as a slow reconciliation fallback.
 */

const social = () => (typeof window !== 'undefined' ? window.native?.social : null);
const relay = () => (typeof window !== 'undefined' ? window.native?.relay : null);

const EMPTY_THREAD = { messages: [], hasMore: false, oldestTime: null, loading: false, loaded: false };
const TYPING_TTL = 6000;
const RECONCILE_INTERVAL = 20_000;
const PER_FRIEND_PRELOAD = 40;
const THREAD_PAGE_SIZE = 50;

const SOCIAL_CACHE_PREFIX = 'native.relay.social.';
const CACHE_THREAD_MESSAGES = 20;
const CACHE_MAX_THREADS = 40;

function readSocialCache(selfId) {
  if (!selfId) return null;
  try {
    const value = JSON.parse(localStorage.getItem(SOCIAL_CACHE_PREFIX + selfId) || 'null');
    return value && Array.isArray(value.friends) ? value : null;
  } catch { return null; }
}

function writeSocialCache(selfId, friends, conversations) {
  if (!selfId) return;
  try {
    const trimmed = {};
    Object.entries(conversations || {})
      .filter(([, thread]) => thread?.messages?.length)
      .sort((a, b) => (b[1].messages.at(-1)?.createdAt || 0) - (a[1].messages.at(-1)?.createdAt || 0))
      .slice(0, CACHE_MAX_THREADS)
      .forEach(([id, thread]) => {
        trimmed[id] = {
          messages: thread.messages.filter((m) => !String(m.id).startsWith('optimistic-')).slice(-CACHE_THREAD_MESSAGES),
          hasMore: true,
          oldestTime: thread.messages[0]?.createdAt ?? null,
          loading: false,
          loaded: true
        };
      });
    localStorage.setItem(SOCIAL_CACHE_PREFIX + selfId, JSON.stringify({ friends, conversations: trimmed, at: Date.now() }));
  } catch { /* quota */ }
}

function sortMessages(list) {
  return [...list].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

/** Merge incoming messages into a thread, replacing optimistic placeholders. */
function mergeMessages(existing, incoming) {
  const byId = new Map();
  for (const message of existing) byId.set(message.id, message);

  for (const message of incoming) {
    if (!message || !message.id) continue;
    // A confirmed message replaces its optimistic twin (same author + body).
    if (!String(message.id).startsWith('optimistic-')) {
      for (const [id, candidate] of byId) {
        if (!String(id).startsWith('optimistic-')) continue;
        const sameAuthor = candidate.senderId === message.senderId;
        const sameBody = (candidate.content || '') === (message.content || '') &&
          (candidate.mediaUrl || null) === (message.mediaUrl || null);
        if (sameAuthor && sameBody) {
          byId.delete(id);
          break;
        }
      }
    }
    const previous = byId.get(message.id);
    byId.set(message.id, previous ? { ...previous, ...message } : message);
  }

  return sortMessages([...byId.values()]);
}

export function useSocial(account) {
  // A connected premium account carries no token here: the main process holds it.
  const isNative = Boolean(account?.type === 'native' && (account?.token || account?.sessionToken || account?.linkedPremium));
  const selfId = account?.id || null;

  const initialCache = useMemo(() => (isNative ? readSocialCache(selfId) : null), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [friends, setFriends] = useState(() => initialCache?.friends || []);
  const [requests, setRequests] = useState({ received: [], sent: [] });
  const [conversations, setConversations] = useState(() => initialCache?.conversations || {});
  const [blocked, setBlocked] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [typingBy, setTypingBy] = useState({});
  const [streamStatus, setStreamStatus] = useState('connecting');
  const [initialLoading, setInitialLoading] = useState(() => !initialCache);
  const [socialError, setSocialError] = useState(null);
  const [liveUserCount, setLiveUserCount] = useState(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);

  const [contextMenu, setContextMenu] = useState(null);
  const [nicknameModalFriend, setNicknameModalFriend] = useState(null);

  const activeChatIdRef = useRef(null);
  const conversationsRef = useRef({});
  const inFlightThreadsRef = useRef(new Set());
  const cursorRef = useRef(0);
  const isPollingRef = useRef(false);
  const subscribersRef = useRef(new Set());
  const typingTimersRef = useRef({});
  const typingSentRef = useRef({});

  useEffect(() => { activeChatIdRef.current = activeChatId; }, [activeChatId]);
  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);

  const activeChatFriend = useMemo(
    () => friends.find((friend) => friend.id === activeChatId) || null,
    [friends, activeChatId]
  );

  const thread = conversations[activeChatId] || EMPTY_THREAD;
  const messages = thread.messages;

  // Loading ------------------------------------------------------------------

  const loadFriends = useCallback(async () => {
    const api = social();
    if (!api || !isNative) return;
    const res = await api.getFriends();
    if (Array.isArray(res?.friends)) setFriends(res.friends);
    if (res?.ok === false && res?.error) setSocialError(res.error);
    else setSocialError(null);
  }, [isNative]);

  const loadStats = useCallback(async () => {
    const api = social();
    if (!api?.getStats) return;
    try {
      const res = await api.getStats();
      if (res?.ok && Number.isFinite(Number(res.onlineUsers))) {
        setLiveUserCount(Math.max(0, Math.round(Number(res.onlineUsers))));
        return;
      }
    } catch {
      /* ignore */
    }
    setLiveUserCount(null);
  }, []);

  const loadRequests = useCallback(async () => {
    const api = social();
    if (!api || !isNative) return;
    const res = await api.getRequests();
    if (res?.requests) setRequests(res.requests);
  }, [isNative]);

  const loadConversations = useCallback(async () => {
    const api = social();
    if (!api || !isNative) return;
    const res = await api.getConversations(PER_FRIEND_PRELOAD);
    if (res?.conversations) {
      setConversations((previous) => {
        const next = { ...previous };
        for (const [friendId, payload] of Object.entries(res.conversations)) {
          const existing = next[friendId] || EMPTY_THREAD;
          next[friendId] = {
            ...existing,
            messages: mergeMessages(existing.messages, payload.messages || []),
            hasMore: Boolean(payload.hasMore),
            oldestTime: payload.oldestTime ?? existing.oldestTime,
            loading: false,
            loaded: true
          };
        }
        return next;
      });
      let newest = cursorRef.current;
      for (const payload of Object.values(res.conversations)) {
        for (const message of payload.messages || []) {
          if ((message.createdAt || 0) > newest) newest = message.createdAt;
        }
      }
      cursorRef.current = newest;
    }
  }, [isNative]);

  const loadBlocked = useCallback(async () => {
    const api = social();
    if (!api || !isNative) return;
    const res = await api.getBlocked?.();
    if (Array.isArray(res?.blocked)) setBlocked(res.blocked);
  }, [isNative]);

  /**
   * Fetch the newest page of a single conversation.
   *
   * The bulk preload only covers friends the server included in its payload,
   * so opening any other thread has to fetch its own history. Without this the
   * thread stays empty forever, because `loadOlder` needs an existing
   * `oldestTime`/`hasMore` to page backwards from.
   */
  const loadThread = useCallback(async (friendId, { force = false, markRead = true } = {}) => {
    const api = social();
    if (!api?.getMessages || !friendId) return;

    const current = conversationsRef.current[friendId];
    if (current?.loading || inFlightThreadsRef.current.has(friendId)) return;
    if (current?.loaded && !force) return;

    inFlightThreadsRef.current.add(friendId);

    setConversations((previous) => ({
      ...previous,
      [friendId]: { ...(previous[friendId] || EMPTY_THREAD), loading: true }
    }));

    let res = null;
    try {
      res = await api.getMessages(friendId, THREAD_PAGE_SIZE, { markRead });
    } catch {
      res = null;
    } finally {
      inFlightThreadsRef.current.delete(friendId);
    }

    setConversations((previous) => {
      const existing = previous[friendId] || EMPTY_THREAD;
      return {
        ...previous,
        [friendId]: {
          ...existing,
          messages: mergeMessages(existing.messages, res?.messages || []),
          hasMore: res ? Boolean(res.hasMore) : existing.hasMore,
          oldestTime: res?.oldestTime ?? existing.oldestTime,
          loading: false,
          loaded: Boolean(res)
        }
      };
    });

    for (const message of res?.messages || []) {
      if ((message.createdAt || 0) > cursorRef.current) cursorRef.current = message.createdAt;
    }
  }, []);

  // Keep a saved copy so the inbox opens instantly next time, and works offline.
  useEffect(() => {
    if (!isNative || !selfId || initialLoading) return undefined;
    const timer = setTimeout(() => writeSocialCache(selfId, friends, conversations), 1500);
    return () => clearTimeout(timer);
  }, [isNative, selfId, initialLoading, friends, conversations]);

  const refresh = useCallback(async () => {
    loadStats();
    if (!isNative) {
      setFriends([]);
      setRequests({ received: [], sent: [] });
      setConversations({});
      setInitialLoading(false);
      return;
    }
    await Promise.all([loadFriends(), loadRequests(), loadConversations(), loadBlocked()]);
    setInitialLoading(false);
  }, [isNative, loadFriends, loadRequests, loadConversations, loadBlocked, loadStats]);

  useEffect(() => {
    // A saved copy means there is nothing to wait for: refresh quietly behind it.
    const saved = isNative ? readSocialCache(selfId) : null;
    if (saved) {
      setFriends((current) => (current.length ? current : saved.friends));
      setConversations((current) => (Object.keys(current).length ? current : saved.conversations || {}));
    }
    setInitialLoading(!saved);
    refresh();
  }, [refresh, account?.id]);

  // Connection came back: refresh everything in the background.
  useEffect(() => {
    const onBack = () => { refresh(); };
    window.addEventListener('native:reconnected', onBack);
    return () => window.removeEventListener('native:reconnected', onBack);
  }, [refresh]);

  // Slow reconciliation only - realtime events do the heavy lifting.
  useEffect(() => {
    const timer = setInterval(() => {
      loadStats();
      if (isNative) {
        loadFriends();
        loadRequests();
      }
    }, RECONCILE_INTERVAL);
    return () => clearInterval(timer);
  }, [isNative, loadFriends, loadRequests, loadStats]);

  // Realtime -----------------------------------------------------------------

  const applyMessage = useCallback((message) => {
    if (!message) return;
    const friendId = message.senderId === selfId ? message.receiverId : message.senderId;
    if ((message.createdAt || 0) > cursorRef.current) cursorRef.current = message.createdAt;

    setConversations((previous) => {
      const existing = previous[friendId] || EMPTY_THREAD;
      return {
        ...previous,
        [friendId]: { ...existing, messages: mergeMessages(existing.messages, [message]) }
      };
    });

    const isIncoming = message.senderId !== selfId;
    const isOpen = activeChatIdRef.current === friendId;

    setFriends((previous) => previous.map((friend) => {
      if (friend.id !== friendId) return friend;
      return {
        ...friend,
        lastMessageContent: message.content || message.mediaName || 'Sent attachment',
        lastMessageTime: message.createdAt,
        lastMessageSenderId: message.senderId,
        lastMessageIsMedia: Boolean(message.isMedia),
        unreadCount: isIncoming && !isOpen
          ? (friend.unreadCount || 0) + 1
          : (isOpen ? 0 : friend.unreadCount || 0)
      };
    }));

    if (isIncoming && isOpen) social()?.markRead?.(friendId);
    if (isIncoming) {
      setTypingBy((previous) => (previous[friendId] ? { ...previous, [friendId]: false } : previous));
    }
  }, [selfId]);

  /** Patch an existing bubble in place after a remote edit or delete. */
  const applyMessageUpdate = useCallback((message) => {
    if (!message?.id) return;

    setConversations((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const [friendId, item] of Object.entries(previous)) {
        if (!item.messages.some((m) => m.id === message.id)) continue;
        next[friendId] = {
          ...item,
          messages: item.messages.map((m) => (m.id === message.id ? { ...m, ...message } : m))
        };
        changed = true;
      }
      return changed ? next : previous;
    });

    const friendId = message.senderId === selfId ? message.receiverId : message.senderId;
    setFriends((previous) => previous.map((friend) => (
      friend.id === friendId && friend.lastMessageTime === message.createdAt
        ? {
          ...friend,
          lastMessageContent: message.isDeleted
            ? 'Message deleted'
            : (message.content || message.mediaName || 'Sent attachment')
        }
        : friend
    )));
  }, [selfId]);

  const handleEvent = useCallback((event) => {
    if (!event) return;
    for (const sub of subscribersRef.current) {
      try { sub(event); } catch {}
    }

    switch (event.type) {
      case 'message:new':
        applyMessage(event.message);
        break;

      case 'message:updated':
        applyMessageUpdate(event.message);
        break;

      case 'message:reaction':
        setConversations((previous) => {
          const next = { ...previous };
          for (const [friendId, item] of Object.entries(next)) {
            if (!item.messages.some((m) => m.id === event.messageId)) continue;
            next[friendId] = {
              ...item,
              messages: item.messages.map((m) => (
                m.id === event.messageId ? { ...m, reactions: event.reactions || [] } : m
              ))
            };
          }
          return next;
        });
        break;

      case 'message:read':
        setConversations((previous) => {
          const friendId = event.readerId;
          const item = previous[friendId];
          if (!item) return previous;
          return {
            ...previous,
            [friendId]: {
              ...item,
              messages: item.messages.map((m) => (
                m.senderId === selfId && (!event.messageIds || event.messageIds.includes(m.id))
                  ? { ...m, isRead: 1 }
                  : m
              ))
            }
          };
        });
        break;

      case 'typing': {
        const friendId = event.userId;
        setTypingBy((previous) => ({ ...previous, [friendId]: Boolean(event.isTyping) }));
        clearTimeout(typingTimersRef.current[friendId]);
        if (event.isTyping) {
          typingTimersRef.current[friendId] = setTimeout(() => {
            setTypingBy((previous) => ({ ...previous, [friendId]: false }));
          }, TYPING_TTL);
        }
        break;
      }

      case 'presence':
        setFriends((previous) => previous.map((friend) => (
          friend.id === event.userId
            ? {
              ...friend,
              status: event.status || 'offline',
              activity: event.status === 'offline' ? null : (event.activity || 'In Launcher'),
              serverAddress: event.status === 'offline' ? null : (event.serverAddress || null),
              lastSeen: event.at || Date.now()
            }
            : friend
        )));
        break;

      case 'skin:updated':
        setFriends((previous) => previous.map((friend) => (
          friend.id === event.userId ? { ...friend, skinUrl: event.skinUrl || null } : friend
        )));
        break;

      case 'request:changed':
        loadRequests();
        break;

      case 'friends:changed':
        loadFriends();
        loadRequests();
        loadConversations();
        break;

      case 'blocks:changed':
        loadBlocked();
        loadFriends();
        break;

      default:
        break;
    }
  }, [applyMessage, applyMessageUpdate, loadRequests, loadFriends, loadConversations, loadBlocked, selfId]);

  useEffect(() => {
    const api = social();
    if (!api?.onSocialEvent) return undefined;
    return api.onSocialEvent(handleEvent);
  }, [handleEvent]);

  useEffect(() => {
    const api = social();
    if (!api?.onStreamStatus) return undefined;
    return api.onStreamStatus((payload) => {
      setStreamStatus(payload?.status || 'idle');
      // Catch up on anything missed while the socket was down.
      if (payload?.status === 'connected') {
        api.getUpdates?.(cursorRef.current).then((res) => {
          for (const message of res?.messages || []) applyMessage(message);
          loadFriends();
          loadRequests();
        }).catch(() => {});
      }
    });
  }, [applyMessage, loadFriends, loadRequests]);

  // Actions ------------------------------------------------------------------

  const setActiveChatFriend = useCallback((friend) => {
    const friendId = typeof friend === 'string' ? friend : friend?.id || null;
    setActiveChatId(friendId);
    if (!friendId) return;
    setFriends((previous) => previous.map((item) => (
      item.id === friendId ? { ...item, unreadCount: 0 } : item
    )));
    social()?.markRead?.(friendId);
    // Make sure the opened thread actually has its history in memory.
    loadThread(friendId);
  }, [loadThread]);

  const loadOlder = useCallback(async (friendId = activeChatIdRef.current) => {
    const api = social();
    if (!api || !friendId) return;
    const current = conversationsRef.current[friendId];
    if (!current || current.loading) return;
    if (!current.loaded) {
      await loadThread(friendId);
      return;
    }
    if (!current.hasMore) return;

    setConversations((previous) => ({
      ...previous,
      [friendId]: { ...(previous[friendId] || EMPTY_THREAD), loading: true }
    }));

    let res = null;
    try {
      res = await api.getMessages(friendId, THREAD_PAGE_SIZE, { before: current.oldestTime, markRead: false });
    } catch {
      res = null;
    }

    setConversations((previous) => {
      const existing = previous[friendId] || EMPTY_THREAD;
      return {
        ...previous,
        [friendId]: {
          ...existing,
          messages: mergeMessages(existing.messages, res?.messages || []),
          hasMore: res ? Boolean(res.hasMore) : existing.hasMore,
          oldestTime: res?.oldestTime ?? existing.oldestTime,
          loading: false
        }
      };
    });
  }, [loadThread]);

  const sendMessage = useCallback(async (friendId, content, mediaOptions = {}) => {
    const api = social();
    const targetId = friendId || activeChatIdRef.current;
    if (!api || !targetId) return { ok: false, error: 'No conversation selected.' };

    const optimistic = {
      id: `optimistic-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      senderId: selfId,
      receiverId: targetId,
      content: content || '',
      mediaUrl: mediaOptions.mediaUrl || null,
      mediaName: mediaOptions.mediaName || null,
      mediaKind: mediaOptions.mediaKind || null,
      isMedia: Boolean(mediaOptions.isMedia || mediaOptions.mediaUrl),
      replyTo: mediaOptions.replyTo || null,
      reply: mediaOptions.reply || null,
      isRead: 0,
      createdAt: Date.now(),
      reactions: [],
      pending: true
    };

    setConversations((previous) => {
      const existing = previous[targetId] || EMPTY_THREAD;
      return {
        ...previous,
        [targetId]: { ...existing, messages: mergeMessages(existing.messages, [optimistic]) }
      };
    });

    const res = await api.sendMessage(targetId, content, mediaOptions);

    if (res?.ok && res.message) {
      applyMessage(res.message);
    } else {
      setConversations((previous) => {
        const existing = previous[targetId] || EMPTY_THREAD;
        return {
          ...previous,
          [targetId]: {
            ...existing,
            messages: existing.messages.map((m) => (
              m.id === optimistic.id ? { ...m, pending: false, failed: true } : m
            ))
          }
        };
      });
      if (res?.error) setSocialError(res.error);
    }
    return res;
  }, [applyMessage, selfId]);

  /** Drop the failed placeholder and send the very same payload again. */
  const retryMessage = useCallback(async (friendId, message) => {
    const targetId = friendId || activeChatIdRef.current;
    if (!targetId || !message) return { ok: false, error: 'Nothing to retry.' };

    setConversations((previous) => {
      const existing = previous[targetId] || EMPTY_THREAD;
      return {
        ...previous,
        [targetId]: { ...existing, messages: existing.messages.filter((m) => m.id !== message.id) }
      };
    });

    return sendMessage(targetId, message.content || '', {
      mediaUrl: message.mediaUrl || null,
      mediaName: message.mediaName || null,
      mediaKind: message.mediaKind || null,
      isMedia: Boolean(message.isMedia),
      replyTo: message.replyTo || null,
      reply: message.reply || null
    });
  }, [sendMessage]);

  const editMessage = useCallback(async (messageId, content) => {
    const api = relay();
    if (!api?.editDirectMessage) return { ok: false, error: 'Relay is unavailable.' };
    const res = await api.editDirectMessage(messageId, content);
    if (res?.ok && res.message) applyMessageUpdate(res.message);
    else if (res?.error) setSocialError(res.error);
    return res;
  }, [applyMessageUpdate]);

  const deleteMessage = useCallback(async (messageId) => {
    const api = relay();
    if (!api?.deleteDirectMessage) return { ok: false, error: 'Relay is unavailable.' };
    const res = await api.deleteDirectMessage(messageId);
    if (res?.ok && res.message) applyMessageUpdate(res.message);
    else if (res?.error) setSocialError(res.error);
    return res;
  }, [applyMessageUpdate]);

  const uploadMedia = useCallback(async (dataUrl, filename) => {
    const api = social();
    if (!api?.uploadMedia) return { ok: false, error: 'No social bridge' };
    if (dataUrl instanceof Blob || (typeof File !== 'undefined' && dataUrl instanceof File)) {
      const file = dataUrl;
      const fname = filename || file.name || 'upload.png';
      const readDataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      return api.uploadMedia(readDataUrl, fname);
    }
    return api.uploadMedia(dataUrl, filename);
  }, []);

  const subscribe = useCallback((cb) => {
    if (typeof cb !== 'function') return () => {};
    subscribersRef.current.add(cb);
    return () => subscribersRef.current.delete(cb);
  }, []);

  /** Optimistic reaction toggle keyed on the signed-in user. */
  const setMessageReaction = useCallback(async (messageId, reaction) => {
    const api = social();
    if (!api) return { ok: false };

    const patchReactions = (updater) => {
      setConversations((previous) => {
        const next = { ...previous };
        for (const [friendId, item] of Object.entries(next)) {
          if (!item.messages.some((m) => m.id === messageId)) continue;
          next[friendId] = {
            ...item,
            messages: item.messages.map((message) => (
              message.id === messageId ? { ...message, reactions: updater(message) } : message
            ))
          };
        }
        return next;
      });
    };

    patchReactions((message) => {
      const current = message.reactions || [];
      const mine = current.find((r) => r.userId === selfId && r.reaction === reaction);
      const withoutMine = current.filter((r) => !(r.userId === selfId && r.reaction === reaction));
      return mine ? withoutMine : [...withoutMine, { userId: selfId, reaction }];
    });

    const res = await api.setMessageReaction(messageId, reaction);
    if (res?.ok && Array.isArray(res.reactions)) {
      patchReactions(() => res.reactions);
    }
    return res;
  }, [selfId]);

  /** Debounced typing indicator: one "start" then a single "stop". */
  const notifyTyping = useCallback((friendId = activeChatIdRef.current) => {
    const api = social();
    if (!api?.setTyping || !friendId) return;
    const state = typingSentRef.current[friendId];
    if (!state?.active) {
      api.setTyping(friendId, true).catch(() => {});
    }
    clearTimeout(state?.timer);
    typingSentRef.current[friendId] = {
      active: true,
      timer: setTimeout(() => {
        typingSentRef.current[friendId] = { active: false };
        api.setTyping(friendId, false).catch(() => {});
      }, 2500)
    };
  }, []);

  const stopTyping = useCallback((friendId = activeChatIdRef.current) => {
    const api = social();
    if (!api?.setTyping || !friendId) return;
    clearTimeout(typingSentRef.current[friendId]?.timer);
    typingSentRef.current[friendId] = { active: false };
    api.setTyping(friendId, false).catch(() => {});
  }, []);

  const sendRequest = useCallback(async (username) => {
    const api = social();
    if (!api) return { ok: false };
    const res = await api.sendRequest(username);
    if (res?.ok) { loadRequests(); loadFriends(); }
    else if (res?.error) setSocialError(res.error);
    return res;
  }, [loadRequests, loadFriends]);

  const respondRequest = useCallback(async (requestId, action) => {
    const api = social();
    if (!api) return { ok: false };
    setRequests((previous) => ({
      received: (previous.received || []).filter((r) => r.id !== requestId),
      sent: (previous.sent || []).filter((r) => r.id !== requestId)
    }));
    const res = await api.respondRequest(requestId, action);
    loadRequests();
    if (action === 'accept') { loadFriends(); loadConversations(); }
    return res;
  }, [loadRequests, loadFriends, loadConversations]);

  const updateFriend = useCallback(async (friendId, data) => {
    const api = social();
    if (!api) return { ok: false };
    setFriends((previous) => previous.map((friend) => (
      friend.id === friendId ? { ...friend, ...data } : friend
    )));
    const res = await api.updateFriend(friendId, data);
    loadFriends();
    return res;
  }, [loadFriends]);

  const unfriend = useCallback(async (friendId) => {
    const api = social();
    if (!api) return { ok: false };
    setFriends((previous) => previous.filter((friend) => friend.id !== friendId));
    if (activeChatIdRef.current === friendId) setActiveChatId(null);
    const res = await api.unfriend(friendId);
    loadFriends();
    return res;
  }, [loadFriends]);

  const block = useCallback(async (targetId) => {
    const api = social();
    if (!api) return { ok: false };
    setFriends((previous) => previous.filter((friend) => friend.id !== targetId));
    if (activeChatIdRef.current === targetId) setActiveChatId(null);
    const res = await api.block(targetId);
    loadFriends();
    loadBlocked();
    return res;
  }, [loadFriends, loadBlocked]);

  const unblock = useCallback(async (targetId) => {
    const api = social();
    if (!api?.unblock) return { ok: false };
    setBlocked((previous) => previous.filter((item) => item.id !== targetId));
    const res = await api.unblock(targetId);
    loadBlocked();
    return res;
  }, [loadBlocked]);

  const searchPlayers = useCallback(async (query) => {
    const api = social();
    setSearchQuery(query);
    if (!api || !query || query.trim().length < 2) {
      setSearchResults([]);
      return [];
    }
    setSearchLoading(true);
    const res = await api.searchUsers(query.trim());
    setSearchLoading(false);
    const results = Array.isArray(res?.results) ? res.results : [];
    setSearchResults(results);
    return results;
  }, []);

  const reconnect = useCallback(() => {
    social()?.reconnectStream?.();
  }, []);

  useEffect(() => () => {
    Object.values(typingTimersRef.current).forEach(clearTimeout);
    Object.values(typingSentRef.current).forEach((state) => clearTimeout(state?.timer));
  }, []);

  // Relay writes its optimistic mute state here, so the nav badge agrees with
  // the toggle the moment it is flipped rather than after the next refresh.
  const readMutedIds = () => {
    try {
      return JSON.parse(localStorage.getItem('native_relay_store_v5') || '{}')?.mutedIds || {};
    } catch {
      return {};
    }
  };

  const unreadTotal = useMemo(() => {
    const mutedIds = readMutedIds();
    return friends.reduce((total, friend) => {
      const muted = mutedIds[friend.id] ?? friend.muted;
      return total + (muted ? 0 : friend.unreadCount || 0);
    }, 0);
  }, [friends]);
  const pendingRequestsTotal = requests.received?.length || 0;
  const badgeTotal = unreadTotal + pendingRequestsTotal;

  return {
    isNative,
    selfId,
    friends,
    requests,
    blocked,
    conversations,
    activeChatFriend,
    activeChatId,
    setActiveChatFriend,
    messages,
    hasMoreMessages: thread.hasMore,
    loadingMessages: Boolean(thread.loading),
    initialLoading,
    loadThread,
    loadOlder,
    typingBy,
    streamStatus,
    isRealtime: streamStatus === 'connected',
    reconnect,
    searchQuery,
    searchResults,
    searchLoading,
    socialError,
    liveUserCount,
    setSocialError,
    contextMenu,
    setContextMenu,
    nicknameModalFriend,
    setNicknameModalFriend,
    badgeTotal,
    pendingRequestsTotal,
    unreadTotal,
    refresh,
    sendRequest,
    respondRequest,
    sendMessage,
    retryMessage,
    editMessage,
    deleteMessage,
    uploadMedia,
    subscribe,
    setMessageReaction,
    notifyTyping,
    stopTyping,
    updateFriend,
    unfriend,
    block,
    unblock,
    searchPlayers
  };
}

export default useSocial;
