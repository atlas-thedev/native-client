import React, { useEffect, useMemo, useRef, useState } from 'react';
import NativeIcon from '../../../components/ui/NativeIcon.jsx';
import { primaryFile } from '../api/modrinthApi.js';
import './ModpackVersionPrompt.css';

function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff) return diff;
  }
  return String(b).localeCompare(String(a));
}

function publishedAt(version) {
  const time = new Date(version?.date_published || 0).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function formatDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatRelative(value) {
  const time = new Date(value || 0).getTime();
  if (!time || Number.isNaN(time)) return null;
  const days = Math.floor((Date.now() - time) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.round(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (!value) return null;
  if (value >= 1073741824) return `${(value / 1073741824).toFixed(1)} GB`;
  if (value >= 1048576) return `${(value / 1048576).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

const CHANNELS = [
  { value: 'all', label: 'All' },
  { value: 'release', label: 'Release' },
  { value: 'beta', label: 'Beta' },
  { value: 'alpha', label: 'Alpha' }
];

/**
 * Modpack version selector.
 *
 * The fast path is the top: the newest build is pre-selected and surfaced as a
 * recommended card, so "just install the latest" is one click. Everything else
 * — Minecraft version rail, channel filters, search — is progressive
 * refinement for players who want an older or pre-release build.
 */
export default function ModpackVersionPrompt({ prompt, onConfirm, onCancel }) {
  const { project, versions = [] } = prompt || {};

  // Newest first, so "latest" is always index 0 of whatever is on screen.
  const ordered = useMemo(
    () => [...versions].sort((a, b) => publishedAt(b) - publishedAt(a)),
    [versions]
  );

  const latest = useMemo(
    () => ordered.find((v) => (v.version_type || 'release') === 'release') || ordered[0] || null,
    [ordered]
  );

  const [mcVersion, setMcVersion] = useState('all');
  const [channel, setChannel] = useState('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(() => latest?.id || null);

  const listRef = useRef(null);
  const searchRef = useRef(null);

  const mcVersions = useMemo(() => {
    const counts = new Map();
    ordered.forEach((version) => {
      (version.game_versions || []).forEach((gv) => {
        if (gv) counts.set(gv, (counts.get(gv) || 0) + 1);
      });
    });
    return Array.from(counts.entries())
      .sort((a, b) => compareVersions(a[0], b[0]))
      .map(([value, count]) => ({ value, count }));
  }, [ordered]);

  const channelCounts = useMemo(() => {
    const counts = { all: ordered.length, release: 0, beta: 0, alpha: 0 };
    ordered.forEach((v) => {
      const type = v.version_type || 'release';
      if (counts[type] != null) counts[type] += 1;
    });
    return counts;
  }, [ordered]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return ordered.filter((version) => {
      if (mcVersion !== 'all' && !(version.game_versions || []).includes(mcVersion)) return false;
      if (channel !== 'all' && (version.version_type || 'release') !== channel) return false;
      if (!needle) return true;
      const haystack = [
        version.name,
        version.version_number,
        (version.game_versions || []).join(' '),
        (version.loaders || []).join(' ')
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [ordered, mcVersion, channel, query]);

  const isDefaultView = mcVersion === 'all' && channel === 'all' && !query.trim();
  const recommended = isDefaultView ? latest : null;
  const rows = recommended ? filtered.filter((v) => v.id !== recommended.id) : filtered;

  const selected =
    filtered.find((version) => version.id === selectedId) ||
    (recommended && recommended.id === selectedId ? recommended : null);

  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!filtered.some((version) => version.id === selectedId)) {
      setSelectedId(filtered[0].id);
    }
  }, [filtered, selectedId]);

  const move = (delta) => {
    const order = recommended ? [recommended, ...rows] : rows;
    if (order.length === 0) return;
    const index = order.findIndex((version) => version.id === selectedId);
    const next = Math.min(order.length - 1, Math.max(0, (index < 0 ? 0 : index) + delta));
    const target = order[next];
    setSelectedId(target.id);
    listRef.current
      ?.querySelector(`[data-version-id="${target.id}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  };

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel?.();
        return;
      }
      if (event.key === '/' && document.activeElement !== searchRef.current) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        move(1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        move(-1);
        return;
      }
      if (event.key === 'Enter' && selectedId) {
        event.preventDefault();
        onConfirm?.(selectedId);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  if (!project || versions.length === 0) return null;

  const selectedFile = selected ? primaryFile(selected) : null;
  const selectedSize = formatSize(selectedFile?.size);
  const selectedIsLatest = Boolean(selected && latest && selected.id === latest.id);

  const resetFilters = () => {
    setQuery('');
    setChannel('all');
    setMcVersion('all');
  };

  const renderRow = (version, { featured = false } = {}) => {
    const isSelected = version.id === selectedId;
    const type = version.version_type || 'release';
    const date = formatDate(version.date_published);
    const size = formatSize(primaryFile(version)?.size);
    const gameVersions = version.game_versions || [];
    return (
      <button
        key={version.id}
        type="button"
        role="radio"
        aria-checked={isSelected}
        data-version-id={version.id}
        className={`mvp-row${isSelected ? ' is-selected' : ''}${featured ? ' is-featured' : ''}`}
        onClick={() => setSelectedId(version.id)}
        onDoubleClick={() => onConfirm?.(version.id)}
      >
        <span className="mvp-radio" aria-hidden="true">
          <span className="mvp-radio-dot" />
        </span>

        <span className="mvp-row-main">
          <span className="mvp-row-title">
            <span className="mvp-row-name">{version.name || version.version_number}</span>
            {featured ? (
              <span className="mvp-badge-latest">
                <NativeIcon name="check" size={10} strokeWidth={3} />
                Latest
              </span>
            ) : null}
            <span className={`mvp-channel is-${type}`}>{type}</span>
          </span>
          <span className="mvp-row-meta">
            <span className="mvp-row-mc">{gameVersions.slice(0, 3).join(', ') || 'Unknown'}</span>
            {gameVersions.length > 3 ? (
              <span className="mvp-row-more">+{gameVersions.length - 3}</span>
            ) : null}
            <span className="mvp-sep" aria-hidden="true">·</span>
            <span>{(version.loaders || []).join(', ') || 'fabric'}</span>
            {date ? (
              <>
                <span className="mvp-sep" aria-hidden="true">·</span>
                <span>{date}</span>
              </>
            ) : null}
            {size ? (
              <>
                <span className="mvp-sep" aria-hidden="true">·</span>
                <span>{size}</span>
              </>
            ) : null}
          </span>
        </span>

        <span className="mvp-row-check" aria-hidden="true">
          <NativeIcon name="check" size={13} strokeWidth={2.6} />
        </span>
      </button>
    );
  };

  return (
    <div className="mvp-backdrop" onMouseDown={onCancel} role="presentation">
      <div
        className="mvp-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mvp-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="mvp-header">
          <div className="mvp-identity">
            {project.icon_url ? (
              <img src={project.icon_url} alt="" className="mvp-icon" />
            ) : (
              <span className="mvp-icon mvp-icon-fallback">
                <NativeIcon name="type-modpack" size={22} />
              </span>
            )}
            <div className="mvp-identity-text">
              <h3 id="mvp-title" className="mvp-title">
                {project.title}
              </h3>
              <p className="mvp-subtitle">
                {versions.length} build{versions.length === 1 ? '' : 's'} available
                {latest ? ` · updated ${formatRelative(latest.date_published) || 'recently'}` : ''}
              </p>
            </div>
          </div>

          <button type="button" className="mvp-close" onClick={onCancel} aria-label="Close dialog">
            <NativeIcon name="close" size={16} />
          </button>
        </header>

        <div className="mvp-body">
          {/* Minecraft version rail */}
          <nav className="mvp-rail" aria-label="Minecraft versions">
            <span className="mvp-rail-label">Minecraft</span>
            <div className="mvp-rail-list">
              <button
                type="button"
                className={`mvp-rail-item${mcVersion === 'all' ? ' is-active' : ''}`}
                onClick={() => setMcVersion('all')}
              >
                <span>All versions</span>
                <span className="mvp-rail-count">{versions.length}</span>
              </button>
              {mcVersions.map((entry, index) => (
                <button
                  key={entry.value}
                  type="button"
                  className={`mvp-rail-item${mcVersion === entry.value ? ' is-active' : ''}`}
                  onClick={() => setMcVersion(entry.value)}
                >
                  <span className="mvp-rail-name">
                    {entry.value}
                    {index === 0 ? <span className="mvp-rail-tag">newest</span> : null}
                  </span>
                  <span className="mvp-rail-count">{entry.count}</span>
                </button>
              ))}
            </div>
          </nav>

          {/* Build list */}
          <div className="mvp-pane">
            <div className="mvp-toolbar">
              <div className="mvp-search">
                <NativeIcon name="search" size={15} className="mvp-search-icon" />
                <input
                  ref={searchRef}
                  type="text"
                  className="mvp-search-input"
                  placeholder="Search builds by name, version or loader"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  aria-label="Search modpack builds"
                />
                {query ? (
                  <button
                    type="button"
                    className="mvp-search-clear"
                    onClick={() => setQuery('')}
                    aria-label="Clear search"
                  >
                    <NativeIcon name="close" size={11} />
                  </button>
                ) : (
                  <kbd className="mvp-search-kbd">/</kbd>
                )}
              </div>

              <div className="mvp-chips" role="group" aria-label="Release channel">
                {CHANNELS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    className={`mvp-chip${channel === item.value ? ' is-active' : ''}`}
                    onClick={() => setChannel(item.value)}
                    aria-pressed={channel === item.value}
                    disabled={item.value !== 'all' && !channelCounts[item.value]}
                  >
                    {item.label}
                    <span className="mvp-chip-count">{channelCounts[item.value] || 0}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="mvp-list" role="radiogroup" aria-label="Available builds" ref={listRef}>
              {recommended ? (
                <section className="mvp-group mvp-group-featured">
                  <h4 className="mvp-group-label">Recommended</h4>
                  {renderRow(recommended, { featured: true })}
                </section>
              ) : null}

              {rows.length > 0 ? (
                <section className="mvp-group">
                  <h4 className="mvp-group-label">
                    {recommended ? 'Earlier builds' : `${rows.length} matching build${rows.length === 1 ? '' : 's'}`}
                  </h4>
                  {rows.map((version) => renderRow(version))}
                </section>
              ) : null}

              {filtered.length === 0 && (
                <div className="mvp-empty">
                  <NativeIcon name="search" size={20} />
                  <p>No builds match these filters.</p>
                  <button type="button" className="browse-btn browse-btn-secondary" onClick={resetFilters}>
                    Reset filters
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <footer className="mvp-footer">
          <div className="mvp-summary">
            {selected ? (
              <>
                <span className="mvp-summary-label">Installing</span>
                <span className="mvp-summary-value">{selected.name || selected.version_number}</span>
                {selectedIsLatest ? <span className="mvp-summary-pill">Latest</span> : null}
                <span className="mvp-summary-meta">
                  {(selected.game_versions || []).slice(0, 3).join(', ')}
                  {(selected.game_versions || []).length > 3 ? '…' : ''}
                  {selectedSize ? ` · ${selectedSize}` : ''}
                </span>
              </>
            ) : (
              <span className="mvp-summary-label">Select a build to continue</span>
            )}
          </div>

          <div className="mvp-actions">
            {latest && !selectedIsLatest ? (
              <button
                type="button"
                className="mvp-ghost"
                onClick={() => {
                  resetFilters();
                  setSelectedId(latest.id);
                }}
              >
                Jump to latest
              </button>
            ) : null}
            <button type="button" className="browse-btn browse-btn-secondary" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="browse-btn browse-btn-install"
              onClick={() => onConfirm?.(selectedId)}
              disabled={!selectedId}
            >
              <NativeIcon name="download" size={14} />
              <span>Install{selectedIsLatest ? ' latest' : ''}</span>
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
