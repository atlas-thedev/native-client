import React, { useEffect, useRef, useState } from 'react';
import { ArrowUp, Loader2, PackageSearch, RotateCcw } from 'lucide-react';
import ProjectCard from './ProjectCard.jsx';
import useInfiniteScroll from '../hooks/useInfiniteScroll.js';

const BREAK_MS = 340;

function SkeletonCard({ index }) {
  return (
    <div className="browse-card-skeleton" style={{ '--sk-i': index }}>
      <div className="sk-head">
        <div className="sk-block sk-icon" />
        <div className="sk-head-text">
          <div className="sk-block sk-title" />
          <div className="sk-block sk-author" />
        </div>
      </div>
      <div className="sk-block sk-line" />
      <div className="sk-block sk-line short" />
      <div className="sk-chips">
        <div className="sk-block sk-chip" />
        <div className="sk-block sk-chip" />
        <div className="sk-block sk-chip wide" />
      </div>
      <div className="sk-footer">
        <div className="sk-block sk-stats" />
        <div className="sk-block sk-btn" />
      </div>
    </div>
  );
}

export default function ResultsGrid({
  source = 'modrinth',
  resultsSource = 'modrinth',
  results = [],
  loading = false,
  loadingMore = false,
  error = null,
  hasMore = false,
  onLoadMore,
  contentType,
  isVanillaInstance,
  installedKeys,
  busyIds,
  fetchingVersionIds,
  packProgress,
  onSelectProject,
  onInstall,
  onRemove,
  onRetry,
  onClearFilters,
  hasActiveFilters
}) {
  const containerRef = useRef(null);
  const [showBackToTop, setShowBackToTop] = useState(false);

  /* Source switch: the old cards break apart, skeletons hold the space until
     the other source answers, then the new cards pop in. */
  const [breakingCards, setBreakingCards] = useState(null);
  const breaking = Boolean(breakingCards);
  const lastSourceRef = useRef(source);
  const shownRef = useRef(results);
  if (!breakingCards && resultsSource === lastSourceRef.current) shownRef.current = results;
  useEffect(() => {
    if (lastSourceRef.current === source) return undefined;
    lastSourceRef.current = source;
    containerRef.current?.scrollTo({ top: 0 });
    // snapshot what was on screen: cached results for the new source may land instantly
    const snapshot = (shownRef.current || []).slice(0, 18);
    if (!snapshot.length) return undefined;
    setBreakingCards(snapshot);
    const timer = setTimeout(() => setBreakingCards(null), BREAK_MS);
    return () => clearTimeout(timer);
  }, [source]);
  const visibleResults = breakingCards || results;
  const stale = resultsSource !== source;
  const showCards = breaking || (results.length > 0 && !stale);
  const showSkeleton = !breaking && ((loading && results.length === 0) || stale);

  const sentinelRef = useInfiniteScroll({
    onLoadMore,
    disabled: loading || loadingMore || !hasMore
  });

  const handleScroll = () => {
    if (!containerRef.current) return;
    setShowBackToTop(containerRef.current.scrollTop > 500);
  };

  const scrollToTop = () => {
    containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div
      className="browse-results-scroll"
      ref={containerRef}
      onScroll={handleScroll}
    >
      {/* Error state */}
      {error && !loading && !stale && (
        <div className="browse-error-state" role="alert">
          <p className="browse-error-message">{error}</p>
          {onRetry && (
            <button type="button" className="browse-retry-btn" onClick={onRetry}>
              <RotateCcw size={14} />
              <span>Try again</span>
            </button>
          )}
        </div>
      )}

      {/* Initial Loading Skeletons */}
      {showSkeleton && (
        <div className="browse-cards-grid is-skeleton" aria-label="Loading results" aria-busy="true">
          {Array.from({ length: 9 }).map((_, i) => (
            <SkeletonCard key={i} index={i} />
          ))}
        </div>
      )}

      {/* Zero results empty state */}
      {!loading && !error && !stale && !breaking && results.length === 0 && (
        <div className="browse-empty-state">
          <div className="browse-empty-icon-wrap">
            <PackageSearch size={36} />
          </div>
          <h3 className="browse-empty-title">No matching content found</h3>
          <p className="browse-empty-hint">
            Try adjusting your search query, or clear some category and version filters.
          </p>
          {onClearFilters && hasActiveFilters && (
            <button
              type="button"
              className="browse-empty-reset-btn"
              onClick={onClearFilters}
            >
              <RotateCcw size={13} />
              <span>Reset filters & search</span>
            </button>
          )}
        </div>
      )}

      {/* Results Card Grid */}
      {showCards && (
        <div
          key={breaking ? 'breaking' : `cards:${resultsSource}`}
          className={`browse-cards-grid ${breaking ? 'is-breaking' : 'is-entering'}`}
          role="feed"
          aria-busy={loadingMore}
        >
          {visibleResults.map((project, index) => {
            const id = project.project_id || project.id;
            const isInstalled = installedKeys ? installedKeys.has(id) : false;
            const isBusy = busyIds ? busyIds.has(id) : false;
            const isFetching = fetchingVersionIds ? fetchingVersionIds.has(id) : false;
            const currentPackProgress =
              packProgress?.instanceId === id || isBusy ? packProgress : null;

            return (
              <div className="browse-card-cell" key={id} style={{ '--card-i': Math.min(index, 14) }}>
              <ProjectCard
                project={project}
                contentType={contentType}
                isVanillaInstance={isVanillaInstance}
                isInstalled={isInstalled}
                isBusy={isBusy}
                isFetching={isFetching}
                packProgress={currentPackProgress}
                onSelect={onSelectProject}
                onInstall={onInstall}
                onRemove={onRemove}
              />
              </div>
            );
          })}
        </div>
      )}

      {/* Infinite Scroll Sentinel */}
      {hasMore && !loading && showCards && !breaking && (
        <div
          ref={sentinelRef}
          className="browse-sentinel"
          style={{ height: '40px', margin: '16px 0' }}
        >
          {loadingMore && (
            <div className="browse-loading-more">
              <Loader2 size={18} className="browse-spin-icon" />
              <span>Loading more…</span>
            </div>
          )}
        </div>
      )}

      {/* Floating Back to Top Button */}
      {showBackToTop && (
        <button
          type="button"
          className="browse-back-to-top"
          onClick={scrollToTop}
          aria-label="Back to top"
        >
          <ArrowUp size={16} />
          <span>Top</span>
        </button>
      )}
    </div>
  );
}
