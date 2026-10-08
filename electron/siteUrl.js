'use strict';

/**
 * The Native website address. The backend (api.nativelaunch.xyz) decides it — Admin → Domains →
 * "Make main website" — so profile, store and account links follow a domain move without a
 * launcher release. Last answer is cached on disk for offline starts.
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SITE = 'https://playnative.fun';
const BASE_HOSTS = ['playnative.fun', 'nativelaunch.xyz'];
const REFRESH_MS = 30 * 60_000;

let state = null; // { site, sites: [host], at }
let inflight = null;

function cacheFile() {
  try { return path.join(require('electron').app.getPath('userData'), 'site.json'); } catch { return null; }
}
function load() {
  if (state) return state;
  state = { site: DEFAULT_SITE, sites: [], at: 0 };
  try {
    const file = cacheFile();
    const saved = file && JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && valid(saved.site)) state = { site: saved.site, sites: cleanHosts(saved.sites), at: Number(saved.at) || 0 };
  } catch { /* first run */ }
  return state;
}
function valid(url) {
  try { const u = new URL(String(url)); return u.protocol === 'https:' && !u.pathname.replace(/\/$/, '') && !u.search; } catch { return false; }
}
const cleanHosts = (list) => (Array.isArray(list) ? list : [])
  .map((h) => String(h || '').toLowerCase().trim())
  .filter((h) => /^(?=.{3,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/.test(h))
  .slice(0, 50);

async function refresh(force = false) {
  const now = Date.now();
  if (!force && now - load().at < REFRESH_MS) return state;
  if (inflight) return inflight;
  inflight = (async () => {
    const roots = require('./social').API_ROOTS || [];
    for (const root of roots) {
      try {
        const res = await fetch(`${root}/v1/domains/primary`, { signal: AbortSignal.timeout(6000) });
        const data = await res.json();
        if (!res.ok || !data?.ok || !valid(data.site)) continue;
        state = { site: data.site.replace(/\/$/, ''), sites: cleanHosts(data.sites), at: Date.now() };
        try { const file = cacheFile(); if (file) fs.writeFileSync(file, JSON.stringify(state)); } catch {}
        break;
      } catch { /* next root / keep cache */ }
    }
    return state;
  })().finally(() => { inflight = null; });
  return inflight;
}

/** Current main website origin, e.g. https://playnative.fun (cached; refreshes in the background). */
function siteUrl() {
  const s = load();
  refresh().catch(() => {});
  return s.site;
}

/** Is this one of Native's own website hosts (old, new or any domain set up in Admin → Domains)? */
function isSiteHost(host) {
  const h = String(host || '').toLowerCase();
  let main = '';
  try { main = new URL(load().site).hostname; } catch {}
  return [...BASE_HOSTS, main, ...load().sites].filter(Boolean).some((d) => h === d || h.endsWith(`.${d}`));
}

function init(ipcMain) {
  ipcMain.handle('site:info', async () => {
    const s = await refresh().catch(() => load());
    return { ok: true, site: (s || load()).site };
  });
  refresh().catch(() => {});
}

module.exports = { siteUrl, isSiteHost, refresh, init, DEFAULT_SITE };
