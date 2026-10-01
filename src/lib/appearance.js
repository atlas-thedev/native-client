/* ============================================================
   Noctra — appearance store

   Single source of truth for the launcher's look. Persists to
   localStorage, applies itself to <html> as data-attributes +
   accent variables, and notifies subscribers so the Settings
   panel and the rest of the UI stay in sync.
   ============================================================ */

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'noctra.appearance';
const LEGACY_STORAGE_KEY = 'native.appearance';

export const ACCENT_PRESETS = [
  { id: 'black', name: 'Black', hex: '#000000' },
  { id: 'ice', name: 'Ice', hex: '#4c9aff' },
  { id: 'mint', name: 'Mint', hex: '#3ddc84' },
  { id: 'aurora', name: 'Aurora', hex: '#22d3ee' },
  { id: 'ember', name: 'Ember', hex: '#ff7849' },
  { id: 'amber', name: 'Amber', hex: '#f0b429' },
  { id: 'rose', name: 'Rose', hex: '#f4679b' },
  { id: 'violet', name: 'Violet', hex: '#7c5cff' },
  { id: 'lime', name: 'Lime', hex: '#a3e635' },
  { id: 'steel', name: 'Steel', hex: '#94a3b8' }
];

export const SURFACE_PRESETS = [
  { id: 'black', name: 'Black', desc: 'True black, OLED', swatch: '#000000' }
];

export const CONTRAST_PRESETS = [
  { id: 'soft', name: 'Soft' },
  { id: 'normal', name: 'Normal' },
  { id: 'high', name: 'High' }
];

export const RADIUS_PRESETS = [
  { id: 'sharp', name: 'Sharp' },
  { id: 'soft', name: 'Soft' },
  { id: 'round', name: 'Round' }
];

export const DEFAULT_APPEARANCE = {
  accent: '#000000',
  surface: 'black',
  contrast: 'normal',
  radius: 'soft',
  scale: 100,
  wallpaperDim: 95,
  animations: true,
  glow: true
};

/* ---------------- colour helpers ---------------- */

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function normalizeHex(input) {
  if (typeof input !== 'string') return null;
  let hex = input.trim().replace(/^#/, '');
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return '#' + hex.toLowerCase();
}

function toRgb(hex) {
  const normalized = normalizeHex(hex) || DEFAULT_APPEARANCE.accent;
  const int = parseInt(normalized.slice(1), 16);
  return {
    r: (int >> 16) & 255,
    g: (int >> 8) & 255,
    b: int & 255
  };
}

function toHex(r, g, b) {
  const part = (n) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');
  return '#' + part(r) + part(g) + part(b);
}

function mix(hex, targetHex, amount) {
  const a = toRgb(hex);
  const b = toRgb(targetHex);
  const t = clamp(amount, 0, 1);
  return toHex(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t);
}

function rgba(hex, alpha) {
  const { r, g, b } = toRgb(hex);
  return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
}

export function luminance(hex) {
  const { r, g, b } = toRgb(hex);
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Text colour that stays readable on top of the accent. */
export function onAccentText(hex) {
  return luminance(hex) > 0.42 ? '#080d14' : '#ffffff';
}

/* ---------------- store ---------------- */

const listeners = new Set();
let current = { ...DEFAULT_APPEARANCE };

function sanitize(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const contrastIds = CONTRAST_PRESETS.map((c) => c.id);
  const radiusIds = RADIUS_PRESETS.map((r) => r.id);

  return {
    accent: normalizeHex(source.accent) || DEFAULT_APPEARANCE.accent,
    surface: 'black',
    contrast: contrastIds.includes(source.contrast) ? source.contrast : DEFAULT_APPEARANCE.contrast,
    radius: radiusIds.includes(source.radius) ? source.radius : DEFAULT_APPEARANCE.radius,
    scale: 100,
    wallpaperDim: 95,
    animations: source.animations !== false,
    glow: source.glow !== false
  };
}

function readStorage() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY) || window.localStorage.getItem(LEGACY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    const value = sanitize(parsed);
    if (!parsed || parsed.surface !== 'black' || parsed.accent === '#4c9aff' || !parsed.accent) {
      value.accent = '#000000';
      value.surface = 'black';
      writeStorage(value);
    }
    return value;
  } catch {
    const fallback = { ...DEFAULT_APPEARANCE, accent: '#000000', surface: 'black' };
    writeStorage(fallback);
    return fallback;
  }
}

function writeStorage(value) {
  try {
    const locked = { ...value, surface: 'black' };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(locked));
    window.localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(locked));
  } catch {
    /* storage disabled — the theme still applies for this session */
  }
}

