/**
 * Turns a Relay stream event into something worth showing, or null.
 * Pure, so the rules can be tested without a window.
 */

export const NOTIFY_PREFS_KEY = 'native.relay.notifications';
const DEFAULT_PREFS = { desktop: true, sound: true };

export function readNotifyPrefs(storage = globalThis.localStorage) {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(storage?.getItem(NOTIFY_PREFS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function writeNotifyPrefs(patch, storage = globalThis.localStorage) {
  const next = { ...readNotifyPrefs(storage), ...patch };
  try { storage?.setItem(NOTIFY_PREFS_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  return next;
}

const attachmentText = (message) => (message?.mediaName ? `Sent ${/\.gif$/i.test(message.mediaName) ? 'a GIF' : 'an attachment'}` : 'Sent an attachment');

export function describeRelayEvent(event, state = {}) {
  if (!event) return null;
  const { selfId, friends = [] } = state;

  if (event.type === 'message:new') {
    const message = event.message;
    if (!message || message.senderId === selfId) return null;
    const friend = friends.find((item) => item.id === message.senderId);
    return {
      kind: 'dm',
      threadId: message.senderId,
      title: friend?.nickname || friend?.name || message.senderName || 'Direct message',
      body: message.content || attachmentText(message),
      muted: Boolean(friend?.muted)
    };
  }

  if (event.type === 'group:message') {
    const message = event.data?.message ?? event.message;
    const threadId = event.data?.groupId ?? event.groupId;
    if (!message || !threadId || message.senderId === selfId || message.isSystem) return null;
    const group = event.data?.groupName || event.groupName || 'Group';
    return {
      kind: 'group',
      threadId,
      title: group,
      body: `${message.senderName || 'Someone'}: ${message.content || attachmentText(message)}`,
      muted: false
    };
  }

  if (event.type === 'request:changed' && event.actorId && event.actorId !== selfId) {
    const actor = event.actorName || 'A player';
    if (event.action === 'accepted') return { kind: 'friend', threadId: event.actorId, title: 'Friend request accepted', body: `${actor} is now your friend.` };
    if (!event.action || event.action === 'sent') return { kind: 'request', threadId: null, title: 'New friend request', body: `${actor} wants to be your friend.` };
    return null;
  }

  // The server sends this (not request:changed) when both sides had asked.
  if (event.type === 'friends:changed' && event.actorId && event.actorId !== selfId && event.action === 'accepted') {
    return { kind: 'friend', threadId: event.actorId, title: 'Friend request accepted', body: `${event.actorName || 'A player'} is now your friend.` };
  }

  if (event.type === 'group:created') {
    const group = event.group ?? event.data?.group;
    if (!group || !group.id || group.ownerId === selfId) return null;
    return { kind: 'group-added', threadId: group.id, title: 'Added to a group', body: `You are now in ${group.name || 'a new group'}.` };
  }

  return null;
}

/** Should this be shown given mute settings and what the user is looking at? */
export function shouldSurface(note, { mutedIds = {}, viewing = false } = {}) {
  if (!note) return false;
  if (note.threadId && (mutedIds[note.threadId] ?? note.muted)) return false;
  return !viewing;
}
