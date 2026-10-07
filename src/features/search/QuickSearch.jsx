import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  Blocks,
  Bell,
  CircleHelp,
  Clock,
  Coffee,
  Compass,
  CornerDownLeft,
  Download,
  FolderOpen,
  HardDrive,
  Home,
  Info,
  Layers3,
  Link2,
  Loader2,
  MessageSquare,
  Package,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  User,
  UserRound,
  Users,
  X
} from 'lucide-react';
import PlayerAvatar from '../../components/ui/PlayerAvatar.jsx';
import { GUIDES, GUIDE_CATEGORIES } from '../guides/guides.js';
import { getVersionManifest } from '../../lib/mojang.js';
import {
  highlight,
  mergeRemote,
  modrinthHitToItem,
  pushRecent,
  rankItems,
  readRecents
} from './quickSearchScore.js';
import './QuickSearch.css';

export const SCOPES = [
  { id: 'all', label: 'All' },
  { id: 'nav', label: 'Pages', groups: ['pages', 'actions', 'settings'] },
  { id: 'instances', label: 'Instances', groups: ['instances', 'versions'] },
  { id: 'friends', label: 'Friends', groups: ['friends'] },
  { id: 'guides', label: 'How to', groups: ['guides'] },
  { id: 'modrinth', label: 'Mods', groups: ['modrinth'] }
];

const GROUP_LABELS = {
  recent: 'Recent',
  suggested: 'Suggested',
  actions: 'Actions',
  pages: 'Go to',
  instances: 'Instances',
  friends: 'Friends',
  guides: 'How to',
  settings: 'Settings',
  versions: 'Minecraft versions',
  modrinth: 'On Modrinth'
};

const GROUP_ICONS = {
  pages: ArrowRight,
  actions: Sparkles,
  settings: Settings,
  guides: BookOpen,
  versions: Blocks,
  modrinth: Package
};

const SETTINGS_TABS = [
  { id: 'launcher', title: 'Launcher settings', subtitle: 'Theme, language, behaviour', icon: Settings, keywords: ['appearance', 'theme', 'language', 'discord', 'startup', 'notifications'] },
  { id: 'minecraft', title: 'Minecraft settings', subtitle: 'Memory, resolution, JVM', icon: Blocks, keywords: ['ram', 'memory', 'gb', 'resolution', 'fullscreen', 'jvm', 'arguments'] },
  { id: 'java', title: 'Java settings', subtitle: 'Java runtimes', icon: Coffee, keywords: ['jre', 'jdk', 'runtime', 'path'] },
  { id: 'storage', title: 'Storage', subtitle: 'Folders and cache', icon: HardDrive, keywords: ['disk', 'cache', 'folder', 'data', 'clear'] },
  { id: 'changelog', title: 'Changelog', subtitle: "What's new in Native", icon: RefreshCw, keywords: ['whats new', 'release notes', 'changes', 'version'] },
  { id: 'about', title: 'About Native', subtitle: 'Version and credits', icon: Info, keywords: ['version', 'credits', 'license', 'build'] }
];

const MAX_INSTANCES = 200;
const MAX_FRIENDS = 300;

function useDebounced(value, delay) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function Highlighted({ text, query }) {
  return highlight(text, query).map((part, index) => (
    part.hit ? <mark key={index}>{part.text}</mark> : <React.Fragment key={index}>{part.text}</React.Fragment>
  ));
}

