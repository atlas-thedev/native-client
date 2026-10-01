/**
 * Game log helpers.
 *
 * Minecraft writes chat to the same stdout stream as its own diagnostics, so
 * anything we infer from the log (crash detection, Relay presence, Discord
 * activity) must ignore lines another player or a server could have written.
 * Output arrives in arbitrary chunks, so it is re-assembled into lines first.
 */

// "[12:34:56] [Render thread/INFO]: " and "[12:34:56] [Render thread/INFO] [minecraft/Foo]: "
const LOG_PREFIX = /^\s*\[[^\]\r\n]{1,40}\]\s*\[[^\]\r\n]{1,80}\/[A-Z]{3,5}\](?:\s*\[[^\]\r\n]{1,120}\])?:\s?/;
const CHAT_TAG = /\[(?:System\]\s*\[)?CHAT\]/i;
const MAX_LINE = 16 * 1024;

const GAME_CRASH_MARKER = /#@!@# Game crashed!|---- Minecraft Crash Report ----|Minecraft ran into a problem|A fatal error has been detected by the Java Runtime/i;

function createLineReader(onLine) {
  let pending = '';
  const reader = (chunk) => {
    pending += String(chunk ?? '');
    const parts = pending.split(/\r?\n/);
    pending = parts.pop() || '';
    if (pending.length > MAX_LINE) {
      parts.push(pending);
      pending = '';
    }
    for (const part of parts) onLine(part);
  };
  reader.flush = () => {
    if (pending) onLine(pending);
    pending = '';
  };
  return reader;
}

/**
 * Returns a stateful classifier. Lines without a log prefix that follow a chat
 * line are treated as part of that (multi-line, server-sent) chat message.
 */
function createLogClassifier() {
  let inChat = false;
  return (rawLine) => {
    const line = String(rawLine ?? '');
    const hasPrefix = LOG_PREFIX.test(line);
    let chat;
    if (CHAT_TAG.test(line)) chat = true;
    else if (!hasPrefix && line.trim() && inChat) chat = true;
    else chat = false;
    if (hasPrefix || CHAT_TAG.test(line)) inChat = chat;
    const message = hasPrefix ? line.replace(LOG_PREFIX, '') : line.trim();
    return { line, message, chat, hasPrefix };
  };
}

function isCrashLine(entry) {
  return Boolean(entry && !entry.chat && GAME_CRASH_MARKER.test(entry.line));
}

/** Presence hints from a single, non-chat log line. */
function presenceFromLine(entry) {
  if (!entry || entry.chat || !entry.hasPrefix) return null;
  const message = entry.message;
  const conn = message.match(/^Connecting to ([a-zA-Z0-9.-]{1,253})(?:,\s*|:)(\d{1,5})\s*$/);
  if (conn) return { kind: 'server', host: conn[1], port: conn[2] };
  if (/^Starting integrated server\b/i.test(message)) return { kind: 'singleplayer' };
  if (/^(?:Disconnecting from|Stopping integrated server|Stopping server)\b/i.test(message)) return { kind: 'menus' };
  return null;
}

const KNOWN_SERVERS = [
  ['hypixel.net', 'Hypixel'],
  ['donutsmp.net', 'Donut SMP'],
  ['cubecraft.net', 'CubeCraft'],
  ['playhive.com', 'The Hive'],
  ['hivemc.com', 'The Hive'],
  ['minemen.club', 'Minemen Club']
];

function formatServerActivity(host) {
  const lower = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!lower) return 'Multiplayer';
  for (const [domain, label] of KNOWN_SERVERS) {
    if (lower === domain || lower.endsWith(`.${domain}`)) return label;
  }
  if (lower === 'localhost' || /^127\./.test(lower) || lower === '::1') return 'Local Server';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(lower)) return 'Multiplayer';
  const parts = lower.split('.').filter(Boolean);
  if (parts.length >= 2) {
    const main = parts[parts.length - 2];
    return main.charAt(0).toUpperCase() + main.slice(1);
  }
  return host;
}

module.exports = {
  GAME_CRASH_MARKER,
  LOG_PREFIX,
  createLineReader,
  createLogClassifier,
  isCrashLine,
  presenceFromLine,
  formatServerActivity
};
