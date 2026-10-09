import './lib/legacyStorage.js';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { I18nProvider } from './i18n/I18nProvider.jsx';
import './lib/appearance.js';
import './styles/theme.css';
import './styles/global.css';
import './styles/locker-store.css';

// Safety net for the boot splash in index.html. If its inline script was
// blocked (e.g. a CSP hash mismatch), __nativeBootDone would never exist and
// the splash would stay up forever. Recreate it from the bundle instead.
if (typeof window.__nativeBootDone !== 'function') {
  const fonts = document.getElementById('native-fonts');
  if (fonts && fonts.media !== 'all') fonts.media = 'all';

  window.__nativeBootDone = () => {
    const el = document.getElementById('boot-splash');
    if (!el || el.classList.contains('is-done')) return;
    el.classList.add('is-done');
    setTimeout(() => el.remove(), 320);
  };
  setTimeout(() => window.__nativeBootDone(), 20000);
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>
);
