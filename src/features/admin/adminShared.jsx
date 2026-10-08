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

/** Any admin API call through the launcher bridge: adminCall('POST', '/site', { maintenance }). Throws the API's error. */
export async function adminCall(method, path, body, onAccessRevoked) {
  const result = await window.native?.admin?.request?.(method, path, body);
  if (!result || result.ok === false) throw adminError(result, 'Request failed. Update the launcher if this keeps happening.', onAccessRevoked);
  return result;
}

/** Runs one action at a time with a busy key, error text and an optional success toast. */
export function useAdminAction(onNotify, title = 'Admin') {
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');
  const run = React.useCallback(async (key, fn, ok) => {
    setBusy(key);
    setError('');
    try {
      const value = await fn();
      if (ok) onNotify?.(title, ok);
      return value;
    } catch (reason) {
      setError(reason?.message || 'Something went wrong.');
      return undefined;
    } finally {
      setBusy('');
    }
  }, [onNotify, title]);
  return { busy, error, setError, run };
}

/** ms -> value for <input type="datetime-local"> in the local time zone. */
export function toLocalInput(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function fromLocalInput(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

export const usd = (value) => `$${(Number(value) || 0).toFixed(2)}`;

/** On / off switch row with a label and a short hint. */
export function AdminSwitch({ on, onChange, label, hint, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={Boolean(on)} disabled={disabled} className={`admin-beta-switch${on ? ' is-on' : ''}`} onClick={() => onChange(!on)}>
      <span><strong>{label}</strong>{hint && <small>{hint}</small>}</span>
      <i aria-hidden="true"><b /></i>
    </button>
  );
}

/** A small "two clicks to confirm" helper for destructive buttons. */
export function useConfirm() {
  const [armed, setArmed] = React.useState('');
  React.useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(() => setArmed(''), 2600);
    return () => clearTimeout(timer);
  }, [armed]);
  const ask = (key) => {
    if (armed === key) { setArmed(''); return true; }
    setArmed(key);
    return false;
  };
  return { armed, ask };
}
