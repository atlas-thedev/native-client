/**
 * Quick search ranking. Pure functions so the palette stays instant and the
 * scoring can be unit tested without a browser.
 *
 * A score of 0 means "no match". Exact and prefix matches beat word starts,
 * which beat substrings, which beat loose in-order (fuzzy) matches. Keywords
 * count for less than the title so "mods" finds "Install mods" before a guide
 * that only mentions mods in its tags.
 */

export function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9.+#\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Scores one query token against one text. Returns 0..100. */
export function scoreToken(token, text, { fuzzy = true } = {}) {
  if (!token || !text) return 0;
  if (text === token) return 100;
  if (text.startsWith(token)) return 90 - Math.min(20, text.length - token.length) * 0.25;
  const words = text.split(' ');
  for (let i = 0; i < words.length; i += 1) {
    if (words[i] === token) return 84 - i;
    if (words[i].startsWith(token)) return 76 - i;
  }
  const at = text.indexOf(token);
  if (at >= 0) return 60 - Math.min(20, at);
  // Initials: "ci" -> "create instance".
  if (token.length >= 2 && token.length <= words.length) {
    const initials = words.map((w) => w[0]).join('');
    if (initials.startsWith(token)) return 55;
  }
  // Loose in-order match, penalised by the gaps between characters.
  if (!fuzzy || token.length < 3) return 0;
  let pos = -1;
  let gaps = 0;
  for (const ch of token) {
    const next = text.indexOf(ch, pos + 1);
    if (next < 0) return 0;
    if (pos >= 0) gaps += next - pos - 1;
    pos = next;
  }
  const density = token.length / (token.length + gaps);
  return density >= 0.55 ? Math.round(18 + density * 22) : 0;
}

/**
 * Scores an item `{ title, subtitle?, keywords?: string[], boost? }`
 * against a raw query. Every query word has to match somewhere.
 */
export function scoreItem(item, query) {
  const tokens = normalize(query).split(' ').filter(Boolean);
  if (!tokens.length) return 0;
  const title = normalize(item.title);
  const subtitle = normalize(item.subtitle);
  const keywords = normalize((item.keywords || []).join(' '));
  let total = 0;
  for (const token of tokens) {
    const best = Math.max(
      scoreToken(token, title),
      scoreToken(token, subtitle, { fuzzy: false }) * 0.6,
      scoreToken(token, keywords, { fuzzy: false }) * 0.7
    );
    if (best <= 0) return 0;
    total += best;
  }
  const whole = normalize(query);
  if (tokens.length > 1 && title.includes(whole)) total += 25;
  return total / tokens.length + (item.boost || 0);
}

/**
 * Ranks items for a query. Results are grouped by `group` in the order the
 * best match of each group appears, and each group is capped at `perGroup`.
 */
export function rankItems(items, query, { perGroup = 6, limit = 40 } = {}) {
  const scored = [];
  for (const item of items) {
    const score = scoreItem(item, query);
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || String(a.item.title).localeCompare(String(b.item.title)));
  const counts = new Map();
  const out = [];
  for (const entry of scored) {
    const group = entry.item.group || 'other';
    const count = counts.get(group) || 0;
    if (count >= perGroup) continue;
    counts.set(group, count + 1);
    out.push({ ...entry.item, score: entry.score });
    if (out.length >= limit) break;
  }
  return groupInOrder(out);
}

/** Keeps the best-first order but makes every group contiguous. */
export function groupInOrder(list) {
  const order = [];
  const byGroup = new Map();
  for (const item of list) {
    const group = item.group || 'other';
    if (!byGroup.has(group)) {
      byGroup.set(group, []);
      order.push(group);
    }
    byGroup.get(group).push(item);
  }
  return order.flatMap((group) => byGroup.get(group));
}

/**
 * Places live Modrinth results: first when nothing local is a strong match
 * (the user is probably looking for a mod), otherwise after local results.
 */
export function mergeRemote(local, remote, { strong = 75 } = {}) {
  if (!remote?.length) return local;
  const best = local.reduce((max, item) => Math.max(max, item.score || 0), 0);
  return best < strong ? [...remote, ...local] : [...local, ...remote];
}

/** Splits highlighted spans for a title: [{ text, hit }]. */
export function highlight(title, query) {
  const text = String(title ?? '');
  const tokens = normalize(query).split(' ').filter((t) => t.length > 0);
  if (!tokens.length || !text) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const marks = new Array(text.length).fill(false);
  for (const token of tokens) {
    let from = 0;
    let found = false;
    while (from < lower.length) {
      const at = lower.indexOf(token, from);
      if (at < 0) break;
      const wordStart = at === 0 || /[^a-z0-9]/i.test(lower[at - 1]);
      if (wordStart || !found) {
        for (let i = at; i < at + token.length; i += 1) marks[i] = true;
        found = true;
        if (wordStart) break;
      }
      from = at + 1;
    }
  }
  const parts = [];
  for (let i = 0; i < text.length; i += 1) {
    const last = parts[parts.length - 1];
    if (last && last.hit === marks[i]) last.text += text[i];
    else parts.push({ text: text[i], hit: marks[i] });
  }
  return parts;
}

const RECENTS_KEY = 'noctra.quick-search.recents.v1';

export function readRecents(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(RECENTS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function pushRecent(id, storage = globalThis.localStorage) {
  if (typeof id !== 'string' || !id) return [];
  const next = [id, ...readRecents(storage).filter((entry) => entry !== id)].slice(0, 8);
  try {
    storage?.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch { /* storage full or disabled */ }
  return next;
}

/** Turns a Modrinth search hit into a palette item. */
export function modrinthHitToItem(hit) {
  if (!hit || typeof hit !== 'object') return null;
  const id = String(hit.project_id || hit.slug || '');
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(id)) return null;
  const type = ['mod', 'modpack', 'shader', 'resourcepack', 'datapack'].includes(hit.project_type) ? hit.project_type : 'mod';
  const icon = typeof hit.icon_url === 'string' && /^https:\/\/cdn\.modrinth\.com\//.test(hit.icon_url) ? hit.icon_url : null;
  return {
    id: `modrinth:${id}`,
    group: 'modrinth',
    title: String(hit.title || hit.slug || 'Untitled').slice(0, 80),
    subtitle: String(hit.description || '').slice(0, 120),
    icon,
    meta: { type, downloads: Number(hit.downloads) || 0, author: String(hit.author || '').slice(0, 40) },
    command: { type: 'project', project: hit, contentType: type }
  };
}
