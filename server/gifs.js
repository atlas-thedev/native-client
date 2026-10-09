'use strict';

/**
 * GIF search for Relay (launcher + in-game chat).
 *
 * With GIPHY_API_KEY set this proxies Giphy search / trending (the key never
 * leaves the server). Without a key — or when Giphy fails — it answers from a
 * bundled catalogue of popular Giphy GIFs, matched by tag. Every result is a
 * plain https://media.giphy.com/media/<id>/giphy.gif link, the only GIF form
 * media.normalizeAttachment() accepts for messages.
 */

const CATALOG = require('./gif-catalog.json');

const KEY = String(process.env.GIPHY_API_KEY || '').trim();
const RATING = process.env.GIPHY_RATING || 'pg-13';
const ID = /^[A-Za-z0-9]{6,40}$/;
const cache = new Map(); // "q|limit|offset" -> { at, value }
const TTL = 10 * 60_000;

function toGif(id, title) {
  return {
    id,
    title: String(title || '').slice(0, 80) || 'GIF',
    url: `https://media.giphy.com/media/${id}/giphy.gif`,
    preview: `https://media.giphy.com/media/${id}/200w.gif`
  };
}

function fromCatalog(query, limit, offset) {
  const q = String(query || '').trim().toLowerCase();
  let list = CATALOG;
  if (q) {
    const words = q.split(/\s+/).filter(Boolean);
    const scored = CATALOG
      .map((item, index) => {
        const tags = item.tags.toLowerCase();
        let score = 0;
        for (const word of words) {
          if (tags === word) score += 3;
          else if (tags.split(/\s+/).includes(word)) score += 2;
          else if (tags.includes(word) || word.includes(tags)) score += 1;
        }
        return { item, score, index };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index);
    list = scored.map((entry) => entry.item);
  } else {
    // "Trending": one of each tag first so the grid is varied.
    const firsts = [];
    const rest = [];
    const seen = new Set();
    for (const item of CATALOG) {
      if (seen.has(item.tags)) rest.push(item);
      else { seen.add(item.tags); firsts.push(item); }
    }
    list = firsts.concat(rest);
  }
  const page = list.slice(offset, offset + limit).map((item) => toGif(item.id, item.tags));
  return { ok: true, source: 'catalog', gifs: page, hasMore: offset + limit < list.length };
}

async function fromGiphy(query, limit, offset) {
  const q = String(query || '').trim();
  const params = new URLSearchParams({ api_key: KEY, limit: String(limit), offset: String(offset), rating: RATING });
  if (q) params.set('q', q);
  const url = `https://api.giphy.com/v1/gifs/${q ? 'search' : 'trending'}?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Giphy HTTP ${res.status}`);
    const body = await res.json();
    const gifs = (body.data || [])
      .filter((item) => item && ID.test(String(item.id || '')))
      .map((item) => toGif(item.id, item.title));
    const total = Number(body.pagination?.total_count || 0);
    return { ok: true, source: 'giphy', gifs, hasMore: offset + gifs.length < total };
  } finally {
    clearTimeout(timer);
  }
}

async function searchGifs(query, { limit = 24, offset = 0 } = {}) {
  const lim = Math.min(50, Math.max(1, Number(limit) || 24));
  const off = Math.min(500, Math.max(0, Number(offset) || 0));
  const q = String(query || '').slice(0, 80);
  if (!KEY) return fromCatalog(q, lim, off);
  const key = `${q.toLowerCase()}|${lim}|${off}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  try {
    const value = await fromGiphy(q, lim, off);
    if (cache.size > 500) cache.clear();
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    return fromCatalog(q, lim, off);
  }
}

module.exports = { searchGifs, hasProviderKey: () => Boolean(KEY) };
