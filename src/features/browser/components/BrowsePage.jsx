import React, { useEffect, useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { CONTENT_TYPES, isVanilla } from '../api/modrinthApi.js';
import useBrowseSearch from '../hooks/useBrowseSearch.js';
import useInstaller from '../hooks/useInstaller.js';
import BrowseHeader from './BrowseHeader.jsx';
import SortSelect from './SortSelect.jsx';
import ResultsGrid from './ResultsGrid.jsx';
import ProjectDetail from './ProjectDetail.jsx';
import DependencyPrompt from './DependencyPrompt.jsx';
import ModpackVersionPrompt from './ModpackVersionPrompt.jsx';
import InstancePickerModal from '../../clusters/InstancePickerModal.jsx';
import { useI18n } from '../../../i18n/I18nProvider.jsx';

export default function BrowsePage({
  initialIntent,
  fixedContentType = null,
  allowedTypes = null,
  excludeTypes = [],
  pageTitle = null,
  instances = [],
  selectedCluster,
  onSelectCluster,
  onBack,
  onAddInstance,
  onOpenCluster,
  onNotify,
  hideInstallToast = false,
  initialResults = []
}) {
  const { t } = useI18n();

  const availableContentTypes = useMemo(() => {
    let types = CONTENT_TYPES;
    if (Array.isArray(allowedTypes) && allowedTypes.length > 0) {
      types = types.filter((entry) => allowedTypes.includes(entry.id));
    }
    if (Array.isArray(excludeTypes) && excludeTypes.length > 0) {
      types = types.filter((entry) => !excludeTypes.includes(entry.id));
    }
    return types.length > 0 ? types : CONTENT_TYPES;
  }, [allowedTypes, excludeTypes]);

  const [contentType, setContentType] = useState(() => {
    if (fixedContentType) {
      const match = CONTENT_TYPES.find((c) => c.id === fixedContentType);
      return match || CONTENT_TYPES[0];
    }
    if (Array.isArray(allowedTypes) && allowedTypes.length > 0 && !allowedTypes.includes('mod')) {
      const match = CONTENT_TYPES.find((c) => c.id === allowedTypes[0]);
      return match || CONTENT_TYPES[0];
    }
    return (
      availableContentTypes.find((c) => c.id === 'mod') || availableContentTypes[0] || CONTENT_TYPES[0]
    );
  });

  const [selectedProject, setSelectedProject] = useState(null);

  /* Install-time instance chooser state (existing instances only). */
  const [pendingInstall, setPendingInstall] = useState(null); // { project, version|null }
  const [chosenInstance, setChosenInstance] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (fixedContentType) {
      const match = CONTENT_TYPES.find((c) => c.id === fixedContentType);
      if (match) setContentType(match);
    }
  }, [fixedContentType]);

  /* Instance-settings browse locks the target to one instance. On the main
     Discover page there is no locked target: the instance is picked at install
     time from the existing instances. */
  const lockedTarget = selectedCluster || null;
  const isChooserMode = !lockedTarget;
  const target = lockedTarget || chosenInstance || null;

  const isTargetVanilla = target ? isVanilla(target) : false;

  /* ---------------------------------------------------- search hooks */
  const search = useBrowseSearch({
    contentType: contentType?.id,
    target,
    initialResults,
    errorMessage: t('browse.connectionError')
  });

  const {
    results,
    totalHits,
    loading,
    loadingMore,
    error,
    query,
    setQuery,
    setQueryImmediate,
    sort,
    setSort,
    loadMore,
    hasMore
  } = search;

  /* ------------------------------------------------- installer hooks */
  const installer = useInstaller({
    target,
    activeType: contentType,
    onAddInstance,
    onNotify,
    hideInstallToast
  });

  const {
    installedKeys,
    busyIds,
    fetchingVersionIds,
    packProgress,
    depPrompt,
    modpackPrompt,
    install,
    installVersion,
    remove,
    toggleOptionalDep,
    confirmDeps,
    cancelDeps,
    confirmModpackVersion,
    cancelModpackVersion,
    versionMatchesTarget
  } = installer;

  /* Deep link intent */
  useEffect(() => {
    if (!initialIntent) return;
    if (initialIntent.contentType) {
      const match = availableContentTypes.find((c) => c.id === initialIntent.contentType);
      if (match) setContentType(match);
    }
    if (initialIntent.query) {
      setQueryImmediate(initialIntent.query);
    }
    setSelectedProject(null);
  }, [initialIntent?.nonce, availableContentTypes, setQueryImmediate]);

  const handleContentTypeChange = (type) => {
    setContentType(type);
    setSelectedProject(null);
  };

  /* ------------------------------------------ install-time targeting */

  const openInstanceChooser = (project, version) => {
    setChosenInstance(null);
    setPendingInstall({ project, version: version || null });
    setPickerOpen(true);
  };

  const handleInstall = (project) => {
    // Modpacks create their own instance, so they never need a target chooser.
    if (!isChooserMode || contentType?.id === 'modpack') {
      install(project);
      return;
    }
    openInstanceChooser(project, null);
  };

  const handleInstallVersion = (project, version) => {
    if (!isChooserMode || contentType?.id === 'modpack') {
      installVersion(project, version);
      return;
    }
    openInstanceChooser(project, version);
  };

  const handlePickInstance = (instance) => {
    setPickerOpen(false);
    setChosenInstance(instance);
  };

  const handleCancelPick = () => {
    setPickerOpen(false);
    setPendingInstall(null);
    setChosenInstance(null);
  };

  /* Once the installer has retargeted to the chosen instance, run the queued
     install. The compatibility check inside useInstaller still applies to the
     chosen instance (incompatible builds are rejected / warned). */
  useEffect(() => {
    if (!isChooserMode || !pendingInstall || !chosenInstance) return;
    if (target?.id !== chosenInstance.id) return;
    const { project, version } = pendingInstall;
    setPendingInstall(null);
    if (version) installVersion(project, version);
    else install(project);
  }, [isChooserMode, pendingInstall, chosenInstance, target, install, installVersion]);

  const compatFor = useMemo(() => {
    if (!pendingInstall) return null;
    const { project, version } = pendingInstall;
    return {
      gameVersions: version?.game_versions || project.game_versions || project.versions || [],
      loaders: version?.loaders || project.loaders || [],
      contentType: contentType?.id
    };
  }, [pendingInstall, contentType?.id]);

  return (
    <div className="browse-page-root">
      {/* Top Header */}
      <BrowseHeader
        pageTitle={pageTitle}
        availableContentTypes={availableContentTypes}
        contentType={contentType}
        onSelectContentType={handleContentTypeChange}
        target={lockedTarget}
        onBack={onBack}
        fixedContentType={Boolean(fixedContentType)}
      />

      {/* Main Viewport: Swaps between Detail view and Grid view */}
      {selectedProject ? (
        <ProjectDetail
          project={selectedProject}
          activeType={contentType}
          target={target}
          hasLockedTarget={!isChooserMode}
          isVanillaInstance={isTargetVanilla}
          isInstalled={installedKeys.has(selectedProject.project_id || selectedProject.id)}
          isBusy={busyIds.has(selectedProject.project_id || selectedProject.id)}
          isFetching={fetchingVersionIds.has(selectedProject.project_id || selectedProject.id)}
          onBack={() => setSelectedProject(null)}
          onInstall={handleInstall}
          onInstallVersion={handleInstallVersion}
          onRemove={remove}
          versionMatchesTarget={versionMatchesTarget}
        />
      ) : (
        <main className="browse-results-main is-full-width">
          {/* Search and Sort Toolbar */}
          <div className="browse-toolbar">
            <div className="browse-search-box">
              <Search size={15} className="browse-search-icon" />
              <input
                type="text"
                className="browse-search-input"
                placeholder={`Search ${contentType?.id ? t(contentType.labelKey) || contentType.id : 'content'}\u2026`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search content"
              />
              {query && (
                <button
                  type="button"
                  className="browse-search-clear"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                >
                  <X size={13} />
                </button>
              )}
            </div>

            <div className="browse-toolbar-right">
              <div className="browse-results-count">
                {loading && results.length === 0 ? (
                  'Searching\u2026'
                ) : (
                  <span>
                    <strong className="mono-count">{totalHits.toLocaleString()}</strong> results
                  </span>
                )}
              </div>
              <SortSelect sort={sort} onChange={setSort} />
            </div>
          </div>

          {/* Results Grid (full width) */}
          <ResultsGrid
            results={results}
            loading={loading}
            loadingMore={loadingMore}
            error={error}
            hasMore={hasMore}
            onLoadMore={loadMore}
            contentType={contentType}
            isVanillaInstance={isTargetVanilla}
            installedKeys={installedKeys}
            busyIds={busyIds}
            fetchingVersionIds={fetchingVersionIds}
            packProgress={packProgress}
            onSelectProject={setSelectedProject}
            onInstall={handleInstall}
            onRemove={remove}
            onRetry={() => search.loadMore?.()}
            onClearFilters={() => setQuery('')}
            hasActiveFilters={Boolean(query)}
          />
        </main>
      )}

      {/* Dependency Confirmation Modal */}
      {depPrompt && (
        <DependencyPrompt
          prompt={depPrompt}
          onToggleOptional={toggleOptionalDep}
          onConfirm={confirmDeps}
          onCancel={cancelDeps}
        />
      )}

      {/* Modpack Version Modal */}
      {modpackPrompt && (
        <ModpackVersionPrompt
          prompt={modpackPrompt}
          onConfirm={confirmModpackVersion}
          onCancel={cancelModpackVersion}
        />
      )}

      {/* Install-time Instance Chooser (existing instances only) */}
      {isChooserMode && (
        <InstancePickerModal
          open={pickerOpen}
          mode="settings"
          title="Install to instance"
          actionLabel="Install"
          subtitle={pendingInstall ? pendingInstall.project.title : ''}
          instances={instances}
          compatFor={compatFor}
          onClose={handleCancelPick}
          onSelect={handlePickInstance}
        />
      )}
    </div>
  );
}
