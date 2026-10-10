import React, { useEffect, useMemo, useRef, useState } from 'react';
import NativeIcon from '../../components/ui/NativeIcon.jsx';
import Dropdown from '../../components/ui/Dropdown.jsx';
import LaunchActionButton from '../launcher/LaunchActionButton.jsx';
import useIsInstalled from '../instances/useIsInstalled.js';
import SettingsTab from './SettingsTab.jsx';
import InstanceContentTab from './InstanceContentTab.jsx';
import ScreenshotManager from './ScreenshotManager.jsx';
import ConsoleTab from './ConsoleTab.jsx';
import LoaderTab from './LoaderTab.jsx';
import { formatPlaytime } from '../instances/playtimeStats.js';
import { getClusterArt } from '../../data/versionsData.js';
import './ClusterDetailView.css';
import './InstanceManager.css';

import useVersionBanners from '../../lib/useVersionBanners.js';
const TAB_META = {
  mods: { title: 'Mods', icon: 'type-mod', folder: 'mods', search: 'Find a mod…' },
  shaders: { title: 'Shaders', icon: 'type-shader', folder: 'shaderpacks', search: 'Find a shader…' },
  worlds: { title: 'Worlds', icon: 'globe', folder: 'saves', search: 'Find a world…' },
  screenshots: { title: 'Screenshots', icon: 'camera', folder: 'screenshots', search: 'Find a screenshot…' },
  textures: { title: 'Resource packs', icon: 'type-resourcepack', folder: 'resourcepacks', search: 'Find a resource pack…' },
  loader: { title: 'Mod loader', icon: 'layers', folder: '', search: 'Find a version…' },
  console: { title: 'Console', icon: 'code', folder: 'logs', search: 'Filter output…' },
  settings: { title: 'Advanced', icon: 'sliders', folder: '', search: 'Search settings…' }
};

