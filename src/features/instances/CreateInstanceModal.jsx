import React, { useEffect, useMemo, useState } from 'react';
import NativeIcon from '../../components/ui/NativeIcon.jsx';
import { RELEASE_LINES, getClusterArt } from '../../data/versionsData.js';
import {
  LOADERS,
  getFabricGameVersions,
  getVersionManifest,
  loaderAvailability,
  versionLine
} from '../../lib/mojang.js';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import './CreateInstanceModal.css';

const MAX_VERSION_ROWS = 90;
const RAM_MIN = 1024;
const RAM_MAX = 16384;
const RAM_STEP = 512;

function lineFor(versionId) {
  const line = versionLine(versionId);
  return (
    RELEASE_LINES.find(
      (entry) =>
        entry.id === line ||
        String(entry.major) === line ||
        '1.' + entry.major === line
    ) || null
  );
}

function artFor(versionId) {
  const line = lineFor(versionId);
  const exact = line?.versions?.find((entry) => entry.version === versionId);
  return (
    exact?.art ||
    line?.art ||
    getClusterArt({ version: versionId, mc_version: versionId, artKey: line?.artKey })
  );
}

export default function CreateInstanceModal({ open, instances = [], onClose, onCreate }) {
  const { t, formatDate } = useI18n();
  const [manifest, setManifest] = useState(null);
  const [fabricSet, setFabricSet] = useState(null);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [version, setVersion] = useState('');
  const [loader, setLoader] = useState('Fabric');
  const [memoryMb, setMemoryMb] = useState(4096);
  const [search, setSearch] = useState('');
  const [showSnapshots, setShowSnapshots] = useState(false);

  /* Reset every time the modal is opened so it never shows stale input. */
  useEffect(() => {
    if (!open) return;
    setName('');
    setNameTouched(false);
    setSearch('');
    setShowSnapshots(false);
    setLoader('Fabric');
    setMemoryMb(4096);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    setLoading(true);
    getVersionManifest()
      .then((data) => {
        if (cancelled) return;
        setManifest(data);
        setVersion((current) => current || data.latest?.release || data.versions[0]?.id || '');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    getFabricGameVersions()
      .then((result) => {
        if (!cancelled) setFabricSet(result);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  /* Suggest a name until the user types their own. */
  useEffect(() => {
    if (nameTouched || !version) return;
    setName(`${version} ${loader}`);
  }, [version, loader, nameTouched]);

  const versions = useMemo(() => {
    const all = manifest?.versions || [];
    const query = search.trim().toLowerCase();
    return all
      .filter((entry) => (showSnapshots ? true : entry.type === 'release'))
      .filter((entry) => (query ? entry.id.toLowerCase().includes(query) : true))
      .slice(0, MAX_VERSION_ROWS);
  }, [manifest, search, showSnapshots]);

  const availability = version
    ? loaderAvailability(loader, version, fabricSet)
    : { available: true };

  const trimmedName = name.trim();
  const duplicateName = instances.some(
    (instance) => String(instance.name || '').toLowerCase() === trimmedName.toLowerCase()
  );
  const canSubmit = Boolean(trimmedName) && Boolean(version) && availability.available;

  const submit = () => {
    if (!canSubmit) return;
    const line = lineFor(version);
    onCreate?.({
      name: trimmedName,
      version,
      loader,
      memoryMb,
      art: artFor(version),
      description: line?.description || `Minecraft ${version}`,
      tags: line?.tags?.length ? line.tags.slice(0, 3) : [loader]
    });
    onClose?.();
  };

  if (!open) return null;

  return (
    <div className="create-instance-backdrop" onClick={onClose}>
      <div
        className="create-instance-box"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="create-instance-header">
          <div>
            <h2 className="create-instance-title">{t('instances.new')}</h2>
            <p className="create-instance-sub">
              {t('create.subtitle')}
            </p>
          </div>
          <button
            type="button"
            className="create-instance-close"
            onClick={onClose}
            title={t('common.close')}
          >
            <NativeIcon name="close" size={16} />
          </button>
        </header>

        <div className="create-instance-body">
          <div className="create-instance-form">
            <div className="ci-field">
              <label className="ci-label" htmlFor="ci-name">
                {t('onboarding.instanceName')}
              </label>
              <input
                id="ci-name"
                className="ci-input"
                type="text"
                value={name}
                maxLength={60}
                autoFocus
                placeholder={t('create.namePlaceholder')}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameTouched(true);
                }}
              />
              {duplicateName && (
                <p className="ci-hint warn">
                  <NativeIcon name="alert" size={13} />
                  {t('create.duplicateName')}
                </p>
              )}
            </div>

            <div className="ci-field">
              <div className="ci-label-row">
                <span className="ci-label">{t('onboarding.minecraftVersion')}</span>
                <button
                  type="button"
                  className={`ci-toggle ${showSnapshots ? 'active' : ''}`}
                  onClick={() => setShowSnapshots((value) => !value)}
                >
                  <span className="ci-toggle-track">
                    <span className="ci-toggle-knob" />
                  </span>
                  {t('create.showSnapshots')}
                </button>
              </div>

              <label className="ci-search">
                <NativeIcon name="search" size={15} />
                <input
                  type="text"
                  value={search}
                  placeholder={t('create.searchVersions')}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>

              <div className="ci-version-list">
                {loading && !manifest && (
                  <div className="ci-version-empty">
                    <NativeIcon name="refresh" size={16} className="is-spinning" />
                    <span>{t('onboarding.loadingVersions')}</span>
                  </div>
                )}

                {!loading && versions.length === 0 && (
                  <div className="ci-version-empty">
                    <span>{t('create.noVersionsMatch')}</span>
                  </div>
                )}

                {versions.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className={`ci-version-row ${version === entry.id ? 'active' : ''}`}
                    onClick={() => setVersion(entry.id)}
                  >
                    <span className="ci-version-id">{entry.id}</span>
                    <span className="ci-version-meta">
                      {entry.type !== 'release' && (
                        <span className="ci-version-tag">{entry.type.replace('old_', '')}</span>
                      )}
                      {entry.releaseTime ? formatDate(new Date(entry.releaseTime), { year: 'numeric', month: 'short', day: 'numeric' }) : ''}
                    </span>
                    {version === entry.id && <NativeIcon name="check" size={14} />}
                  </button>
                ))}
              </div>

              {manifest?.offline && (
                <p className="ci-hint warn">
                  <NativeIcon name="alert" size={13} />
                  {t('create.offlineCache')}
                </p>
              )}
            </div>

            <div className="ci-field">
              <span className="ci-label">{t('onboarding.modLoader')}</span>
              <div className="ci-loader-row">
                {LOADERS.map((option) => {
                  const state = version
                    ? loaderAvailability(option, version, fabricSet)
                    : { available: true };
                  return (
                    <button
                      key={option}
                      type="button"
                      className={`ci-loader-btn ${loader === option ? 'active' : ''} ${
                        state.available ? '' : 'unavailable'
                      }`}
                      onClick={() => setLoader(option)}
                      title={state.available ? option : state.reasonKey ? t(state.reasonKey, state.reasonVars) : state.reason}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
              {!availability.available && (
                <p className="ci-hint warn">
                  <NativeIcon name="alert" size={13} />
                  {availability.reasonKey ? t(availability.reasonKey, availability.reasonVars) : availability.reason}
                </p>
              )}
            </div>

            <div className="ci-field">
              <div className="ci-label-row">
                <span className="ci-label">{t('onboarding.memory')}</span>
                <span className="ci-ram-value">{`${(memoryMb / 1024).toFixed(1)} GB`}</span>
              </div>
              <input
                className="ci-range"
                type="range"
                min={RAM_MIN}
                max={RAM_MAX}
                step={RAM_STEP}
                value={memoryMb}
                onChange={(event) => setMemoryMb(Number(event.target.value))}
              />
              <div className="ci-range-scale">
                <span>1 GB</span>
                <span>16 GB</span>
              </div>
            </div>
          </div>

          <aside className="create-instance-preview">
            <span className="ci-preview-label">{t('create.preview')}</span>

            <div className="ci-preview-card">
              <div className="ci-preview-art">
                {version ? <img src={artFor(version)} alt="" /> : <div className="ci-preview-blank" />}
              </div>
              <div className="ci-preview-body">
                <h3>{trimmedName || t('create.untitled')}</h3>
                <div className="ci-preview-chips">
                  <span className="ci-preview-chip mono">{version || '--'}</span>
                  <span className="ci-preview-chip brand">{loader}</span>
                </div>
              </div>
            </div>

            <dl className="ci-preview-specs">
              <div>
                <dt>{t('create.version')}</dt>
                <dd>{version || t('create.notSelected')}</dd>
              </div>
              <div>
                <dt>{t('create.loader')}</dt>
                <dd>{loader}</dd>
              </div>
              <div>
                <dt>{t('onboarding.memory')}</dt>
                <dd>{`${memoryMb} MB`}</dd>
              </div>
              <div>
                <dt>{t('create.edition')}</dt>
                <dd>{lineFor(version)?.name || t('create.javaEdition')}</dd>
              </div>
            </dl>
          </aside>
        </div>

        <footer className="create-instance-footer">
          <button type="button" className="ci-ghost-btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="ci-brand-btn" onClick={submit} disabled={!canSubmit}>
            <NativeIcon name="plus" size={15} />
            <span>{t('onboarding.finish')}</span>
          </button>
        </footer>
      </div>
    </div>
  );
}
