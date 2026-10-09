/**
 * Which attachment URLs the chat may load. Server-side validation already
 * rejects anything else for new messages; this also covers older messages
 * and anything cached before that check existed, so a message can never make
 * the launcher fetch an arbitrary third-party URL (IP logging, tracking).
 */
const GIPHY_GIF = /^https:\/\/(?:media\d?|i)\.giphy\.com\/media\/[A-Za-z0-9]{6,40}\/giphy\.gif$/;
const NATIVE_MEDIA_PATH = /^\/v1\/social\/media\/[a-f0-9]{32}\.[a-z0-9]{2,4}$/;
// Only our own API hosts (plus a local dev server) may serve attachments.
const NATIVE_MEDIA_HOSTS = new Set(['api.playnative.fun', 'localhost', '127.0.0.1', '[::1]']);

export function safeMediaUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^blob:/i.test(raw)) return raw;
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(raw)) return raw;
  if (GIPHY_GIF.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (!NATIVE_MEDIA_HOSTS.has(url.hostname.toLowerCase())) return null;
    if (url.protocol === 'http:' && url.hostname === 'api.playnative.fun') return null;
    return NATIVE_MEDIA_PATH.test(url.pathname) ? url.href : null;
  } catch {
    return null;
  }
}
