import React, { useCallback, useEffect, useState } from 'react';
import NativeIcon from '../../components/ui/NativeIcon.jsx';
import { Lock, Package, Plus, RotateCcw, Search, Trash2 } from 'lucide-react';
import noctraIcon from '../../assets/noctra-icon.png';
import { isNoctraCoreMod, noctraModVersion } from './coreMods.js';
import customSkinLoaderIcon from '../../assets/mod-icons/customskinloader.png';
import ContentHealth, { useContentHealth } from './ContentHealth.jsx';
import { GlyphBump } from './HealthGlyphs.jsx';

const formatSize = (bytes) => {
  if (!Number.isFinite(bytes)) return '';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
};

const ENRICHED_TYPES = new Set(['mods', 'shaders', 'textures']);

const config = {
  mods: { folder: 'mods', title: '3rd Party Mods', noun: 'mods', browse: 'mod' },
  worlds: { folder: 'saves', title: 'Worlds', noun: 'worlds' },
  shaders: { folder: 'shaderpacks', title: 'Shaders', noun: 'shader packs', browse: 'shader' },
  textures: { folder: 'resourcepacks', title: 'Resources', noun: 'resource packs', browse: 'resourcepack' },
  screenshots: { folder: 'screenshots', title: 'Screenshots', noun: 'screenshots' }
};

function WorldArtwork({ world }) {
  const hue = Number(world.artSeed || 0) % 360;
  return (
    <span className="im-world-art" style={{ '--world-hue': hue }} aria-hidden="true">
      <span className="im-world-sky" />
      <span className="im-world-sun" />
      <span className="im-world-hill is-back" />
      <span className="im-world-hill is-front" />
      {world.iconUrl && (
        <img
          src={world.iconUrl}
          alt=""
          onError={(event) => {
            event.currentTarget.style.display = 'none';
          }}
        />
      )}
    </span>
  );
}

