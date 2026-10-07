import React, { useEffect, useMemo, useRef, useState } from 'react';
import NativeIcon from '../../components/ui/NativeIcon.jsx';
import { getClusterArt } from '../../data/versionsData.js';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import { formatLaunchProgress } from '../launcher/useLauncher.js';
import LaunchActionButton from '../launcher/LaunchActionButton.jsx';
import fabricIcon from '../../assets/icons/fabric.png';
import forgeIcon from '../../assets/icons/forge.jpg';
import vanillaIcon from '../../assets/icons/vanilla.png';

import './InstancesView.css';


const DISK_CACHE_KEY = 'native.installedVersions.v1';
let diskCache = null;
function readDiskCache() {
  if (diskCache) return diskCache;
  try {
    const list = JSON.parse(window.localStorage.getItem(DISK_CACHE_KEY) || 'null');
    if (Array.isArray(list)) diskCache = new Set(list);
  } catch { /* no cache yet */ }
  return diskCache;
}
function writeDiskCache(keys) {
  diskCache = new Set(keys);
  try { window.localStorage.setItem(DISK_CACHE_KEY, JSON.stringify(keys)); } catch { /* storage off */ }
}
import useVersionBanners from '../../lib/useVersionBanners.js';
const SORTS = [
  { id: 'recent', key: 'instances.sortRecent' },
  { id: 'name', key: 'instances.sortName' },
  { id: 'created', key: 'instances.sortNewest' },
  { id: 'playtime', key: 'instances.sortPlayed' }
];

const LOADER_ICONS = {
  vanilla: vanillaIcon,
  fabric: fabricIcon,
  forge: forgeIcon
};

const LOADER_FILTERS = ['All', 'Vanilla', 'Fabric', 'Forge', 'NeoForge', 'Quilt'];

/* Approximate height of the card menu, used to decide whether it should
   open upwards so it never gets clipped by the bottom of the window. */
const CARD_MENU_HEIGHT = 292;

function versionOf(instance) {
  return instance?.mc_version || instance?.version || '';
}

function loaderOf(instance) {
  return instance?.mc_loader || instance?.loader || 'Vanilla';
}

function artOf(instance) {
  return getClusterArt(instance || {});
}

