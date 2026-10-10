import React from 'react';
import { Check, ChevronLeft, ChevronRight, Calendar, Minus, Plus, X } from 'lucide-react';
import Dropdown from '../../components/ui/Dropdown.jsx';
import './AdminControls.css';

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

/** Closes a popover on an outside click or Escape. */
function useDismiss(open, setOpen, rootRef) {
  React.useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => { if (!rootRef.current?.contains(event.target)) setOpen(false); };
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, setOpen, rootRef]);
}

/* ============================================================
   Custom admin controls. Every picker in the admin panel uses
   these instead of the browser's native widgets.
   ============================================================ */

/** Custom dropdown, styled for the admin panel (wraps the launcher Dropdown). */
export function AdminSelect({ className = '', ...props }) {
  return <Dropdown className={`admin-dropdown ${className}`} {...props} />;
}

/** Custom checkbox with a label. */
export function AdminCheckbox({ checked, onChange, label, hint, disabled }) {
  return (
    <button type="button" role="checkbox" aria-checked={Boolean(checked)} disabled={disabled} className={`admin-check${checked ? ' is-on' : ''}`} onClick={() => onChange?.(!checked)}>
      <i aria-hidden="true">{checked && <Check size={11} strokeWidth={3} />}</i>
      {(label || hint) && <span>{label && <strong>{label}</strong>}{hint && <small>{hint}</small>}</span>}
    </button>
  );
}

/** Custom radio group: options = [{ value, label, hint }]. */
export function AdminRadioGroup({ value, options = [], onChange, disabled, columns }) {
  return (
    <div className="admin-radio-group" role="radiogroup" style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button key={String(option.value)} type="button" role="radio" aria-checked={on} disabled={disabled || option.disabled} className={`admin-radio${on ? ' is-on' : ''}`} onClick={() => !on && onChange?.(option.value)}>
            <i aria-hidden="true" />
            <span><strong>{option.label}</strong>{option.hint && <small>{option.hint}</small>}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Custom segmented selector: options = [[value, label], ...] or [{ value, label }]. */
export function AdminSegmented({ value, options = [], onChange, ariaLabel }) {
  const list = options.map((option) => (Array.isArray(option) ? { value: option[0], label: option[1] } : option));
  return (
    <div className="admin-segmented" role="tablist" aria-label={ariaLabel}>
      {list.map((option) => (
        <button key={String(option.value)} type="button" role="tab" aria-selected={option.value === value} className={option.value === value ? 'active' : ''} onClick={() => onChange?.(option.value)}>{option.label}</button>
      ))}
    </div>
  );
}

/** Custom number field with − / + steppers (no native spinner). */
export function AdminNumber({ value, onChange, min = -Infinity, max = Infinity, step = 1, disabled, suffix }) {
  const decimals = Math.max(2, (String(step).split('.')[1] || '').length);
  const clamp = (n) => Number(Math.min(max, Math.max(min, n)).toFixed(decimals));
  const current = Number(value) || 0;
  const [text, setText] = React.useState(String(current));
  React.useEffect(() => { setText(String(Number(value) || 0)); }, [value]);
  const commit = (raw) => {
    const parsed = Number(raw);
    const next = Number.isFinite(parsed) ? clamp(parsed) : current;
    setText(String(next));
    if (next !== current) onChange?.(next);
  };
  return (
    <div className={`admin-number${disabled ? ' is-disabled' : ''}`}>
      <button type="button" aria-label="Decrease" disabled={disabled || current <= min} onClick={() => onChange?.(clamp(current - step))}><Minus size={13} /></button>
      <input
        inputMode="decimal"
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.target.value.replace(/[^0-9.\-]/g, ''))}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); commit(event.currentTarget.value); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); onChange?.(clamp(current + step)); }
          else if (event.key === 'ArrowDown') { event.preventDefault(); onChange?.(clamp(current - step)); }
        }}
      />
      {suffix && <em>{suffix}</em>}
      <button type="button" aria-label="Increase" disabled={disabled || current >= max} onClick={() => onChange?.(clamp(current + step))}><Plus size={13} /></button>
    </div>
  );
}

