import React, { useEffect, useMemo, useState } from 'react';
import {
  Bell,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  Cpu,
  Database,
  ExternalLink,
  Folder,
  Globe,
  HardDrive,
  History,
  Info,
  Monitor,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Sliders,
  Terminal,
  X,
  Zap
} from 'lucide-react';
import Dropdown from '../../components/ui/Dropdown.jsx';
import Logo from '../../components/ui/Logo.jsx';
import StoragePanel from './StoragePanel.jsx';
import JavaPanel, { GlobalMemory } from './JavaPanel.jsx';
import ChangelogPanel from './ChangelogPanel.jsx';
import { SUPPORTED_LOCALES } from '../../i18n/catalogs.js';
import { readNotifyPrefs, writeNotifyPrefs } from '../shell/relayNotifications.js';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import packageInfo from '../../../package.json';
import './SettingsView.css';

const TABS = [
  {
    id: 'launcher',
    title: 'General & Launcher',
    desc: 'Behavior & updates',
    icon: SettingsIcon,
    group: 'Client'
  },
  {
    id: 'minecraft',
    title: 'Game & Display',
    desc: 'Fullscreen, resolution & RAM',
    icon: Monitor,
    group: 'Client'
  },
  {
    id: 'java',
    title: 'Java & Arguments',
    desc: 'Runtime & launch flags',
    icon: Terminal,
    group: 'Client'
  },
  {
    id: 'storage',
    title: 'Storage & Caches',
    desc: 'Disk space & clear cache',
    icon: HardDrive,
    group: 'System'
  },
  {
    id: 'changelog',
    title: 'Release Notes',
    desc: 'Version history & patch notes',
    icon: History,
    group: 'System'
  },
  {
    id: 'about',
    title: 'About Native',
    desc: 'System info & credits',
    icon: Info,
    group: 'System'
  }
];

const PREFS_KEY = 'native.preferences';
const LEGACY_PREFS_KEY = 'native.preferences';

const DEFAULT_PREFS = {
  discordRpc: true,
  launcherAction: 'keep',
  reopenOnExit: true,
  keepLogs: true,
  fullscreen: false,
  ram: 4,
  resolutionWidth: 1920,
  resolutionHeight: 1080,
  javaPath: '',
  javaArgs: ''
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
  { w: 1280, h: 720, label: '1280 × 720', sub: 'HD' },
  { w: 1920, h: 1080, label: '1920 × 1080', sub: 'FHD' },
  { w: 2560, h: 1440, label: '2560 × 1440', sub: 'QHD 2K' },
  { w: 3840, h: 2160, label: '3840 × 2160', sub: '4K UHD' }
];


