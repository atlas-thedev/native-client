import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { I18nProvider } from './i18n/I18nProvider.jsx';
import './lib/appearance.js';
import './styles/theme.css';
import './styles/global.css';

// Safety net for the boot splash in index.html. If its inline script was
// blocked (e.g. a CSP hash mismatch), __noctraBootDone would never exist and
// the splash would stay up forever. Recreate it from the bundle instead.
if (typeof window.__noctraBootDone !== 'function') {
  const fonts = document.getElementById('noctra-fonts');
  if (fonts && fonts.media !== 'all') fonts.media = 'all';

  window.__noctraBootDone = () => {
    const el = document.getElementById('boot-splash');
    if (!el || el.classList.contains('is-done')) return;
    el.classList.add('is-done');
    setTimeout(() => el.remove(), 320);
  };
  setTimeout(() => window.__noctraBootDone(), 20000);
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>
);