export default function ClusterDetailView({
  cluster,
  instances = [],
  onSelectCluster,
  onBack,
  guardRef = null,
  onLaunch,
  onKill,
  launcherState,
  onUpdateCluster,
  onUpdateInstance,
  social,
  account,
  onNavigateBrowse,
  onAnalyzeCrash,
  onOpenCrashReport,
  initialTab = 'overview'
}) {
  useVersionBanners();
  const loader = cluster.mc_loader || cluster.loader || 'Vanilla';
  const vanilla = loader.toLowerCase() === 'vanilla';

  // Default tab: 'mods' for modded instances, 'worlds' for vanilla
  const [tab, setTab] = useState(() => {
    if (initialTab === 'overview') return vanilla ? 'worlds' : 'mods';
    return initialTab;
  });

  const [query, setQuery] = useState('');
  const [filtered, setFiltered] = useState(false);
  const [notice, setNotice] = useState(null);
  const noticeTimerRef = useRef(null);

  const isInstalled = useIsInstalled(cluster, launcherState?.status);
  const isThisRunning =
    (launcherState?.instanceId || launcherState?.instance?.id || launcherState?.clusterId) === cluster.id;

  const showNotice = (title, body) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    const payload = body ? { title, body } : { title: '', body: title };
    setNotice(payload);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 4000);
  };

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const [dirty, setDirty] = useState(false);
  const dialog = useRef(null);
  const closeRef = useRef(null);

  const confirmDiscard = () => !dirty || window.confirm('Discard unsaved instance settings?');
  closeRef.current = () => {
    if (confirmDiscard()) onBack();
  };
  // The shell asks before switching tabs away from this page.
  if (guardRef) guardRef.current = confirmDiscard;
  useEffect(() => () => { if (guardRef) guardRef.current = null; }, [guardRef]);

  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus();

    const handleKey = (event) => {
      const nested = dialog.current?.querySelector(
        '.dep-prompt-backdrop, .mvp-backdrop, .content-modal-backdrop, .sm-dialog-backdrop, .browse-lightbox-backdrop, .browse-confirm-backdrop'
      );
      // A crash report or app dialog above this page owns Escape.
      const above = document.querySelector('.crash-overlay, .settings-modal-backdrop, .create-instance-backdrop');
      if (event.key === 'Escape' && !nested && !above) {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
      // Full page, not a modal: only keep Tab inside an open nested dialog.
      if (event.key !== 'Tab' || !nested) return;
      const focusable = [...(nested || dialog.current).querySelectorAll(
        'button, input, select, textarea, [tabindex="0"], a[href]'
      )].filter((el) => !el.matches(':disabled') && el.getClientRects().length);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('keydown', handleKey, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  /* Content sections. Vanilla instances cannot load mods or shaders, so those
     entries are never offered instead of being offered and then refused. */
  const contentTabs = useMemo(
    () => [
      ...(!vanilla ? ['mods', 'shaders'] : []),
      'worlds',
      'screenshots',
      'textures'
    ],
    [vanilla]
  );

  const meta = TAB_META[tab] || TAB_META.worlds;

  const openFolder = async () => {
    try {
      await window.native.instance.openFolder(cluster.id, meta.folder);
    } catch (error) {
      showNotice('Could not open folder', error.message);
    }
  };

  const switchTab = (id) => {
    setTab(id);
    setQuery('');
    setFiltered(false);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    setNotice(null);
  };

  const handleNavKeyDown = (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const order = [...contentTabs, 'loader', 'console', 'settings'];
    const index = order.indexOf(tab);
    const next = order[(index + (event.key === 'ArrowDown' ? 1 : -1) + order.length) % order.length];
    switchTab(next);
  };

  const filterLabel =
    tab === 'settings'
      ? 'Show enabled overrides only'
      : 'Sort alphabetically';

  const playtimeSeconds = cluster.totalPlaytime || cluster.playtime || 0;
  const playtimeLabel = formatPlaytime(playtimeSeconds);

  return (
    <div className="instance-manager-backdrop is-page">
      <section
        className="instance-manager"
        role="region"
        aria-label={`Manage ${cluster.name || cluster.version}`}
        tabIndex={-1}
        ref={dialog}
      >
        <button
          className="im-close"
          aria-label="Close instance settings"
          onClick={() => closeRef.current()}
        >
          <NativeIcon name="close" size={16} />
        </button>

        {/* Sidebar */}
        <aside className="im-sidebar">
          {/* Identity: art, name and loader badges read as one object */}
          <div className="im-identity-block">
            <div className="im-identity-banner-wrap">
              <img
                src={getClusterArt(cluster)}
                alt=""
                className="im-identity-banner"
                draggable={false}
              />
              <span className={`im-state-pill${isThisRunning ? ' is-live' : ''}`}>
                <span className="im-state-dot" aria-hidden="true" />
                {isThisRunning ? 'Running' : 'Idle'}
              </span>
            </div>

            <div className="im-identity-overlay-meta">
              <h2 className="im-identity-title" title={cluster.name}>
                {cluster.name}
              </h2>
              <div className="im-identity-badges">
                <span className="im-badge-version">{cluster.mc_version || cluster.version}</span>
                <span className={`im-badge-loader is-${loader.toLowerCase().replace(/\s+/g, '-')}`}>{loader}</span>
                <span className="im-identity-stat" title="Total playtime">
                  <NativeIcon name="clock" size={12} className="im-stat-icon" />
                  <span>{playtimeLabel}</span>
                </span>
              </div>
            </div>

            <LaunchActionButton
              className="im-launch"
              instance={cluster}
              launcherState={isThisRunning ? launcherState : null}
              isInstalled={isInstalled}
              onLaunch={onLaunch}
              onKill={onKill}
              size="sm"
            />
          </div>

          {/* Instance switcher */}
          {instances.length > 1 && (
            <div className="im-version">
              <span className="im-version-label">Switch instance</span>
              <div className="im-version-selector">
                <Dropdown
                  className="im-version-dropdown"
                  value={cluster.id}
                  options={instances.map((item) => ({
                    value: item.id,
                    label: `${item.mc_version || item.version}${
                      instances.filter(
                        (i) => (i.mc_version || i.version) === (item.mc_version || item.version)
                      ).length > 1
                        ? ` · ${item.name}`
                        : ''
                    }`
                  }))}
                  onChange={(val) => {
                    if (confirmDiscard()) onSelectCluster?.(val);
                  }}
                />
              </div>
            </div>
          )}

          {/* Navigation */}
          <nav className="im-nav-list" aria-label="Instance sections" onKeyDown={handleNavKeyDown}>
            <span className="im-nav-group-label">Content</span>
            {contentTabs.map((id) => (
              <button
                key={id}
                className={`im-nav ${tab === id ? 'active' : ''} im-nav-${id}`}
                aria-current={tab === id ? 'page' : undefined}
                onClick={() => switchTab(id)}
              >
                <NativeIcon name={TAB_META[id].icon} size={16} className="im-nav-icon" />
                <span className="im-nav-text">{TAB_META[id].title}</span>
              </button>
            ))}
          </nav>

          <div className="im-sidebar-footer">
            <span className="im-nav-group-label">Instance</span>
            <button
              className={`im-nav im-nav-loader ${tab === 'loader' ? 'active' : ''}`}
              aria-current={tab === 'loader' ? 'page' : undefined}
              onClick={() => switchTab('loader')}
            >
              <NativeIcon name="layers" size={16} className="im-nav-icon" />
              <span className="im-nav-text">Mod loader</span>
            </button>
            <button
              className={`im-nav im-nav-console ${tab === 'console' ? 'active' : ''}`}
              aria-current={tab === 'console' ? 'page' : undefined}
              onClick={() => switchTab('console')}
            >
              <NativeIcon name="code" size={16} className="im-nav-icon" />
              <span className="im-nav-text">Console</span>
              {isThisRunning && launcherState?.status === 'running' && <span className="im-nav-live" aria-label="Live" />}
            </button>
            <button
              className={`im-nav im-nav-settings ${tab === 'settings' ? 'active' : ''}`}
              aria-current={tab === 'settings' ? 'page' : undefined}
              onClick={() => switchTab('settings')}
            >
              <NativeIcon name="sliders" size={16} className="im-nav-icon" />
              <span className="im-nav-text">Advanced</span>
            </button>
            {onAnalyzeCrash && (
              <button
                className="im-nav im-nav-crash"
                onClick={() => onAnalyzeCrash(cluster)}
                title="Diagnose the last crash of this instance"
              >
                <NativeIcon name="bug" size={16} className="im-nav-icon" />
                <span className="im-nav-text">Crash analyzer</span>
              </button>
            )}
          </div>
        </aside>

        {/* Main */}
        <main className="im-main">
          <div className="im-toolbar">
            <div className="im-toolbar-title">
              <NativeIcon name={meta.icon} size={16} className="im-toolbar-title-icon" />
              <h3>{meta.title}</h3>
            </div>

            <label className="im-search">
              <NativeIcon name="search" size={14} className="im-search-icon" />
              <input
                aria-label="Search instance content"
                placeholder={meta.search}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query && (
                <button
                  type="button"
                  className="im-search-clear"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                >
                  <NativeIcon name="close" size={12} />
                </button>
              )}
            </label>

            <div className="im-toolbar-actions">
              {tab !== 'mods' && tab !== 'console' && tab !== 'loader' && (
                <button
                  className={`im-toolbar-btn ${filtered ? 'is-active' : ''}`}
                  title={filterLabel}
                  aria-label={filterLabel}
                  aria-pressed={filtered}
                  onClick={() => setFiltered(!filtered)}
                >
                  <NativeIcon name="filter" size={16} />
                </button>
              )}
              {meta.folder && (
                <button
                  className="im-toolbar-btn"
                  title="Open folder"
                  aria-label="Open folder"
                  onClick={openFolder}
                >
                  <NativeIcon name="folder-open" size={16} />
                </button>
              )}
            </div>
          </div>

          {['mods', 'shaders', 'textures', 'worlds'].includes(tab) && (
            <InstanceContentTab
              key={tab}
              cluster={cluster}
              type={tab}
              query={query}
              filtered={filtered}
              onBrowse={
                onNavigateBrowse
                  ? (contentType) => {
                      if (confirmDiscard()) onNavigateBrowse(cluster, contentType);
                    }
                  : undefined
              }
            />
          )}

          {tab === 'console' && (
            <ConsoleTab
              cluster={cluster}
              query={query}
              running={isThisRunning && ['running', 'launching', 'stopping'].includes(launcherState?.status)}
              onAnalyzeCrash={onAnalyzeCrash}
              onOpenCrashReport={onOpenCrashReport}
              onNotify={showNotice}
            />
          )}

          {tab === 'loader' && (
            <LoaderTab
              cluster={cluster}
              query={query}
              running={isThisRunning && ['running', 'launching', 'stopping', 'preparing', 'downloading'].includes(launcherState?.status)}
              onUpdateInstance={onUpdateInstance}
              onNotify={showNotice}
            />
          )}

          {tab === 'screenshots' && (
            <ScreenshotManager
              cluster={cluster}
              query={query}
              sortAlphabetically={filtered}
              social={social}
              account={account}
              onNotify={showNotice}
            />
          )}

          <div className="im-settings-host" hidden={tab !== 'settings'}>
            <SettingsTab
              cluster={cluster}
              onUpdateCluster={onUpdateCluster}
              query={query}
              enabledOnly={filtered}
              onDirtyChange={setDirty}
            />
          </div>

          {notice && (
            <div className="im-toast" role="status">
              <div className="im-toast-icon">
                <NativeIcon name="check-circle" size={16} />
              </div>
              <div className="im-toast-content">
                {notice.title && <strong className="im-toast-title">{notice.title}</strong>}
                <span className="im-toast-body">{notice.body}</span>
              </div>
              <button
                type="button"
                className="im-toast-dismiss"
                aria-label="Dismiss message"
                onClick={() => {
                  if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
                  setNotice(null);
                }}
              >
                <NativeIcon name="close" size={14} />
              </button>
            </div>
          )}
        </main>
      </section>
    </div>
  );
}
