import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bell,
  Check,
  ChevronRight,
  Copy,
  Cpu,
  Database,
  Download,
  ExternalLink,
  Folder,
  Gauge,
  Globe,
  HardDrive,
  History,
  Info,
  LayoutGrid,
  Monitor,
  Palette,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sliders,
  Sparkles,
  Terminal,
  Upload,
  Volume2,
  X,
  Zap
} from 'lucide-react';
import useUpdater from '../updater/useUpdater.js';
import { UpdateCard } from '../updater/UpdateCenter.jsx';
import Dropdown from '../../components/ui/Dropdown.jsx';
import Logo from '../../components/ui/Logo.jsx';
import StoragePanel from './StoragePanel.jsx';
import JavaPanel, { GlobalMemory } from './JavaPanel.jsx';
import ChangelogPanel from './ChangelogPanel.jsx';
import { DEFAULTS, deepMerge } from './useSettings.js';
import { SUPPORTED_LOCALES } from '../../i18n/catalogs.js';
import { readNotifyPrefs, writeNotifyPrefs } from '../shell/relayNotifications.js';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import packageInfo from '../../../package.json';
import './SettingsView.css';

/* ────────────────────────────────────────────────────────────
   Navigation
   ──────────────────────────────────────────────────────────── */

const TABS = [
  { id: 'overview', title: 'Overview', desc: 'Your setup at a glance', icon: LayoutGrid, group: 'Start' },
  { id: 'launcher', title: 'General', desc: 'Language, behavior & window', icon: Sliders, group: 'Launcher' },
  { id: 'notifications', title: 'Notifications', desc: 'Relay alerts & sounds', icon: Bell, group: 'Launcher' },
  { id: 'appearance', title: 'Appearance', desc: 'Motion & density', icon: Palette, group: 'Launcher' },
  { id: 'updates', title: 'Updates', desc: 'Launcher updates & delivery', icon: RefreshCw, group: 'Launcher' },
  { id: 'minecraft', title: 'Game & Display', desc: 'Fullscreen, resolution & RAM', icon: Monitor, group: 'Game' },
  { id: 'java', title: 'Java & Arguments', desc: 'Runtimes & launch flags', icon: Terminal, group: 'Game' },
  { id: 'storage', title: 'Storage', desc: 'Data folder, disk & caches', icon: HardDrive, group: 'System' },
  { id: 'backup', title: 'Backup & Reset', desc: 'Export, import & restore', icon: Database, group: 'System' },
  { id: 'changelog', title: 'Release Notes', desc: 'Version history', icon: History, group: 'System' },
  { id: 'about', title: 'About', desc: 'System info & support', icon: Info, group: 'System' }
];
const GROUPS = ['Start', 'Launcher', 'Game', 'System'];

const PREFS_KEY = 'native.preferences';
const DEFAULT_PREFS = {
  discordRpc: true,
  launcherAction: 'keep',
  reopenOnExit: true,
  keepLogs: true,
  fullscreen: false,
  resolutionWidth: 1920,
  resolutionHeight: 1080
};

const LANGUAGE_NAMES = {
  en: 'English',
  es: 'Español',
  de: 'Deutsch',
  fr: 'Français',
  'pt-BR': 'Português (Brasil)',
  tr: 'Türkçe'
};

const RESOLUTION_PRESETS = [
  { w: 854, h: 480, label: '854 × 480', sub: 'Default' },
  { w: 1280, h: 720, label: '1280 × 720', sub: 'HD' },
  { w: 1920, h: 1080, label: '1920 × 1080', sub: 'Full HD' },
  { w: 2560, h: 1440, label: '2560 × 1440', sub: 'QHD' },
  { w: 3840, h: 2160, label: '3840 × 2160', sub: '4K' }
];

const DISCORD_URL = 'https://discord.gg/playnative';
const YOUTUBE_URL = 'https://www.youtube.com/@native-client';

/* ────────────────────────────────────────────────────────────
   Persistence helpers
   ──────────────────────────────────────────────────────────── */

