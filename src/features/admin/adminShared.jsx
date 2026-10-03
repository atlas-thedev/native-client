import React from 'react';

export const formatNumber = (value) => Number(value || 0).toLocaleString();
export const plural = (value, noun) => `${formatNumber(value)} ${noun}${Number(value) === 1 ? '' : 's'}`;

export function formatBytes(bytes = 0) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

export function formatDate(value, empty = 'Never') {
  if (!value) return empty;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? empty : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatAgo(value, empty = 'Never') {
  if (!value) return empty;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return empty;
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(time).toLocaleDateString([], { dateStyle: 'medium' });
}

export function InitialAvatar({ name, size = 'md' }) {
  const letters = String(name || '?').slice(0, 2).toUpperCase();
  const hue = [...String(name || '')].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 360;
  return <span className={`admin-avatar is-${size}`} style={{ '--avatar-hue': hue }} aria-hidden="true">{letters}</span>;
}

export function Presence({ status }) {
  const value = status || 'offline';
  return <span className={`admin-presence is-${value}`}><i />{value}</span>;
}

/** Re-throws admin errors and tells the shell when the session lost its admin role. */
export function adminError(result, fallback, onAccessRevoked) {
  if (/administrator|session|required/i.test(result?.error || '')) onAccessRevoked?.();
  return new Error(result?.error || fallback);
}
