import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LOADER_FACETS,
  PAGE_SIZE,
  contentTypeById,
  loaderOf,
  searchProjects,
  versionOf
} from '../api/modrinthApi.js';

function instanceFilters(target, overrides = {}) {
  const targetLoader = loaderOf(target);
  const loaderFacet = LOADER_FACETS.has(targetLoader.toLowerCase()) ? targetLoader.toLowerCase() : null;
  return {
    gameVersion: versionOf(target) || '',
    loader: loaderFacet,
    environment: null,
    categories: [],
    matchInstance: true,
    ...overrides
  };
}

/**
 * Owns the Modrinth search lifecycle: debounced query, filter state
 * (gameVersion / loader / environment / categories / matchInstance), sort,
 * cumulative pages for infinite scroll, and abort + generation guarding so
 * stale responses never land.
 *
 * `errorMessage` is the localized message rendered on failure.
 */
export default function useBrowseSearch({ contentType, target, initialResults = [], errorMessage }) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [sort, setSort] = useState('relevance');
  const [source, setSource] = useState('modrinth');
  const [filters, setFiltersState] = useState(() => instanceFilters(target));

  const [results, setResults] = useState(initialResults);
  const [totalHits, setTotalHits] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);

  /* Generation guard: every parameter change bumps the generation so slower
     in-flight responses from an older request are discarded. */
  const generationRef = useRef(0);
  const controllerRef = useRef(null);
  const loadedPagesRef = useRef(0);

  const activeType = useMemo(
    () => contentTypeById(contentType) || contentTypeById('mod'),
    [contentType]
  );

  /* Any manual filter edit detaches from the instance. */
  const setFilters = useCallback((update) => {
    setFiltersState((current) => {
      const next = typeof update === 'function' ? update(current) : update;
      return { ...current, ...next, matchInstance: false };
    });
  }, []);

  const setCategories = useCallback((update) => {
    setFiltersState((current) => ({
      ...current,
      categories: typeof update === 'function' ? update(current.categories) : update
    }));
  }, []);

  const resetToInstance = useCallback(() => {
    setFiltersState((current) => instanceFilters(target, { categories: current.categories }));
  }, [target]);

  /* While matching the instance, follow instance/target changes. */
  const targetVersion = versionOf(target);
  const targetLoader = loaderOf(target);
  useEffect(() => {
    setFiltersState((current) => (current.matchInstance
      ? instanceFilters(target, { categories: current.categories, environment: current.environment })
      : current));
  }, [target?.id, targetVersion, targetLoader]);

  /* ---------------------------------------------------------- debounce */

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(timer);
  }, [query]);

  /* Applies a query without waiting for the debounce (deep links / intents). */
  const setQueryImmediate = useCallback((value) => {
    setQuery(value);
    setDebouncedQuery(value);
  }, []);

  const runSearch = useCallback((pageToLoad, { append }) => {
    const generation = generationRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);

    searchProjects({
      contentType: activeType,
      filters,
      query: debouncedQuery,
      sort,
      source: activeType?.id === 'modpack' ? 'modrinth' : source,
      offset: (pageToLoad - 1) * PAGE_SIZE,
      limit: PAGE_SIZE,
      signal: controller.signal
    })
      .then(({ hits, totalHits: total }) => {
        if (generation !== generationRef.current) return;
        setTotalHits(total);
        loadedPagesRef.current = pageToLoad;
        if (append) {
          setResults((current) => {
            const seen = new Set(current.map((entry) => entry.project_id));
            return [...current, ...hits.filter((entry) => !seen.has(entry.project_id))];
          });
        } else {
          setResults(hits);
        }
      })
      .catch((err) => {
        if (generation !== generationRef.current || err.name === 'AbortError') return;
        if (!append) {
          setResults([]);
          setTotalHits(0);
        }
        setError(errorMessage || 'Could not load results.');
      })
      .finally(() => {
        if (generation !== generationRef.current) return;
        if (append) setLoadingMore(false);
        else setLoading(false);
      });
  }, [activeType, filters, debouncedQuery, sort, source, errorMessage]);

  const runSearchRef = useRef(runSearch);
  runSearchRef.current = runSearch;

  /* Reset to page 1 and re-query whenever any search parameter changes. */
  useEffect(() => {
    generationRef.current += 1;
    setPage(1);
    loadedPagesRef.current = 0;
    runSearchRef.current(1, { append: false });
    return () => {
      controllerRef.current?.abort();
    };
  }, [
    activeType,
    debouncedQuery,
    sort,
    source,
    filters.gameVersion,
    filters.loader,
    filters.environment,
    filters.categories
  ]);

  const totalPages = Math.max(1, Math.ceil(totalHits / PAGE_SIZE));
  const hasMore = page < totalPages;

  /* Infinite-scroll: fetch the next page and append (deduplicated). */
  const loadMore = useCallback(() => {
    if (loading || loadingMore) return;
    const next = loadedPagesRef.current + 1;
    if (loadedPagesRef.current >= Math.ceil(totalHits / PAGE_SIZE)) return;
    setPage(next);
    runSearchRef.current(next, { append: true });
  }, [loading, loadingMore, totalHits]);

  /* Numbered pagination (legacy UI): fetch the page and replace results. */
  const goToPage = useCallback((next) => {
    const clamped = Math.min(Math.max(1, next), Math.max(1, Math.ceil(totalHits / PAGE_SIZE)));
    generationRef.current += 1;
    setPage(clamped);
    runSearchRef.current(clamped, { append: false });
  }, [totalHits]);

  return {
    results,
    totalHits,
    totalPages,
    loading,
    loadingMore,
    error,
    query,
    setQuery,
    setQueryImmediate,
    debouncedQuery,
    sort,
    setSort,
    source,
    setSource,
    filters,
    setFilters,
    setCategories,
    resetToInstance,
    page,
    goToPage,
    loadMore,
    hasMore
  };
}
