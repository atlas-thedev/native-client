# Noctra Client — Discover redesign
Request: fully redesign the Discover page (best UX), connect it to instance settings for browsing. Code only; no build/test.
Implemented (code only, not run): header with title + instance switcher (Manage instances / New instance / instance settings button), underline content tabs, larger search, environment + sort + grid/list toggle, category chips (Modrinth tags), compatibility pill, featured hero, staggered card animations, list layout. Shell passes selected instance from instance-settings "Browse" into Discover.
Files: src/features/browser/{Discover.css, BrowseView.jsx, components/*}, hooks/useBrowseSearch.js, shell/Shell.jsx.
Backlog: run tests/visual QA, i18n strings for new labels.