function relativeTime(value, formatRelativeTime, t) {
  if (!value) return t('instances.neverPlayed');
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return t('instances.neverPlayed');

  const seconds = Math.max(1, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return formatRelativeTime(0, 'second');

  const steps = [
    { limit: 3600, div: 60, unit: 'minute' },
    { limit: 86400, div: 3600, unit: 'hour' },
    { limit: 2592000, div: 86400, unit: 'day' },
    { limit: 31536000, div: 2592000, unit: 'month' }
  ];

  for (const step of steps) {
    if (seconds < step.limit) {
      const amount = Math.floor(seconds / step.div);
      return formatRelativeTime(-amount, step.unit);
    }
  }

  const years = Math.floor(seconds / 31536000);
  return formatRelativeTime(-years, 'year');
}

/** Reads whichever shape the launcher hook reports without assuming one. */
function readLauncher(state) {
  const id = state?.instanceId || state?.instance?.id || state?.clusterId || null;
  const status = state?.status || (state?.running ? 'running' : 'idle');
  const active = Boolean(id) && status !== 'idle' && status !== 'stopped' && status !== 'error';
  return { id, status, active };
}

export default function InstancesView({
  instances = [],
  selectedId,
  onSelect,
  onOpenCluster,
  onLaunch,
  onKill,
  launcherState,
  onOpenCreateModal,
  onUpdate,
  onDuplicate,
  onRemove,
  onNavigateBrowse,
  onNotify
}) {
  useVersionBanners();
  const { t, formatDuration, formatNumber, formatRelativeTime } = useI18n();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('recent');
  const [loaderFilter, setLoaderFilter] = useState('All');
  const [layout, setLayout] = useState('grid');


  const [sortOpen, setSortOpen] = useState(false);
  const [menuFor, setMenuFor] = useState(null);
  const [menuPlacement, setMenuPlacement] = useState('down');
  const [renaming, setRenaming] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);
  // Last known install list (kept across visits and restarts) so cards show Launch right away;
  // null = not known yet, treated as installed until the disk check answers.
  const [installedDiskKeys, setInstalledDiskKeys] = useState(readDiskCache);

  useEffect(() => {
    let cancelled = false;
    window.native?.instance?.installedVersions?.()
      .then((list) => {
        if (!cancelled && Array.isArray(list)) {
          const keys = list.map((v) => `${v.version}:${v.loader || 'Vanilla'}`);
          writeDiskCache(keys);
          setInstalledDiskKeys(new Set(keys));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [launcherState?.status]);

  const sortRef = useRef(null);
  const menuRef = useRef(null);

  const launcher = readLauncher(launcherState);

  /* Close the popovers on any outside click or Escape. */
  useEffect(() => {
    if (!sortOpen && !menuFor) return undefined;

    const onPointerDown = (event) => {
      if (sortRef.current?.contains(event.target)) return;
      if (menuRef.current?.contains(event.target)) return;
      setSortOpen(false);
      setMenuFor(null);
    };
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      setSortOpen(false);
      setMenuFor(null);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [sortOpen, menuFor]);

  /* A scroll or resize while the menu is open would move it away from the
     button, so just close it instead of letting it float. */
  useEffect(() => {
    if (!menuFor) return undefined;
    const close = () => setMenuFor(null);
    window.addEventListener('resize', close);
    return () => window.removeEventListener('resize', close);
  }, [menuFor]);

  const toggleCardMenu = (instance, event) => {
    event.stopPropagation();
    setSortOpen(false);

    if (menuFor === instance.id) {
      setMenuFor(null);
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const flip = spaceBelow < CARD_MENU_HEIGHT + 18 && spaceAbove > spaceBelow;

    setMenuPlacement(flip ? 'up' : 'down');
    setMenuFor(instance.id);
  };

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();

    const filtered = instances.filter((instance) => {
      if (loaderFilter !== 'All' && loaderOf(instance) !== loaderFilter) return false;
      if (!query) return true;
      const haystack = [instance.name, versionOf(instance), loaderOf(instance), ...(instance.tags || [])]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (sort === 'name') return String(a.name || '').localeCompare(String(b.name || ''));
      if (sort === 'playtime') return (b.playtimeSecs || 0) - (a.playtimeSecs || 0);
      if (sort === 'created') {
        return new Date(b.created || 0).getTime() - new Date(a.created || 0).getTime();
      }
      return new Date(b.lastPlayed || 0).getTime() - new Date(a.lastPlayed || 0).getTime();
    });

    return sorted;
  }, [instances, search, loaderFilter, sort]);

  const totalPlaytime = useMemo(
    () => instances.reduce((sum, instance) => sum + (instance.playtimeSecs || 0), 0),
    [instances]
  );

  const openFolder = async (instance) => {
    try {
      await window.native?.instance?.openFolder?.(instance.id);
    } catch {
      onNotify?.(t('instances.folderError'), t('instances.folderErrorBody', { name: instance.name }));
    }
  };

  const submitRename = () => {
    const next = renameValue.trim();
    if (!renaming) return;
    if (next && next !== renaming.name) {
      onUpdate?.(renaming.id, { name: next });
    }
    setRenaming(null);
  };

  const doDelete = () => {
    if (!confirmDelete) return;
    onRemove?.(confirmDelete.id);
    onNotify?.(t('instances.removed'), t('instances.removedBody', { name: confirmDelete.name }));
    setConfirmDelete(null);
  };

  const activeSort = SORTS.find((entry) => entry.id === sort) || SORTS[0];

  return (
    <div className="instances-view">
      <header className="instances-header">
        <div className="instances-heading-group">
          <h1 className="instances-title page-title">{t('nav.instances')}</h1>
          <p className="instances-subtitle">
            {instances.length === 0
              ? t('instances.getStarted')
              : t('instances.summary', { count: formatNumber(instances.length), duration: formatDuration(totalPlaytime) })}
          </p>
        </div>

        <div className="instances-header-actions">
          <button type="button" className="instances-brand-btn" onClick={onOpenCreateModal}>
            <NativeIcon name="plus" size={16} />
            <span>{t('instances.new')}</span>
          </button>
        </div>
      </header>

      {instances.length > 0 && (
        <div className="instances-toolbar">
          <label className="instances-search">
            <NativeIcon name="search" size={16} />
            <input
              type="text"
              value={search}
              placeholder={t('instances.search')}
              onChange={(event) => setSearch(event.target.value)}
            />
            {search && (
              <button
                type="button"
                className="instances-search-clear"
                onClick={() => setSearch('')}
                title={t('instances.clearSearch')}
              >
                <NativeIcon name="close" size={14} />
              </button>
            )}
          </label>

          <div className="instances-chips">
            {LOADER_FILTERS.map((option) => (
              <button
                key={option}
                type="button"
                className={`instances-chip ${loaderFilter === option ? 'active' : ''}`}
                onClick={() => setLoaderFilter(option)}
              >
                {option === 'All' ? t('instances.all') : option}
              </button>
            ))}
          </div>

          <div className="instances-toolbar-right">
            <div className="instances-sort" ref={sortRef}>
              <button
                type="button"
                className="instances-sort-btn"
                onClick={() => setSortOpen((value) => !value)}
              >
                <NativeIcon name="sort" size={15} />
                <span>{t(activeSort.key)}</span>
                <NativeIcon name="chevron-down" size={13} />
              </button>

              {sortOpen && (
                <div className="instances-popover">
                  {SORTS.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className={`instances-popover-item ${sort === entry.id ? 'active' : ''}`}
                      onClick={() => {
                        setSort(entry.id);
                        setSortOpen(false);
                      }}
                    >
                      <span>{t(entry.key)}</span>
                      {sort === entry.id && <NativeIcon name="check" size={13} />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="instances-layout-toggle">
              <button
                type="button"
                className={layout === 'grid' ? 'active' : ''}
                onClick={() => setLayout('grid')}
                title={t('instances.gridView')}
              >
                <NativeIcon name="grid" size={15} />
              </button>
              <button
                type="button"
                className={layout === 'list' ? 'active' : ''}
                onClick={() => setLayout('list')}
                title={t('instances.listView')}
              >
                <NativeIcon name="list" size={15} />
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="instances-body">
        {instances.length === 0 ? (
          <div className="instances-empty">
            <div className="instances-empty-icon">
              <NativeIcon name="cube" size={28} />
            </div>
            <h2>{t('home.empty')}</h2>
            <p>{t('instances.emptyBody')}</p>
            <button type="button" className="instances-brand-btn" onClick={onOpenCreateModal}>
              <NativeIcon name="plus" size={16} />
              <span>{t('instances.create')}</span>
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="instances-empty small">
            <NativeIcon name="search" size={22} />
            <h2>{t('instances.noMatch')}</h2>
            <p>{t('instances.noMatchBody')}</p>
          </div>
        ) : (
          <div className={`instances-grid is-${layout}`}>
            {visible.map((instance) => {
              const running = launcher.active && launcher.id === instance.id;
              const isSelected = selectedId === instance.id;
              const menuOpen = menuFor === instance.id;

              const isInstalledOnDisk = installedDiskKeys ? installedDiskKeys.has(`${versionOf(instance)}:${loaderOf(instance)}`) : true;

              return (
                <article
                  key={instance.id}
                  className={`instance-card ${isSelected ? 'is-selected selected' : ''} ${
                    running ? 'is-running running' : ''
                  } ${menuOpen ? 'menu-open' : ''}`}
                  tabIndex={0}
                  aria-label={`Manage ${instance.name}`}
                  onKeyDown={(event) => {
                    if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) {
                      event.preventDefault();
                      onSelect?.(instance.id);
                      onOpenCluster?.(instance);
                    }
                  }}
                  onClick={() => {
                    onSelect?.(instance.id);
                    onOpenCluster?.(instance);
                  }}
                >
                  <div className="instance-card-art">
                    <img src={artOf(instance)} alt="" draggable="false" />

                    {running && (
                      <span className="instance-card-live">
                        <NativeIcon name="dot" size={10} />
                        {launcher.status === 'running' ? t('instances.running') : formatLaunchProgress(launcherState, t)}
                      </span>
                    )}

                  </div>

                  <div className="instance-card-body">
                    <div className="instance-card-headline">
                      <h3 className="instance-card-name" title={instance.name}>
                        {instance.name}
                      </h3>

                      <div className="instance-card-quick-actions">
                        <button
                          type="button"
                          className="instance-card-settings-btn"
                          onClick={(event) => {
                            event.stopPropagation();
                            onSelect?.(instance.id);
                            onOpenCluster?.(instance, 'settings');
                          }}
                          title="Open instance settings"
                          aria-label={`Open settings for ${instance.name}`}
                        >
                          <NativeIcon name="settings" size={15} />
                        </button>

                        <div className="instance-card-menu-wrap" ref={menuOpen ? menuRef : null}>
                        <button
                          type="button"
                          className="instance-card-menu-btn"
                          onClick={(event) => toggleCardMenu(instance, event)}
                          title={t('instances.moreActions')}
                        >
                          <NativeIcon name="more-vertical" size={16} />
                        </button>

                        {menuOpen && (
                          <div
                            className={`instances-popover align-right ${
                              menuPlacement === 'up' ? 'drop-up' : ''
                            }`}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <button
                              type="button"
                              className="instances-popover-item"
                              onClick={() => {
                                setMenuFor(null);
                                onOpenCluster?.(instance, 'overview');
                              }}
                            >
                              <NativeIcon name="external-link" size={14} />
                              <span>{t('instances.open')}</span>
                            </button>
                            <button
                              type="button"
                              className="instances-popover-item"
                              onClick={() => {
                                setMenuFor(null);
                                onNavigateBrowse?.(instance);
                              }}
                            >
                              <NativeIcon name="compass" size={14} />
                              <span>{t('instances.addContent')}</span>
                            </button>
                            <button
                              type="button"
                              className="instances-popover-item"
                              onClick={() => {
                                setMenuFor(null);
                                openFolder(instance);
                              }}
                            >
                              <NativeIcon name="folder" size={14} />
                              <span>{t('instances.openFolder')}</span>
                            </button>

                            <div className="instances-popover-divider" />

                            <button
                              type="button"
                              className="instances-popover-item"
                              onClick={() => {
                                setMenuFor(null);
                                setRenameValue(instance.name || '');
                                setRenaming(instance);
                              }}
                            >
                              <NativeIcon name="edit" size={14} />
                              <span>{t('common.rename')}</span>
                            </button>
                            <button
                              type="button"
                              className="instances-popover-item"
                              onClick={() => {
                                setMenuFor(null);
                                onDuplicate?.(instance.id);
                              }}
                            >
                              <NativeIcon name="copy" size={14} />
                              <span>{t('common.duplicate')}</span>
                            </button>
                            <button
                              type="button"
                              className="instances-popover-item danger"
                              onClick={() => {
                                setMenuFor(null);
                                setConfirmDelete(instance);
                              }}
                            >
                              <NativeIcon name="trash" size={14} />
                              <span>{t('common.delete')}</span>
                            </button>
                          </div>
                        )}
                        </div>
                      </div>
                    </div>

                    <div className="instance-card-chips">
                      <span className="instance-chip mono">{versionOf(instance)}</span>
                      <span className="instance-chip brand">
                        {LOADER_ICONS[String(loaderOf(instance)).toLowerCase()] && (
                          <img
                            className="instance-chip-icon"
                            src={LOADER_ICONS[String(loaderOf(instance)).toLowerCase()]}
                            alt=""
                            draggable="false"
                          />
                        )}
                        {loaderOf(instance)}
                      </span>
                    </div>

                    <div className="instance-card-footer">
                      <div className="instance-card-stats">
                        <span title="Total playtime">
                          <NativeIcon name="clock" size={12} />
                          {formatDuration(instance.playtimeSecs || 0)}
                        </span>
                        <span>{relativeTime(instance.lastPlayed, formatRelativeTime, t)}</span>
                      </div>

                      <div
                        className="instance-card-launch"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <LaunchActionButton
                          instance={instance}
                          launcherState={running ? launcherState : null}
                          isInstalled={Boolean(isInstalledOnDisk)}
                          onLaunch={(target) => {
                            onSelect?.(target.id);
                            onLaunch?.(target);
                          }}
                          onKill={onKill}
                          size="md"
                          className={layout === 'list' ? 'is-icon-only' : ''}
                        />
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}

            <button type="button" className="instance-add-card" onClick={onOpenCreateModal}>
              <NativeIcon name="plus" size={24} />
              <span>{t('instances.new')}</span>
            </button>
          </div>
        )}
      </div>

      {renaming && (
        <div className="instances-dialog-backdrop" onClick={() => setRenaming(null)}>
          <div className="instances-dialog" onClick={(event) => event.stopPropagation()}>
            <h3>{t('instances.rename')}</h3>
            <input
              className="instances-dialog-input"
              type="text"
              value={renameValue}
              autoFocus
              maxLength={60}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submitRename();
                if (event.key === 'Escape') setRenaming(null);
              }}
            />
            <div className="instances-dialog-actions">
              <button type="button" className="instances-ghost-btn" onClick={() => setRenaming(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="instances-brand-btn"
                onClick={submitRename}
                disabled={!renameValue.trim()}
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="instances-dialog-backdrop" onClick={() => setConfirmDelete(null)}>
          <div className="instances-dialog" onClick={(event) => event.stopPropagation()}>
            <h3>{t('instances.delete')}</h3>
            <p className="instances-dialog-text">
              {t('instances.deleteConfirm', { name: confirmDelete.name })}
            </p>
            <div className="instances-dialog-actions">
              <button
                type="button"
                className="instances-ghost-btn"
                onClick={() => setConfirmDelete(null)}
              >
                {t('common.cancel')}
              </button>
              <button type="button" className="instances-danger-btn" onClick={doDelete}>
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
