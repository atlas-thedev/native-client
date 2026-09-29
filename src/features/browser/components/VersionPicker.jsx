import React, { useMemo, useState } from 'react';
import NativeIcon from '../../../components/ui/NativeIcon.jsx';
import SegmentedTabs from '../../../components/ui/SegmentedTabs.jsx';
import Dropdown from '../../../components/ui/Dropdown.jsx';
import { primaryFile } from '../api/modrinthApi.js';

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  } catch {
    return dateStr;
  }
}

function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (!value) return null;
  if (value >= 1048576) return `${(value / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

function compareGameVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff) return diff;
  }
  return String(b).localeCompare(String(a));
}

const CHANNELS = [
  { id: 'all', label: 'All' },
  { id: 'release', label: 'Release' },
  { id: 'beta', label: 'Beta' },
  { id: 'alpha', label: 'Alpha' }
];

export default function VersionPicker({
  project,
  versions = [],
  loading = false,
  target,
  activeType,
  isVanillaInstance,
  isBusy,
  onInstallVersion,
  versionMatchesTarget
}) {
  const [confirmIncompatible, setConfirmIncompatible] = useState(null);
  const [channel, setChannel] = useState('all');
  const [gameVersion, setGameVersion] = useState('all');
  const [loader, setLoader] = useState('all');
  const [compatibleOnly, setCompatibleOnly] = useState(false);

  const isModOnVanilla = activeType?.id === 'mod' && isVanillaInstance;
  const hasTarget = Boolean(target);

  const gameVersionOptions = useMemo(() => {
    const set = new Set();
    versions.forEach((version) => (version.game_versions || []).forEach((gv) => gv && set.add(gv)));
    return [
      { value: 'all', label: 'All Minecraft versions' },
      ...Array.from(set)
        .sort(compareGameVersions)
        .map((gv) => ({ value: gv, label: gv }))
    ];
  }, [versions]);

  const loaderOptions = useMemo(() => {
    const set = new Set();
    versions.forEach((version) => (version.loaders || []).forEach((ld) => ld && set.add(ld)));
    return [
      { value: 'all', label: 'All loaders' },
      ...Array.from(set)
        .sort()
        .map((ld) => ({ value: ld, label: ld.charAt(0).toUpperCase() + ld.slice(1) }))
    ];
  }, [versions]);

  const decorated = useMemo(
    () =>
      versions.map((version) => ({
        version,
        compatible: versionMatchesTarget ? versionMatchesTarget(version) : true
      })),
    [versions, versionMatchesTarget]
  );

  const filtered = useMemo(
    () =>
      decorated.filter(({ version, compatible }) => {
        if (channel !== 'all' && (version.version_type || 'release') !== channel) return false;
        if (gameVersion !== 'all' && !(version.game_versions || []).includes(gameVersion)) return false;
        if (loader !== 'all' && !(version.loaders || []).includes(loader)) return false;
        if (compatibleOnly && !compatible) return false;
        return true;
      }),
    [decorated, channel, gameVersion, loader, compatibleOnly]
  );

  const hasFilters = channel !== 'all' || gameVersion !== 'all' || loader !== 'all' || compatibleOnly;

  const resetFilters = () => {
    setChannel('all');
    setGameVersion('all');
    setLoader('all');
    setCompatibleOnly(false);
  };

  const handleInstallClick = (version, isCompatible) => {
    if (!isCompatible) setConfirmIncompatible(version);
    else onInstallVersion?.(project, version);
  };

  const confirmAndInstall = () => {
    if (!confirmIncompatible) return;
    onInstallVersion?.(project, confirmIncompatible);
    setConfirmIncompatible(null);
  };

  return (
    <div className="browse-version-picker">
      <div className="browse-version-header">
        <div className="browse-version-heading-group">
          <h3 className="browse-version-title">Versions</h3>
          <span className="browse-version-count">
            {filtered.length === versions.length
              ? `${versions.length} releases`
              : `${filtered.length} of ${versions.length} releases`}
          </span>
        </div>

        <div className="browse-version-filters">
          <SegmentedTabs
            size="sm"
            className="browse-channel-tabs"
            items={CHANNELS}
            value={channel}
            onChange={setChannel}
            ariaLabel="Release channel"
          />

          <Dropdown
            className="browse-version-dropdown"
            value={gameVersion}
            options={gameVersionOptions}
            onChange={setGameVersion}
            maxHeight={260}
          />

          {loaderOptions.length > 1 && (
            <Dropdown
              className="browse-version-dropdown"
              value={loader}
              options={loaderOptions}
              onChange={setLoader}
              maxHeight={260}
            />
          )}

          {hasTarget && (
            <button
              type="button"
              className={`browse-filter-toggle${compatibleOnly ? ' is-on' : ''}`}
              aria-pressed={compatibleOnly}
              onClick={() => setCompatibleOnly((value) => !value)}
              title={`Only builds that match ${target?.name || 'this instance'}`}
            >
              <NativeIcon name={compatibleOnly ? 'check-circle' : 'circle'} size={14} />
              <span>Compatible only</span>
            </button>
          )}
        </div>
      </div>

      {loading && versions.length === 0 ? (
        <div className="browse-version-list" aria-busy="true">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="browse-version-row is-skeleton" aria-hidden="true">
              <span className="browse-skeleton-line" style={{ width: '38%' }} />
              <span className="browse-skeleton-line" style={{ width: '22%' }} />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="browse-version-empty">
          <NativeIcon name="tag" size={22} />
          <p>{versions.length === 0 ? 'No downloadable builds for this project.' : 'No builds match these filters.'}</p>
          {hasFilters && versions.length > 0 && (
            <button type="button" className="browse-btn browse-btn-secondary" onClick={resetFilters}>
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="browse-version-list" role="list">
          {filtered.map(({ version, compatible }) => {
            const file = primaryFile(version);
            const downloads = version.downloads || file?.downloads || 0;
            const channelType = version.version_type || 'release';
            const size = formatSize(file?.size);
            const gameVersions = version.game_versions || [];

            return (
              <article
                key={version.id}
                role="listitem"
                className={`browse-version-row ${compatible ? 'is-compatible' : 'is-incompatible'}`}
              >
                <span className={`browse-channel-dot is-${channelType}`} title={channelType} aria-hidden="true" />

                <div className="browse-version-identity">
                  <div className="browse-version-name-row">
                    <span className="browse-ver-name" title={version.name || version.version_number}>
                      {version.name || version.version_number}
                    </span>
                    <span className={`browse-ver-type-pill is-${channelType}`}>{channelType}</span>
                    {hasTarget && !compatible && (
                      <span className="browse-compat-pill is-mismatch" title="Differs from the target version or loader">
                        <NativeIcon name="alert" size={11} />
                        <span>Mismatch</span>
                      </span>
                    )}
                  </div>

                  <div className="browse-version-meta-row">
                    <span className="browse-version-number">{version.version_number}</span>
                    <span className="browse-meta-sep" aria-hidden="true">·</span>
                    <span className="browse-version-meta-item">
                      <NativeIcon name="calendar" size={12} />
                      {formatDate(version.date_published)}
                    </span>
                    <span className="browse-meta-sep" aria-hidden="true">·</span>
                    <span className="browse-version-meta-item">
                      <NativeIcon name="download" size={12} />
                      {downloads.toLocaleString()}
                    </span>
                    {size && (
                      <>
                        <span className="browse-meta-sep" aria-hidden="true">·</span>
                        <span className="browse-version-meta-item">{size}</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="browse-version-tags">
                  {gameVersions.slice(0, 3).map((gv) => (
                    <span key={gv} className="browse-ver-game-chip">
                      {gv}
                    </span>
                  ))}
                  {gameVersions.length > 3 && (
                    <span
                      className="browse-ver-game-chip-more"
                      title={gameVersions.join(', ')}
                    >
                      +{gameVersions.length - 3}
                    </span>
                  )}
                  {(version.loaders || []).map((ld) => (
                    <span key={ld} className={`browse-loader-chip is-${ld}`}>
                      {ld}
                    </span>
                  ))}
                </div>

                <div className="browse-version-action">
                  {isModOnVanilla ? (
                    <button type="button" className="browse-ver-install-btn is-disabled-vanilla" disabled>
                      Vanilla
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={`browse-ver-install-btn ${compatible ? 'is-primary' : 'is-warning'}`}
                      disabled={isBusy}
                      onClick={() => handleInstallClick(version, compatible)}
                      title={compatible ? 'Install this build' : 'Install despite a version mismatch'}
                    >
                      <NativeIcon name="download" size={13} />
                      <span>Install</span>
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Confirmation for an incompatible build */}
      {confirmIncompatible && (
        <div className="browse-confirm-backdrop" onClick={() => setConfirmIncompatible(null)}>
          <div
            className="browse-confirm-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-incompat-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="browse-confirm-icon-wrap is-warning">
              <NativeIcon name="alert" size={22} />
            </div>
            <h4 id="confirm-incompat-title" className="browse-confirm-title">
              This build does not match your instance
            </h4>
            <p className="browse-confirm-body">
              <strong>{confirmIncompatible.name || confirmIncompatible.version_number}</strong> targets{' '}
              <strong>{(confirmIncompatible.game_versions || []).join(', ') || 'unknown versions'}</strong> on{' '}
              <strong>{(confirmIncompatible.loaders || []).join(', ') || 'unknown loaders'}</strong>, while{' '}
              <strong>{target?.name || 'your instance'}</strong> runs{' '}
              <strong>
                {target?.mc_version || target?.version} ({target?.mc_loader || target?.loader || 'Vanilla'})
              </strong>
              . Installing it may crash the game.
            </p>
            <div className="browse-confirm-actions">
              <button
                type="button"
                className="browse-btn browse-btn-secondary"
                onClick={() => setConfirmIncompatible(null)}
              >
                Cancel
              </button>
              <button type="button" className="browse-btn browse-btn-danger" onClick={confirmAndInstall}>
                Install anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
