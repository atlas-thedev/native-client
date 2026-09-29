import React from 'react';
import { Download, Flame, Heart, Package } from 'lucide-react';
import InstallButton from './InstallButton.jsx';
import { formatDownloads } from './ProjectCard.jsx';
import defaultBanner from '../../../assets/backgrounds/Tricky_Trials.jpg';

export default function FeaturedHero({
  project,
  typeLabel,
  contentType,
  isVanillaInstance,
  isInstalled,
  isBusy,
  isFetching,
  packProgress,
  onSelect,
  onInstall,
  onRemove
}) {
  if (!project) return null;

  const bannerUrl =
    project.featured_gallery ||
    project.gallery?.[0]?.url ||
    (Array.isArray(project.featured_gallery_images) && project.featured_gallery_images[0]) ||
    defaultBanner;
  const categories = (project.display_categories || project.categories || []).slice(0, 4);
  const isModOnVanilla = (contentType?.id === 'mod' || !contentType) && isVanillaInstance;

  return (
    <section className="browse-hero" data-testid="browse-featured-hero" aria-label="Featured">
      <img
        src={bannerUrl}
        alt=""
        className="browse-hero-banner"
        onError={(e) => {
          if (e.currentTarget.src !== defaultBanner) e.currentTarget.src = defaultBanner;
        }}
      />
      <div className="browse-hero-scrim" />

      <div className="browse-hero-content">
        <span className="browse-hero-eyebrow">
          <Flame size={12} /> Featured {typeLabel}
        </span>

        <div className="browse-hero-main">
          <div className="browse-hero-icon">
            {project.icon_url ? (
              <img src={project.icon_url} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
            ) : (
              <Package size={30} />
            )}
          </div>

          <div className="browse-hero-text">
            <h2 className="browse-hero-title">{project.title}</h2>
            {project.author && <span className="browse-hero-author">by {project.author}</span>}
            <p className="browse-hero-desc">{project.description}</p>

            <div className="browse-hero-meta">
              {categories.map((cat) => (
                <span key={cat} className="browse-card-chip">
                  {cat.replace(/-/g, ' ')}
                </span>
              ))}
              <span className="browse-stat">
                <Download size={12} className="browse-stat-icon" />
                <span className="browse-stat-mono">{formatDownloads(project.downloads)}</span>
              </span>
              <span className="browse-stat">
                <Heart size={12} className="browse-stat-icon" />
                <span className="browse-stat-mono">{formatDownloads(project.follows)}</span>
              </span>
            </div>
          </div>

          <div className="browse-hero-actions">
            <InstallButton
              project={project}
              large
              isModOnVanilla={isModOnVanilla}
              isInstalled={isInstalled}
              isBusy={isBusy}
              isFetching={isFetching}
              packProgress={packProgress}
              onInstall={onInstall}
              onRemove={onRemove}
            />
            <button
              type="button"
              className="browse-btn browse-btn-secondary is-large"
              onClick={() => onSelect?.(project)}
              data-testid="browse-hero-details-btn"
            >
              View details
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
