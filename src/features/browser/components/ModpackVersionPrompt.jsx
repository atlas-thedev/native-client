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

function formatDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (!value) return null;
  if (value >= 1073741824) return `${(value / 1073741824).toFixed(1)} GB`;
  if (value >= 1048576) return `${(value / 1048576).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

/**
 * Modpack version selector.
 *
 * Left rail narrows by Minecraft version (the decision players actually make
 * first), the right pane lists builds for that version. Keyboard users can
 * walk the list with the arrow keys and confirm with Enter.
 */
export default function ModpackVersionPrompt({ prompt, onConfirm, onCancel }) {
  const { project, versions = [] } = prompt || {};

  const [mcVersion, setMcVersion] = useState('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(() => versions[0]?.id || null);

  const listRef = useRef(null);
  const searchRef = useRef(null);

  const mcVersions = useMemo(() => {
    const counts = new Map();
    versions.forEach((version) => {
      (version.game_versions || []).forEach((gv) => {
        if (gv) counts.set(gv, (counts.get(gv) || 0) + 1);
      });
    });
    return Array.from(counts.entries())
      .sort((a, b) => compareVersions(a[0], b[0]))
      .map(([value, count]) => ({ value, count }));
  }, [versions]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return versions.filter((version) => {
      if (mcVersion !== 'all' && !(version.game_versions || []).includes(mcVersion)) return false;
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
  }, [versions, mcVersion, query]);

  const selected = filtered.find((version) => version.id === selectedId) || null;

  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!filtered.some((version) => version.id === selectedId)) {
      setSelectedId(filtered[0].id);
    }
  }, [filtered, selectedId]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const move = (delta) => {
    if (filtered.length === 0) return;
    const index = filtered.findIndex((version) => version.id === selectedId);
    const next = Math.min(filtered.length - 1, Math.max(0, (index < 0 ? 0 : index) + delta));
    const target = filtered[next];
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
              <p className="mvp-subtitle">Pick the Minecraft version and build to install</p>
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
              {mcVersions.map((entry) => (
                <button
                  key={entry.value}
                  type="button"
                  className={`mvp-rail-item${mcVersion === entry.value ? ' is-active' : ''}`}
                  onClick={() => setMcVersion(entry.value)}
                >
                  <span>{entry.value}</span>
                  <span className="mvp-rail-count">{entry.count}</span>
                </button>
              ))}
            </div>
          </nav>

          {/* Build list */}
          <div className="mvp-pane">
            <div className="mvp-search">
              <NativeIcon name="search" size={14} className="mvp-search-icon" />
              <input
                ref={searchRef}
                type="text"
                className="mvp-search-input"
                placeholder="Search builds…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Search modpack builds"
              />
              {query && (
                <button
                  type="button"
                  className="mvp-search-clear"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                >
                  <NativeIcon name="close" size={12} />
                </button>
              )}
            </div>

            <div className="mvp-list" role="radiogroup" aria-label="Available builds" ref={listRef}>
              {filtered.map((version) => {
                const isSelected = version.id === selectedId;
                const channel = version.version_type || 'release';
                const date = formatDate(version.date_published);
                const size = formatSize(primaryFile(version)?.size);
                return (
                  <button
                    key={version.id}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    data-version-id={version.id}
                    className={`mvp-row${isSelected ? ' is-selected' : ''}`}
                    onClick={() => setSelectedId(version.id)}
                    onDoubleClick={() => onConfirm?.(version.id)}
                  >
                    <span className="mvp-radio" aria-hidden="true">
                      <span className="mvp-radio-dot" />
                    </span>

                    <span className="mvp-row-main">
                      <span className="mvp-row-title">
                        <span className="mvp-row-name">{version.name || version.version_number}</span>
                        <span className={`mvp-channel is-${channel}`}>{channel}</span>
                      </span>
                      <span className="mvp-row-meta">
                        <span className="mvp-row-mc">
                          {(version.game_versions || []).slice(0, 3).join(', ') || 'Unknown'}
                        </span>
                        <span className="mvp-sep" aria-hidden="true">·</span>
                        <span>{(version.loaders || []).join(', ') || 'fabric'}</span>
                        {date && (
                          <>
                            <span className="mvp-sep" aria-hidden="true">·</span>
                            <span>{date}</span>
                          </>
                        )}
                        {size && (
                          <>
                            <span className="mvp-sep" aria-hidden="true">·</span>
                            <span>{size}</span>
                          </>
                        )}
                      </span>
                    </span>

                    <span className="mvp-row-check" aria-hidden="true">
                      <NativeIcon name="check" size={13} strokeWidth={2.6} />
                    </span>
                  </button>
                );
              })}

              {filtered.length === 0 && (
                <div className="mvp-empty">
                  <NativeIcon name="search" size={20} />
                  <p>No builds match this filter.</p>
                  <button
                    type="button"
                    className="browse-btn browse-btn-secondary"
                    onClick={() => {
                      setQuery('');
                      setMcVersion('all');
                    }}
                  >
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
                <span className="mvp-summary-value">
                  {selected.name || selected.version_number}
                </span>
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
              <span>Install modpack</span>
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
