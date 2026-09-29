import React, { useEffect, useState } from 'react';
import { Check, Filter, RotateCcw, Search, Sparkles, X } from 'lucide-react';
import { LOADER_FACETS, getCategoryTags } from '../api/modrinthApi.js';
import { useI18n } from '../../../i18n/I18nProvider.jsx';

const KNOWN_LOADERS = ['fabric', 'forge', 'neoforge', 'quilt'];

export default function FilterPanel({
  contentType,
  target,
  filters,
  onUpdateFilters,
  onResetToInstance
}) {
  const { t } = useI18n();
  const [allTags, setAllTags] = useState([]);
  const [categorySearch, setCategorySearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    getCategoryTags()
      .then((tags) => {
        if (!cancelled && Array.isArray(tags)) {
          setAllTags(tags);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const projectType = contentType?.projectType || 'mod';

  const relevantCategories = allTags.filter((tag) => {
    if (tag.project_type && tag.project_type !== projectType) return false;
    if (tag.header === 'loaders') return false;
    if (categorySearch.trim()) {
      return tag.name.toLowerCase().includes(categorySearch.toLowerCase());
    }
    return true;
  });

  const selectedCategories = filters.categories || [];

  const toggleCategory = (catName) => {
    const exists = selectedCategories.includes(catName);
    const next = exists
      ? selectedCategories.filter((c) => c !== catName)
      : [...selectedCategories, catName];
    onUpdateFilters({ categories: next });
  };

  const clearAllFilters = () => {
    onUpdateFilters({
      gameVersion: '',
      loader: null,
      environment: null,
      categories: []
    });
  };

  const hasActiveFilters =
    Boolean(filters.gameVersion) ||
    Boolean(filters.loader) ||
    Boolean(filters.environment) ||
    selectedCategories.length > 0;

  return (
    <aside className="browse-filter-panel" aria-label="Search filters">
      <div className="browse-filter-header">
        <div className="browse-filter-title-row">
          <span className="browse-filter-heading">
            <Filter size={14} className="browse-filter-icon" />
            Filters
          </span>
          <button
            type="button"
            className={`browse-filter-clear-all ${hasActiveFilters ? 'is-active' : 'is-disabled'}`}
            onClick={clearAllFilters}
            disabled={!hasActiveFilters}
            title={hasActiveFilters ? 'Reset all filters' : 'No filters applied'}
            aria-label="Reset all filters"
          >
            <RotateCcw size={11} />
            <span>Reset filters</span>
          </button>
        </div>

        {target && (
          <button
            type="button"
            className={`browse-filter-match-btn ${filters.matchInstance ? 'is-active' : ''}`}
            onClick={onResetToInstance}
            title={`Align filters with ${target.name || 'target instance'}`}
          >
            <RotateCcw size={12} />
            <span>Match instance</span>
          </button>
        )}
      </div>

      {/* Game Version input */}
      <div className="browse-filter-section">
        <label className="browse-filter-label" htmlFor="browse-version-filter">
          Game Version
        </label>
        <div className="browse-filter-input-wrap">
          <input
            id="browse-version-filter"
            type="text"
            className="browse-filter-text-input"
            placeholder={target?.mc_version || target?.version || 'e.g. 1.21.1'}
            value={filters.gameVersion || ''}
            onChange={(e) => onUpdateFilters({ gameVersion: e.target.value.trim() })}
          />
          {filters.gameVersion && (
            <button
              type="button"
              className="browse-filter-input-clear"
              onClick={() => onUpdateFilters({ gameVersion: '' })}
              aria-label="Clear version filter"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Mod Loader selector (for mods and modpacks) */}
      {(contentType?.id === 'mod' || contentType?.id === 'modpack') && (
        <div className="browse-filter-section">
          <span className="browse-filter-label">Mod Loader</span>
          <div className="browse-filter-chips">
            {KNOWN_LOADERS.map((loaderName) => {
              const isSelected = filters.loader === loaderName;
              return (
                <button
                  type="button"
                  key={loaderName}
                  className={`browse-filter-chip ${isSelected ? 'is-selected' : ''}`}
                  onClick={() =>
                    onUpdateFilters({ loader: isSelected ? null : loaderName })
                  }
                >
                  {isSelected && <Check size={12} />}
                  <span>{loaderName.charAt(0).toUpperCase() + loaderName.slice(1)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Environment (Client / Server) */}
      {(contentType?.id === 'mod' || contentType?.id === 'modpack') && (
        <div className="browse-filter-section">
          <span className="browse-filter-label">Environment</span>
          <div className="browse-filter-segmented">
            {[
              { id: null, label: 'Any' },
              { id: 'client', label: 'Client' },
              { id: 'server', label: 'Server' }
            ].map((env) => (
              <button
                type="button"
                key={String(env.id)}
                className={`browse-segmented-btn ${filters.environment === env.id ? 'is-selected' : ''}`}
                onClick={() => onUpdateFilters({ environment: env.id })}
              >
                {env.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Categories */}
      <div className="browse-filter-section browse-categories-section">
        <div className="browse-filter-section-head">
          <span className="browse-filter-label">Categories</span>
          {selectedCategories.length > 0 && (
            <span className="browse-category-count-badge">
              {selectedCategories.length}
            </span>
          )}
        </div>

        {/* Note: EXACT classes required by test/ui.render.test.js:
            .browse-category-search and browse-search-clear */}
        <div className="browse-category-search-wrap">
          <Search size={13} className="browse-category-search-icon" />
          <input
            type="text"
            className="browse-category-search"
            placeholder="Filter categories…"
            value={categorySearch}
            onChange={(e) => setCategorySearch(e.target.value)}
          />
          {categorySearch && (
            <button
              type="button"
              className="browse-search-clear"
              onClick={() => setCategorySearch('')}
              aria-label="Clear category search"
            >
              <X size={12} />
            </button>
          )}
        </div>

        <div className="browse-category-list" role="group" aria-label="Category tags">
          {relevantCategories.map((cat) => {
            const isSelected = selectedCategories.includes(cat.name);
            return (
              <button
                type="button"
                key={cat.name}
                className={`browse-category-item ${isSelected ? 'is-selected' : ''}`}
                onClick={() => toggleCategory(cat.name)}
                aria-pressed={isSelected}
              >
                <span className="browse-cat-checkbox">
                  {isSelected && <Check size={11} />}
                </span>
                <span className="browse-cat-name">
                  {cat.name.charAt(0).toUpperCase() + cat.name.slice(1).replace(/-/g, ' ')}
                </span>
              </button>
            );
          })}
          {relevantCategories.length === 0 && (
            <p className="browse-category-empty">No matching categories</p>
          )}
        </div>
      </div>
    </aside>
  );
}
