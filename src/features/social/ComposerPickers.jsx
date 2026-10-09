import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Clock, Search, Smile, Sparkles, X } from 'lucide-react';

/* Full emoji + GIF pickers for the Relay composer. */

const RECENT_KEY = 'native.relay.recentEmoji';
const GROUP_ICONS = {
  'Smileys & Emotion': '\u{1F600}',
  'People & Body': '\u{1F44B}',
  'Animals & Nature': '\u{1F43B}',
  'Food & Drink': '\u{1F354}',
  'Travel & Places': '\u{1F697}',
  Activities: '\u26BD',
  Objects: '\u{1F4A1}',
  Symbols: '\u2764\uFE0F',
  Flags: '\u{1F3F3}\uFE0F'
};

let emojiData = null;
function loadEmoji() {
  if (!emojiData) emojiData = import('../../data/emoji.json').then((mod) => mod.default || mod);
  return emojiData;
}

function readRecent() {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(value) ? value.slice(0, 24) : [];
  } catch { return []; }
}

export function rememberEmoji(emoji) {
  try {
    const next = [emoji, ...readRecent().filter((item) => item !== emoji)].slice(0, 24);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* quota */ }
}

/** Closes a popover when the user clicks anywhere outside `ref` (or presses Escape). */
export function useDismiss(ref, open, onClose, ignoreSelector) {
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      const node = ref.current;
      if (!node || node.contains(event.target)) return;
      if (ignoreSelector && event.target.closest?.(ignoreSelector)) return;
      onClose();
    };
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [ref, open, onClose, ignoreSelector]);
}

