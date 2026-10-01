import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Download, Play, Plus, Search, X, ChevronRight } from 'lucide-react';
import { ART_ASSETS, getClusterArt } from '../../data/versionsData.js';
import vanillaIcon from '../../assets/icons/vanilla.png';
import fabricIcon from '../../assets/icons/fabric.png';
import forgeIcon from '../../assets/icons/forge.jpg';
import './InstancePickerModal.css';

import useVersionBanners from '../../lib/useVersionBanners.js';
const LOADER_ICONS = {
  vanilla: vanillaIcon,
  fabric: fabricIcon,
  forge: forgeIcon
};

function ArtThumbnail({ src }) {
  const [url, setUrl] = useState(src);

  useEffect(() => {
    setUrl(src);
  }, [src]);

  return (
    <img
      className="instance-picker-thumb"
      src={url || ART_ASSETS.default}
      alt=""
      loading="lazy"
      draggable={false}
      onError={() => {
        if (url !== ART_ASSETS.default) setUrl(ART_ASSETS.default);
      }}
    />
  );
}

function instVersion(inst) {
  return inst.mc_version || inst.version || '';
}

function instLoader(inst) {
  return inst.mc_loader || inst.loader || 'Vanilla';
}

/* Optional install-time compatibility check for a chosen project/version.
   Returns { ok, versionOk, loaderOk } so the UI can say *why* it doesn't fit. */
function checkCompat(inst, compatFor) {
  const gameVersions = Array.isArray(compatFor.gameVersions) ? compatFor.gameVersions : [];
  const loaders = Array.isArray(compatFor.loaders) ? compatFor.loaders : [];
  const version = instVersion(inst);
  const loader = String(instLoader(inst)).toLowerCase();
  const versionOk = gameVersions.length === 0 || gameVersions.includes(version);
  const loaderOk =
    compatFor.contentType !== 'mod' ||
    loaders.length === 0 ||
    loaders.map((l) => String(l).toLowerCase()).includes(loader);
  return { ok: versionOk && loaderOk, versionOk, loaderOk };
}

function formatRam(memoryMb) {
  return memoryMb ? `${Math.round(memoryMb / 1024)} GB` : null;
}