/** Custom slider (replaces <input type="range">). Drag, click the track or use the arrow keys. */
export function AdminSlider({ value, onChange, min = 0, max = 100, step = 1, disabled, ariaLabel, className = '' }) {
  const current = Math.min(max, Math.max(min, Number(value) || 0));
  const pct = max > min ? ((current - min) / (max - min)) * 100 : 0;
  const snap = (raw) => {
    const snapped = Math.round((raw - min) / step) * step + min;
    return Math.min(max, Math.max(min, Number(snapped.toFixed(4))));
  };
  const fromX = (element, clientX) => {
    const rect = element.getBoundingClientRect();
    if (!rect.width) return current;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return snap(min + ratio * (max - min));
  };
  const onPointerDown = (event) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    const element = event.currentTarget;
    element.focus();
    element.setPointerCapture?.(event.pointerId);
    let last = fromX(element, event.clientX);
    if (last !== current) onChange?.(last);
    const move = (moveEvent) => {
      const next = fromX(element, moveEvent.clientX);
      if (next !== last) { last = next; onChange?.(next); }
    };
    const up = () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
  };
  const onKeyDown = (event) => {
    if (disabled) return;
    const big = step * 10;
    const keys = { ArrowRight: current + step, ArrowUp: current + step, ArrowLeft: current - step, ArrowDown: current - step, PageUp: current + big, PageDown: current - big, Home: min, End: max };
    if (!(event.key in keys)) return;
    event.preventDefault();
    const next = snap(keys[event.key]);
    if (next !== current) onChange?.(next);
  };
  return (
    <div
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={current}
      aria-disabled={disabled || undefined}
      className={`admin-slider${disabled ? ' is-disabled' : ''} ${className}`.trim()}
      style={{ '--pct': `${pct}%` }}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    >
      <span className="admin-slider-track"><span className="admin-slider-fill" /></span>
      <span className="admin-slider-thumb" />
    </div>
  );
}

const SWATCHES = ['#3d8bff', '#a45cff', '#ffb020', '#ff3d6e', '#3ddc84', '#22d3ee', '#f97316', '#ef4444', '#eab308', '#ec4899', '#ffffff', '#71717a'];
const HEX = /^#[0-9a-f]{6}$/i;

function hexToHue(hex) {
  if (!HEX.test(String(hex || ''))) return 0;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const maxC = Math.max(r, g, b);
  const d = maxC - Math.min(r, g, b);
  if (!d) return 0;
  let h = maxC === r ? ((g - b) / d) % 6 : maxC === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = Math.round(h * 60);
  return h < 0 ? h + 360 : h;
}

function hueToHex(h, s = 0.85, l = 0.6) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round((l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))) * 255).toString(16).padStart(2, '0');
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Custom colour picker (replaces <input type="color">): swatches, a hue slider and a hex field. */
export function AdminColor({ value, onChange, swatches = SWATCHES, disabled }) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef(null);
  const [text, setText] = React.useState(value || '');
  React.useEffect(() => { setText(value || ''); }, [value]);
  useDismiss(open, setOpen, rootRef);
  const commit = () => {
    if (HEX.test(text)) { if (text.toLowerCase() !== String(value || '').toLowerCase()) onChange?.(text.toLowerCase()); }
    else setText(value || '');
  };
  const current = String(value || '').toLowerCase();
  return (
    <div ref={rootRef} className={`admin-color${open ? ' is-open' : ''}`}>
      <button type="button" className="admin-color-trigger" disabled={disabled} aria-label="Pick a colour" onClick={() => setOpen((state) => !state)}>
        <i style={{ background: value || 'transparent' }} />
      </button>
      {open && (
        <div className="admin-color-pop" role="dialog">
          <div className="admin-color-grid">
            {swatches.map((swatch) => (
              <button key={swatch} type="button" aria-label={swatch} className={swatch === current ? 'is-on' : ''} style={{ '--sw': swatch }} onClick={() => onChange?.(swatch)} />
            ))}
          </div>
          <div className="admin-color-row">
            <span>Hue</span>
            <AdminSlider className="is-hue" min={0} max={359} value={hexToHue(value)} onChange={(h) => onChange?.(hueToHex(h))} ariaLabel="Hue" />
          </div>
          <label className="admin-color-hex">
            <span>#</span>
            <input
              value={String(text).replace(/^#/, '')}
              maxLength={6}
              spellCheck={false}
              onChange={(event) => setText(`#${event.target.value.replace(/[^0-9a-f]/gi, '')}`)}
              onBlur={commit}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }}
            />
          </label>
        </div>
      )}
    </div>
  );
}

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const pad2 = (n) => String(n).padStart(2, '0');

