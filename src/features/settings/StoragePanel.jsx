import React, { useCallback, useEffect, useMemo, useState } from 'react';
import NativeIcon from '../../components/ui/NativeIcon.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import './SettingsPanels.css';

const CACHE_KEYS = [
  { key: 'native.versionManifest', labelKey: 'storage.versionManifest' },
  { key: 'native.patchNotes', labelKey: 'storage.versionArtwork' },
  { key: 'native.instances', labelKey: 'storage.instanceLibrary' },
  { key: 'native.preferences', labelKey: 'storage.preferences' },
  { key: 'native.appearance', labelKey: 'settings.appearance' }
];

function formatBytes(bytes, formatNumber) {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return formatNumber(value < 10 && unit > 0 ? value : Math.round(value), { maximumFractionDigits: 1 }) + ' ' + units[unit];
}

function localBytes(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? new Blob([raw]).size : 0;
  } catch {
    return 0;
  }
}

/** listDir may return strings or objects depending on platform; handle both. */
function countEntries(result) {
  if (!Array.isArray(result)) return { count: 0, bytes: 0 };
  let bytes = 0;
  result.forEach((entry) => {
    if (entry && typeof entry === 'object' && typeof entry.size === 'number') bytes += entry.size;
  });
  return { count: result.length, bytes };
}