function formatDownloads(value) {
  if (!value) return '';
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`;
  if (value >= 1e3) return `${Math.round(value / 1e3)}K`;
  return String(value);
}

function ItemIcon({ item }) {
  if (item.avatar) {
    return <PlayerAvatar account={item.avatar} size={30} radius={8} className="qs-avatar" />;
  }
  if (item.icon && typeof item.icon === 'string') {
    return <img className="qs-img" src={item.icon} alt="" loading="lazy" referrerPolicy="no-referrer" />;
  }
  const Icon = item.icon || GROUP_ICONS[item.group] || ArrowRight;
  return (
    <span className={`qs-icon tone-${item.tone || item.group}`}>
      <Icon size={15} strokeWidth={2} aria-hidden="true" />
    </span>
  );
}

/**
 * Title-bar quick search (Ctrl/Cmd + K). One box that finds pages, actions,
 * instances, friends, guides, settings, Minecraft versions and Modrinth
 * projects. Everything except Modrinth is searched locally, so typing is
 * instant; Modrinth results stream in underneath after a short debounce.
 */
export default function QuickSearch({
  open,
  onClose,
  onCommand,
  instances = [],
  friends = [],
  hasNative = false,
  isAdmin = false,
  account = null,
  runningInstanceId = null
}) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('all');
  const [activeIndex, setActiveIndex] = useState(0);
  const [recents, setRecents] = useState(() => readRecents());
  const [versions, setVersions] = useState([]);
  const [remote, setRemote] = useState({ query: '', items: [], loading: false, error: false });
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const lastFocusRef = useRef(null);
  const debouncedQuery = useDebounced(query.trim(), 230);

  /* Reset each time it opens, restore focus when it closes. */
  useEffect(() => {
    if (!open) return undefined;
    lastFocusRef.current = document.activeElement;
    setQuery('');
    setScope('all');
    setActiveIndex(0);
    setRecents(readRecents());
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      const last = lastFocusRef.current;
      if (last && typeof last.focus === 'function' && document.contains(last)) last.focus();
    };
  }, [open]);

  /* Minecraft versions come from the cached Mojang manifest. */
  useEffect(() => {
    if (!open || versions.length) return undefined;
    let cancelled = false;
    getVersionManifest()
      .then((data) => {
        if (cancelled || !Array.isArray(data?.versions)) return;
        setVersions(data.versions.slice(0, 900).map((entry) => ({ id: entry.id, type: entry.type })));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open, versions.length]);

  /* Live Modrinth search. */
  useEffect(() => {
    if (!open) return undefined;
    const wantsRemote = scope === 'all' || scope === 'modrinth';
    if (!wantsRemote || debouncedQuery.length < 2) {
      setRemote({ query: debouncedQuery, items: [], loading: false, error: false });
      return undefined;
    }
    const controller = new AbortController();
    setRemote((prev) => ({ ...prev, query: debouncedQuery, loading: true, error: false }));
    const params = new URLSearchParams({
      query: debouncedQuery,
      limit: scope === 'modrinth' ? '12' : '5',
      index: 'relevance',
      facets: JSON.stringify([['project_type:mod', 'project_type:modpack', 'project_type:shader', 'project_type:resourcepack']])
    });
    fetch(`https://api.modrinth.com/v2/search?${params}`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('search failed'))))
      .then((json) => {
        const items = (Array.isArray(json?.hits) ? json.hits : []).map(modrinthHitToItem).filter(Boolean);
        setRemote({ query: debouncedQuery, items, loading: false, error: false });
      })
      .catch((error) => {
        if (error?.name === 'AbortError') return;
        setRemote({ query: debouncedQuery, items: [], loading: false, error: true });
      });
    return () => controller.abort();
  }, [open, debouncedQuery, scope]);

  const localItems = useMemo(() => {
    const items = [];
    const page = (id, title, subtitle, icon, keywords = [], extra = {}) => items.push({
      id: `page:${id}`, group: 'pages', title, subtitle, icon, keywords, command: { type: 'tab', tab: id }, ...extra
    });
    page('home', 'Home', 'Your selected instance and Launch', Home, ['start', 'play', 'main', 'dashboard']);
    page('instances', 'Instances', 'Every Minecraft install you have', Layers3, ['profiles', 'library', 'my games', 'installs']);
    page('versions', 'Versions', 'Browse Minecraft releases', Blocks, ['releases', 'snapshots', 'minecraft versions', 'update']);
    page('discover', 'Discover', 'Mods, modpacks, shaders and packs', Compass, ['browse', 'modrinth', 'mods', 'modpacks', 'shaders', 'resource packs', 'store']);
    page('skins', 'Locker', 'Skins and capes', User, ['skin', 'cape', 'wardrobe', 'cosmetics']);
    page('store', 'Store', 'Animated cloaks from Native', User, ['store', 'shop', 'cloak', 'cape', 'animated', 'buy']);
    page('relay', 'Relay', hasNative ? 'Friends and chat' : 'Friends and chat · needs Native', MessageSquare, ['chat', 'friends', 'messages', 'social', 'dm']);
    page('guides', 'How to', 'Video guides and answers', BookOpen, ['help', 'tutorial', 'guide', 'videos', 'faq', 'learn']);
    page('settings', 'Settings', 'Launcher, Minecraft, Java, storage', Settings, ['preferences', 'options', 'config']);
    if (isAdmin) page('admin', 'Admin control room', 'Moderation and live stats', ShieldCheck, ['admin', 'moderation', 'ban', 'users']);

    const action = (id, title, subtitle, icon, keywords = [], extra = {}) => items.push({
      id: `action:${id}`, group: 'actions', title, subtitle, icon, keywords, command: { type: 'action', id }, ...extra
    });
    action('new-instance', 'Create new instance', 'Pick a version and mod loader', Plus, ['add', 'make', 'new', 'instance', 'profile', 'install minecraft'], { boost: 4 });
    action('discover-mods', 'Browse mods', 'Open Discover on mods', Package, ['install', 'download', 'modrinth']);
    action('discover-modpacks', 'Browse modpacks', 'Open Discover on modpacks', Layers3, ['install', 'download', 'pack']);
    action('discover-shaders', 'Browse shaders', 'Open Discover on shaders', Sparkles, ['shader', 'graphics', 'iris', 'optifine']);
    action('accounts', 'Switch account', account?.name ? `Signed in as ${account.name}` : 'Add or switch accounts', UserRound, ['account', 'login', 'sign in', 'logout', 'microsoft', 'offline', 'profile']);
    if (account?.type === 'microsoft') {
      action('connect-native', 'Merge with a Native account',
        account.nativeLink?.type === 'merged' ? 'Already merged with your Native account' : 'Move your email Native account onto this Microsoft account',
        Link2, ['link', 'premium', 'microsoft', 'native', 'merge', 'connect']);
    }
    action('notifications', 'Notifications', 'Recent launcher activity', Bell, ['alerts', 'inbox', 'activity']);
    action('updates', 'Check for updates', 'Launcher updates', Download, ['update', 'upgrade', 'new version', 'download']);
    action('open-folder', 'Open launcher folder', 'Instances, logs and screenshots on disk', FolderOpen, ['files', 'directory', 'explorer', 'logs', 'screenshots']);

    for (const tab of SETTINGS_TABS) {
      items.push({
        id: `settings:${tab.id}`,
        group: 'settings',
        title: tab.title,
        subtitle: tab.subtitle,
        icon: tab.icon,
        keywords: ['settings', ...tab.keywords],
        command: { type: 'settings', tab: tab.id }
      });
    }

    for (const instance of instances.slice(0, MAX_INSTANCES)) {
      if (!instance?.id) continue;
      const version = instance.mc_version || instance.version || '';
      const loader = instance.mc_loader || instance.loader || 'vanilla';
      const running = runningInstanceId === instance.id;
      items.push({
        id: `instance:${instance.id}`,
        group: 'instances',
        title: instance.name || version || 'Instance',
        subtitle: `${version}${loader ? ` · ${loader}` : ''}${running ? ' · running' : ''}`,
        icon: Layers3,
        tone: running ? 'running' : 'instances',
        keywords: [version, loader, 'instance', 'play', 'launch'],
        command: { type: 'instance', instance },
        secondary: { label: running ? 'Running' : 'Launch', command: { type: 'launch', instance }, disabled: running },
        boost: 3
      });
    }

    if (hasNative) {
      for (const friend of friends.slice(0, MAX_FRIENDS)) {
        if (!friend?.id) continue;
        const name = friend.nickname || friend.name || 'Friend';
        const online = friend.status && friend.status !== 'offline';
        items.push({
          id: `friend:${friend.id}`,
          group: 'friends',
          title: name,
          subtitle: friend.nickname && friend.name ? `${friend.name} · ${online ? friend.activity || 'online' : 'offline'}` : (online ? friend.activity || 'Online' : 'Offline'),
          avatar: { name: friend.name, uuid: friend.uuid, skinUrl: friend.skinUrl, model: friend.model, type: 'native' },
          keywords: [friend.name, 'friend', 'chat', 'message', online ? 'online' : 'offline'],
          command: { type: 'friend', friend },
          secondary: friend.serverAddress ? { label: 'Join', command: { type: 'join', friend } } : null,
          boost: online ? 2 : 0
        });
      }
    }

    const categoryLabel = Object.fromEntries(GUIDE_CATEGORIES.map((c) => [c.id, c.label]));
    for (const guide of GUIDES) {
      items.push({
        id: `guide:${guide.id}`,
        group: 'guides',
        title: guide.title,
        subtitle: `${guide.video ? 'Video guide' : 'Guide'} · ${categoryLabel[guide.category] || 'How to'}`,
        icon: guide.video ? Play : BookOpen,
        keywords: [...(guide.tags || []), guide.summary, 'how to', 'help'],
        command: { type: 'guide', id: guide.id }
      });
    }
    return items;
  }, [instances, friends, hasNative, isAdmin, account?.name, account?.type, account?.nativeLink?.connected, account?.nativeLink?.name, runningInstanceId]);

  const versionItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!versions.length || q.length < 1) return [];
    const looksLikeVersion = /\d/.test(q);
    const wantsSnapshots = /snap|pre|rc|w\d/.test(q);
    return versions
      .filter((entry) => entry.type === 'release' || (wantsSnapshots && entry.type === 'snapshot'))
      .slice(0, looksLikeVersion ? 900 : 12)
      .map((entry, index) => ({
        id: `version:${entry.id}`,
        group: 'versions',
        title: `Minecraft ${entry.id}`,
        subtitle: index === 0 && entry.type === 'release' ? 'Latest release · create an instance' : `${entry.type === 'release' ? 'Release' : 'Snapshot'} · create an instance`,
        icon: Blocks,
        keywords: [entry.id, entry.type, 'version', 'minecraft', index === 0 ? 'latest newest' : ''],
        command: { type: 'version', version: entry.id },
        boost: looksLikeVersion ? 2 : -12
      }));
  }, [versions, query]);

  const recentItems = useMemo(() => {
    const byId = new Map(localItems.map((item) => [item.id, item]));
    return recents.map((id) => byId.get(id)).filter(Boolean).slice(0, 5).map((item) => ({ ...item, group: 'recent' }));
  }, [recents, localItems]);

  const results = useMemo(() => {
    const scopeDef = SCOPES.find((entry) => entry.id === scope) || SCOPES[0];
    const allowed = scopeDef.groups ? new Set(scopeDef.groups) : null;
    const q = query.trim();
    if (!q) {
      if (allowed) {
        return localItems
          .filter((item) => allowed.has(item.group))
          .slice(0, 24);
      }
      const suggestedIds = ['action:new-instance', 'page:discover', 'page:guides'];
      const recentIds = new Set(recentItems.map((item) => item.id));
      const firstInstances = localItems.filter((item) => item.group === 'instances').slice(0, 3).map((item) => ({ ...item, group: 'suggested' }));
      const suggested = [
        ...firstInstances,
        ...suggestedIds
          .filter((id) => !recentIds.has(id))
          .map((id) => localItems.find((item) => item.id === id))
          .filter(Boolean)
          .map((item) => ({ ...item, group: 'suggested' }))
      ];
      return [...recentItems, ...suggested];
    }
    const pool = [...localItems, ...versionItems].filter((item) => !allowed || allowed.has(item.group));
    const ranked = rankItems(pool, q, { perGroup: scope === 'all' ? 5 : 30, limit: 60 });
    const showRemote = (scope === 'all' || scope === 'modrinth') && remote.query === q;
    return showRemote ? mergeRemote(ranked, remote.items) : ranked;
  }, [scope, query, localItems, versionItems, recentItems, remote]);

  useEffect(() => { setActiveIndex(0); }, [query, scope]);
  useEffect(() => {
    if (activeIndex >= results.length) setActiveIndex(Math.max(0, results.length - 1));
  }, [results.length, activeIndex]);

  /* Keep the highlighted row in view. */
  useEffect(() => {
    // scroll only the results list: scrollIntoView would also scroll the (overflow: hidden) panel
    // and push the search box out of sight
    const list = listRef.current;
    const row = list?.querySelector(`[data-index="${activeIndex}"]`);
    if (!list || !row) return;
    const box = list.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const top = r.top - box.top + list.scrollTop;
    const bottom = top + r.height;
    if (activeIndex === 0) list.scrollTop = 0;
    else if (top < list.scrollTop) list.scrollTop = top - 8;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 8;
  }, [activeIndex, results]);

  const run = useCallback((item, useSecondary = false) => {
    if (!item) return;
    const command = useSecondary && item.secondary && !item.secondary.disabled ? item.secondary.command : item.command;
    if (!command) return;
    if (!String(item.id).startsWith('modrinth:') && !String(item.id).startsWith('version:')) {
      setRecents(pushRecent(item.id));
    }
    onClose?.();
    // Let the palette unmount before the target view mounts.
    window.setTimeout(() => onCommand?.(command), 0);
  }, [onClose, onCommand]);

  const searchOnDiscover = useCallback(() => {
    const q = query.trim();
    if (!q) return;
    onClose?.();
    window.setTimeout(() => onCommand?.({ type: 'discover-query', query: q, contentType: 'mod' }), 0);
  }, [query, onClose, onCommand]);

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (query) setQuery('');
      else onClose?.();
      return;
    }
    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
      event.preventDefault();
      setActiveIndex((index) => (results.length ? (index + 1) % results.length : 0));
      return;
    }
    if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      event.preventDefault();
      setActiveIndex((index) => (results.length ? (index - 1 + results.length) % results.length : 0));
      return;
    }
    if (event.key === 'PageDown' || event.key === 'PageUp') {
      event.preventDefault();
      const step = event.key === 'PageDown' ? 6 : -6;
      setActiveIndex((index) => Math.max(0, Math.min(results.length - 1, index + step)));
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      const index = SCOPES.findIndex((entry) => entry.id === scope);
      const next = (index + (event.shiftKey ? -1 : 1) + SCOPES.length) % SCOPES.length;
      setScope(SCOPES[next].id);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (results[activeIndex]) run(results[activeIndex], event.shiftKey);
      else searchOnDiscover();
    }
  };

  if (!open) return null;

  const active = results[activeIndex] || null;
  const showModrinthStatus = (scope === 'all' || scope === 'modrinth') && query.trim().length >= 2;
  const remoteLoading = showModrinthStatus && (remote.loading || remote.query !== query.trim());
  let lastGroup = null;

  return (
    <div className="qs-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
      <div className="qs-panel" role="dialog" aria-modal="true" aria-label="Quick search">
        <div className="qs-input-row">
          <Search size={17} className="qs-input-icon" aria-hidden="true" />
          <input
            ref={inputRef}
            className="qs-input"
            value={query}
            onChange={(event) => setQuery(event.target.value.slice(0, 120))}
            onKeyDown={onKeyDown}
            placeholder="Search instances, mods, friends, settings, how-tos…"
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-expanded="true"
            aria-controls="qs-results"
            aria-activedescendant={active ? `qs-opt-${activeIndex}` : undefined}
            aria-autocomplete="list"
          />
          {remoteLoading && <Loader2 size={15} className="qs-spin" aria-label="Searching Modrinth" />}
          {query ? (
            <button type="button" className="qs-clear" onClick={() => { setQuery(''); inputRef.current?.focus(); }} aria-label="Clear search">
              <X size={13} />
            </button>
          ) : (
            <kbd className="qs-esc">Esc</kbd>
          )}
        </div>

        <div className="qs-scopes" role="tablist" aria-label="Search in">
          {SCOPES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={scope === entry.id}
              className={`qs-scope${scope === entry.id ? ' is-active' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setScope(entry.id)}
            >
              {entry.label}
            </button>
          ))}
          <span className="qs-scope-hint"><kbd>Tab</kbd> to switch</span>
        </div>

        <div className="qs-results" id="qs-results" role="listbox" ref={listRef} aria-label="Results">
          {results.map((item, index) => {
            const header = item.group !== lastGroup ? GROUP_LABELS[item.group] || item.group : null;
            lastGroup = item.group;
            const isActive = index === activeIndex;
            return (
              <React.Fragment key={`${item.group}:${item.id}`}>
                {header && (
                  <div className="qs-group" role="presentation">
                    {item.group === 'recent' && <Clock size={11} aria-hidden="true" />}
                    {item.group === 'modrinth' && <span className="qs-modrinth-dot" aria-hidden="true" />}
                    {header}
                  </div>
                )}
                <div
                  id={`qs-opt-${index}`}
                  data-index={index}
                  role="option"
                  aria-selected={isActive}
                  className={`qs-row${isActive ? ' is-active' : ''}`}
                  style={{ '--qs-i': Math.min(index, 12) }}
                  onMouseMove={() => { if (!isActive) setActiveIndex(index); }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => run(item, event.shiftKey)}
                >
                  <ItemIcon item={item} />
                  <span className="qs-text">
                    <span className="qs-title"><Highlighted text={item.title} query={query} /></span>
                    {item.subtitle && <span className="qs-sub">{item.subtitle}</span>}
                  </span>
                  {item.meta?.type && (
                    <span className="qs-meta">
                      <span className="qs-type">{item.meta.type}</span>
                      {item.meta.downloads > 0 && <span className="qs-dl"><Download size={10} aria-hidden="true" />{formatDownloads(item.meta.downloads)}</span>}
                    </span>
                  )}
                  {item.secondary && (
                    <button
                      type="button"
                      className={`qs-secondary${item.secondary.disabled ? ' is-disabled' : ''}`}
                      tabIndex={-1}
                      disabled={item.secondary.disabled}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) => { event.stopPropagation(); run(item, true); }}
                    >
                      {item.secondary.label === 'Launch' && <Rocket size={11} aria-hidden="true" />}
                      {item.secondary.label === 'Join' && <Users size={11} aria-hidden="true" />}
                      {item.secondary.label}
                      {!item.secondary.disabled && <kbd>⇧↵</kbd>}
                    </button>
                  )}
                  {isActive && <CornerDownLeft size={13} className="qs-enter" aria-hidden="true" />}
                </div>
              </React.Fragment>
            );
          })}

          {query.trim() && !results.length && !remoteLoading && (
            <div className="qs-empty">
              <Search size={22} aria-hidden="true" />
              <strong>No matches for “{query.trim()}”</strong>
              <span>Try another word, or search all of Modrinth.</span>
              <button type="button" className="qs-empty-btn" onClick={searchOnDiscover}>
                <Compass size={13} aria-hidden="true" /> Search “{query.trim()}” in Discover
              </button>
            </div>
          )}

          {showModrinthStatus && remote.error && remote.query === query.trim() && (
            <div className="qs-remote-note">Modrinth couldn’t be reached — local results only.</div>
          )}
        </div>

        <footer className="qs-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          {active?.secondary && !active.secondary.disabled && <span><kbd>⇧</kbd><kbd>↵</kbd> {active.secondary.label.toLowerCase()}</span>}
          <span><kbd>Esc</kbd> close</span>
          {query.trim().length >= 2 && (
            <button type="button" className="qs-footer-link" onMouseDown={(event) => event.preventDefault()} onClick={searchOnDiscover}>
              Search all of Modrinth <ArrowRight size={11} aria-hidden="true" />
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
