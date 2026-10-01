import React, { useCallback, useEffect, useRef, useState } from 'react';
import Dropdown from '../../components/ui/Dropdown.jsx';
import NativeIcon from '../../components/ui/NativeIcon.jsx';
import './javaUi.css';

/* Shared Java pieces for global settings and per-instance overrides. */

const ARCH_LABEL = { x64: 'x64', x86: 'x86 · 32-bit', arm64: 'ARM64', arm: 'ARM · 32-bit', unknown: '?' };

export function runtimeTitle(rt) {
  if (!rt) return 'Unknown Java';
  return `Java ${rt.version}`;
}

export function runtimeMeta(rt) {
  if (!rt) return '';
  return [rt.vendor, ARCH_LABEL[rt.arch] || rt.arch, rt.jdk ? 'JDK' : 'JRE'].filter(Boolean).join(' · ');
}

export function ArchBadge({ runtime, host }) {
  if (!runtime) return null;
  const is32 = runtime.bits === 32 || runtime.arch === 'x86' || runtime.arch === 'arm';
  const foreign = host === 'x64' && runtime.arch === 'arm64';
  const emulated = !foreign && host && runtime.arch !== 'unknown' && runtime.arch !== host && !is32;
  const tone = foreign ? 'bad' : is32 || emulated ? 'warn' : 'ok';
  const text = foreign
    ? 'ARM64 · can’t run here'
    : is32
      ? '32-bit'
      : emulated
        ? `${ARCH_LABEL[runtime.arch]} · emulated`
        : `${ARCH_LABEL[runtime.arch] || runtime.arch} · native`;
  return <span className={`jx-badge is-${tone}`}>{text}</span>;
}

/** Every Java on this machine (cached by the main process for a minute). */
export function useJavaRuntimes() {
  const [list, setList] = useState([]);
  const [scanning, setScanning] = useState(true);
  const [host, setHost] = useState(null);
  const alive = useRef(true);

  const scan = useCallback(async (force = false) => {
    const api = window.native?.java;
    if (!api?.scan) {
      setScanning(false);
      return;
    }
    setScanning(true);
    try {
      const found = await api.scan({ force });
      if (alive.current) setList(Array.isArray(found) ? found : []);
    } catch {
      if (alive.current) setList([]);
    } finally {
      if (alive.current) setScanning(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    scan(false);
    window.native?.java?.host?.().then((h) => alive.current && setHost(h?.arch || null)).catch(() => {});
    return () => {
      alive.current = false;
    };
  }, [scan]);

  return { list, scanning, host, rescan: () => scan(true) };
}

/** Debounced pre-launch check: which Java would run and whether it can. */
export function useJavaCheck(payload, { enabled = true, delay = 300 } = {}) {
  const [state, setState] = useState({ loading: false, result: null });
  const key = JSON.stringify(payload || {});
  useEffect(() => {
    const api = window.native?.java;
    if (!enabled || !api?.check || !payload?.mcVersion) {
      setState({ loading: false, result: null });
      return undefined;
    }
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true }));
    const timer = setTimeout(() => {
      api.check(payload)
        .then((result) => !cancelled && setState({ loading: false, result }))
        .catch((error) => !cancelled && setState({ loading: false, result: { status: 'error', issues: [{ level: 'error', message: error?.message || String(error) }] } }));
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, delay]);
  return state;
}

const BROWSE = '__browse__';

/**
 * Pick a Java: Automatic, any detected runtime, or a binary from disk.
 * `value` is a path ('' = automatic).
 */
export function JavaPicker({ value = '', onChange, runtimes = [], scanning = false, onRescan, autoLabel = 'Automatic (recommended)', autoHint, disabled = false, filter }) {
  const [browsed, setBrowsed] = useState(null);
  const pool = filter ? runtimes.filter(filter) : runtimes;
  const known = pool.some((rt) => rt.path === value);
  const options = [
    { value: '', label: autoLabel, hint: autoHint },
    ...pool.map((rt) => ({ value: rt.path, label: `${runtimeTitle(rt)} · ${rt.vendor}`, hint: `${ARCH_LABEL[rt.arch] || rt.arch} · ${rt.source}` })),
    ...(value && !known ? [{ value, label: browsed ? `${runtimeTitle(browsed)} · ${browsed.vendor}` : value.split(/[\\/]/).slice(-3).join('/'), hint: 'Custom path' }] : []),
    { value: BROWSE, label: 'Browse for java…' }
  ];

  const pick = async (next) => {
    if (next !== BROWSE) {
      onChange?.(next);
      return;
    }
    const file = await window.native?.java?.browse?.();
    if (!file) return;
    const info = await window.native?.java?.probe?.(file).catch(() => null);
    setBrowsed(info);
    onChange?.(file);
  };

  return (
    <div className="jx-picker">
      <Dropdown value={value} options={options} onChange={pick} disabled={disabled} maxHeight={300} />
      {onRescan && (
        <button type="button" className="jx-icon" onClick={onRescan} disabled={scanning || disabled} title="Scan this computer for Java again" aria-label="Rescan for Java">
          <NativeIcon name={scanning ? 'loader' : 'refresh'} size={15} className={scanning ? 'jx-spin' : ''} />
        </button>
      )}
    </div>
  );
}

/** Result line(s) of a Java check. */
export function CompatNote({ check, loading, mcVersion, compact = false }) {
  if (loading && !check) return <p className="jx-compat is-pending">Checking Java…</p>;
  if (!check) return null;
  const issues = (check.issues || []).filter((issue) => issue.level !== 'info');
  const info = (check.issues || []).find((issue) => issue.level === 'info');
  const rt = check.runtime;
  const summary = info
    ? info.message
    : rt
      ? `${runtimeTitle(rt)} (${runtimeMeta(rt)})${check.source && check.source !== 'custom' ? ` · ${{ configured: 'chosen in Settings', managed: 'downloaded by Noctra', detected: 'found on this computer' }[check.source] || ''}` : ''}`
      : 'No Java selected';
  return (
    <div className={`jx-compat is-${check.status || 'ok'}${loading ? ' is-loading' : ''}${compact ? ' is-compact' : ''}`} role="status">
      <div className="jx-compat-head">
        <NativeIcon name={check.status === 'error' ? 'alert' : check.status === 'warn' ? 'info' : 'check-circle'} size={15} />
        <span>
          {check.status === 'error'
            ? `Won’t start Minecraft ${mcVersion}`
            : check.status === 'warn'
              ? `Works with Minecraft ${mcVersion}, with caveats`
              : `Compatible with Minecraft ${mcVersion}`}
          {check.requiredMajor ? <em> · needs Java {check.requiredMajor}+</em> : null}
        </span>
      </div>
      <span className="jx-compat-runtime">{summary}</span>
      {issues.length > 0 && (
        <ul className="jx-compat-list">
          {issues.map((issue, i) => (
            <li key={i} className={`is-${issue.level}`}>{issue.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