export default function StoragePanel({ instances = [] }) {
  const { t, formatDate, formatDuration, formatNumber } = useI18n();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [cacheTick, setCacheTick] = useState(0);

  const scan = useCallback(async () => {
    setLoading(true);

    const scanned = await Promise.all(
      instances.map(async (instance) => {
        const row = {
          id: instance.id,
          name: instance.name,
          version: instance.mc_version || instance.version || '',
          loader: instance.mc_loader || instance.loader || 'Vanilla',
          playtime: instance.playtimeSecs || 0,
          lastPlayed: instance.lastPlayed || null,
          installed: null,
          mods: 0,
          worlds: 0,
          resourcepacks: 0,
          shaderpacks: 0,
          bytes: 0
        };

        try {
          row.installed = await window.native?.instance?.isInstalled?.(
            instance.version || instance.mc_version,
            instance.loader || instance.mc_loader
          );
        } catch {
          row.installed = null;
        }

        try {
          const mods = await window.native?.mods?.installed?.(instance.id);
          row.mods = mods ? Object.keys(mods).length : 0;
        } catch {
          row.mods = 0;
        }

        try {
          const worlds = await window.native?.instance?.worldList?.(instance.id);
          row.worlds = Array.isArray(worlds) ? worlds.length : 0;
        } catch {
          row.worlds = 0;
        }

        for (const folder of ['resourcepacks', 'shaderpacks']) {
          try {
            const listed = await window.native?.instance?.listDir?.(instance.id, folder);
            const info = countEntries(listed);
            row[folder] = info.count;
            row.bytes += info.bytes;
          } catch {
            /* folder may not exist yet */
          }
        }

        return row;
      })
    );

    setRows(scanned);
    setLoading(false);
  }, [instances]);

  useEffect(() => {
    scan();
  }, [scan]);

  const totals = useMemo(() => {
    const cacheBytes = CACHE_KEYS.reduce((sum, entry) => sum + localBytes(entry.key), 0);
    return {
      instances: rows.length,
      installed: rows.filter((row) => row.installed === true).length,
      mods: rows.reduce((sum, row) => sum + row.mods, 0),
      worlds: rows.reduce((sum, row) => sum + row.worlds, 0),
      packs: rows.reduce((sum, row) => sum + row.resourcepacks + row.shaderpacks, 0),
      playtime: rows.reduce((sum, row) => sum + row.playtime, 0),
      cacheBytes
    };
    // cacheTick forces a recount after clearing caches
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, cacheTick]);

  const clearCaches = () => {
    ['native.versionManifest', 'native.patchNotes'].forEach((key) => {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    });
    setCacheTick((value) => value + 1);
  };

  const openFolder = (id, folder) => {
    window.native?.instance?.openFolder?.(id, folder || '');
  };

  return (
    <div className="sp-panel">
      <div className="sp-metric-grid">
        {loading ? (
          Array.from({ length: 6 }).map((_, idx) => (
            <div key={idx} className="sp-metric is-skeleton">
              <div className="sp-skeleton-pill" style={{ width: '45%', height: '10px', marginBottom: '6px' }} />
              <div className="sp-skeleton-pill" style={{ width: '65%', height: '22px', marginBottom: '6px' }} />
              <div className="sp-skeleton-pill" style={{ width: '80%', height: '10px' }} />
            </div>
          ))
        ) : (
          <>
            <div className="sp-metric">
              <span className="sp-metric-label">{t('nav.instances')}</span>
              <span className="sp-metric-value">{formatNumber(totals.instances)}</span>
              <span className="sp-metric-sub">{t('storage.fullyInstalled', { count: formatNumber(totals.installed) })}</span>
            </div>
            <div className="sp-metric">
              <span className="sp-metric-label">{t('detail.mods')}</span>
              <span className="sp-metric-value">{formatNumber(totals.mods)}</span>
              <span className="sp-metric-sub">{t('storage.tracked')}</span>
            </div>
            <div className="sp-metric">
              <span className="sp-metric-label">{t('storage.worlds')}</span>
              <span className="sp-metric-value">{formatNumber(totals.worlds)}</span>
              <span className="sp-metric-sub">{t('storage.acrossInstances')}</span>
            </div>
            <div className="sp-metric">
              <span className="sp-metric-label">{t('storage.packs')}</span>
              <span className="sp-metric-value">{formatNumber(totals.packs)}</span>
              <span className="sp-metric-sub">{t('storage.packsDesc')}</span>
            </div>
            <div className="sp-metric">
              <span className="sp-metric-label">{t('stats.playtime')}</span>
              <span className="sp-metric-value">{formatDuration(totals.playtime)}</span>
              <span className="sp-metric-sub">{t('storage.recorded')}</span>
            </div>
            <div className="sp-metric">
              <span className="sp-metric-label">{t('storage.localCache')}</span>
              <span className="sp-metric-value">{formatBytes(totals.cacheBytes, formatNumber)}</span>
              <span className="sp-metric-sub">{t('storage.cacheDesc')}</span>
            </div>
          </>
        )}
      </div>

      <div className="sp-section-head">
        <h3 className="sp-section-title">{t('storage.perInstance')}</h3>
        <button type="button" className="sp-ghost-btn" onClick={scan} disabled={loading}>
          <NativeIcon name="refresh" size={13} className={loading ? 'is-spinning' : ''} />
          <span>{t(loading ? 'storage.scanning' : 'storage.rescan')}</span>
        </button>
      </div>

      {loading ? (
        <div className="sp-rows">
          {Array.from({ length: 3 }).map((_, idx) => (
            <div key={idx} className="sp-row is-skeleton">
              <div className="sp-row-head is-skeleton">
                <div className="sp-skeleton-pill" style={{ width: '16px', height: '16px', borderRadius: '4px' }} />
                <div className="sp-skeleton-pill" style={{ width: '130px', height: '14px' }} />
                <div className="sp-skeleton-pill" style={{ width: '56px', height: '18px', borderRadius: '12px' }} />
                <div className="sp-skeleton-pill" style={{ width: '64px', height: '18px', borderRadius: '12px' }} />
                <span className="sp-row-spacer" />
                <div className="sp-skeleton-pill" style={{ width: '60px', height: '12px' }} />
                <div className="sp-skeleton-pill" style={{ width: '60px', height: '12px' }} />
              </div>
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="sp-empty">{t('storage.empty')}</p>
      ) : (
        <div className="sp-rows">
          {rows.map((row) => {
            const open = expanded === row.id;
            return (
              <div key={row.id} className={'sp-row ' + (open ? 'open' : '')}>
                <button
                  type="button"
                  className="sp-row-head"
                  onClick={() => setExpanded(open ? null : row.id)}
                >
                  <NativeIcon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
                  <span className="sp-row-name">{row.name}</span>
                  <span className="sp-row-chip mono">{row.version}</span>
                  <span className="sp-row-chip">{row.loader}</span>
                  <span className="sp-row-spacer" />
                  {row.installed === false && <span className="sp-row-warn">{t('storage.notDownloaded')}</span>}
                  <span className="sp-row-count">{t('storage.modCount', { count: formatNumber(row.mods) })}</span>
                  <span className="sp-row-count">{t('storage.worldCount', { count: formatNumber(row.worlds) })}</span>
                </button>

                {open && (
                  <div className="sp-row-body">
                    <div className="sp-detail-grid">
                      <div className="sp-detail">
                        <span>{t('detail.mods')}</span>
                        <strong>{row.mods}</strong>
                      </div>
                      <div className="sp-detail">
                        <span>{t('storage.worlds')}</span>
                        <strong>{row.worlds}</strong>
                      </div>
                      <div className="sp-detail">
                        <span>{t('storage.resourcePacks')}</span>
                        <strong>{row.resourcepacks}</strong>
                      </div>
                      <div className="sp-detail">
                        <span>{t('storage.shaderPacks')}</span>
                        <strong>{row.shaderpacks}</strong>
                      </div>
                      <div className="sp-detail">
                        <span>{t('stats.playtime')}</span>
                        <strong>{formatDuration(row.playtime)}</strong>
                      </div>
                      <div className="sp-detail">
                        <span>{t('storage.lastPlayed')}</span>
                        <strong>
                          {row.lastPlayed ? formatDate(new Date(row.lastPlayed)) : t('storage.never')}
                        </strong>
                      </div>
                    </div>

                    <div className="sp-row-actions">
                      <button type="button" className="sp-ghost-btn" onClick={() => openFolder(row.id, '')}>
                        <NativeIcon name="folder" size={13} />
                        <span>{t('storage.instanceFolder')}</span>
                      </button>
                      <button
                        type="button"
                        className="sp-ghost-btn"
                        onClick={() => openFolder(row.id, 'mods')}
                      >
                        <NativeIcon name="package" size={13} />
                        <span>{t('detail.mods')}</span>
                      </button>
                      <button
                        type="button"
                        className="sp-ghost-btn"
                        onClick={() => openFolder(row.id, 'saves')}
                      >
                        <NativeIcon name="globe" size={13} />
                        <span>{t('storage.worlds')}</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="sp-section-head">
        <h3 className="sp-section-title">{t('storage.cachedData')}</h3>
        <button type="button" className="sp-ghost-btn danger" onClick={clearCaches}>
          <NativeIcon name="trash" size={13} />
          <span>{t('storage.clearCaches')}</span>
        </button>
      </div>

      <div className="sp-cache-list">
        {CACHE_KEYS.map((entry) => {
          const bytes = localBytes(entry.key);
          return (
            <div key={entry.key} className="sp-cache-row">
              <span className="sp-cache-label">{t(entry.labelKey)}</span>
              <span className="sp-cache-key mono">{entry.key}</span>
              <span className="sp-cache-size">{bytes ? formatBytes(bytes, formatNumber) : t('storage.cacheEmpty')}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
