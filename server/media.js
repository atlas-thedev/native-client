const fs = require('fs');
const path = require('path');

/**
 * Shared attachment rules for direct, group and legacy social messages.
 *
 * Attachments must be files uploaded through POST /v1/social/upload. The
 * stored URL is rebuilt from our own origin, so a message can never make a
 * recipient's launcher load an arbitrary third-party URL (IP logging,
 * tracking pixels, drive-by downloads).
 */

const DATA_DIR = path.resolve(
  process.env.NOCTRA_DATA_DIR ||
  process.env.NATIVE_SKIN_DATA ||
  path.join(__dirname, 'data')
);
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const PORT = Number(process.env.PORT || process.env.NATIVE_SKIN_PORT || 3418);
const PUBLIC_URL = (process.env.NATIVE_SKIN_PUBLIC_URL || process.env.NOCTRA_PUBLIC_URL || '').replace(/\/+$/, '');

const MEDIA_FILE = /^[a-f0-9]{32}\.(?:png|jpg|gif|webp|mp3|ogg|webm|wav|mp4|txt|zip)$/;
const IMAGE_FILE = /\.(?:png|jpg|gif|webp)$/;
const KINDS = new Set(['image', 'audio', 'video', 'file']);
// The launcher's built-in quick GIFs are served by Giphy's CDN.
const GIPHY_GIF = /^https:\/\/(?:media\d?|i)\.giphy\.com\/media\/[A-Za-z0-9]{6,40}\/giphy\.gif$/;

const DEFAULT_PUBLIC_URL = 'https://api.nativelaunch.xyz';
const ALLOWED_HOSTS = new Set(
  String(process.env.NOCTRA_ALLOWED_HOSTS || 'api.nativelaunch.xyz,localhost,127.0.0.1,[::1]')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
);

function isLoopback(address) {
  const value = String(address || '');
  return value === '::1' || value.startsWith('127.') || value.startsWith('::ffff:127.');
}

/**
 * Public origin for generated URLs. An explicit NOCTRA_PUBLIC_URL wins;
 * otherwise the Host header is used only when it names one of our hosts, so a
 * spoofed Host can never make stored attachment URLs point somewhere else.
 */
function originOf(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const headers = (req && req.headers) || {};
  const rawHost = String(headers.host || '').split(',')[0].trim().toLowerCase();
  const match = rawHost.match(/^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/);
  if (!match || !ALLOWED_HOSTS.has(match[1])) return DEFAULT_PUBLIC_URL;
  const fromProxy = isLoopback(req.socket && req.socket.remoteAddress);
  const forwardedProto = fromProxy
    ? String(headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
    : '';
  const proto = forwardedProto === 'https' || forwardedProto === 'http'
    ? forwardedProto
    : (req.socket && req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${rawHost}`;
}

function mediaFileFromUrl(value) {
  if (!value) return null;
  let parsed;
  try { parsed = new URL(String(value).trim()); } catch { return null; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  const match = parsed.pathname.match(/^\/v1\/social\/media\/([^/]+)$/);
  return match && MEDIA_FILE.test(match[1]) ? match[1] : null;
}

function mediaPath(filename) {
  return path.join(MEDIA_DIR, path.basename(String(filename)));
}

function cleanMediaName(value) {
  const name = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f<>"\\]/g, '')
    .replace(/[/]/g, '_')
    .trim()
    .slice(0, 180);
  return name || null;
}

/**
 * Validates the attachment fields of a message body.
 * Returns null fields when there is no attachment; throws on anything else.
 */
function normalizeAttachment(body, origin) {
  const source = body || {};
  const raw = source.mediaUrl ?? source.media_url ?? null;
  if (raw == null || raw === '') {
    return { mediaUrl: null, mediaName: null, mediaKind: null, isMedia: 0 };
  }
  if (GIPHY_GIF.test(String(raw).trim())) {
    return {
      mediaUrl: String(raw).trim(),
      mediaName: cleanMediaName(source.mediaName ?? source.media_name) || 'GIF.gif',
      mediaKind: 'image',
      isMedia: 1
    };
  }
  const file = mediaFileFromUrl(raw);
  if (!file) throw new Error('Attachments must be uploaded through Noctra.');
  if (!fs.existsSync(mediaPath(file))) throw new Error('Attachment not found. Please upload it again.');
  const requestedKind = String(source.mediaKind ?? source.media_kind ?? '').toLowerCase();
  const mediaKind = KINDS.has(requestedKind) ? requestedKind : (IMAGE_FILE.test(file) ? 'image' : 'file');
  const isMedia = source.isMedia ?? source.is_media ?? true;
  return {
    mediaUrl: `${origin}/v1/social/media/${file}`,
    mediaName: cleanMediaName(source.mediaName ?? source.media_name),
    mediaKind,
    isMedia: isMedia ? 1 : 0
  };
}

/** Group icons follow the same rule, and must be images. */
function normalizeIconUrl(value, origin) {
  if (value == null || value === '') return null;
  const file = mediaFileFromUrl(value);
  if (!file || !IMAGE_FILE.test(file)) throw new Error('Group image must be an image uploaded through Noctra.');
  return origin ? `${origin}/v1/social/media/${file}` : String(value).trim();
}

/** Deletes an uploaded file once nothing references it any more. */
function releaseMedia(url, isReferenced) {
  const file = mediaFileFromUrl(url);
  if (!file) return false;
  try {
    if (typeof isReferenced === 'function' && isReferenced(file)) return false;
    fs.rmSync(mediaPath(file), { force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  DATA_DIR,
  MEDIA_DIR,
  PORT,
  PUBLIC_URL,
  MEDIA_FILE,
  GIPHY_GIF,
  originOf,
  mediaFileFromUrl,
  mediaPath,
  cleanMediaName,
  normalizeAttachment,
  normalizeIconUrl,
  releaseMedia
};