/** Custom date + time picker (value in ms, or null). Replaces <input type="datetime-local">. */
export function AdminDateTime({ value, onChange, placeholder = 'Not set', disabled }) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef(null);
  const date = value ? new Date(value) : null;
  const valid = date && !Number.isNaN(date.getTime());
  const [view, setView] = React.useState(() => {
    const base = valid ? date : new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });

  useDismiss(open, setOpen, rootRef);

  const base = valid ? date : null;
  const hours = base ? base.getHours() : 12;
  const minutes = base ? base.getMinutes() : 0;
  const emit = (y, m, d, h, min) => onChange?.(new Date(y, m, d, h, min, 0, 0).getTime());
  const pickDay = (day) => emit(view.getFullYear(), view.getMonth(), day, hours, minutes);
  const setTime = (h, min) => {
    const ref = base || new Date();
    emit(ref.getFullYear(), ref.getMonth(), ref.getDate(), h, min);
  };
  const shift = (delta) => setView((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1));

  const offset = view.getDay();
  const daysIn = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
  const cells = [...Array(offset).fill(null), ...Array.from({ length: daysIn }, (_, i) => i + 1)];
  const today = new Date();
  const isSame = (d, day) => d && d.getFullYear() === view.getFullYear() && d.getMonth() === view.getMonth() && d.getDate() === day;

  return (
    <div ref={rootRef} className={`admin-datetime${open ? ' is-open' : ''}`}>
      <button type="button" className="admin-datetime-trigger" disabled={disabled} onClick={() => setOpen((state) => !state)}>
        <Calendar size={13} />
        <span className={valid ? '' : 'is-placeholder'}>{valid ? formatDate(value) : placeholder}</span>
        {valid && !disabled && (
          <i role="button" tabIndex={-1} aria-label="Clear" onClick={(event) => { event.stopPropagation(); onChange?.(null); }}><X size={12} /></i>
        )}
      </button>
      {open && (
        <div className="admin-datetime-pop" role="dialog">
          <div className="admin-datetime-head">
            <button type="button" onClick={() => shift(-1)} aria-label="Previous month"><ChevronLeft size={14} /></button>
            <strong>{view.toLocaleDateString([], { month: 'long', year: 'numeric' })}</strong>
            <button type="button" onClick={() => shift(1)} aria-label="Next month"><ChevronRight size={14} /></button>
          </div>
          <div className="admin-datetime-grid">
            {WEEKDAYS.map((day) => <span key={day} className="is-weekday">{day}</span>)}
            {cells.map((day, index) => day == null ? <span key={`e${index}`} /> : (
              <button key={day} type="button" className={`${isSame(base, day) ? 'is-on' : ''}${isSame(today, day) ? ' is-today' : ''}`} onClick={() => pickDay(day)}>{day}</button>
            ))}
          </div>
          <div className="admin-datetime-time">
            <span>Time</span>
            <AdminNumber min={0} max={23} value={hours} onChange={(h) => setTime(h, minutes)} />
            <b>:</b>
            <AdminNumber min={0} max={59} step={5} value={minutes} onChange={(m) => setTime(hours, m)} />
            <small>{pad2(hours)}:{pad2(minutes)}</small>
          </div>
          <div className="admin-datetime-foot">
            <button type="button" className="admin-btn ghost" onClick={() => { const now = new Date(); setView(new Date(now.getFullYear(), now.getMonth(), 1)); onChange?.(now.getTime()); }}>Now</button>
            <button type="button" className="admin-btn ghost" onClick={() => onChange?.(null)}>Clear</button>
            <button type="button" className="admin-btn primary" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