function readPrefs() {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : { ...DEFAULT_PREFS };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

async function loadStore() {
  try {
    if (window.native?.settings?.load) return (await window.native.settings.load()) || {};
    return JSON.parse(localStorage.getItem('native.settings') || '{}');
  } catch {
    return {};
  }
}

async function saveStore(next) {
  if (window.native?.settings?.save) await window.native.settings.save(next);
  else localStorage.setItem('native.settings', JSON.stringify(next));
  // Keep every useSettings() consumer (and data-* appearance flags) in sync.
  window.dispatchEvent(new CustomEvent('native:settings-changed', { detail: next }));
  return next;
}

/** Merge a patch into the main-process settings store: patchStore((cur) => ({ section: {...} })) */
async function patchStore(build) {
  const current = await loadStore();
  const patch = build(current);
  const next = { ...current };
  for (const key of Object.keys(patch)) {
    next[key] = patch[key] && typeof patch[key] === 'object' && !Array.isArray(patch[key])
      ? { ...(current?.[key] ?? {}), ...patch[key] }
      : patch[key];
  }
  return saveStore(next);
}

function applyAppearanceFlags(appearance = {}) {
  const root = document.documentElement;
  root.dataset.reducedMotion = appearance.reducedMotion ? 'true' : 'false';
  root.dataset.density = appearance.compactDensity ? 'compact' : 'comfortable';
  root.dataset.backgroundMotion = appearance.backgroundMotion === false ? 'off' : 'on';
}

const openExternal = (url) =>
  window.native?.openExternal ? window.native.openExternal(url) : window.open(url, '_blank');

/* ────────────────────────────────────────────────────────────
   Building blocks
   ──────────────────────────────────────────────────────────── */

function Toggle({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={Boolean(checked)}
      aria-label={label}
      className={`sv-toggle ${checked ? 'is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="sv-toggle-thumb" />
    </button>
  );
}

function Segmented({ value, options, onChange }) {
  return (
    <div className="sv-segmented" role="radiogroup">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          className={value === opt.value ? 'is-active' : ''}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function Section({ title, desc, children, action }) {
  return (
    <section className="sv-section">
      {(title || action) && (
        <header className="sv-section-head">
          <div>
            {title && <h3>{title}</h3>}
            {desc && <p>{desc}</p>}
          </div>
          {action}
        </header>
      )}
      <div className="sv-section-body">{children}</div>
    </section>
  );
}

function Row({ id, icon: Icon, title, desc, children, vertical, badge, highlight }) {
  return (
    <div id={id ? `sv-row-${id}` : undefined} className={`sv-row ${vertical ? 'is-vertical' : ''} ${highlight ? 'is-flash' : ''}`}>
      <div className="sv-row-main">
        {Icon && (
          <span className="sv-row-icon">
            <Icon size={17} />
          </span>
        )}
        <div className="sv-row-text">
          <span className="sv-row-title">
            {title}
            {badge && <em className="sv-badge">{badge}</em>}
          </span>
          {desc && <span className="sv-row-desc">{desc}</span>}
        </div>
      </div>
      {children && <div className="sv-row-control">{children}</div>}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, sub, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} className={`sv-stat ${onClick ? 'is-link' : ''}`} onClick={onClick}>
      <span className="sv-stat-icon">
        <Icon size={16} />
      </span>
      <span className="sv-stat-label">{label}</span>
      <span className="sv-stat-value">{value}</span>
      {sub && <span className="sv-stat-sub">{sub}</span>}
      {onClick && <ChevronRight size={14} className="sv-stat-arrow" />}
    </Tag>
  );
}

/** The launcher's own update, live: checking, downloading with progress, ready to restart. */
function LiveUpdateCard({ onOpenUpdater }) {
  const updater = useUpdater();
  return (
    <UpdateCard
      className="settings-update-card"
      status={updater.status}
      onCheck={updater.check}
      onDownload={updater.download}
      onPause={updater.pause}
      onInstall={updater.install}
      onDetails={onOpenUpdater}
    />
  );
}

/* ────────────────────────────────────────────────────────────
   Page
   ──────────────────────────────────────────────────────────── */

export default function SettingsView({ initialTab = 'overview', instances = [], onOpenUpdater, onBack }) {
  const { locale, setLocale, t } = useI18n();
  const [activeTab, setActiveTab] = useState(TABS.some((tab) => tab.id === initialTab) ? initialTab : 'overview');
  const [searchQuery, setSearchQuery] = useState('');
  const [prefs, setPrefs] = useState(readPrefs);
  const [store, setStore] = useState(null);
  const [notifyPrefs, setNotifyPrefs] = useState(() => readNotifyPrefs());
  const [dataDir, setDataDir] = useState('');
  const [systemMem, setSystemMem] = useState(null);
  const [toast, setToast] = useState(null);
  const [flashRow, setFlashRow] = useState(null);
  const [customRes, setCustomRes] = useState({ w: '', h: '' });
  const [confirmReset, setConfirmReset] = useState(false);
  const searchRef = useRef(null);
  const contentRef = useRef(null);
  const importRef = useRef(null);
  const toastTimer = useRef(null);

  const buildVersion = window.native?.version || packageInfo.version || '0.0.0';

  const notify = useCallback((text, tone = 'ok') => {
    clearTimeout(toastTimer.current);
    setToast({ text, tone, key: Date.now() });
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  /* Load everything once */
  useEffect(() => {
    let cancelled = false;
    loadStore().then((stored) => {
      if (cancelled) return;
      const merged = deepMerge(DEFAULTS, stored || {});
      setStore(merged);
      const b = stored?.behavior;
      const res = stored?.resolution;
      setPrefs((prev) => ({
        ...prev,
        ...(b ? {
          launcherAction: b.launcherAction === 'minimize' ? 'minimize' : 'keep',
          reopenOnExit: b.reopenOnExit !== false,
          discordRpc: b.discordRpc !== false
        } : {}),
        ...(res ? {
          fullscreen: Boolean(res.fullscreen),
          resolutionWidth: Number(res.width) || prev.resolutionWidth,
          resolutionHeight: Number(res.height) || prev.resolutionHeight
        } : {})
      }));
    });
    window.native?.settings?.dataDir?.().then((dir) => !cancelled && setDataDir(dir)).catch(() => {});
    window.native?.settings?.systemMemory?.().then((mem) => !cancelled && setSystemMem(mem)).catch(() => {});
    const sync = (event) => event.detail && setStore(deepMerge(DEFAULTS, event.detail));
    window.addEventListener('native:settings-changed', sync);
    return () => {
      cancelled = true;
      window.removeEventListener('native:settings-changed', sync);
      clearTimeout(toastTimer.current);
    };
  }, []);

  /* Keyboard: Esc goes back / clears search, Ctrl+F or / focuses search */
  useEffect(() => {
    const onKey = (event) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '');
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (event.key === '/' && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.key === 'Escape' && !typing && onBack) onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  /* Scroll to the top when switching tabs */
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [activeTab]);

  /* ── Mutations ───────────────────────────────────────────── */

  const updatePref = (patch) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
    const behavior = {};
    for (const key of ['discordRpc', 'launcherAction', 'reopenOnExit', 'keepLogs']) {
      if (key in patch) behavior[key] = patch[key];
    }
    const resolution = {};
    if ('fullscreen' in patch) resolution.fullscreen = patch.fullscreen;
    if ('resolutionWidth' in patch) resolution.width = patch.resolutionWidth;
    if ('resolutionHeight' in patch) resolution.height = patch.resolutionHeight;
    patchStore(() => ({
      ...(Object.keys(behavior).length ? { behavior } : {}),
      ...(Object.keys(resolution).length ? { resolution } : {})
    }))
      .then(() => notify('Saved'))
      .catch(() => notify('Could not save', 'err'));
  };

  const updateSection = (section, patch) => {
    setStore((prev) => (prev ? { ...prev, [section]: { ...prev[section], ...patch } } : prev));
    if (section === 'appearance') applyAppearanceFlags({ ...(store?.appearance ?? {}), ...patch });
    patchStore(() => ({ [section]: patch }))
      .then(() => notify('Saved'))
      .catch(() => notify('Could not save', 'err'));
  };

  const setNotify = (patch) => {
    setNotifyPrefs(writeNotifyPrefs(patch));
    notify('Saved');
  };

  const changeLanguage = (next) => {
    setLocale(next);
    updateSection('onboarding', { language: next });
  };

  const copyText = async (text, message) => {
    try {
      await navigator.clipboard?.writeText(text);
      notify(message);
    } catch {
      notify('Clipboard unavailable', 'err');
    }
  };

  const diagnostics = () => [
    `Native Client v${buildVersion}`,
    `Platform: ${window.native?.platform || navigator.platform || 'unknown'}`,
    `User agent: ${navigator.userAgent}`,
    `System RAM: ${systemMem?.totalGb ? `${systemMem.totalGb} GB` : 'unknown'}`,
    `Allocated RAM: ${store?.memory?.min ?? '?'}–${store?.memory?.max ?? '?'} GB`,
    `Resolution: ${prefs.fullscreen ? 'Fullscreen' : `${prefs.resolutionWidth}×${prefs.resolutionHeight}`}`,
    `Language: ${locale}`,
    `Instances: ${instances.length}`,
    `Data folder: ${dataDir || 'default'}`
  ].join('\n');

  const exportSettings = async () => {
    const current = await loadStore();
    const { apiKeys, ...safe } = current || {};
    const payload = {
      kind: 'native-client-settings',
      version: 1,
      exportedAt: new Date().toISOString(),
      launcher: buildVersion,
      settings: safe,
      preferences: prefs,
      notifications: notifyPrefs
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `native-settings-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('Settings exported');
  };

  const importSettings = async (file) => {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data?.kind !== 'native-client-settings' || typeof data.settings !== 'object') throw new Error('bad file');
      const current = await loadStore();
      // Never import API keys, Java paths are machine-specific: keep this machine's.
      const incoming = { ...data.settings };
      delete incoming.apiKeys;
      delete incoming.java;
      const next = deepMerge(deepMerge(DEFAULTS, current || {}), incoming);
      await saveStore(next);
      setStore(next);
      applyAppearanceFlags(next.appearance);
      if (data.preferences) {
        const p = { ...DEFAULT_PREFS, ...data.preferences };
        setPrefs(p);
        localStorage.setItem(PREFS_KEY, JSON.stringify(p));
      }
      if (data.notifications) setNotifyPrefs(writeNotifyPrefs(data.notifications));
      if (next.onboarding?.language) setLocale(next.onboarding.language);
      notify('Settings imported');
    } catch {
      notify('That file is not a Native settings backup', 'err');
    } finally {
      if (importRef.current) importRef.current.value = '';
    }
  };

  const resetSettings = async () => {
    const current = await loadStore();
    const next = deepMerge(DEFAULTS, {
      onboarding: current?.onboarding,
      apiKeys: current?.apiKeys,
      java: current?.java
    });
    await saveStore(next);
    setStore(next);
    applyAppearanceFlags(next.appearance);
    setPrefs({ ...DEFAULT_PREFS, resolutionWidth: next.resolution.width, resolutionHeight: next.resolution.height });
    localStorage.removeItem(PREFS_KEY);
    setConfirmReset(false);
    notify('Settings restored to defaults');
  };

  const applyCustomResolution = () => {
    const w = Math.round(Number(customRes.w));
    const h = Math.round(Number(customRes.h));
    if (!(w >= 320 && w <= 7680 && h >= 240 && h <= 4320)) {
      notify('Use a size between 320×240 and 7680×4320', 'err');
      return;
    }
    updatePref({ resolutionWidth: w, resolutionHeight: h });
    setCustomRes({ w: '', h: '' });
  };

  /* ── Search ──────────────────────────────────────────────── */

  const searchIndex = useMemo(
    () => [
      { tab: 'launcher', id: 'language', icon: Globe, title: t('settings.interfaceLanguage'), desc: t('settings.interfaceLanguageDesc'), keywords: 'language locale translation english' },
      { tab: 'launcher', id: 'discord', icon: Zap, title: 'Discord Rich Presence', desc: t('settings.discordDesc'), keywords: 'discord rpc activity status' },
      { tab: 'launcher', id: 'launch-action', icon: Monitor, title: t('settings.launchAction'), desc: t('settings.launchActionDesc'), keywords: 'minimize hide close launcher window reopen restore' },
      { tab: 'launcher', id: 'logs', icon: Terminal, title: t('settings.keepLogs'), desc: t('settings.keepLogsDesc'), keywords: 'logs log session console' },
      { tab: 'notifications', id: 'notify-desktop', icon: Bell, title: t('settings.notifyDesktop'), desc: t('settings.notifyDesktopDesc'), keywords: 'notifications relay desktop alert message' },
      { tab: 'notifications', id: 'notify-sound', icon: Volume2, title: t('settings.notifySound'), desc: t('settings.notifySoundDesc'), keywords: 'sound audio ping notification' },
      { tab: 'appearance', id: 'reduced-motion', icon: Sparkles, title: 'Reduce motion', desc: 'Turn off animations and transitions.', keywords: 'animation motion accessibility transitions' },
      { tab: 'appearance', id: 'bg-motion', icon: Monitor, title: 'Animated backgrounds', desc: 'Moving artwork behind pages.', keywords: 'background video animation art' },
      { tab: 'appearance', id: 'density', icon: LayoutGrid, title: 'Compact layout', desc: 'Tighter spacing to fit more on screen.', keywords: 'density compact spacing small' },
      { tab: 'updates', id: 'update-startup', icon: ShieldCheck, title: t('settings.checkOnStartup'), desc: t('settings.checkOnStartupDesc'), keywords: 'update startup automatic version' },
      { tab: 'updates', id: 'update-bg', icon: History, title: t('settings.backgroundChecks'), desc: t('settings.backgroundChecksDesc'), keywords: 'update background periodic' },
      { tab: 'updates', id: 'update-auto', icon: Download, title: t('settings.autoDownload'), desc: t('settings.autoDownloadDesc'), keywords: 'update download automatic install' },
      { tab: 'minecraft', id: 'fullscreen', icon: Monitor, title: t('settings.fullscreen'), desc: t('settings.fullscreenDesc'), keywords: 'fullscreen window display screen' },
      { tab: 'minecraft', id: 'resolution', icon: Sliders, title: 'Window size', desc: 'Size of the game window in windowed mode.', keywords: 'resolution width height size 720p 1080p 1440p 4k custom' },
      { tab: 'minecraft', id: 'memory', icon: Cpu, title: t('settings.defaultMemory'), desc: t('settings.defaultMemoryDesc'), keywords: 'ram memory allocation gb heap xmx' },
      { tab: 'java', icon: Terminal, title: t('settings.javaExecutable'), desc: t('settings.javaExecutableDesc'), keywords: 'java path runtime jre jdk executable' },
      { tab: 'java', icon: Zap, title: t('settings.jvmArgs'), desc: t('settings.jvmArgsDesc'), keywords: 'jvm arguments flags args gc optimization' },
      { tab: 'storage', id: 'data-folder', icon: Folder, title: t('settings.dataLocation'), desc: 'Where packages, assets and profiles live.', keywords: 'data folder directory path open copy files' },
      { tab: 'storage', icon: HardDrive, title: 'Storage usage', desc: 'Disk space used by each instance.', keywords: 'disk space mods worlds packs cache clear' },
      { tab: 'backup', id: 'export', icon: Upload, title: 'Export settings', desc: 'Save all your settings to a file.', keywords: 'backup export save file transfer' },
      { tab: 'backup', id: 'import', icon: Download, title: 'Import settings', desc: 'Restore settings from a backup file.', keywords: 'backup import restore load file' },
      { tab: 'backup', id: 'reset', icon: RotateCcw, title: 'Reset to defaults', desc: 'Restore every setting to its default.', keywords: 'reset default restore factory clear' },
      { tab: 'changelog', icon: History, title: 'Release notes', desc: 'Version history and patch notes.', keywords: 'changelog patch notes versions history' },
      { tab: 'about', id: 'diagnostics', icon: ShieldCheck, title: 'Copy diagnostics', desc: 'System info for support tickets.', keywords: 'diagnostics support debug info system bug report' },
      { tab: 'about', icon: ExternalLink, title: 'Community & support', desc: 'Discord and YouTube.', keywords: 'discord youtube support community help' }
    ],
    [t]
  );

  const searchResults = useMemo(() => {
    const terms = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return null;
    return searchIndex.filter((item) => {
      const tab = TABS.find((x) => x.id === item.tab);
      const hay = `${item.title} ${item.desc} ${item.keywords} ${tab?.title || ''}`.toLowerCase();
      return terms.every((term) => hay.includes(term));
    });
  }, [searchQuery, searchIndex]);

  const goTo = (tabId, rowId) => {
    setActiveTab(tabId);
    setSearchQuery('');
    if (rowId) {
      setTimeout(() => {
        document.getElementById(`sv-row-${rowId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setFlashRow(rowId);
        setTimeout(() => setFlashRow(null), 1600);
      }, 60);
    }
  };

  const current = TABS.find((tab) => tab.id === activeTab) || TABS[0];
  const appearance = store?.appearance ?? DEFAULTS.appearance;
  const updates = store?.updates ?? DEFAULTS.updates;
  const memory = store?.memory ?? DEFAULTS.memory;
  const javaCount = Object.values(store?.java?.paths ?? {}).filter(Boolean).length;
  const R = (id) => flashRow === id;

  /* ── Render ──────────────────────────────────────────────── */

  return (
    <div className="settings-view-page sv" data-testid="settings-view-page">
      <aside className="sv-sidebar">
        <div className="sv-brand">
          {onBack && (
            <button type="button" className="sv-icon-btn" onClick={onBack} title="Back (Esc)" aria-label="Back">
              <ArrowLeft size={16} />
            </button>
          )}
          <div>
            <span className="sv-brand-kicker">Preferences</span>
            <h2 className="sv-brand-title page-title">Settings</h2>
          </div>
        </div>

        <div className="sv-search">
          <Search size={14} aria-hidden="true" />
          <input
            ref={searchRef}
            type="text"
            placeholder="Search settings"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setSearchQuery('');
                e.currentTarget.blur();
              }
              if (e.key === 'Enter' && searchResults?.[0]) goTo(searchResults[0].tab, searchResults[0].id);
            }}
            aria-label="Search settings"
          />
          {searchQuery ? (
            <button type="button" className="sv-search-clear" onClick={() => setSearchQuery('')} aria-label="Clear search">
              <X size={12} />
            </button>
          ) : (
            <kbd>Ctrl F</kbd>
          )}
        </div>

        <nav className="sv-nav" aria-label="Settings categories">
          {GROUPS.map((group) => (
            <div className="sv-nav-group" key={group} role="group" aria-label={group}>
              {group !== 'Start' && <span className="sv-nav-label">{group}</span>}
              {TABS.filter((tab) => tab.group === group).map((tab) => {
                const Icon = tab.icon;
                const active = !searchResults && activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    className={`sv-nav-btn ${active ? 'is-active' : ''}`}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => goTo(tab.id)}
                  >
                    <Icon size={15} />
                    <span>{tab.title}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sv-sidebar-foot">
          <Logo height={14} variant="mark" />
          <span>Native Client v{buildVersion}</span>
        </div>
      </aside>

      <main className="sv-main" ref={contentRef}>
        <div className="sv-content" key={searchResults ? 'search' : activeTab}>
          {searchResults ? (
            <>
              <header className="sv-page-head">
                <span className="sv-page-kicker">Search</span>
                <h1>
                  {searchResults.length} {searchResults.length === 1 ? 'result' : 'results'} for “{searchQuery.trim()}”
                </h1>
              </header>
              {searchResults.length === 0 ? (
                <div className="sv-empty">
                  <Search size={22} />
                  <strong>No settings match your search</strong>
                  <span>Try “java”, “memory”, “backup” or “update”.</span>
                </div>
              ) : (
                <div className="sv-section-body" data-testid="settings-search-results">
                  {searchResults.map((item) => {
                    const Icon = item.icon;
                    const tab = TABS.find((x) => x.id === item.tab);
                    return (
                      <button key={`${item.tab}:${item.title}`} type="button" className="sv-row sv-result" onClick={() => goTo(item.tab, item.id)}>
                        <div className="sv-row-main">
                          <span className="sv-row-icon"><Icon size={17} /></span>
                          <div className="sv-row-text">
                            <span className="sv-row-title">{item.title}</span>
                            <span className="sv-row-desc">{item.desc}</span>
                          </div>
                        </div>
                        <div className="sv-row-control">
                          <span className="sv-chip">{tab?.title}</span>
                          <ChevronRight size={16} />
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <>
              <header className="sv-page-head">
                <span className="sv-page-kicker">{current.group === 'Start' ? 'Settings' : current.group}</span>
                <h1>{current.title}</h1>
                <p>{current.desc}</p>
              </header>

              {/* ════ OVERVIEW ════ */}
              {activeTab === 'overview' && (
                <>
                  <div className="sv-hero">
                    <div className="sv-hero-logo"><Logo height={30} variant="mark" /></div>
                    <div className="sv-hero-text">
                      <h3>Native Client</h3>
                      <p>Version {buildVersion} · {instances.length} {instances.length === 1 ? 'instance' : 'instances'}</p>
                    </div>
                    <div className="sv-hero-actions">
                      <button type="button" className="sv-btn" onClick={() => copyText(diagnostics(), 'Diagnostics copied')}>
                        <Copy size={14} /> Diagnostics
                      </button>
                      <button type="button" className="sv-btn is-primary" onClick={onOpenUpdater}>
                        <RefreshCw size={14} /> Check updates
                      </button>
                    </div>
                  </div>

                  <div className="sv-stats">
                    <StatCard icon={Cpu} label="Memory" value={`${memory.min}–${memory.max} GB`} sub={systemMem?.totalGb ? `of ${systemMem.totalGb} GB system RAM` : 'Allocated to Minecraft'} onClick={() => goTo('minecraft', 'memory')} />
                    <StatCard icon={Monitor} label="Display" value={prefs.fullscreen ? 'Fullscreen' : `${prefs.resolutionWidth}×${prefs.resolutionHeight}`} sub="Game window" onClick={() => goTo('minecraft', 'resolution')} />
                    <StatCard icon={Terminal} label="Java" value={javaCount ? `${javaCount} custom` : 'Automatic'} sub="Runtime selection" onClick={() => goTo('java')} />
                    <StatCard icon={Globe} label="Language" value={LANGUAGE_NAMES[locale] || locale} sub="Interface" onClick={() => goTo('launcher', 'language')} />
                    <StatCard icon={RefreshCw} label="Updates" value={updates.autoDownload ? 'Automatic' : 'Manual'} sub={updates.checkOnStartup ? 'Checks on startup' : 'Startup check off'} onClick={() => goTo('updates')} />
                    <StatCard icon={Gauge} label="Motion" value={appearance.reducedMotion ? 'Reduced' : 'Full'} sub={appearance.compactDensity ? 'Compact layout' : 'Comfortable layout'} onClick={() => goTo('appearance')} />
                  </div>

                  <Section title="Quick toggles" desc="The settings people change most.">
                    <Row icon={Zap} title="Discord Rich Presence" desc={t('settings.discordDesc')}>
                      <Toggle label="Discord Rich Presence" checked={prefs.discordRpc} onChange={(v) => updatePref({ discordRpc: v })} />
                    </Row>
                    <Row icon={Monitor} title={t('settings.fullscreen')} desc={t('settings.fullscreenDesc')}>
                      <Toggle label="Fullscreen" checked={prefs.fullscreen} onChange={(v) => updatePref({ fullscreen: v })} />
                    </Row>
                    <Row icon={Bell} title={t('settings.notifyDesktop')} desc={t('settings.notifyDesktopDesc')}>
                      <Toggle label="Desktop notifications" checked={notifyPrefs.desktop} onChange={(v) => setNotify({ desktop: v })} />
                    </Row>
                  </Section>

                  <Section title="Tips">
                    <div className="sv-tips">
                      <span><kbd>Ctrl F</kbd> or <kbd>/</kbd> search any setting</span>
                      <span><kbd>Esc</kbd> leave settings</span>
                      <span><kbd>Enter</kbd> in search opens the top result</span>
                    </div>
                  </Section>
                </>
              )}

              {/* ════ GENERAL ════ */}
              {activeTab === 'launcher' && (
                <>
                  <Section title="Language">
                    <Row id="language" highlight={R('language')} icon={Globe} title={t('settings.interfaceLanguage')} desc={t('settings.interfaceLanguageDesc')}>
                      <div className="sv-dropdown">
                        <Dropdown
                          value={locale}
                          options={SUPPORTED_LOCALES.map((code) => ({ value: code, label: LANGUAGE_NAMES[code] || code }))}
                          onChange={changeLanguage}
                        />
                      </div>
                    </Row>
                  </Section>

                  <Section title={t('settings.behavior')}>
                    <Row id="discord" highlight={R('discord')} icon={Zap} title="Discord Rich Presence" desc={t('settings.discordDesc')}>
                      <Toggle label="Discord Rich Presence" checked={prefs.discordRpc} onChange={(v) => updatePref({ discordRpc: v })} />
                    </Row>
                    <Row id="logs" highlight={R('logs')} icon={Terminal} title={t('settings.keepLogs')} desc={t('settings.keepLogsDesc')}>
                      <Toggle label="Keep logs" checked={prefs.keepLogs} onChange={(v) => updatePref({ keepLogs: v })} />
                    </Row>
                  </Section>

                  <Section title="While playing" desc="What the launcher window does when the game starts.">
                    <Row id="launch-action" highlight={R('launch-action')} icon={Monitor} title={t('settings.launchAction')} desc={t('settings.launchActionDesc')}>
                      <Segmented
                        value={prefs.launcherAction}
                        options={[{ value: 'keep', label: 'Keep open' }, { value: 'minimize', label: 'Minimize' }]}
                        onChange={(v) => updatePref({ launcherAction: v })}
                      />
                    </Row>
                    {prefs.launcherAction === 'minimize' && (
                      <Row icon={RotateCcw} title={t('settings.reopenOnExit')} desc={t('settings.reopenOnExitDesc')}>
                        <Toggle label="Reopen on exit" checked={prefs.reopenOnExit} onChange={(v) => updatePref({ reopenOnExit: v })} />
                      </Row>
                    )}
                  </Section>
                </>
              )}

              {/* ════ NOTIFICATIONS ════ */}
              {activeTab === 'notifications' && (
                <Section title="Relay" desc="Messages and invites from friends.">
                  <Row id="notify-desktop" highlight={R('notify-desktop')} icon={Bell} title={t('settings.notifyDesktop')} desc={t('settings.notifyDesktopDesc')}>
                    <Toggle label="Desktop notifications" checked={notifyPrefs.desktop} onChange={(v) => setNotify({ desktop: v })} />
                  </Row>
                  <Row id="notify-sound" highlight={R('notify-sound')} icon={Volume2} title={t('settings.notifySound')} desc={t('settings.notifySoundDesc')}>
                    <Toggle label="Notification sound" checked={notifyPrefs.sound} onChange={(v) => setNotify({ sound: v })} />
                  </Row>
                  <Row icon={Sparkles} title={t('settings.notifyTest')} desc={t('settings.notifyTestDesc')}>
                    <button
                      type="button"
                      className="sv-btn"
                      onClick={() => {
                        window.native?.showNotification?.('Native Relay', 'Notifications are working.');
                        notify('Test notification sent');
                      }}
                    >
                      {t('settings.notifyTestBtn')}
                    </button>
                  </Row>
                </Section>
              )}

              {/* ════ APPEARANCE ════ */}
              {activeTab === 'appearance' && (
                <>
                  <Section title="Motion" desc="Smoother on older PCs and easier on the eyes.">
                    <Row id="reduced-motion" highlight={R('reduced-motion')} icon={Sparkles} title="Reduce motion" desc="Turns off animations and transitions across the launcher.">
                      <Toggle label="Reduce motion" checked={appearance.reducedMotion} onChange={(v) => updateSection('appearance', { reducedMotion: v })} />
                    </Row>
                    <Row id="bg-motion" highlight={R('bg-motion')} icon={Monitor} title="Animated backgrounds" desc="Moving artwork behind pages. Turn off to save GPU.">
                      <Toggle label="Animated backgrounds" checked={appearance.backgroundMotion !== false} onChange={(v) => updateSection('appearance', { backgroundMotion: v })} />
                    </Row>
                  </Section>
                  <Section title="Layout">
                    <Row id="density" highlight={R('density')} icon={LayoutGrid} title="Interface density" desc="Compact fits more on screen; comfortable is easier to read.">
                      <Segmented
                        value={appearance.compactDensity ? 'compact' : 'comfortable'}
                        options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]}
                        onChange={(v) => updateSection('appearance', { compactDensity: v === 'compact' })}
                      />
                    </Row>
                    <Row icon={Palette} title="Theme" desc="OLED true black, built for the Native look." badge="Locked" />
                  </Section>
                </>
              )}

              {/* ════ UPDATES ════ */}
              {activeTab === 'updates' && (
                <>
                  <Section title="Launcher">
                    <LiveUpdateCard onOpenUpdater={onOpenUpdater} />
                  </Section>
                  <Section title="Delivery" desc="How Native finds and installs new versions.">
                    <Row id="update-startup" highlight={R('update-startup')} icon={ShieldCheck} title={t('settings.checkOnStartup')} desc={t('settings.checkOnStartupDesc')}>
                      <Toggle label="Check on startup" checked={updates.checkOnStartup !== false} onChange={(v) => updateSection('updates', { checkOnStartup: v })} />
                    </Row>
                    <Row id="update-bg" highlight={R('update-bg')} icon={History} title={t('settings.backgroundChecks')} desc={t('settings.backgroundChecksDesc')}>
                      <Toggle label="Background checks" checked={updates.backgroundChecks !== false} onChange={(v) => updateSection('updates', { backgroundChecks: v })} />
                    </Row>
                    <Row id="update-auto" highlight={R('update-auto')} icon={Download} title={t('settings.autoDownload')} desc={t('settings.autoDownloadDesc')}>
                      <Toggle label="Auto download" checked={updates.autoDownload !== false} onChange={(v) => updateSection('updates', { autoDownload: v })} />
                    </Row>
                  </Section>
                </>
              )}

              {/* ════ GAME & DISPLAY ════ */}
              {activeTab === 'minecraft' && (
                <>
                  <Section title="Window">
                    <Row id="fullscreen" highlight={R('fullscreen')} icon={Monitor} title={t('settings.fullscreen')} desc={t('settings.fullscreenDesc')}>
                      <Toggle label="Fullscreen" checked={prefs.fullscreen} onChange={(v) => updatePref({ fullscreen: v })} />
                    </Row>
                    <Row id="resolution" highlight={R('resolution')} vertical icon={Sliders} title="Window size" desc={prefs.fullscreen ? 'Used when fullscreen is off.' : 'Size of the game window when it opens.'}>
                      <div className="sv-res-grid">
                        {RESOLUTION_PRESETS.map((res) => {
                          const on = prefs.resolutionWidth === res.w && prefs.resolutionHeight === res.h;
                          return (
                            <button key={res.label} type="button" className={`sv-res ${on ? 'is-active' : ''}`} onClick={() => updatePref({ resolutionWidth: res.w, resolutionHeight: res.h })}>
                              <span className="sv-res-preview" style={{ aspectRatio: `${res.w} / ${res.h}` }} />
                              <strong>{res.label}</strong>
                              <span>{res.sub}</span>
                              {on && <Check size={13} className="sv-res-check" />}
                            </button>
                          );
                        })}
                      </div>
                      <div className="sv-custom-res">
                        <span>Custom</span>
                        <input type="number" min="320" max="7680" placeholder={String(prefs.resolutionWidth)} value={customRes.w} onChange={(e) => setCustomRes((c) => ({ ...c, w: e.target.value }))} aria-label="Width" />
                        <X size={12} />
                        <input type="number" min="240" max="4320" placeholder={String(prefs.resolutionHeight)} value={customRes.h} onChange={(e) => setCustomRes((c) => ({ ...c, h: e.target.value }))} onKeyDown={(e) => e.key === 'Enter' && applyCustomResolution()} aria-label="Height" />
                        <button type="button" className="sv-btn" disabled={!customRes.w || !customRes.h} onClick={applyCustomResolution}>Apply</button>
                      </div>
                    </Row>
                  </Section>
                  <Section title="Memory (RAM)" desc="4–6 GB suits almost every modpack. Leave some for Windows.">
                    <Row id="memory" highlight={R('memory')} vertical icon={Cpu} title={t('settings.defaultMemory')} desc={t('settings.defaultMemoryDesc')}>
                      <div className="sv-ram"><GlobalMemory /></div>
                    </Row>
                  </Section>
                </>
              )}

              {/* ════ JAVA ════ */}
              {activeTab === 'java' && (
                <div className="sv-embed"><JavaPanel /></div>
              )}

              {/* ════ STORAGE ════ */}
              {activeTab === 'storage' && (
                <>
                  <Section title={t('settings.dataFolder')}>
                    <Row id="data-folder" highlight={R('data-folder')} vertical icon={Folder} title={t('settings.dataLocation')} desc="Packages, assets, profiles and runtimes are stored here.">
                      <div className="sv-path">
                        <code>{dataDir || t('settings.defaultData')}</code>
                        <button type="button" className="sv-btn" disabled={!dataDir} onClick={() => copyText(dataDir, 'Path copied')}>
                          <Copy size={14} /> Copy
                        </button>
                        <button type="button" className="sv-btn is-primary" onClick={() => window.native?.settings?.openDataDir?.()}>
                          <Folder size={14} /> Open
                        </button>
                      </div>
                    </Row>
                  </Section>
                  <div className="sv-embed"><StoragePanel instances={instances} /></div>
                </>
              )}

              {/* ════ BACKUP ════ */}
              {activeTab === 'backup' && (
                <>
                  <Section title="Backup" desc="Move your setup to another PC or keep a copy before experimenting. API keys and Java paths are never included.">
                    <Row id="export" highlight={R('export')} icon={Upload} title="Export settings" desc="Download every setting as a .json file.">
                      <button type="button" className="sv-btn is-primary" onClick={exportSettings}>
                        <Upload size={14} /> Export
                      </button>
                    </Row>
                    <Row id="import" highlight={R('import')} icon={Download} title="Import settings" desc="Restore from a Native settings backup.">
                      <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(e) => importSettings(e.target.files?.[0])} />
                      <button type="button" className="sv-btn" onClick={() => importRef.current?.click()}>
                        <Download size={14} /> Import
                      </button>
                    </Row>
                  </Section>
                  <Section title="Danger zone">
                    <Row id="reset" highlight={R('reset')} icon={RotateCcw} title="Reset to defaults" desc="Restores every setting. Your accounts, instances, language and Java paths stay.">
                      {confirmReset ? (
                        <div className="sv-confirm">
                          <button type="button" className="sv-btn" onClick={() => setConfirmReset(false)}>Cancel</button>
                          <button type="button" className="sv-btn is-danger" onClick={resetSettings}>Yes, reset</button>
                        </div>
                      ) : (
                        <button type="button" className="sv-btn is-danger-ghost" onClick={() => setConfirmReset(true)}>
                          <RotateCcw size={14} /> Reset
                        </button>
                      )}
                    </Row>
                  </Section>
                </>
              )}

              {/* ════ CHANGELOG ════ */}
              {activeTab === 'changelog' && (
                <div className="sv-embed"><ChangelogPanel onOpenUpdater={onOpenUpdater} /></div>
              )}

              {/* ════ ABOUT ════ */}
              {activeTab === 'about' && (
                <>
                  <div className="sv-hero">
                    <div className="sv-hero-logo"><Logo height={30} variant="mark" /></div>
                    <div className="sv-hero-text">
                      <h3>Native Client</h3>
                      <p>High-performance Minecraft launcher & modpack platform.</p>
                    </div>
                    <div className="sv-hero-actions">
                      <button type="button" className="sv-btn is-primary" onClick={onOpenUpdater}>
                        <RefreshCw size={14} /> Check updates
                      </button>
                    </div>
                  </div>

                  <div className="sv-stats is-compact">
                    <StatCard icon={Info} label="Version" value={`v${buildVersion}`} sub="Stable channel" />
                    <StatCard icon={Monitor} label="Platform" value={window.native?.platform || navigator.platform || 'Windows'} sub="Operating system" />
                    <StatCard icon={Cpu} label="System RAM" value={systemMem?.totalGb ? `${systemMem.totalGb} GB` : '—'} sub="Installed memory" />
                    <StatCard icon={HardDrive} label="Instances" value={String(instances.length)} sub="On this PC" />
                  </div>

                  <Section title="Support">
                    <Row id="diagnostics" highlight={R('diagnostics')} icon={ShieldCheck} title="Copy diagnostics" desc="Paste this into a support ticket so we can help faster.">
                      <button type="button" className="sv-btn" onClick={() => copyText(diagnostics(), 'Diagnostics copied')}>
                        <Copy size={14} /> Copy
                      </button>
                    </Row>
                    <Row icon={ExternalLink} title="Discord" desc="Help, announcements and the community.">
                      <button type="button" className="sv-btn" onClick={() => openExternal(DISCORD_URL)}>
                        Join <ExternalLink size={13} />
                      </button>
                    </Row>
                    <Row icon={ExternalLink} title="YouTube" desc="Guides, trailers and updates.">
                      <button type="button" className="sv-btn" onClick={() => openExternal(YOUTUBE_URL)}>
                        Watch <ExternalLink size={13} />
                      </button>
                    </Row>
                  </Section>
                </>
              )}
            </>
          )}
        </div>
      </main>

      {toast && (
        <div key={toast.key} className={`sv-toast ${toast.tone === 'err' ? 'is-err' : ''}`} role="status">
          {toast.tone === 'err' ? <X size={14} /> : <Check size={14} />}
          {toast.text}
        </div>
      )}
    </div>
  );
}
