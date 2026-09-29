import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import NativeIcon from '../../../components/ui/NativeIcon.jsx';
import SegmentedTabs from '../../../components/ui/SegmentedTabs.jsx';
import useProjectDetail from '../hooks/useProjectDetail.js';
import VersionPicker from './VersionPicker.jsx';
import { useI18n } from '../../../i18n/I18nProvider.jsx';
import defaultBanner from '../../../assets/backgrounds/Tricky_Trials.jpg';

function formatCompact(count) {
  const value = Number(count) || 0;
  if (value >= 1000000) return `${(value / 1000000).toFixed(value >= 10000000 ? 0 : 1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K`;
  return String(value);
}

function formatDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const SIDE_LABELS = {
  required: 'Required',
  optional: 'Optional',
  unsupported: 'Unsupported',
  unknown: 'Unknown'
};

/* Newest-first ordering so "Compatible versions" never opens on 1.16. */
function sortGameVersions(list = []) {
  return [...list].sort((a, b) => {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const diff = (pb[i] || 0) - (pa[i] || 0);
      if (diff) return diff;
    }
    return String(b).localeCompare(String(a));
  });
}

export default function ProjectDetail({
  project,
  activeType,
  target,
  hasLockedTarget = false,
  isVanillaInstance,
  isInstalled,
  isBusy,
  isFetching,
  onBack,
  onInstall,
  onInstallVersion,
  onRemove,
  versionMatchesTarget
}) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState('overview'); // 'overview' | 'versions'
  const [lightboxIndex, setLightboxIndex] = useState(-1);
  const [showAllVersions, setShowAllVersions] = useState(false);
  const [condensed, setCondensed] = useState(false);

  const scrollRef = useRef(null);
  const galleryRef = useRef(null);

  const { data: detailData, versions, loading } = useProjectDetail(project, { versionLimit: 30 });

  const record = detailData || project;
  const projectId = project.project_id || project.id;
  const isModOnVanilla = activeType?.id === 'mod' && isVanillaInstance;
  const isPending = isFetching || isBusy;

  const bannerUrl =
    record.featured_gallery ||
    record.gallery?.[0]?.url ||
    project.featured_gallery ||
    defaultBanner;

  const renderedMarkdown = useMemo(() => {
    const raw = record.body || record.description || '';
    if (!raw) return '';
    try {
      return DOMPurify.sanitize(marked.parse(raw));
    } catch {
      return raw;
    }
  }, [record.body, record.description]);

  const galleryImages = record.gallery || [];
  const gameVersions = useMemo(
    () => sortGameVersions(record.game_versions || []),
    [record.game_versions]
  );
  const visibleGameVersions = showAllVersions ? gameVersions : gameVersions.slice(0, 12);
  const updatedLabel = formatDate(record.updated || record.date_modified);
  const createdLabel = formatDate(record.published || record.date_created);

  /* The page title collapses into the sticky bar once the hero scrolls away,
     so context is never lost and the hero is never covered. */
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return undefined;
    const onScroll = () => setCondensed(node.scrollTop > 150);
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [activeTab, projectId]);

  const closeLightbox = useCallback(() => setLightboxIndex(-1), []);
  const stepLightbox = useCallback(
    (delta) => {
      setLightboxIndex((index) => {
        if (index < 0 || galleryImages.length === 0) return index;
        return (index + delta + galleryImages.length) % galleryImages.length;
      });
    },
    [galleryImages.length]
  );

  useEffect(() => {
    if (lightboxIndex < 0) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') closeLightbox();
      if (event.key === 'ArrowRight') stepLightbox(1);
      if (event.key === 'ArrowLeft') stepLightbox(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxIndex, closeLightbox, stepLightbox]);

  const scrollGallery = (delta) => {
    galleryRef.current?.scrollBy({ left: delta, behavior: 'smooth' });
  };

  const openExternal = (url) => {
    if (!url) return;
    if (window.native?.openExternal) window.native.openExternal(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  };

  const modrinthUrl = `https://modrinth.com/${record.project_type || activeType?.id || 'mod'}/${
    record.slug || projectId
  }`;

  const links = [
    record.source_url && { id: 'source', label: 'Source', icon: 'branch', url: record.source_url },
    record.issues_url && { id: 'issues', label: 'Issues', icon: 'bug', url: record.issues_url },
    record.wiki_url && { id: 'wiki', label: 'Wiki', icon: 'file', url: record.wiki_url },
    record.discord_url && { id: 'discord', label: 'Discord', icon: 'users', url: record.discord_url },
    { id: 'modrinth', label: 'Modrinth', icon: 'external-link', url: modrinthUrl }
  ].filter(Boolean);

  const primaryAction = () => {
    if (isModOnVanilla) {
      return (
        <button
          type="button"
          className="browse-btn browse-btn-install is-disabled-vanilla"
          disabled
          title="Minecraft Vanilla does not support mods"
        >
          <NativeIcon name="alert" size={15} />
          <span>Vanilla (no mods)</span>
        </button>
      );
    }
    if (isPending) {
      return (
        <button type="button" className="browse-btn browse-btn-busy is-large" disabled>
          <NativeIcon name="loader" size={15} className="browse-spin-icon" />
          <span>{isFetching ? 'Loading versions…' : 'Installing…'}</span>
        </button>
      );
    }
    if (isInstalled) {
      return (
        <button
          type="button"
          className="browse-btn browse-btn-danger is-large"
          onClick={() => onRemove?.(project)}
        >
          <NativeIcon name="trash" size={15} />
          <span>Remove</span>
        </button>
      );
    }
    return (
      <button
        type="button"
        className="browse-btn browse-btn-install is-large"
        onClick={() => onInstall?.(project)}
      >
        <NativeIcon name="download" size={15} />
        <span>{hasLockedTarget ? `Install to ${target?.name || 'instance'}` : 'Install'}</span>
      </button>
    );
  };

  return (
    <div className="browse-detail-view" role="region" aria-label={record.title} ref={scrollRef}>
      {/* Sticky context bar: back, collapsed title, section switcher */}
      <div className={`browse-detail-topbar${condensed ? ' is-condensed' : ''}`}>
        <div className="browse-detail-topbar-left">
          <button
            type="button"
            className="browse-detail-back-btn"
            onClick={onBack}
            aria-label="Back to results"
          >
            <NativeIcon name="arrow-left" size={16} />
            <span>Back</span>
          </button>

          <div className="browse-detail-crumb" aria-hidden={!condensed}>
            {record.icon_url && <img src={record.icon_url} alt="" className="browse-detail-crumb-icon" />}
            <span className="browse-detail-crumb-title">{record.title}</span>
          </div>
        </div>

        <SegmentedTabs
          className="browse-detail-tabs"
          size="sm"
          items={[
            { id: 'overview', label: 'Overview', icon: 'file' },
            { id: 'versions', label: 'Versions', icon: 'tag', count: versions.length }
          ]}
          value={activeTab}
          onChange={setActiveTab}
          ariaLabel="Project sections"
        />
      </div>

      {/* Hero: identity, stats and the primary action live together so nothing
          can be covered by a second sticky layer. */}
      <header className="browse-detail-hero">
        <img
          src={bannerUrl || defaultBanner}
          alt=""
          className="browse-detail-hero-banner"
          onError={(event) => {
            if (event.currentTarget.src !== defaultBanner) event.currentTarget.src = defaultBanner;
          }}
        />
        <div className="browse-detail-hero-scrim" />

        <div className="browse-detail-hero-content">
          <div className="browse-detail-icon-wrap">
            {record.icon_url ? (
              <img src={record.icon_url} alt="" className="browse-detail-icon" />
            ) : (
              <div className="browse-detail-icon-placeholder">
                <NativeIcon name="type-mod" size={34} />
              </div>
            )}
          </div>

          <div className="browse-detail-title-block">
            <div className="browse-detail-eyebrow">
              <span className="browse-detail-kind">{record.project_type || activeType?.id || 'mod'}</span>
              {record.author && (
                <>
                  <span className="browse-detail-dot" aria-hidden="true">·</span>
                  <span className="browse-detail-author">by {record.author}</span>
                </>
              )}
              {isInstalled && (
                <span className="browse-detail-installed-pill">
                  <NativeIcon name="check" size={11} strokeWidth={2.4} />
                  Installed
                </span>
              )}
            </div>

            <h1 className="browse-detail-title">{record.title}</h1>
            <p className="browse-detail-summary">{record.description}</p>

            <div className="browse-detail-stats">
              <span className="browse-detail-stat">
                <NativeIcon name="download" size={13} />
                <strong>{formatCompact(record.downloads)}</strong>
                <span>downloads</span>
              </span>
              <span className="browse-detail-stat">
                <NativeIcon name="heart" size={13} />
                <strong>{formatCompact(record.followers ?? record.follows)}</strong>
                <span>followers</span>
              </span>
              {updatedLabel && (
                <span className="browse-detail-stat">
                  <NativeIcon name="clock" size={13} />
                  <span>Updated {updatedLabel}</span>
                </span>
              )}
            </div>
          </div>

          <div className="browse-detail-hero-actions">
            {primaryAction()}
            <button
              type="button"
              className="browse-btn browse-btn-secondary"
              onClick={() => setActiveTab('versions')}
            >
              <NativeIcon name="tag" size={14} />
              <span>Choose version</span>
            </button>
          </div>
        </div>
      </header>

      {/* Body */}
      <div className="browse-detail-body">
        {activeTab === 'overview' ? (
          <div className="browse-detail-layout">
            <div className="browse-detail-main-col">
              {galleryImages.length > 0 && (
                <section className="browse-gallery-strip">
                  <div className="browse-section-head">
                    <h3 className="browse-section-label">Screenshots</h3>
                    {galleryImages.length > 2 && (
                      <div className="browse-gallery-nav">
                        <button
                          type="button"
                          className="browse-icon-btn"
                          onClick={() => scrollGallery(-480)}
                          aria-label="Previous screenshots"
                        >
                          <NativeIcon name="chevron-left" size={15} />
                        </button>
                        <button
                          type="button"
                          className="browse-icon-btn"
                          onClick={() => scrollGallery(480)}
                          aria-label="More screenshots"
                        >
                          <NativeIcon name="chevron-right" size={15} />
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="browse-gallery-scroll" ref={galleryRef}>
                    {galleryImages.map((img, index) => (
                      <button
                        type="button"
                        key={img.url || index}
                        className="browse-gallery-item"
                        onClick={() => setLightboxIndex(index)}
                        aria-label={img.title || `Open screenshot ${index + 1}`}
                      >
                        <img src={img.url} alt={img.title || ''} loading="lazy" />
                        <span className="browse-gallery-zoom" aria-hidden="true">
                          <NativeIcon name="maximize-corners" size={15} />
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              <section className="browse-markdown-wrap">
                <div className="browse-section-head">
                  <h3 className="browse-section-label">About</h3>
                </div>
                {loading && !renderedMarkdown ? (
                  <div className="browse-detail-skeleton" aria-hidden="true">
                    <span style={{ width: '92%' }} />
                    <span style={{ width: '78%' }} />
                    <span style={{ width: '86%' }} />
                    <span style={{ width: '54%' }} />
                  </div>
                ) : renderedMarkdown ? (
                  <div
                    className="browse-markdown-content"
                    dangerouslySetInnerHTML={{ __html: renderedMarkdown }}
                  />
                ) : (
                  <p className="browse-no-readme">This project has no detailed description yet.</p>
                )}
              </section>
            </div>

            <aside className="browse-detail-sidebar">
              <div className="browse-sidebar-card">
                <h4 className="browse-sidebar-heading">Compatibility</h4>

                <div className="browse-sidebar-row">
                  <span className="browse-sidebar-label">Client</span>
                  <span className={`browse-side-tag is-${record.client_side || 'unknown'}`}>
                    {SIDE_LABELS[record.client_side] || 'Unknown'}
                  </span>
                </div>
                <div className="browse-sidebar-row">
                  <span className="browse-sidebar-label">Server</span>
                  <span className={`browse-side-tag is-${record.server_side || 'unknown'}`}>
                    {SIDE_LABELS[record.server_side] || 'Unknown'}
                  </span>
                </div>

                {record.loaders?.length > 0 && (
                  <div className="browse-sidebar-row-stacked">
                    <span className="browse-sidebar-label">Loaders</span>
                    <div className="browse-sidebar-chips">
                      {record.loaders.map((loader) => (
                        <span key={loader} className={`browse-loader-chip is-${loader}`}>
                          {loader}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {gameVersions.length > 0 && (
                  <div className="browse-sidebar-row-stacked">
                    <span className="browse-sidebar-label">Minecraft versions</span>
                    <div className="browse-sidebar-chips">
                      {visibleGameVersions.map((version) => (
                        <span key={version} className="browse-sidebar-chip">
                          {version}
                        </span>
                      ))}
                      {gameVersions.length > 12 && (
                        <button
                          type="button"
                          className="browse-sidebar-chip is-more"
                          onClick={() => setShowAllVersions((value) => !value)}
                        >
                          {showAllVersions ? 'Show less' : `+${gameVersions.length - 12} more`}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="browse-sidebar-card">
                <h4 className="browse-sidebar-heading">Details</h4>
                <div className="browse-sidebar-row">
                  <span className="browse-sidebar-label">License</span>
                  <span className="browse-sidebar-value">{record.license?.id || 'Unknown'}</span>
                </div>
                {createdLabel && (
                  <div className="browse-sidebar-row">
                    <span className="browse-sidebar-label">Published</span>
                    <span className="browse-sidebar-value">{createdLabel}</span>
                  </div>
                )}
                {updatedLabel && (
                  <div className="browse-sidebar-row">
                    <span className="browse-sidebar-label">Updated</span>
                    <span className="browse-sidebar-value">{updatedLabel}</span>
                  </div>
                )}
              </div>

              <div className="browse-sidebar-card">
                <h4 className="browse-sidebar-heading">Links</h4>
                <div className="browse-sidebar-links">
                  {links.map((link) => (
                    <button
                      key={link.id}
                      type="button"
                      className="browse-sidebar-link"
                      onClick={() => openExternal(link.url)}
                    >
                      <NativeIcon name={link.icon} size={15} />
                      <span>{link.label}</span>
                      <NativeIcon name="arrow-up-right" size={14} className="browse-sidebar-link-go" />
                    </button>
                  ))}
                </div>
              </div>
            </aside>
          </div>
        ) : (
          <div className="browse-detail-versions-tab">
            <VersionPicker
              project={project}
              versions={versions}
              loading={loading}
              target={target}
              activeType={activeType}
              isVanillaInstance={isVanillaInstance}
              isBusy={isBusy}
              onInstallVersion={onInstallVersion}
              versionMatchesTarget={versionMatchesTarget}
            />
          </div>
        )}
      </div>

      {/* Lightbox */}
      {lightboxIndex >= 0 && galleryImages[lightboxIndex] && (
        <div
          className="browse-lightbox-backdrop"
          onClick={closeLightbox}
          role="dialog"
          aria-modal="true"
          aria-label="Screenshot preview"
        >
          <button
            type="button"
            className="browse-lightbox-close"
            onClick={closeLightbox}
            aria-label="Close image preview"
          >
            <NativeIcon name="close" size={18} />
          </button>

          {galleryImages.length > 1 && (
            <button
              type="button"
              className="browse-lightbox-nav is-prev"
              onClick={(event) => {
                event.stopPropagation();
                stepLightbox(-1);
              }}
              aria-label="Previous screenshot"
            >
              <NativeIcon name="chevron-left" size={20} />
            </button>
          )}

          <figure className="browse-lightbox-figure" onClick={(event) => event.stopPropagation()}>
            <img src={galleryImages[lightboxIndex].url} alt="" className="browse-lightbox-img" />
            <figcaption className="browse-lightbox-caption">
              <span>{galleryImages[lightboxIndex].title || record.title}</span>
              <span className="browse-lightbox-counter">
                {lightboxIndex + 1} / {galleryImages.length}
              </span>
            </figcaption>
          </figure>

          {galleryImages.length > 1 && (
            <button
              type="button"
              className="browse-lightbox-nav is-next"
              onClick={(event) => {
                event.stopPropagation();
                stepLightbox(1);
              }}
              aria-label="Next screenshot"
            >
              <NativeIcon name="chevron-right" size={20} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
