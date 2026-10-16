'use strict';
/**
 * Partners page feed.
 *
 * The backend lists live partners at /v1/site/partners (each with colours, a motion preset and
 * https art). The last good feed is saved to <userData>/partners/feed.json so the page still has
 * something to show offline; the renderer falls back to the bundled Aurex card if both fail.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const API = String(process.env.NATIVE_WARDROBE_API || 'https://api.playnative.net').replace(/\/+$/, '');
const FEED_TTL = 10 * 60_000;
const ANIMATIONS = new Set(['aurora', 'orbit', 'glitch', 'float', 'shine', 'pulse', 'grid', 'none']);
const HEX = /^#[0-9a-f]{6}$/i;

let deps = null;
let memo = { at: 0, partners: null };

const feedFile = () => path.join(deps.app.getPath('userData'), 'partners', 'feed.json');
// An http:// link (e.g. from a backend behind a plain-http proxy hop) is upgraded rather than dropping the partner.
const upgrade = (value) => String(value || '').replace(/^http:\/\//i, 'https://');
const isHttps = (value) => /^https:\/\//i.test(upgrade(value));
const text = (value, max) => String(value || '').slice(0, max);
const image = (value) => (isHttps(value) ? upgrade(value) : '');

function sanitize(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((pt) => pt && typeof pt.id === 'string' && pt.name && isHttps(pt.website) && isHttps(pt.logo))
    .slice(0, 50)
    .map((pt) => ({
      id: pt.id.slice(0, 40),
      name: text(pt.name, 48),
      tagline: text(pt.tagline, 90),
      description: text(pt.description, 500),
      website: upgrade(pt.website),
      cta: text(pt.cta, 24) || 'Visit',
      logo: upgrade(pt.logo),
      background: image(pt.background),
      art: image(pt.art),
      accent: HEX.test(pt.accent) ? pt.accent : '#ffffff',
      accent2: HEX.test(pt.accent2) ? pt.accent2 : (HEX.test(pt.accent) ? pt.accent : '#ffffff'),
      animation: ANIMATIONS.has(pt.animation) ? pt.animation : 'aurora',
      speed: Math.max(0.25, Math.min(3, Number(pt.speed) || 1)),
      intensity: Math.max(0, Math.min(100, Number.isFinite(Number(pt.intensity)) ? Number(pt.intensity) : 60)),
      perks: (Array.isArray(pt.perks) ? pt.perks : []).map((perk) => text(perk, 40)).filter(Boolean).slice(0, 6),
      code: text(pt.code, 24),
      tier: ['featured', 'partner', 'sponsor'].includes(pt.tier) ? pt.tier : 'partner',
      buttonStyle: ['gradient', 'solid', 'outline', 'glass'].includes(pt.buttonStyle) ? pt.buttonStyle : 'gradient',
      buttonColor: HEX.test(pt.buttonColor) ? pt.buttonColor : '',
      buttonText: HEX.test(pt.buttonText) ? pt.buttonText : '',
      button2Label: isHttps(pt.button2Url) ? text(pt.button2Label, 24) : '',
      button2Url: pt.button2Label && isHttps(pt.button2Url) ? upgrade(pt.button2Url) : '',
      logoStyle: ['plain', 'tile', 'circle', 'glass'].includes(pt.logoStyle) ? pt.logoStyle : 'plain',
      logoBg: HEX.test(pt.logoBg) ? pt.logoBg : '',
      logoSize: Number(pt.logoSize) ? Math.max(20, Math.min(160, Number(pt.logoSize))) : 52,
      badge: text(pt.badge, 24),
      showName: pt.showName !== false
    }));
}

async function readFeed() {
  try { return sanitize(JSON.parse(await fsp.readFile(feedFile(), 'utf8')).partners); } catch { return null; }
}

async function fetchFeed() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(`${API}/v1/site/partners`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const partners = sanitize((await res.json())?.partners);
    await fsp.mkdir(path.dirname(feedFile()), { recursive: true });
    await fsp.writeFile(feedFile(), JSON.stringify({ partners, savedAt: Date.now() }));
    return partners;
  } finally {
    clearTimeout(timer);
  }
}

async function list({ force = false } = {}) {
  if (!force && memo.partners && Date.now() - memo.at < FEED_TTL) return { ok: true, partners: memo.partners, cached: true };
  try {
    const partners = await fetchFeed();
    memo = { at: Date.now(), partners };
    return { ok: true, partners };
  } catch (error) {
    const saved = memo.partners || (await readFeed());
    return { ok: false, offline: true, partners: saved, error: String(error?.message || error) };
  }
}

function init(appDeps, ipcMain) {
  deps = appDeps;
  ipcMain.handle('partners:list', (_e, options) => list({ force: Boolean(options?.force) }));
}

module.exports = { init, list, sanitize };
