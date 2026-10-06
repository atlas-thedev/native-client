import { useEffect, useState } from 'react';
import { setApplicationLocale } from '../../i18n/I18nProvider.jsx';

export const DEFAULTS = {
  onboarding: {
    completed: null,
    language: 'en'
  },
  appearance: {
    theme: 'black',
    backgroundMotion: true,
    reducedMotion: false,
    compactDensity: false
  },
  memory: { min: 1, max: 4 },
  java: { paths: { 8: '', 17: '', 21: '', 25: '' } },
  resolution: { width: 854, height: 480, fullscreen: false },
  behavior: {
    startPage: 'play',
    launcherAction: 'keep',
    reopenOnExit: true,
    confirmInstanceDelete: true
  },
  apiKeys: {
    curseforge: ''
  },
  updates: {
    checkOnStartup: true,
    backgroundChecks: true,
    autoDownload: true
  }
};

const SETTINGS_EVENT = 'native:settings-changed';
const LEGACY_SETTINGS_EVENT = 'native:settings-changed';

export function deepMerge(base, override) {
  const out = { ...base };
  for (const key of Object.keys(override ?? {})) {
    if (
      override[key] &&
      typeof override[key] === 'object' &&
      !Array.isArray(override[key]) &&
      typeof base[key] === 'object'
    ) {
      out[key] = deepMerge(base[key], override[key]);
    } else {
      out[key] = override[key];
    }
  }
  return out;
}

export default function useSettings() {
  const [settings, setSettings] = useState(null);

  useEffect(() => {
    const migrateSettings = (saved) => {
      const next = deepMerge(DEFAULTS, saved ?? {});
      if (!next.appearance || next.appearance.theme !== 'black') {
        next.appearance = { ...(next.appearance || {}), theme: 'black' };
        if (window.native?.settings) {
          window.native.settings.save(next).catch(() => {});
        } else {
          try {
            localStorage.setItem('native.settings', JSON.stringify(next));
          } catch {}
        }
      }
      return next;
    };

    if (window.native?.settings) {
      window.native.settings.load().then((saved) => {
        const next = migrateSettings(saved);
        setSettings(next);
        applyAppearance(next);
        if (next.onboarding?.language) setApplicationLocale(next.onboarding.language);
      });
    } else {
      const raw = localStorage.getItem('native.settings');
      const next = migrateSettings(raw ? JSON.parse(raw) : {});
      setSettings(next);
      applyAppearance(next);
      if (next.onboarding?.language) setApplicationLocale(next.onboarding.language);
    }
    const sync = (event) => setSettings(event.detail);
    window.addEventListener(SETTINGS_EVENT, sync);
    window.addEventListener(LEGACY_SETTINGS_EVENT, sync);
    return () => {
      window.removeEventListener(SETTINGS_EVENT, sync);
      window.removeEventListener(LEGACY_SETTINGS_EVENT, sync);
    };
  }, []);

  const updateSection = (section, changes) => {
    const next = {
      ...settings,
      [section]: { ...settings[section], ...changes }
    };
    setSettings(next);
    if (window.native?.settings) {
      window.native.settings.save(next);
    } else {
      localStorage.setItem('native.settings', JSON.stringify(next));
    }
    applyAppearance(next);
    window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: next }));
    window.dispatchEvent(new CustomEvent(LEGACY_SETTINGS_EVENT, { detail: next }));
  };

  /** update('memory', 'max', 8) — updates one key in one section and persists */
  const update = (section, key, value) => updateSection(section, { [key]: value });

  return { settings, update, updateSection };
}

function applyAppearance(settings) {
  const root = document.documentElement;
  const appearance = settings?.appearance ?? DEFAULTS.appearance;
  root.dataset.theme = 'black';
  root.dataset.surface = 'black';
  root.dataset.reducedMotion = appearance.reducedMotion ? 'true' : 'false';
  root.dataset.density = appearance.compactDensity ? 'compact' : 'comfortable';
  root.dataset.backgroundMotion = appearance.backgroundMotion === false ? 'off' : 'on';
}