export function EmojiPicker({ onPick, onClose }) {
  const [groups, setGroups] = useState(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState('recent');
  const [recent, setRecent] = useState(readRecent);
  const ref = useRef(null);
  const bodyRef = useRef(null);
  const searchRef = useRef(null);
  useDismiss(ref, true, onClose, '[data-picker-toggle="emoji"]');

  useEffect(() => {
    let alive = true;
    loadEmoji().then((data) => { if (alive) setGroups(data); }).catch(() => { if (alive) setGroups([]); });
    const t = window.setTimeout(() => searchRef.current?.focus({ preventScroll: true }), 30);
    return () => { alive = false; window.clearTimeout(t); };
  }, []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !groups) return null;
    const out = [];
    for (const [, list] of groups) {
      for (const [emoji, name] of list) {
        if (name.includes(q)) out.push([emoji, name]);
        if (out.length >= 160) return out;
      }
    }
    return out;
  }, [query, groups]);

  const pick = (emoji) => {
    rememberEmoji(emoji);
    setRecent(readRecent());
    onPick(emoji);
  };

  const jump = (name) => {
    setActive(name);
    setQuery('');
    const node = bodyRef.current?.querySelector(`[data-emoji-group="${CSS.escape(name)}"]`);
    if (node && bodyRef.current) bodyRef.current.scrollTop = node.offsetTop - 4;
  };

  const onScroll = () => {
    const body = bodyRef.current;
    if (!body || results) return;
    let current = 'recent';
    body.querySelectorAll('[data-emoji-group]').forEach((node) => {
      if (node.offsetTop - 8 <= body.scrollTop) current = node.getAttribute('data-emoji-group');
    });
    setActive(current);
  };

  const cell = ([emoji, name]) => (
    <button key={emoji} type="button" className="relay-emoji-item" title={name} onClick={() => pick(emoji)}>{emoji}</button>
  );

  return (
    <div ref={ref} className="relay-quick-popover relay-emoji-popover is-full" data-testid="relay-emoji-picker">
      <div className="relay-picker-search">
        <Search size={13} aria-hidden="true" />
        <input
          ref={searchRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search emoji"
          data-testid="relay-emoji-search"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && results?.length) { event.preventDefault(); pick(results[0][0]); }
          }}
        />
        <button type="button" className="relay-picker-close" onClick={onClose} title="Close"><X size={13} /></button>
      </div>
      <div className="relay-emoji-tabs">
        <button type="button" className={active === 'recent' ? 'is-active' : ''} onClick={() => jump('recent')} title="Recent"><Clock size={14} /></button>
        {(groups || []).map(([name]) => (
          <button key={name} type="button" className={active === name ? 'is-active' : ''} onClick={() => jump(name)} title={name}>
            {GROUP_ICONS[name] || '\u2B50'}
          </button>
        ))}
      </div>
      <div ref={bodyRef} className="relay-emoji-body" onScroll={onScroll}>
        {!groups ? (
          <div className="relay-emoji-grid">{Array.from({ length: 48 }, (_, i) => <span key={i} className="relay-emoji-skel" />)}</div>
        ) : results ? (
          results.length ? <div className="relay-emoji-grid">{results.map(cell)}</div>
            : <div className="relay-picker-empty"><Smile size={18} /><span>No emoji found</span></div>
        ) : (
          <>
            <div data-emoji-group="recent">
              <div className="relay-emoji-heading">Recent</div>
              {recent.length ? (
                <div className="relay-emoji-grid">{recent.map((emoji) => cell([emoji, emoji]))}</div>
              ) : <div className="relay-emoji-hint">Emoji you use show up here.</div>}
            </div>
            {groups.map(([name, list]) => (
              <div key={name} data-emoji-group={name}>
                <div className="relay-emoji-heading">{name}</div>
                <div className="relay-emoji-grid">{list.map(cell)}</div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

const FALLBACK_GIFS = [
  { id: 'TYrch3lM9mHjLmJfAw', title: 'gg' },
  { id: 'QiEwJvLEcyHIeMYHOs', title: 'hype' },
  { id: 'kC8N6DPOkbqWTxkNTe', title: 'lol' },
  { id: 'BFYLNwlsSNtcc', title: 'laughing' },
  { id: 'oYtVHSxngR3lC', title: 'wow' },
  { id: 'lGBecpB2dIMwt6ohfI', title: 'sad' },
  { id: 'ujTVMASREzuRbH6zy5', title: 'dance' },
  { id: 'm745dTCAxerHa', title: 'yes' },
  { id: 'eKrgVyZ7zLvJrgZNZn', title: 'no' },
  { id: 'MF9wHplBBbqwYiTTEk', title: 'thank you' },
  { id: 'UBjcywH1QTCUxBB75b', title: 'hello' },
  { id: 'hFXwY4lER3oBO', title: 'bye' }
].map((gif) => ({
  ...gif,
  url: `https://media.giphy.com/media/${gif.id}/giphy.gif`,
  preview: `https://media.giphy.com/media/${gif.id}/200w.gif`
}));

const QUICK_TERMS = ['gg', 'lol', 'hype', 'wow', 'sad', 'dance', 'thank you', 'minecraft'];

export function GifPicker({ onPick, onClose }) {
  const [query, setQuery] = useState('');
  const [state, setState] = useState({ loading: true, gifs: [], hasMore: false, error: null });
  const ref = useRef(null);
  const searchRef = useRef(null);
  const seq = useRef(0);
  useDismiss(ref, true, onClose, '[data-picker-toggle="gif"]');

  const run = async (q, offset = 0) => {
    const id = ++seq.current;
    const api = window.native?.social;
    if (!api?.searchGifs) {
      setState({ loading: false, gifs: FALLBACK_GIFS, hasMore: false, error: null });
      return;
    }
    setState((previous) => ({ ...previous, loading: true, error: null, ...(offset ? {} : { gifs: [] }) }));
    let res = null;
    try { res = await api.searchGifs(q, { limit: 24, offset }); } catch { res = null; }
    if (id !== seq.current) return;
    if (res?.ok) {
      setState((previous) => ({
        loading: false,
        gifs: offset ? [...previous.gifs, ...(res.gifs || [])] : (res.gifs || []),
        hasMore: Boolean(res.hasMore),
        error: null
      }));
    } else {
      setState({ loading: false, gifs: offset ? state.gifs : FALLBACK_GIFS, hasMore: false, error: res?.error || null });
    }
  };

  useEffect(() => {
    const t = window.setTimeout(() => run(query.trim()), query ? 280 : 0);
    return () => window.clearTimeout(t);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = window.setTimeout(() => searchRef.current?.focus({ preventScroll: true }), 30);
    return () => window.clearTimeout(t);
  }, []);

  const onScroll = (event) => {
    const node = event.currentTarget;
    if (!state.loading && state.hasMore && node.scrollHeight - node.scrollTop - node.clientHeight < 120) {
      run(query.trim(), state.gifs.length);
    }
  };

  return (
    <div ref={ref} className="relay-quick-popover relay-gif-popover is-full" data-testid="relay-gif-picker">
      <div className="relay-picker-search">
        <Search size={13} aria-hidden="true" />
        <input
          ref={searchRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search GIFs"
          data-testid="relay-gif-search"
        />
        <button type="button" className="relay-picker-close" onClick={onClose} title="Close"><X size={13} /></button>
      </div>
      <div className="relay-gif-terms">
        {QUICK_TERMS.map((term) => (
          <button key={term} type="button" className={query === term ? 'is-active' : ''} onClick={() => setQuery(term)}>{term}</button>
        ))}
      </div>
      <div className="relay-gif-body" onScroll={onScroll}>
        <div className="relay-gif-grid">
          {state.gifs.map((gif) => (
            <button key={gif.id} type="button" className="relay-gif-item" onClick={() => onPick(gif)} title={gif.title}>
              <img src={gif.preview || gif.url} alt={gif.title} loading="lazy" referrerPolicy="no-referrer" />
            </button>
          ))}
          {state.loading && Array.from({ length: state.gifs.length ? 3 : 9 }, (_, i) => <span key={`s${i}`} className="relay-gif-skel" />)}
        </div>
        {!state.loading && state.gifs.length === 0 && (
          <div className="relay-picker-empty"><Sparkles size={18} /><span>No GIFs found</span></div>
        )}
      </div>
      <div className="relay-gif-credit">Powered by GIPHY</div>
    </div>
  );
}
