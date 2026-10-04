import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { CATALOGS, DEFAULT_LOCALE, SUPPORTED_LOCALES } from './catalogs.js';

const LOCALE_EVENT = 'native:locale-changed';
const LEGACY_LOCALE_EVENT = 'native:locale-changed';
const I18nContext = createContext(null);

function normaliseLocale(value) {
  if (!value || value === 'si' || String(value).toLowerCase().startsWith('si')) return DEFAULT_LOCALE;
  if (SUPPORTED_LOCALES.includes(value)) return value;
  const short = String(value || '').split('-')[0].toLowerCase();
  return SUPPORTED_LOCALES.find((locale) => locale.toLowerCase().startsWith(short)) || DEFAULT_LOCALE;
}

function interpolate(value, variables) {
  return String(value).replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? String(variables[key]) : match
  );
}

function getInitialLocale() {
  try {
    const saved = localStorage.getItem('native.locale');
    if (saved === 'si') {
      localStorage.setItem('native.locale', DEFAULT_LOCALE);
      return DEFAULT_LOCALE;
    }
    if (saved) return normaliseLocale(saved);
    const rawSettings = localStorage.getItem('native.settings');
    if (rawSettings) {
      const parsed = JSON.parse(rawSettings);
      if (parsed?.onboarding?.language) return normaliseLocale(parsed.onboarding.language);
    }
  } catch {
    /* fallback to navigator */
  }
  return normaliseLocale(typeof navigator !== 'undefined' ? navigator.language : DEFAULT_LOCALE);
}

export function I18nProvider({ children }) {
  const [locale, setLocaleState] = useState(getInitialLocale);

  useEffect(() => {
    const handleLocale = (event) => {
      const next = normaliseLocale(event.detail);
      setLocaleState(next);
      try {
        localStorage.setItem('native.locale', next);
      } catch {}
    };
    window.addEventListener(LOCALE_EVENT, handleLocale);
    window.addEventListener(LEGACY_LOCALE_EVENT, handleLocale);
    return () => {
      window.removeEventListener(LOCALE_EVENT, handleLocale);
      window.removeEventListener(LEGACY_LOCALE_EVENT, handleLocale);
    };
  }, []);

  const value = useMemo(() => {
    const setLocale = (nextLocale) => {
      const next = normaliseLocale(nextLocale);
      setLocaleState(next);
      document.documentElement.lang = next;
      try {
        localStorage.setItem('native.locale', next);
      } catch {}
      window.dispatchEvent(new CustomEvent(LOCALE_EVENT, { detail: next }));
      window.dispatchEvent(new CustomEvent(LEGACY_LOCALE_EVENT, { detail: next }));
    };

    const t = (key, variables = {}) => {
      const message = CATALOGS[locale]?.[key] ?? CATALOGS[DEFAULT_LOCALE]?.[key] ?? key;
      return interpolate(message, variables);
    };

    const formatNumber = (number, options) => new Intl.NumberFormat(locale, options).format(number);
    const formatDuration = (seconds) => {
      const total = Math.max(0, Number(seconds) || 0);
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      if (hours > 0) {
        return `${formatNumber(hours)} ${t('unit.hourShort')}${minutes ? ` ${formatNumber(minutes)} ${t('unit.minuteShort')}` : ''}`;
      }
      return `${formatNumber(minutes)} ${t('unit.minuteShort')}`;
    };

    return {
      locale,
      setLocale,
      t,
      formatNumber,
      formatDuration,
      formatDate: (date, options) => new Intl.DateTimeFormat(locale, options).format(date),
      formatRelativeTime: (number, unit) =>
        new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(number, unit)
    };
  }, [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside I18nProvider');
  return context;
}

export function setApplicationLocale(locale) {
  const next = normaliseLocale(locale);
  document.documentElement.lang = next;
  try {
    localStorage.setItem('native.locale', next);
  } catch {}
  window.dispatchEvent(new CustomEvent(LOCALE_EVENT, { detail: next }));
  window.dispatchEvent(new CustomEvent(LEGACY_LOCALE_EVENT, { detail: next }));
}