function readPrefs() {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY) || window.localStorage.getItem(LEGACY_PREFS_KEY);
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : { ...DEFAULT_PREFS };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export default function SettingsView({
  initialTab = 'launcher',
  instances = [],
  onOpenUpdater,
  onBack
}) {
  const { locale, setLocale, t } = useI18n();
  const [activeTab, setActiveTab] = useState(initialTab);
  const [searchQuery, setSearchQuery] = useState('');
  const [prefs, setPrefs] = useState(readPrefs);
  const [notifyPrefs, setNotifyPrefs] = useState(() => readNotifyPrefs());
  const setNotify = (patch) => setNotifyPrefs(writeNotifyPrefs(patch));
  const sendTestNotification = () => window.native?.showNotification?.('Native Relay', 'Notifications are working.');
  const [dataDir, setDataDir] = useState('');
  const [copiedPath, setCopiedPath] = useState(false);
  const [updates, setUpdates] = useState({
    checkOnStartup: true,
    backgroundChecks: true,
    autoDownload: false
  });

  const buildVersion = window.native?.version || packageInfo.version || '3.9.110';

  useEffect(() => {
    if (window.native?.settings?.dataDir) {
      window.native.settings.dataDir().then(setDataDir).catch(() => {});
    }
  }, []);

  // Sync update prefs from native settings store
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = window.native?.settings?.load
          ? await window.native.settings.load()
          : JSON.parse(localStorage.getItem('native.settings') || '{}');
        const u = stored?.updates ?? {};
        if (!cancelled) {
          setUpdates({
            checkOnStartup: u.checkOnStartup !== false,
            backgroundChecks: u.backgroundChecks !== false,
            autoDownload: u.autoDownload === true
          });
        }
      } catch {
        /* fallback defaults */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Window behavior lives in the main-process settings store, not localStorage.
  useEffect(() => {
    let cancelled = false;
    window.native?.settings?.load?.().then((stored) => {
      const b = stored?.behavior;
      const res = stored?.resolution;
      if (cancelled || (!b && !res)) return;
      setPrefs((prev) => ({
        ...prev,
        ...(b ? {
          launcherAction: b.launcherAction === 'keep' || !b.launcherAction ? 'keep' : 'minimize',
          reopenOnExit: b.reopenOnExit !== false
        } : {}),
        // The launcher reads resolution from the settings store; mirror it here.
        ...(res ? {
          fullscreen: Boolean(res.fullscreen),
          resolutionWidth: Number(res.width) || prev.resolutionWidth,
          resolutionHeight: Number(res.height) || prev.resolutionHeight
        } : {})
      }));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape' && onBack) {
        onBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  const updatePref = (patch) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
    if (window.native?.settings) {
      window.native.settings
        .load()
        .then((current) => {
          const res = {};
          if ('fullscreen' in patch) res.fullscreen = patch.fullscreen;
          if ('resolutionWidth' in patch) res.width = patch.resolutionWidth;
          if ('resolutionHeight' in patch) res.height = patch.resolutionHeight;
          window.native.settings.save({
            ...current,
            behavior: { ...(current?.behavior ?? {}), ...patch },
            ...(Object.keys(res).length ? { resolution: { ...(current?.resolution ?? {}), ...res } } : {})
          });
        })
        .catch(() => {});
    }
  };

  const handleOpenDataDir = () => {
    if (window.native?.settings?.openDataDir) {
      window.native.settings.openDataDir();
    }
  };

  const handleCopyPath = () => {
    if (dataDir) {
      navigator.clipboard?.writeText(dataDir);
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 2000);
    }
  };

  const changeLanguage = async (nextLocale) => {
    setLocale(nextLocale);
    if (window.native?.settings) {
      const current = await window.native.settings.load();
      await window.native.settings.save({
        ...current,
        onboarding: { ...(current?.onboarding ?? {}), language: nextLocale }
      });
    } else {
      const current = JSON.parse(localStorage.getItem('native.settings') || '{}');
      localStorage.setItem(
        'native.settings',
        JSON.stringify({
          ...current,
          onboarding: { ...(current.onboarding ?? {}), language: nextLocale }
        })
      );
    }
  };

  const changeUpdateSetting = async (patch) => {
    setUpdates((prev) => ({ ...prev, ...patch }));
    try {
      if (window.native?.settings) {
        const current = await window.native.settings.load();
        await window.native.settings.save({
          ...current,
          updates: { ...(current?.updates ?? {}), ...patch }
        });
      } else {
        const current = JSON.parse(localStorage.getItem('native.settings') || '{}');
        localStorage.setItem(
          'native.settings',
          JSON.stringify({
            ...current,
            updates: { ...(current.updates ?? {}), ...patch }
          })
        );
      }
    } catch {}
  };

  // Every individual setting, so search finds them across all tabs.
  const searchIndex = useMemo(
    () => [
      { tab: 'launcher', icon: Zap, title: 'Discord Rich Presence', desc: t('settings.discordDesc'), keywords: 'discord rpc activity status' },
      { tab: 'launcher', icon: Monitor, title: t('settings.launchAction'), desc: t('settings.launchActionDesc'), keywords: 'minimize hide close launcher launch window reopen restore' },
      { tab: 'launcher', icon: Terminal, title: t('settings.keepLogs'), desc: t('settings.keepLogsDesc'), keywords: 'logs log session console' },
      { tab: 'launcher', icon: Folder, title: t('settings.dataLocation'), desc: 'Stores your downloaded Minecraft packages, assets, profiles, and runtime files.', keywords: 'data folder directory path open copy files' },
      { tab: 'launcher', icon: RefreshCw, title: t('settings.checkUpdates'), desc: `Native Client Build v${buildVersion}`, keywords: 'update updates version build release channel' },
      { tab: 'launcher', icon: ShieldCheck, title: t('settings.checkOnStartup'), desc: t('settings.checkOnStartupDesc'), keywords: 'update startup automatic' },
      { tab: 'launcher', icon: History, title: t('settings.backgroundChecks'), desc: t('settings.backgroundChecksDesc'), keywords: 'update background periodic' },
      { tab: 'launcher', icon: Zap, title: t('settings.autoDownload'), desc: t('settings.autoDownloadDesc'), keywords: 'update download automatic install' },
      { tab: 'minecraft', icon: Monitor, title: t('settings.fullscreen'), desc: t('settings.fullscreenDesc'), keywords: 'fullscreen window display screen' },
      { tab: 'minecraft', icon: Sliders, title: 'Default Window Dimensions', desc: 'Target viewport size when launching instances in windowed mode.', keywords: 'resolution width height size 720p 1080p 1440p 4k hd fhd qhd' },
      { tab: 'minecraft', icon: Cpu, title: t('settings.defaultMemory'), desc: t('settings.defaultMemoryDesc'), keywords: 'ram memory allocation gb heap xmx' },
      { tab: 'java', icon: Terminal, title: t('settings.javaExecutable'), desc: t('settings.javaExecutableDesc'), keywords: 'java path runtime jre jdk executable' },
      { tab: 'java', icon: Zap, title: t('settings.jvmArgs'), desc: t('settings.jvmArgsDesc'), keywords: 'jvm arguments flags args aikar g1gc shenandoah gc optimization' },
      { tab: 'storage', icon: HardDrive, title: 'Storage usage', desc: 'Disk space used by each instance.', keywords: 'disk space mods worlds packs playtime rescan' },
      { tab: 'storage', icon: Database, title: 'Clear download caches', desc: 'Free space used by manifests, artwork and cached data.', keywords: 'cache clear delete manifest artwork' },
      { tab: 'changelog', icon: History, title: 'Release notes', desc: 'Version history and patch notes.', keywords: 'changelog patch notes versions history' },
      { tab: 'about', icon: Info, title: 'About Native', desc: 'Launcher version, platform and credits.', keywords: 'about version platform architecture credits' },
      { tab: 'about', icon: ExternalLink, title: 'Community & support', desc: 'Discord and YouTube links.', keywords: 'discord youtube support community help' }
    ],
    [t, buildVersion]
  );

  const searchResults = useMemo(() => {
    const terms = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return null;
    return searchIndex.filter((item) => {
      const tabInfo = TABS.find((tab) => tab.id === item.tab);
      const haystack = `${item.title} ${item.desc} ${item.keywords} ${tabInfo?.title || ''} ${tabInfo?.group || ''}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [searchQuery, searchIndex]);

  const openResult = (tabId) => {
    setActiveTab(tabId);
    setSearchQuery('');
  };

  const currentTabObj = TABS.find((t) => t.id === activeTab) || TABS[0];

  return (
    <div className="settings-view-page" data-testid="settings-view-page">
      <header className="settings-topbar">
        <div className="settings-topbar-row">
          <div className="settings-header-info">
            <span className="settings-header-breadcrumb">
              <span>Preferences</span>
              <span>/</span>
              <span>{currentTabObj.group}</span>
            </span>
            <h2 className="settings-header-title page-title">Settings</h2>
          </div>

          <div className="settings-search-box">
            <Search size={14} className="settings-search-icon" aria-hidden="true" />
            <input
              type="text"
              className="settings-search-input"
              placeholder="Search settings..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && searchQuery) {
                  e.stopPropagation();
                  setSearchQuery('');
                }
              }}
              aria-label="Search settings"
            />
            {searchQuery && (
              <button
                type="button"
                className="settings-search-clear"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
                title="Clear search"
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>

        <nav className="settings-tabs" aria-label="Settings categories">
          {['Client', 'System'].map((groupName) => {
            const groupTabs = TABS.filter((tab) => tab.group === groupName);
            if (groupTabs.length === 0) return null;
            return (
              <div className="settings-tab-group" key={groupName} role="group" aria-label={groupName}>
                {groupTabs.map((tab) => {
                  const IconComp = tab.icon;
                  const isActive = !searchResults && activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      className={`settings-nav-btn ${isActive ? 'is-active' : ''}`}
                      aria-current={isActive ? 'page' : undefined}
                      title={tab.desc}
                      onClick={() => openResult(tab.id)}
                    >
                      <IconComp size={15} />
                      <span className="settings-nav-title">{tab.title}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </nav>
      </header>

      <main className="settings-page-main">
        {!searchResults && <p className="settings-header-desc">{currentTabObj.desc}</p>}

        <div className="settings-scroll-container">
          {searchResults && (
            <div className="settings-section-block" data-testid="settings-search-results">
              <div className="settings-section-title-wrap">
                <span className="settings-section-title">
                  {searchResults.length} {searchResults.length === 1 ? 'result' : 'results'} for “{searchQuery.trim()}”
                </span>
                <div className="settings-section-line" />
              </div>
              {searchResults.length === 0 ? (
                <div className="settings-search-empty">
                  <Search size={20} aria-hidden="true" />
                  <strong>No settings match your search</strong>
                  <span>Try a different word, like “java”, “memory” or “update”.</span>
                </div>
              ) : (
                <div className="settings-cards-stack is-results">
                  {searchResults.map((item) => {
                    const ItemIcon = item.icon;
                    const tabInfo = TABS.find((tab) => tab.id === item.tab);
                    return (
                      <button
                        key={`${item.tab}:${item.title}`}
                        type="button"
                        className="native-setting-card is-wide settings-result"
                        onClick={() => openResult(item.tab)}
                      >
                        <div className="setting-card-left">
                          <div className="setting-card-icon-wrap">
                            <ItemIcon size={18} />
                          </div>
                          <div className="setting-card-text">
                            <span className="setting-card-name">{item.title}</span>
                            <span className="setting-card-desc">{item.desc}</span>
                          </div>
                        </div>
                        <div className="setting-card-control">
                          <span className="settings-result-tab">{tabInfo?.title}</span>
                          <ChevronRight size={16} aria-hidden="true" />
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ════ TAB: LAUNCHER & GENERAL ════ */}
          {!searchResults && activeTab === 'launcher' && (
            <>

              {/* Behavior & Features */}
              <div className="settings-section-block">
                <div className="settings-section-title-wrap">
                  <span className="settings-section-title">{t('settings.behavior')}</span>
                  <div className="settings-section-line" />
                </div>
                <div className="settings-cards-stack">
                  {/* Discord RPC */}
                  <div className="native-setting-card">
                    <div className="setting-card-left">
                      <div className="setting-card-icon-wrap">
                        <Zap size={18} />
                      </div>
                      <div className="setting-card-text">
                        <span className="setting-card-name">Discord Rich Presence</span>
                        <span className="setting-card-desc">{t('settings.discordDesc')}</span>
                      </div>
                    </div>
                    <div className="setting-card-control">
                      <label className="native-switch">
                        <input
                          type="checkbox"
                          checked={prefs.discordRpc}
                          onChange={(e) => updatePref({ discordRpc: e.target.checked })}
                        />
                        <span className="native-switch-track">
                          <span className="native-switch-thumb" />
                        </span>
                      </label>
                    </div>
                  </div>

                  {/* Relay notifications */}
                  <div className="native-setting-card">
                    <div className="setting-card-left">
                      <div className="setting-card-icon-wrap">
                        <Bell size={18} />
                      </div>
                      <div className="setting-card-text">
                        <span className="setting-card-name">{t('settings.notifyDesktop')}</span>
                        <span className="setting-card-desc">{t('settings.notifyDesktopDesc')}</span>
                      </div>
                    </div>
                    <div className="setting-card-control">
                      <label className="native-switch">
                        <input type="checkbox" checked={notifyPrefs.desktop} onChange={(e) => setNotify({ desktop: e.target.checked })} />
                        <span className="native-switch-track">
                          <span className="native-switch-thumb" />
                        </span>
                      </label>
                    </div>
                  </div>

                  <div className="native-setting-card">
                    <div className="setting-card-left">
                      <div className="setting-card-icon-wrap">
                        <Bell size={18} />
                      </div>
                      <div className="setting-card-text">
                        <span className="setting-card-name">{t('settings.notifySound')}</span>
                        <span className="setting-card-desc">{t('settings.notifySoundDesc')}</span>
                      </div>
                    </div>
                    <div className="setting-card-control">
                      <label className="native-switch">
                        <input type="checkbox" checked={notifyPrefs.sound} onChange={(e) => setNotify({ sound: e.target.checked })} />
                        <span className="native-switch-track">
                          <span className="native-switch-thumb" />
                        </span>
                      </label>
                    </div>
                  </div>

                  <div className="native-setting-card">
                    <div className="setting-card-left">
                      <div className="setting-card-icon-wrap">
                        <Bell size={18} />
                      </div>
                      <div className="setting-card-text">
                        <span className="setting-card-name">{t('settings.notifyTest')}</span>
                        <span className="setting-card-desc">{t('settings.notifyTestDesc')}</span>
                      </div>
                    </div>
                    <div className="setting-card-control">
                      <button type="button" className="instances-ghost-btn" onClick={sendTestNotification}>{t('settings.notifyTestBtn')}</button>
                    </div>
                  </div>

                  {/* Launcher window while playing */}
                  <div className="native-setting-card">
                    <div className="setting-card-left">
                      <div className="setting-card-icon-wrap">
                        <Monitor size={18} />
                      </div>
                      <div className="setting-card-text">
                        <span className="setting-card-name">{t('settings.launchAction')}</span>
                        <span className="setting-card-desc">
                          {t('settings.launchActionDesc')}
                        </span>
                      </div>
                    </div>
                    <div className="setting-card-control">
                      <label className="native-switch">
                        <input
                          type="checkbox"
                          checked={prefs.launcherAction === 'minimize'}
                          onChange={(e) => updatePref({ launcherAction: e.target.checked ? 'minimize' : 'keep' })}
                        />
                        <span className="native-switch-track">
                          <span className="native-switch-thumb" />
                        </span>
                      </label>
                    </div>
                  </div>

                  {prefs.launcherAction === 'minimize' && (
                    <div className="native-setting-card">
                      <div className="setting-card-left">
                        <div className="setting-card-icon-wrap">
                          <Monitor size={18} />
                        </div>
                        <div className="setting-card-text">
                          <span className="setting-card-name">{t('settings.reopenOnExit')}</span>
                          <span className="setting-card-desc">
                            {t('settings.reopenOnExitDesc')}
                          </span>
                        </div>
                      </div>
                      <div className="setting-card-control">
                        <label className="native-switch">
                          <input
                            type="checkbox"
                            checked={prefs.reopenOnExit}
                            onChange={(e) => updatePref({ reopenOnExit: e.target.checked })}
                          />
                          <span className="native-switch-track">
                            <span className="native-switch-thumb" />
                          </span>
                        </label>
                      </div>
                    </div>
                  )}

                  {/* Keep Logs */}
                  <div className="native-setting-card">
                    <div className="setting-card-left">
                      <div className="setting-card-icon-wrap">
                        <Terminal size={18} />
                      </div>
                      <div className="setting-card-text">
                        <span className="setting-card-name">{t('settings.keepLogs')}</span>
                        <span className="setting-card-desc">{t('settings.keepLogsDesc')}</span>
                      </div>
                    </div>
                    <div className="setting-card-control">
                      <label className="native-switch">
                        <input
                          type="checkbox"
                          checked={prefs.keepLogs}
                          onChange={(e) => updatePref({ keepLogs: e.target.checked })}
                        />
                        <span className="native-switch-track">
                          <span className="native-switch-thumb" />
                        </span>
                      </label>
                    </div>
                  </div>
                </div>
              </div>

              {/* Data Directory */}
              <div className="settings-section-block">
                <div className="settings-section-title-wrap">
                  <span className="settings-section-title">{t('settings.dataFolder')}</span>
                  <div className="settings-section-line" />
                </div>
                <div className="settings-cards-stack">
                  <div className="native-setting-card is-vertical">
                    <div className="setting-card-left">
                      <div className="setting-card-icon-wrap">
                        <Folder size={18} />
                      </div>
                      <div className="setting-card-text">
                        <span className="setting-card-name">{t('settings.dataLocation')}</span>
                        <span className="setting-card-desc">
                          Stores your downloaded Minecraft packages, assets, profiles, and runtime
                          files.
                        </span>
                      </div>
                    </div>
                    <div className="native-code-input-wrap">
                      <input
                        type="text"
                        readOnly
                        value={dataDir || t('settings.defaultData')}
                        className="native-code-input"
                      />
                      <button
                        type="button"
                        className="native-btn-secondary"
                        onClick={handleCopyPath}
                        title="Copy folder path"
                      >
                        {copiedPath ? <Check size={14} /> : <Copy size={14} />}
                        <span>{copiedPath ? 'Copied' : 'Copy'}</span>
                      </button>
                      <button
                        type="button"
                        className="native-btn-primary"
                        onClick={handleOpenDataDir}
                        title="Open in File Explorer"
                      >
                        <Folder size={14} />
                        <span>Open Folder</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Updates & Software Delivery */}
              <div className="settings-section-block">
                <div className="settings-section-title-wrap">
                  <span className="settings-section-title">{t('settings.updates')}</span>
                  <div className="settings-section-line" />
                </div>
                <div className="settings-cards-stack">
                  <div className="native-setting-card is-wide">
                    <div className="setting-card-left">
                      <div className="setting-card-icon-wrap">
                        <RefreshCw size={18} />
                      </div>
                      <div className="setting-card-text">
                        <span className="setting-card-name">
                          Native Client Build v{buildVersion}
                        </span>
                        <span className="setting-card-desc">
                          Production release channel. Click to check for launcher updates.
                        </span>
                      </div>
                    </div>
                    <div className="setting-card-control">
                      <button
                        type="button"
                        className="native-btn-primary"
                        onClick={onOpenUpdater}
                      >
                        <RefreshCw size={14} />
                        <span>{t('settings.checkUpdates')}</span>
                      </button>
                    </div>
                  </div>

                  <div className="native-setting-card">
                    <div className="setting-card-left">
                      <div className="setting-card-icon-wrap">
                        <ShieldCheck size={18} />
                      </div>
                      <div className="setting-card-text">
                        <span className="setting-card-name">{t('settings.checkOnStartup')}</span>
                        <span className="setting-card-desc">
                          {t('settings.checkOnStartupDesc')}
                        </span>
                      </div>
                    </div>
                    <div className="setting-card-control">
                      <label className="native-switch">
                        <input
                          type="checkbox"
                          checked={updates.checkOnStartup}
                          onChange={(e) =>
                            changeUpdateSetting({ checkOnStartup: e.target.checked })
                          }
                        />
                        <span className="native-switch-track">
                          <span className="native-switch-thumb" />
                        </span>
                      </label>
                    </div>
                  </div>

                  <div className="native-setting-card">
                    <div className="setting-card-left">
                      <div className="setting-card-icon-wrap">
                        <History size={18} />
                      </div>
                      <div className="setting-card-text">
                        <span className="setting-card-name">
                          {t('settings.backgroundChecks')}
                        </span>
                        <span className="setting-card-desc">
                          {t('settings.backgroundChecksDesc')}
                        </span>
                      </div>
                    </div>
                    <div className="setting-card-control">
                      <label className="native-switch">
                        <input
                          type="checkbox"
                          checked={updates.backgroundChecks}
                          onChange={(e) =>
                            changeUpdateSetting({ backgroundChecks: e.target.checked })
                          }
                        />
                        <span className="native-switch-track">
                          <span className="native-switch-thumb" />
                        </span>
                      </label>
                    </div>
                  </div>

                  <div className="native-setting-card">
                    <div className="setting-card-left">
                      <div className="setting-card-icon-wrap">
                        <Zap size={18} />
                      </div>
                      <div className="setting-card-text">
                        <span className="setting-card-name">{t('settings.autoDownload')}</span>
                        <span className="setting-card-desc">
                          {t('settings.autoDownloadDesc')}
                        </span>
                      </div>
                    </div>
                    <div className="setting-card-control">
                      <label className="native-switch">
                        <input
                          type="checkbox"
                          checked={updates.autoDownload}
                          onChange={(e) => changeUpdateSetting({ autoDownload: e.target.checked })}
                        />
                        <span className="native-switch-track">
                          <span className="native-switch-thumb" />
                        </span>
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* ════ TAB: MINECRAFT & DISPLAY ════ */}
          {!searchResults && activeTab === 'minecraft' && (
            <>
              {/* Display & Window */}
              <div className="settings-section-block">
                <div className="settings-section-title-wrap">
                  <span className="settings-section-title">Window & Display</span>
                  <div className="settings-section-line" />
                </div>
                <div className="settings-cards-stack">
                  {/* Fullscreen Toggle */}
                  <div className="native-setting-card">
                    <div className="setting-card-left">
                      <div className="setting-card-icon-wrap">
                        <Monitor size={18} />
                      </div>
                      <div className="setting-card-text">
                        <span className="setting-card-name">{t('settings.fullscreen')}</span>
                        <span className="setting-card-desc">{t('settings.fullscreenDesc')}</span>
                      </div>
                    </div>
                    <div className="setting-card-control">
                      <label className="native-switch">
                        <input
                          type="checkbox"
                          checked={prefs.fullscreen}
                          onChange={(e) => updatePref({ fullscreen: e.target.checked })}
                        />
                        <span className="native-switch-track">
                          <span className="native-switch-thumb" />
                        </span>
                      </label>
                    </div>
                  </div>

                  {/* Resolution Presets */}
                  <div className="native-setting-card is-vertical">
                    <div className="setting-card-left">
                      <div className="setting-card-icon-wrap">
                        <Sliders size={18} />
                      </div>
                      <div className="setting-card-text">
                        <span className="setting-card-name">Default Window Dimensions</span>
                        <span className="setting-card-desc">
                          Target viewport size when launching instances in windowed mode.
                        </span>
                      </div>
                    </div>
                    <div className="resolution-presets-grid">
                      {RESOLUTION_PRESETS.map((res) => {
                        const isSelected =
                          prefs.resolutionWidth === res.w && prefs.resolutionHeight === res.h;
                        return (
                          <button
                            key={res.label}
                            type="button"
                            className={`resolution-card-btn ${isSelected ? 'is-active' : ''}`}
                            onClick={() =>
                              updatePref({ resolutionWidth: res.w, resolutionHeight: res.h })
                            }
                          >
                            <span className="resolution-label">{res.label}</span>
                            <span className="resolution-sub">{res.sub}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>

              {/* Memory Allocation */}
              <div className="settings-section-block">
                <div className="settings-section-title-wrap">
                  <span className="settings-section-title">Memory Allocation (RAM)</span>
                  <div className="settings-section-line" />
                </div>
                <div className="settings-cards-stack">
                  <div className="native-setting-card is-vertical">
                    <div className="setting-card-left">
                      <div className="setting-card-icon-wrap">
                        <Cpu size={18} />
                      </div>
                      <div className="setting-card-text">
                        <span className="setting-card-name">{t('settings.defaultMemory')}</span>
                        <span className="setting-card-desc">
                          {t('settings.defaultMemoryDesc')}. 4 GB to 6 GB is ideal for almost all
                          modpacks and vanilla setups.
                        </span>
                      </div>
                    </div>

                    <div className="ram-widget-container">
                      <GlobalMemory />
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* ════ TAB: JAVA & RUNTIME ════ */}
          {!searchResults && activeTab === 'java' && <JavaPanel />}

          {/* ════ TAB: STORAGE ════ */}
          {!searchResults && activeTab === 'storage' && (
            <div className="settings-section-block">
              <StoragePanel instances={instances} />
            </div>
          )}

          {/* ════ TAB: CHANGELOG ════ */}
          {!searchResults && activeTab === 'changelog' && (
            <div className="settings-section-block">
              <ChangelogPanel onOpenUpdater={onOpenUpdater} />
            </div>
          )}

          {/* ════ TAB: ABOUT NATIVE ════ */}
          {!searchResults && activeTab === 'about' && (
            <div className="settings-section-block">
              <div className="about-native-hero">
                <div className="about-hero-left">
                  <div className="about-logo-badge">
                    <Logo height={34} variant="mark" />
                  </div>
                  <div className="about-hero-titles">
                    <h3>Native Client</h3>
                    <p>Next-generation, high-performance Minecraft launcher & modpack platform.</p>
                  </div>
                </div>
                <div className="setting-card-control">
                  <button
                    type="button"
                    className="native-btn-primary"
                    onClick={onOpenUpdater}
                  >
                    <RefreshCw size={14} />
                    <span>Check Updates</span>
                  </button>
                </div>
              </div>

              <div className="settings-section-title-wrap" style={{ marginTop: '20px' }}>
                <span className="settings-section-title">Runtime & Platform Information</span>
                <div className="settings-section-line" />
              </div>

              <div className="about-info-grid">
                <div className="about-info-stat-card">
                  <span className="about-stat-label">Launcher Version</span>
                  <span className="about-stat-val">v{buildVersion}</span>
                </div>
                <div className="about-info-stat-card">
                  <span className="about-stat-label">Release Channel</span>
                  <span className="about-stat-val">Production (Stable)</span>
                </div>
                <div className="about-info-stat-card">
                  <span className="about-stat-label">Platform Architecture</span>
                  <span className="about-stat-val">
                    {window.navigator?.platform || 'Windows x64'}
                  </span>
                </div>
                <div className="about-info-stat-card">
                  <span className="about-stat-label">Theme Engine</span>
                  <span className="about-stat-val">OLED True Black (Hardware Accel)</span>
                </div>
              </div>

              <div className="settings-section-title-wrap" style={{ marginTop: '20px' }}>
                <span className="settings-section-title">Community & Support</span>
                <div className="settings-section-line" />
              </div>

              <div className="about-links-row">
                <button
                  type="button"
                  className="native-btn-secondary"
                  onClick={() =>
                    window.native?.openExternal
                      ? window.native.openExternal('https://discord.gg/Cb3DCf6G7a')
                      : window.open('https://discord.gg/Cb3DCf6G7a', '_blank')
                  }
                >
                  <ExternalLink size={14} />
                  <span>Discord</span>
                </button>
                <button
                  type="button"
                  className="native-btn-secondary"
                  onClick={() =>
                    window.native?.openExternal
                      ? window.native.openExternal('https://www.youtube.com/@native-client')
                      : window.open('https://www.youtube.com/@native-client', '_blank')
                  }
                >
                  <ExternalLink size={14} />
                  <span>YouTube</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