export function applyAppearance(appearance) {
  if (typeof document === 'undefined') return;
  const value = sanitize(appearance);
  const root = document.documentElement;

  root.dataset.surface = 'black';
  root.dataset.theme = 'black';
  root.dataset.contrast = value.contrast;
  root.dataset.radius = value.radius;
  root.dataset.motion = value.animations ? 'full' : 'reduced';
  root.dataset.glow = value.glow ? 'on' : 'off';

  const accent = value.accent;
  const style = root.style;
  const isDarkAccent = accent === '#000000' || luminance(accent) < 0.05;

  style.setProperty('--brand', accent);
  style.setProperty('--brand-hover', isDarkAccent ? '#1f2024' : mix(accent, '#ffffff', 0.14));
  style.setProperty('--brand-pressed', isDarkAccent ? '#0a0a0c' : mix(accent, '#000000', 0.2));
  style.setProperty('--brand-2', isDarkAccent ? '#27272a' : mix(accent, '#ffffff', 0.3));
  style.setProperty('--brand-disabled', isDarkAccent ? '#141416' : mix(accent, '#0a0c10', 0.62));
  style.setProperty('--brand-subtle', isDarkAccent ? 'rgba(255, 255, 255, 0.08)' : rgba(accent, 0.14));
  style.setProperty('--brand-subtle-hover', isDarkAccent ? 'rgba(255, 255, 255, 0.14)' : rgba(accent, 0.22));
  style.setProperty('--brand-border', isDarkAccent ? 'rgba(255, 255, 255, 0.2)' : rgba(accent, 0.38));
  style.setProperty('--brand-glow', isDarkAccent ? 'rgba(255, 255, 255, 0.08)' : rgba(accent, value.glow ? 0.42 : 0.16));
  style.setProperty('--brand-soft', isDarkAccent ? '#27272a' : mix(accent, '#ffffff', 0.55));
  style.setProperty('--fg-on-brand', onAccentText(accent));
  style.setProperty('--accent-text', isDarkAccent ? '#e4e4e7' : mix(accent, '#ffffff', 0.42));
  style.setProperty('--accent-ink', onAccentText(isDarkAccent ? '#e4e4e7' : mix(accent, '#ffffff', 0.42)));
  style.setProperty(
    '--brand-gradient',
    isDarkAccent
      ? 'linear-gradient(135deg, #27272a 0%, #18181b 55%, #000000 100%)'
      : 'linear-gradient(135deg, ' +
        mix(accent, '#000000', 0.12) +
        ' 0%, ' +
        accent +
        ' 55%, ' +
        mix(accent, '#ffffff', 0.24) +
        ' 100%)'
  );
  // Primary actions (Play, Install, Wear outfit) wear the accent so the whole
  // app follows Settings → Appearance, not just its surfaces.
  style.setProperty(
    '--launch-gradient',
    isDarkAccent
      ? 'linear-gradient(135deg, #27272a 0%, #18181b 52%, #000000 100%)'
      : 'linear-gradient(135deg, ' +
        mix(accent, '#000000', 0.18) +
        ' 0%, ' +
        accent +
        ' 52%, ' +
        mix(accent, '#ffffff', 0.28) +
        ' 100%)'
  );
  style.setProperty('--launch-shadow', isDarkAccent ? 'rgba(0, 0, 0, 0.5)' : rgba(accent, value.glow ? 0.5 : 0.22));
  style.setProperty('--shadow-brand', isDarkAccent ? (value.glow ? '0 0 24px rgba(255, 255, 255, 0.08)' : 'none') : (value.glow ? '0 0 24px ' + rgba(accent, 0.32) : 'none'));
  style.setProperty('--home-scrim', String(value.wallpaperDim / 100));

  const zoom = value.scale / 100;
  style.setProperty('--ui-scale', String(zoom));
  if (document.body) {
    document.body.style.zoom = zoom === 1 ? '' : String(zoom);
  }
}

export function getAppearance() {
  return { ...current };
}

export function setAppearance(patch) {
  current = sanitize({ ...current, ...patch });
  writeStorage(current);
  applyAppearance(current);
  listeners.forEach((listener) => listener(current));
  return current;
}

export function resetAppearance() {
  return setAppearance({ ...DEFAULT_APPEARANCE });
}

export function subscribeAppearance(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React binding — returns the live appearance plus a setter. */
export function useAppearance() {
  const [value, setValue] = useState(current);

  useEffect(() => subscribeAppearance(setValue), []);

  return [value, setAppearance];
}

/* Applied as soon as the module is imported so the saved theme
   is on screen before the first paint of the shell. */
if (typeof window !== 'undefined') {
  current = readStorage();
  applyAppearance(current);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => applyAppearance(current), { once: true });
  }
}