export default function InstancePickerModal({
  open,
  mode = 'launch', // 'launch' | 'settings'
  version = '',
  loader = '',
  title = null,
  subtitle = null,
  actionLabel = null,
  instances = [],
  compatFor = null,
  onClose,
  onSelect,
  onCreateNew
}) {
  useVersionBanners();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all'); // 'all' | 'compatible'
  const searchRef = useRef(null);
  const listRef = useRef(null);

  // Reset transient state every time the picker is opened.
  useEffect(() => {
    if (!open) return undefined;
    setQuery('');
    setFilter('all');
    const id = window.setTimeout(() => searchRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  const rows = useMemo(() => {
    const list = instances.map((inst) => ({
      inst,
      compat: compatFor ? checkCompat(inst, compatFor) : null
    }));
    // Compatible instances float to the top; otherwise keep the caller's order.
    if (compatFor) {
      return list
        .map((row, index) => ({ row, index }))
        .sort((a, b) => Number(b.row.compat.ok) - Number(a.row.compat.ok) || a.index - b.index)
        .map(({ row }) => row);
    }
    return list;
  }, [instances, compatFor]);

  const compatibleCount = useMemo(() => rows.filter((r) => r.compat?.ok).length, [rows]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(({ inst, compat }) => {
      if (filter === 'compatible' && compat && !compat.ok) return false;
      if (!q) return true;
      return [inst.name, instVersion(inst), instLoader(inst)]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q));
    });
  }, [rows, query, filter]);

  if (!open) return null;

  const isSettings = mode === 'settings';
  const headerTitle = title || (isSettings ? 'Select Instance' : 'Launch Instance');
  const headerSub = subtitle || [version, loader].filter(Boolean).join(' \u2022 ');
  const verb = actionLabel || (isSettings ? 'Select' : 'Launch');
  const ActionIcon = /install/i.test(verb) ? Download : isSettings ? Check : Play;
  const showSearch = instances.length > 4;
  const showFilters = Boolean(compatFor) && instances.length > 0;

  const requirement = compatFor
    ? {
        versions: (compatFor.gameVersions || []).slice(),
        loaders: compatFor.contentType === 'mod' ? (compatFor.loaders || []).slice() : []
      }
    : null;

  const onListKeyDown = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = Array.from(listRef.current?.querySelectorAll('.instance-picker-item') || []);
    if (items.length === 0) return;
    e.preventDefault();
    const current = items.indexOf(document.activeElement?.closest?.('.instance-picker-item'));
    const next =
      e.key === 'ArrowDown'
        ? items[Math.min(items.length - 1, current + 1)]
        : items[current <= 0 ? 0 : current - 1];
    next?.focus();
  };

  const onSearchKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      listRef.current?.querySelector('.instance-picker-item')?.focus();
    } else if (e.key === 'Enter' && visible.length === 1) {
      onSelect?.(visible[0].inst);
    }
  };

  return (
    <div
      className="instance-picker-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={headerTitle}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className="instance-picker-box">
        {/* Header */}
        <div className="instance-picker-header">
          <div className="instance-picker-header-title">
            <span className="instance-picker-title">{headerTitle}</span>
            {headerSub && <span className="instance-picker-sub">{headerSub}</span>}
          </div>
          <button type="button" className="instance-picker-close-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {/* Requirement chips: what the content needs */}
        {requirement && (requirement.versions.length > 0 || requirement.loaders.length > 0) && (
          <div className="instance-picker-requires">
            <span className="instance-picker-requires-label">Works with</span>
            {requirement.versions.length > 0 && (
              <span className="instance-picker-chip" title={requirement.versions.join(', ')}>
                {requirement.versions.length > 3
                  ? `${requirement.versions[requirement.versions.length - 1]} +${requirement.versions.length - 1}`
                  : requirement.versions.join(', ')}
              </span>
            )}
            {requirement.loaders.slice(0, 4).map((l) => (
              <span key={l} className="instance-picker-chip is-loader">
                {String(l).charAt(0).toUpperCase() + String(l).slice(1)}
              </span>
            ))}
          </div>
        )}

        {/* Search + filters */}
        {(showSearch || showFilters) && (
          <div className="instance-picker-toolbar">
            {showSearch && (
              <label className="instance-picker-search">
                <Search size={15} />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  placeholder="Search instances"
                  spellCheck={false}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onSearchKeyDown}
                />
                {query && (
                  <button
                    type="button"
                    className="instance-picker-search-clear"
                    onClick={() => {
                      setQuery('');
                      searchRef.current?.focus();
                    }}
                    aria-label="Clear search"
                  >
                    <X size={13} />
                  </button>
                )}
              </label>
            )}
            {showFilters && (
              <div className="instance-picker-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'all'}
                  className={`instance-picker-tab ${filter === 'all' ? 'is-active' : ''}`}
                  onClick={() => setFilter('all')}
                >
                  All <span>{rows.length}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'compatible'}
                  className={`instance-picker-tab ${filter === 'compatible' ? 'is-active' : ''}`}
                  onClick={() => setFilter('compatible')}
                >
                  Compatible <span>{compatibleCount}</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* List */}
        <div className="instance-picker-list" ref={listRef} onKeyDown={onListKeyDown}>
          {instances.length === 0 ? (
            <div className="instance-picker-empty">
              <strong>No instances yet</strong>
              <span>Create an instance first, then install content into it.</span>
            </div>
          ) : visible.length === 0 ? (
            <div className="instance-picker-empty">
              <strong>{filter === 'compatible' && !query ? 'No compatible instances' : 'No matches'}</strong>
              <span>
                {filter === 'compatible' && !query
                  ? 'None of your instances match this content. Show all to install anyway.'
                  : 'Try a different name, version or loader.'}
              </span>
            </div>
          ) : (
            visible.map(({ inst, compat }) => {
              const art = getClusterArt(inst);
              const loaderName = instLoader(inst);
              const loaderIcon = LOADER_ICONS[String(loaderName).toLowerCase()];
              const ram = formatRam(inst.memoryMb);
              const mismatch = compat && !compat.ok;
              const reason = mismatch
                ? !compat.versionOk && !compat.loaderOk
                  ? 'Different version & loader'
                  : !compat.versionOk
                    ? 'Different game version'
                    : 'Different loader'
                : null;

              return (
                <div
                  key={inst.id}
                  className={`instance-picker-item ${mismatch ? 'is-mismatch' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect?.(inst)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect?.(inst);
                    }
                  }}
                >
                  <div className="instance-picker-item-thumb-wrap">
                    <ArtThumbnail src={art} />
                  </div>

                  <div className="instance-picker-item-info">
                    <span className="instance-picker-item-name" title={inst.name}>
                      {inst.name}
                    </span>
                    <span className="instance-picker-item-meta">
                      {loaderIcon && <img className="instance-picker-loader-icon" src={loaderIcon} alt="" />}
                      <span>{loaderName}</span>
                      {instVersion(inst) && (
                        <>
                          <i aria-hidden="true" />
                          <span>{instVersion(inst)}</span>
                        </>
                      )}
                      {ram && (
                        <>
                          <i aria-hidden="true" />
                          <span className="instance-picker-item-ram">{ram}</span>
                        </>
                      )}
                    </span>
                    {compat && (
                      <span className={`instance-picker-compat ${compat.ok ? 'is-match' : 'is-mismatch'}`}>
                        {compat.ok ? (
                          <>
                            <Check size={11} /> Compatible
                          </>
                        ) : (
                          <>
                            <AlertTriangle size={11} /> {reason}
                          </>
                        )}
                      </span>
                    )}
                  </div>

                  <span className={`instance-picker-action ${mismatch ? 'is-ghost' : ''}`}>
                    <ActionIcon size={14} />
                    {verb}
                  </span>
                  <ChevronRight size={14} className="instance-picker-arrow" aria-hidden="true" />
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        {(onCreateNew || instances.length > 0) && (
          <div className="instance-picker-footer">
            <span className="instance-picker-count">
              {instances.length} instance{instances.length === 1 ? '' : 's'}
            </span>
            {onCreateNew && (
              <button type="button" className="instance-picker-new-btn" onClick={onCreateNew}>
                <Plus size={14} />
                <span>New instance</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
