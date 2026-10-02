import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Sparkles, Swords, Zap, Box } from 'lucide-react';
import { PRESETS } from '../instances/presets.js';
import Icon from '../../components/ui/Icon.jsx';
import NativeIcon from '../../components/ui/NativeIcon.jsx';
import ContextMenu from '../../components/ui/ContextMenu.jsx';
import { getClusterArt, INITIAL_CLUSTERS } from '../../data/versionsData.js';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import LaunchActionButton from '../launcher/LaunchActionButton.jsx';
import useIsInstalled from '../instances/useIsInstalled.js';
import HomeSidePanel from './HomeSidePanel.jsx';
import './HomeView.css';
import './HomeSelection.css';

import useVersionBanners from '../../lib/useVersionBanners.js';
const loadersOf = (instance) => instance?.mc_loader || instance?.loader || 'Vanilla';
const versionOf = (instance) => instance?.mc_version || instance?.version || '';

function greetingKey() {
  const hour = new Date().getHours();
  if (hour < 5) return 'home.greetingNight';
  if (hour < 12) return 'home.greetingMorning';
  if (hour < 18) return 'home.greetingAfternoon';
  return 'home.greetingEvening';
}

export default function HomeView({
  instances = [],
  selectedCluster,
  onSelectCluster,
  onOpenCluster,
  onOpenInstances,
  onOpenVersions,
  onCreateInstance,
  account,
  identity = null,
  onSwitchIdentity,
  launcherState,
  onLaunch,
  onKill
}) {
  useVersionBanners();
  const { t } = useI18n();
  const [contextMenu, setContextMenu] = useState(null);
  const railRef = useRef(null);
  const cardRefs = useRef({});

  // No premade "Create & Play" instances: with nothing created, Home shows an empty state.
  const isStarterMode = false;
  const [selectedStarterId, setSelectedStarterId] = useState(() => INITIAL_CLUSTERS[0]?.id || 'cluster-26-2-fabric');

  const cluster = useMemo(() => {
    if (selectedCluster) return selectedCluster;
    if (instances && instances.length > 0) return instances[0];
    if (isStarterMode) {
      return INITIAL_CLUSTERS.find((item) => item.id === selectedStarterId) || INITIAL_CLUSTERS[0] || null;
    }
    return null;
  }, [selectedCluster, instances, isStarterMode, selectedStarterId]);

  const backgroundArt = getClusterArt(cluster);
  const isInstalled = useIsInstalled(isStarterMode ? null : cluster, launcherState?.status);

  const activeIndex = useMemo(() => {
    if (isStarterMode) {
      return INITIAL_CLUSTERS.findIndex((item) => item.id === cluster?.id);
    }
    return instances.findIndex((item) => item.id === cluster?.id);
  }, [isStarterMode, instances, cluster]);

  /* ---- switching -------------------------------------------------- */

  const selectByOffset = (delta) => {
    const list = isStarterMode ? INITIAL_CLUSTERS : instances;
    if (!list.length) return;
    const base = activeIndex < 0 ? 0 : activeIndex;
    const next = Math.min(list.length - 1, Math.max(0, base + delta));
    const target = list[next];
    if (!target) return;
    if (isStarterMode) {
      setSelectedStarterId(target.id);
    } else if (target.id !== cluster?.id) {
      onSelectCluster(target.id);
    }
  };

  // Vertical wheel over the rail scrolls it sideways. Registered
  // manually because React attaches wheel listeners passively.
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return undefined;

    const onWheel = (event) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (rail.scrollWidth <= rail.clientWidth) return;
      event.preventDefault();
      rail.scrollLeft += event.deltaY * 1.15;
    };

    rail.addEventListener('wheel', onWheel, { passive: false });
    return () => rail.removeEventListener('wheel', onWheel);
  }, []);

  // Arrow keys switch the active instance from anywhere on the page.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        selectByOffset(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        selectByOffset(-1);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [instances, activeIndex, cluster, isStarterMode]);

  // Keep the active card in view when it changes.
  useEffect(() => {
    const card = cardRefs.current[cluster?.id];
    if (card?.scrollIntoView) {
      card.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }, [cluster?.id]);

  const isPlaying = (item) => launcherState?.status === 'running' && launcherState?.instanceId === item?.id;

  /* The premade cards create exactly the version and loader they show. */
  const createFromStarter = (starter) => {
    if (!starter) {
      onCreateInstance();
      return;
    }
    onCreateInstance({
      name: starter.name,
      version: starter.mc_version || starter.version,
      loader: starter.mc_loader || starter.loader || 'Fabric',
      preset: 'optimization',
      play: true
    });
  };

  const handleCardContextMenu = (e, targetCluster) => {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      title: `${versionOf(targetCluster)} ${loadersOf(targetCluster)}`,
      items: [
        { label: t('detail.overview'), icon: 'info-circle', action: () => onOpenCluster(targetCluster, 'overview') },
        { label: t('detail.logs'), icon: 'terminal', action: () => onOpenCluster(targetCluster, 'logs') },
        { label: t('detail.screenshots'), icon: 'eye', action: () => onOpenCluster(targetCluster, 'screenshots') },
        { label: t('detail.mods'), icon: 'code-snippet-02', action: () => onOpenCluster(targetCluster, 'mods') },
        { label: t('detail.shaders'), icon: 'paint-pour', action: () => onOpenCluster(targetCluster, 'shaders') },
        { label: t('detail.textures'), icon: 'colors', action: () => onOpenCluster(targetCluster, 'textures') },
        { label: t('common.settings'), icon: 'settings-02', action: () => onOpenCluster(targetCluster, 'settings') }
      ]
    });
  };

  return (
    <div className="home-view">
      {/* Wallpaper */}
      <div className="home-bg-layer">
        <img key={backgroundArt} src={backgroundArt} alt={cluster?.name || 'Minecraft'} className="home-bg-img" />
        <div className="home-bg-overlay" />
        <div className="home-bg-fade" />
      </div>

      <div className="home-stage">
      <div className="home-stage-main">
      {/* Greeting */}
      <div className="home-topbar">
        <div className="home-greeting">
          <span className="home-greeting-text">{t(greetingKey())}</span>
          <span className="home-greeting-name">{account?.name || t('home.guest')}</span>
        </div>

        {identity?.canSwitch && (
          <div className="identity-switch" role="group" aria-label="Play as">
            {[
              { id: 'premium', label: 'Premium', name: identity.premiumName, hint: 'Microsoft sign-in: works on online servers' },
              { id: 'noctra', label: 'Noctra', name: identity.noctraName, hint: 'Noctra profile and skins: offline session' }
            ].map((option) => (
              <button
                key={option.id}
                type="button"
                className={`identity-switch-btn ${identity.mode === option.id ? 'is-active' : ''}`}
                aria-pressed={identity.mode === option.id}
                disabled={Boolean(launcherState?.busy)}
                title={`${option.hint}${option.name ? ` (${option.name})` : ''}`}
                onClick={() => onSwitchIdentity?.(option.id)}
              >
                <i aria-hidden="true" />
                <span>{option.label}</span>
                {option.name && <small>{option.name}</small>}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Active instance + launch / Starter display */}
      <div className={`home-hero-content ${isStarterMode ? 'is-starter' : ''}`}>
        {isStarterMode ? (
          <>
            <div className="home-starter-tag-row">
              <span className="home-starter-badge">{cluster?.loader || 'Fabric'}</span>
              <span className="home-starter-badge is-subtle">{cluster?.version || cluster?.mc_version}</span>
              {cluster?.tags?.map((tag) => (
                <span key={tag} className="home-starter-pill">{tag}</span>
              ))}
            </div>

            <h1 className="home-cluster-title">
              {cluster?.name || versionOf(cluster)}
            </h1>
            <p className="home-cluster-subtitle">
              {cluster?.description || `${versionOf(cluster)} ${loadersOf(cluster)}`}
            </p>

            <div className="home-actions-row">
              <button
                type="button"
                className="home-starter-launch-btn"
                onClick={() => createFromStarter(cluster)}
              >
                <Plus size={16} strokeWidth={2.4} />
                <span>Create & Play</span>
              </button>

              <button
                type="button"
                className="cluster-settings-btn"
                onClick={onOpenVersions}
                title={t('home.allVersions')}
              >
                <NativeIcon name="download" size={20} />
              </button>
            </div>
          </>
        ) : cluster ? (
          <>
            <span className={`home-selected-tag ${isPlaying(cluster) ? 'is-playing' : ''}`}>
              <i aria-hidden="true" />
              {isPlaying(cluster) ? 'Playing now' : 'Selected instance'}
            </span>
            <h1 className="home-cluster-title">
              {versionOf(cluster)} {loadersOf(cluster)}
            </h1>
            <p className="home-cluster-subtitle">{cluster.name || 'Minecraft'}</p>

            <div className="home-actions-row">
              <LaunchActionButton
                instance={cluster}
                launcherState={launcherState}
                isInstalled={isInstalled}
                onLaunch={onLaunch}
                onKill={onKill}
              />

              <button
                className="cluster-settings-btn"
                onClick={() => onOpenCluster(cluster, 'overview')}
                title={t('home.options')}
              >
                <Icon name="settings-04" size={20} />
              </button>
            </div>
          </>
        ) : (
          <div className="home-empty-state">
            <h2 className="home-cluster-title">No instances yet</h2>
            <p className="home-cluster-subtitle">Create your first instance to pick a version, a mod loader and start playing.</p>
            <div className="home-actions-row">
              <button type="button" className="home-quick-btn is-primary" onClick={() => onCreateInstance()}>
                <Plus size={16} strokeWidth={2.2} />
                <span>{t('home.newInstance')}</span>
              </button>
            </div>

            <div className="home-empty-starts" role="group" aria-label="Quick start">
              <span className="home-empty-starts-label">Or start from a preset</span>
              <div className="home-empty-tiles">
                {PRESETS.map((preset) => {
                  const Icon = { optimization: Zap, pvp: Swords, visuals: Sparkles }[preset.id] || Box;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      className="home-empty-tile"
                      onClick={() => onCreateInstance({ preset: preset.id, loader: 'Fabric' })}
                    >
                      <span className="home-empty-tile-icon"><Icon size={18} strokeWidth={2} /></span>
                      <strong>{preset.name}</strong>
                      <small>{preset.tagline}</small>
                    </button>
                  );
                })}
                <button type="button" className="home-empty-tile" onClick={() => onCreateInstance({ loader: 'Vanilla' })}>
                  <span className="home-empty-tile-icon"><Box size={18} strokeWidth={2} /></span>
                  <strong>Vanilla</strong>
                  <small>Plain Minecraft, no mods</small>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      </div>

      {!isStarterMode && cluster && (
        <HomeSidePanel instances={instances} fallbackInstance={cluster} onLaunch={onLaunch} />
      )}
      </div>

      {instances.length > 0 && (
        <>
      {/* Instance switcher rail */}
      <div className={`home-recents-container ${isStarterMode ? 'is-starter-rail' : ''}`}>
        <div className="recents-head">
          <span className="recents-title">
            {isStarterMode ? 'Featured Releases' : t('home.yours')}
          </span>
          <span className="recents-hint">
            {isStarterMode ? 'Choose a release to preview, or create an instance' : t('home.switchHint')}
          </span>
          <span className="recents-counter">
            {isStarterMode
              ? `${activeIndex + 1} / ${INITIAL_CLUSTERS.length}`
              : `${activeIndex + 1} / ${instances.length}`}
          </span>
        </div>

        <div className="recents-rail-row">
          {(isStarterMode ? INITIAL_CLUSTERS.length > 1 : instances.length > 1) && (
            <button
              type="button"
              className="recents-rail-btn"
              onClick={() => selectByOffset(-1)}
              disabled={activeIndex <= 0}
              title={t('home.previous')}
            >
              <NativeIcon name="chevron-left" size={18} />
            </button>
          )}

          <div className="recents-scroll-track" ref={railRef}>
            {(isStarterMode ? INITIAL_CLUSTERS : instances).map((item) => {
              const isSelected = cluster?.id === item.id;
              const itemArt = getClusterArt(item);
              const title = isStarterMode
                ? `${item.name} (${item.mc_version})`
                : `${versionOf(item)} ${loadersOf(item)}`;
              const isLargeCard = isStarterMode || instances.length <= 2;

              return (
                <div
                  key={item.id}
                  ref={(element) => {
                    cardRefs.current[item.id] = element;
                  }}
                  className={`version-card ${isLargeCard ? 'is-large' : ''} ${isSelected ? 'active' : ''}`}
                  aria-current={isSelected ? 'true' : undefined}
                  onClick={() => {
                    if (isStarterMode) {
                      setSelectedStarterId(item.id);
                    } else {
                      onSelectCluster(item.id);
                    }
                  }}
                  onDoubleClick={() => {
                    if (isStarterMode) {
                      createFromStarter(item);
                    } else {
                      onOpenCluster(item, 'overview');
                    }
                  }}
                  onContextMenu={(e) => {
                    if (!isStarterMode) handleCardContextMenu(e, item);
                  }}
                >
                  <img src={itemArt} alt={title} className="version-card-bg" />
                  <div className="version-card-gradient" />
                  {isSelected && (
                    <span className={`version-card-selected ${!isStarterMode && isPlaying(item) ? 'is-playing' : ''}`}>
                      <i aria-hidden="true" />
                      {!isStarterMode && isPlaying(item) ? 'Playing' : 'Selected'}
                    </span>
                  )}
                  {isStarterMode && item.tags?.length > 0 && (
                    <div className="version-card-tags">
                      <span className="version-card-tag">{item.loader || 'Fabric'}</span>
                      <span className="version-card-tag">{item.tags[0]}</span>
                    </div>
                  )}
                  <div className="version-card-label" title={title}>
                    <span className="version-card-name">{item.name || title}</span>
                    <span className="version-card-sub">{isStarterMode ? `${item.mc_version} • ${item.loader}` : title}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {(isStarterMode ? INITIAL_CLUSTERS.length > 1 : instances.length > 1) && (
            <button
              type="button"
              className="recents-rail-btn"
              onClick={() => selectByOffset(1)}
              disabled={activeIndex >= (isStarterMode ? INITIAL_CLUSTERS.length - 1 : instances.length - 1)}
              title={t('home.next')}
            >
              <NativeIcon name="chevron-right" size={18} />
            </button>
          )}

          <button
            className="other-versions-tile"
            onClick={isStarterMode ? onOpenVersions : onOpenInstances}
            title={isStarterMode ? t('home.allVersions') : t('nav.instances')}
          >
            <Icon name="dots-grid" size={40} />
          </button>
        </div>
      </div>
        </>
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          title={contextMenu.title}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