export default function InstanceContentTab({ cluster, type, query, filtered, onBrowse }) {
  const { folder, title, noun, browse } = config[type] || config.mods;
  const canBrowse = Boolean(browse && onBrowse);
  const localOnly = type === 'worlds' || type === 'screenshots';
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const bump = useCallback(() => setRevision((value) => value + 1), []);
  const health = useContentHealth({ cluster, type, revision, onChanged: bump });

  const load = useCallback(async () => {
    if (type === 'worlds') {
      return (await window.native.instance.worldList(cluster.id)).map((world) => ({
        ...world,
        id: world.name,
        title: world.name,
        size: world.sizeBytes
      }));
    }
    const [manifest, files] = await Promise.all([
      window.native.mods.installed(cluster.id),
      window.native.instance.listDir(cluster.id, folder)
    ]);
    const tracked = Object.entries(manifest || {})
      .map(([id, value]) => ({ id, ...(typeof value === 'string' ? { filename: value } : value) }))
      .filter((entry) => (entry.folder || 'mods') === folder);

    return [
      ...tracked.map((entry) => ({
        ...entry,
        title: entry.metadata?.title || entry.filename,
        size: files.find((file) => file.name === entry.filename)?.size,
        enabled: !entry.filename.endsWith('.disabled'),
        managed: true
      })),
      ...files
        .filter((file) => !file.name.startsWith('.') && !tracked.some((entry) => entry.filename === file.name))
        .map((file) => (folder === 'mods' && isNoctraCoreMod(file.name) ? {
          // Noctra's own mod: the launcher installs and updates it on every launch. It can't be turned off.
          id: file.name,
          filename: file.name,
          title: 'Noctra Client',
          size: file.size,
          enabled: true,
          core: true,
          coreVersion: noctraModVersion(file.name)
        } : {
          id: file.name,
          filename: file.name,
          title: /customskinloader/i.test(file.name) ? 'CustomSkinLoader' : file.name,
          size: file.size,
          enabled: !file.name.endsWith('.disabled')
        }))
    ].sort((a, b) => Number(Boolean(b.core)) - Number(Boolean(a.core)));
  }, [cluster.id, folder, type]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    load()
      .then((result) => {
        if (!cancelled) setRows(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Could not load content.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load, revision]);

  /* Modpack downloads and hand-copied files have no install record. Resolve
     their title / icon / author from Modrinth (by file hash) or the jar itself,
     then merge it over the rows without blocking the first paint. */
  useEffect(() => {
    if (loading || !ENRICHED_TYPES.has(type) || !window.native?.mods?.enrich) return undefined;
    if (!rows.some((row) => !row.metadata?.iconUrl)) return undefined;
    let cancelled = false;
    window.native.mods
      .enrich(cluster.id, folder)
      .then((found) => {
        if (cancelled || !found) return;
        setRows((current) =>
          current.map((row) => {
            const extra = found[row.filename];
            if (!extra) return row;
            const metadata = { ...extra };
            for (const [key, value] of Object.entries(row.metadata || {})) {
              if (value) metadata[key] = value;
            }
            return {
              ...row,
              metadata,
              title: row.managed && row.metadata?.title ? row.title : extra.title || row.title
            };
          })
        );
      })
      .catch(() => {
        /* icons are cosmetic: keep the placeholder */
      });
    return () => {
      cancelled = true;
    };
  }, [loading, type, folder, cluster.id, rows]);

  const action = async (operation) => {
    setBusy(true);
    setError('');
    try {
      await operation();
      setRevision((value) => value + 1);
    } catch (err) {
      setError(err.message || 'The operation failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const openFolder = () => action(() => window.native.instance.openFolder(cluster.id, folder));
  const browseContent = () => onBrowse(browse);
  const addContent = canBrowse ? browseContent : openFolder;

  const toggleContent = (row) => {
    if (row.core) return;
    const nextEnabled = !row.enabled;
    action(async () => {
      if (type === 'mods' && row.managed) {
        await window.native.mods.toggle({
          instanceId: cluster.id,
          projectId: row.id,
          enabled: nextEnabled
        });
      } else if (window.native?.instance?.toggleFile) {
        await window.native.instance.toggleFile(
          cluster.id,
          folder,
          row.filename,
          nextEnabled
        );
      } else {
        await window.native.mods.toggle({
          instanceId: cluster.id,
          projectId: row.id,
          enabled: nextEnabled
        });
      }
    });
  };

  const remove = (row) => {
    if (row.core) return;
    if (
      !window.confirm(
        `Delete “${row.title}”? ${
          type === 'worlds'
            ? 'This world will be permanently deleted. Back it up first.'
            : row.managed
              ? 'You can reinstall it from Discover.'
              : 'This file will be permanently deleted from the instance folder.'
        }`
      )
    ) return;
    action(() => {
      if (type === 'worlds') return window.native.instance.deleteWorld(cluster.id, row.name);
      if (row.managed) return window.native.mods.remove({ instanceId: cluster.id, projectId: row.id });
      return window.native.mods.removeFile({ instanceId: cluster.id, folder, filename: row.filename });
    });
  };

  const visible = rows.filter(
    (row) =>
      `${row.title} ${row.metadata?.author || ''} ${row.filename || ''}`
        .toLowerCase()
        .includes(query.toLowerCase())
  );

  if (type === 'mods' || filtered) {
    visible.sort((a, b) => a.title.localeCompare(b.title));
  }

  return (
    <div className="im-content">
      <div className="im-count" aria-live="polite">
        {loading
          ? `Fetching ${noun}…`
          : `${rows.length} ${noun}${
              rows.some((row) => row.enabled === false)
                ? ` · ${rows.filter((row) => row.enabled === false).length} disabled`
                : ''
            }`}
      </div>

      <div className="im-panel">
        {/* Upload Banner per Screen 5 */}
        <div
          className="im-upload-banner"
          onClick={addContent}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              addContent();
            }
          }}
        >
          <div className="im-upload-banner-icon">
            <Plus size={20} />
          </div>
          <div className="im-upload-banner-info">
            <h3 className="im-upload-banner-title">
              {title}
            </h3>
            <p className="im-upload-banner-subtitle">
              {localOnly
                ? `Local ${noun} for this Minecraft instance. Click to manage in folder.`
                : canBrowse
                  ? `Browse Modrinth and install ${noun} straight into this instance.`
                  : `Drag & drop files here, or open the folder to add ${noun}.`}
            </p>
          </div>
          {canBrowse && (
            <span className="im-upload-banner-cta">
              <Search size={13} /> Browse
            </span>
          )}
        </div>

        {!loading && rows.length > 0 && <ContentHealth health={health} noun={noun} />}

        {error && (
          <div className="im-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setRevision((value) => value + 1)}>
              <RotateCcw size={13} /> Retry
            </button>
          </div>
        )}

        {loading ? (
          <div className="im-skeleton" aria-label="Loading content">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i}>
                <i />
                <span><i /><i /></span>
                <i />
              </div>
            ))}
          </div>
        ) : visible.length ? (
          <div className="im-file-list" role="list">
            {visible.map((row) => (
              <div
                className={`im-file-row ${row.enabled === false ? 'is-disabled' : ''}`}
                key={row.id}
                role="listitem"
              >
                {/* 36x36px Icon */}
                <span className="im-file-icon">
                  {row.core ? (
                    <img src={noctraIcon} alt="Noctra" />
                  ) : row.metadata?.iconUrl ? (
                    <img
                      src={row.metadata.iconUrl}
                      alt=""
                      onError={(event) => {
                        event.currentTarget.style.display = 'none';
                      }}
                    />
                  ) : /customskinloader/i.test(`${row.id} ${row.title} ${row.filename}`) ? (
                    <img
                      src={customSkinLoaderIcon}
                      alt="CustomSkinLoader"
                    />
                  ) : type === 'worlds' ? (
                    <WorldArtwork world={row} />
                  ) : (
                    <Package size={20} />
                  )}
                </span>

                {/* Title and metadata */}
                <div className="im-file-name">
                  <strong title={row.title}>{row.title}</strong>
                  <small>
                    {row.core
                      ? 'Required for Noctra skins, capes and friends · updated automatically'
                      : row.metadata?.author
                      ? `By ${row.metadata.author}`
                      : type === 'worlds'
                        ? `Modified ${new Date(row.modified).toLocaleDateString()}`
                        : row.managed
                          ? 'Installed content'
                          : 'Local file'}
                  </small>
                </div>

                {/* Version / Size badge in Mono */}
                <span className="im-file-meta">
                  {row.coreVersion && (
                    <span className="im-file-version-tag">{row.coreVersion}</span>
                  )}
                  {row.metadata?.version && (
                    <span className="im-file-version-tag">{row.metadata.version}</span>
                  )}
                  {health.updatesByFile[row.filename] && (
                    <button
                      type="button"
                      className="im-update-pill"
                      disabled={busy || !!health.applying}
                      title={`Update to ${health.updatesByFile[row.filename].to}`}
                      onClick={() => health.apply([health.updatesByFile[row.filename]], (health.updates.data?.dependencies || []).filter((dep) => !dep.unavailable && dep.requiredBy.includes(health.updatesByFile[row.filename].title)))}
                    >
                      <GlyphBump size={12} /> Update
                    </button>
                  )}
                  {formatSize(row.size) && (
                    <span className="im-file-size-tag">{formatSize(row.size)}</span>
                  )}
                </span>

                {/* Actions: Switch toggle & Delete */}
                <div className="im-file-actions">
                  {row.core ? (
                    <span className="im-core-pill" title="Noctra needs this mod. The launcher keeps it installed and up to date.">
                      <Lock size={12} /> Required
                    </span>
                  ) : (<>
                  {['mods', 'shaders', 'textures'].includes(type) && (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={row.enabled}
                      aria-label={`Enable ${row.title}`}
                      className={`im-toggle-switch ${row.enabled ? 'is-enabled' : 'is-disabled'}`}
                      disabled={busy}
                      onClick={() => toggleContent(row)}
                      title={row.enabled ? `Disable ${row.title}` : `Enable ${row.title}`}
                    >
                      <span className="im-toggle-track">
                        <span className="im-toggle-thumb" />
                      </span>
                    </button>
                  )}

                  <button
                    type="button"
                    className="im-action-btn im-delete"
                    aria-label={`Delete ${row.title}`}
                    disabled={busy}
                    onClick={() => remove(row)}
                    title="Delete"
                  >
                    <Trash2 size={15} />
                  </button>
                  </>)}
                </div>
              </div>
            ))}
          </div>
        ) : !error && (
          <div className="im-empty">
            {rows.length
              ? 'No matches. Try another search or clear the filter.'
              : `No ${noun} found yet.`}
            {!rows.length && (
              <div className="im-empty-actions">
                {canBrowse && (
                  <button type="button" className="im-empty-action-btn" onClick={browseContent}>
                    {`Browse ${noun}`}
                  </button>
                )}
                <button
                  type="button"
                  className={canBrowse ? 'im-empty-secondary-btn' : 'im-empty-action-btn'}
                  onClick={openFolder}
                >
                  {`Open ${folder} folder`}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
