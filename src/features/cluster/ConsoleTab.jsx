import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import NativeIcon from '../../components/ui/NativeIcon.jsx';
import useGameConsole from './useGameConsole.js';
import './ConsoleTab.css';

const ROW = 20;
const OVERSCAN = 30;
const LEVELS = [
  { id: 'all', label: 'All' },
  { id: 'info', label: 'Info' },
  { id: 'warn', label: 'Warn' },
  { id: 'severe', label: 'Severe' }
];
const SERVICES = [
  { id: 'mclogs', label: 'mclo.gs', hint: 'Public link with automatic log analysis' },
  { id: 'pastesdev', label: 'pastes.dev', hint: 'Unlisted plain-text paste' }
];

const norm = (text) => String(text || '').trim().slice(0, 400);

function matchesLevel(line, level) {
  if (level === 'all') return true;
  if (line.src === 'launcher') return false;
  if (level === 'info') return line.lv === 'info' || line.lv === 'debug';
  return line.lv === level;
}

function Highlighted({ text, query }) {
  if (!query) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts = [];
  let from = 0;
  let at = lower.indexOf(q);
  while (at !== -1 && parts.length < 40) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(<mark key={at}>{text.slice(at, at + q.length)}</mark>);
    from = at + q.length;
    at = lower.indexOf(q, from);
  }
  parts.push(text.slice(from));
  return parts;
}

function useCrashForSession(instanceId, meta) {
  const [record, setRecord] = useState(null);
  const load = useCallback(async () => {
    const api = window.native?.crash;
    if (!api || !instanceId) return;
    try {
      const list = await api.list(instanceId);
      const latest = list?.[0];
      // Only a crash from the run this console shows.
      const since = meta.source === 'live' ? (meta.startedAt || 0) - 1000 : (meta.endedAt || 0) - 5 * 60 * 1000;
      if (!latest || latest.manual || !meta.source || meta.source === 'empty' || latest.at < since) {
        setRecord(null);
        return;
      }
      setRecord(await api.get(latest.id));
    } catch {
      setRecord(null);
    }
  }, [instanceId, meta.source, meta.startedAt, meta.endedAt]);

  useEffect(() => {
    load();
    const off = window.native?.crash?.onDetected?.((next) => {
      if (next?.instance?.id === instanceId) load();
    });
    return () => off?.();
  }, [instanceId, load]);
  return record;
}

export default function ConsoleTab({ cluster, query = '', running = false, onAnalyzeCrash, onOpenCrashReport, onNotify }) {
  const { lines, version, meta, loading, clear } = useGameConsole(cluster.id);
  const [level, setLevel] = useState('all');
  const [showLauncher, setShowLauncher] = useState(true);
  const [follow, setFollow] = useState(true);
  const [shareOpen, setShareOpen] = useState(false);
  const [busy, setBusy] = useState(null);
  const [confirmKill, setConfirmKill] = useState(false);
  const [view, setView] = useState({ top: 0, height: 400 });
  const [flash, setFlash] = useState(null);
  const scrollRef = useRef(null);
  const shareRef = useRef(null);
  const followRef = useRef(true);
  followRef.current = follow;
  const crash = useCrashForSession(cluster.id, meta);
  const live = meta.running || running;

  const crashHits = useMemo(() => {
    const set = new Set();
    for (const row of crash?.report?.excerpt || []) if (row.hit && row.text) set.add(norm(row.text));
    return set;
  }, [crash]);

  const counts = useMemo(() => {
    const c = { all: lines.length, info: 0, warn: 0, severe: 0, launcher: 0 };
    for (const line of lines) {
      if (line.src === 'launcher') c.launcher += 1;
      else if (line.lv === 'debug' || line.lv === 'info') c.info += 1;
      else c[line.lv] += 1;
    }
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, version]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return lines.filter((line) =>
      (showLauncher || line.src !== 'launcher')
      && matchesLevel(line, level)
      && (!q || line.text.toLowerCase().includes(q)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, version, level, showLauncher, query]);

  const isHit = useCallback((line) => crashHits.size > 0 && crashHits.has(norm(line.text)), [crashHits]);
  const causeIndex = useMemo(() => {
    let index = visible.findIndex(isHit);
    if (index === -1) index = visible.findIndex((line) => line.mk === 'dep');
    if (index === -1) index = visible.findIndex((line) => line.mk === 'crash');
    return index;
  }, [visible, isHit]);

  /* ---- scrolling / windowing */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const measure = () => {
      // The crash strip can appear after the first paint; stay pinned to the end.
      if (followRef.current) el.scrollTop = el.scrollHeight;
      setView({ top: el.scrollTop, height: el.clientHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && follow) {
      el.scrollTop = el.scrollHeight;
      setView({ top: el.scrollTop, height: el.clientHeight });
    }
  }, [visible.length, follow]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setView({ top: el.scrollTop, height: el.clientHeight });
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW * 2;
    if (atBottom !== follow) setFollow(atBottom);
  };

  const scrollToIndex = (index) => {
    const el = scrollRef.current;
    if (!el || index < 0) return;
    setFollow(false);
    el.scrollTop = Math.max(0, index * ROW - el.clientHeight / 3);
    setFlash(visible[index]?.n ?? null);
    setTimeout(() => setFlash(null), 1600);
  };

  const jumpToCause = () => {
    if (causeIndex === -1 && (level !== 'all' || query)) {
      setLevel('all');
      return;
    }
    scrollToIndex(causeIndex);
  };

  const start = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN);
  const end = Math.min(visible.length, Math.ceil((view.top + view.height) / ROW) + OVERSCAN);
  const rows = visible.slice(start, end);
  const gutter = Math.max(3, String(lines[lines.length - 1]?.n || 0).length);

  /* ---- actions */
  useEffect(() => {
    if (!shareOpen) return undefined;
    const close = (event) => { if (!shareRef.current?.contains(event.target)) setShareOpen(false); };
    const esc = (event) => { if (event.key === 'Escape') setShareOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [shareOpen]);

  useEffect(() => {
    if (!confirmKill) return undefined;
    const timer = setTimeout(() => setConfirmKill(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmKill]);

  const copy = async () => {
    const source = level === 'all' && !query && showLauncher ? lines : visible;
    try {
      await navigator.clipboard.writeText(source.map((line) => line.text).join('\n'));
      onNotify?.('Copied', `${source.length.toLocaleString()} line${source.length === 1 ? '' : 's'} on your clipboard.`);
    } catch (error) {
      onNotify?.('Could not copy', error?.message || String(error));
    }
  };

  const save = async () => {
    try {
      const result = await window.native?.console?.save(cluster.id);
      if (result?.ok) onNotify?.('Log saved', result.path);
    } catch (error) {
      onNotify?.('Could not save the log', error?.message || String(error));
    }
  };

  const share = async (service) => {
    setShareOpen(false);
    setBusy(service);
    try {
      const result = await window.native.console.upload(cluster.id, service);
      try { await navigator.clipboard.writeText(result.url); } catch { /* clipboard denied */ }
      onNotify?.(`Uploaded to ${result.service}`, `${result.url.replace(/^https?:\/\//, '')} · link copied`);
      window.native?.openExternal?.(result.url);
    } catch (error) {
      onNotify?.('Upload failed', error?.message || String(error));
    } finally {
      setBusy(null);
    }
  };

  const forceStop = async () => {
    if (!confirmKill) {
      setConfirmKill(true);
      return;
    }
    setConfirmKill(false);
    try {
      await (window.native?.launcher?.stop?.({ force: true }) ?? window.native?.launcher?.kill?.({ force: true }));
    } catch (error) {
      onNotify?.('Could not stop Minecraft', error?.message || String(error));
    }
  };

  const status = live
    ? { tone: 'live', text: 'Live' }
    : meta.source === 'file'
      ? { tone: 'idle', text: `latest.log${meta.endedAt ? ` · ${new Date(meta.endedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : ''}` }
      : meta.exit
        ? meta.exit.killed
          ? { tone: 'idle', text: 'Stopped' }
          : { tone: meta.exit.code && meta.exit.code !== 0 ? 'bad' : 'idle', text: meta.exit.signal ? `Ended · ${meta.exit.signal}` : `Exited · code ${meta.exit.code}` }
        : { tone: 'idle', text: 'No session' };

  const issues = crash?.report?.issues || [];
  const missing = issues.filter((issue) => issue.id === 'missing-dependency');

  return (
    <div className="gc-root">
      <div className="gc-bar">
        <div className="gc-levels" role="radiogroup" aria-label="Log level">
          {LEVELS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={level === item.id}
              className={`gc-pill gc-pill-${item.id}${level === item.id ? ' is-on' : ''}`}
              onClick={() => setLevel(item.id)}
            >
              {item.id !== 'all' && <span className="gc-dot" aria-hidden="true" />}
              {item.label}
              {item.id !== 'all' && <span className="gc-count">{counts[item.id].toLocaleString()}</span>}
            </button>
          ))}
          <span className="gc-sep" aria-hidden="true" />
          <button
            type="button"
            className={`gc-pill gc-pill-launcher${showLauncher ? ' is-on' : ''}`}
            aria-pressed={showLauncher}
            title="Show Native and launch-pipeline messages"
            onClick={() => setShowLauncher(!showLauncher)}
          >
            Launcher
            <span className="gc-count">{counts.launcher.toLocaleString()}</span>
          </button>
        </div>

        <div className="gc-actions">
          <button type="button" className="gc-icon" title="Copy" aria-label="Copy log" onClick={copy} disabled={!lines.length}>
            <NativeIcon name="copy" size={15} />
          </button>
          <button type="button" className="gc-icon" title="Save as file" aria-label="Save log as file" onClick={save} disabled={!lines.length}>
            <NativeIcon name="download" size={15} />
          </button>
          <div className="gc-share" ref={shareRef}>
            <button
              type="button"
              className={`gc-btn${shareOpen ? ' is-open' : ''}`}
              onClick={() => setShareOpen(!shareOpen)}
              disabled={!lines.length || Boolean(busy)}
              aria-haspopup="menu"
              aria-expanded={shareOpen}
            >
              <NativeIcon name={busy ? 'loader' : 'upload'} size={14} className={busy ? 'gc-spin' : ''} />
              {busy ? 'Uploading…' : 'Share'}
            </button>
            {shareOpen && (
              <div className="gc-menu" role="menu">
                {SERVICES.map((service) => (
                  <button key={service.id} type="button" role="menuitem" className="gc-menu-item" onClick={() => share(service.id)}>
                    <span className="gc-menu-title">{service.label}</span>
                    <span className="gc-menu-hint">{service.hint}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {live && (
            <button
              type="button"
              className={`gc-btn gc-btn-danger${confirmKill ? ' is-armed' : ''}`}
              onClick={forceStop}
              title="Ends the Java process and anything it started. Unsaved progress is lost."
            >
              <NativeIcon name="stop" size={13} />
              {confirmKill ? 'Click again to kill' : 'Force stop'}
            </button>
          )}
        </div>
      </div>

      {crash?.report && (
        <div className="gc-crash" role="status">
          <NativeIcon name="bug" size={16} className="gc-crash-icon" />
          <div className="gc-crash-text">
            <strong>{crash.report.headline || 'Minecraft crashed'}</strong>
            {missing.length > 0 ? (
              <span>
                Missing: {missing.map((issue) => issue.title.replace(/ is missing$/, '')).join(', ')}
              </span>
            ) : (
              crash.report.summary && <span>{crash.report.summary}</span>
            )}
          </div>
          <div className="gc-crash-actions">
            {(causeIndex !== -1 || level !== 'all' || query) && (
              <button type="button" className="gc-btn" onClick={jumpToCause}>
                <NativeIcon name="arrow-down" size={13} />
                Jump to cause
              </button>
            )}
            {onOpenCrashReport && (
              <button type="button" className="gc-btn gc-btn-accent" onClick={() => onOpenCrashReport(crash.id)}>
                Show fixes
              </button>
            )}
          </div>
        </div>
      )}

      <div className="gc-screen-wrap">
        <div
          className="gc-screen"
          ref={scrollRef}
          onScroll={onScroll}
          role="log"
          aria-live="off"
          aria-label="Game console"
          tabIndex={0}
        >
          {visible.length > 0 ? (
            <div className="gc-rows" style={{ height: visible.length * ROW, '--gc-gutter': `${gutter}ch` }}>
              {rows.map((line, i) => {
                const hit = isHit(line);
                return (
                  <div
                    key={line.n}
                    className={[
                      'gc-line',
                      `lv-${line.src === 'launcher' ? 'launcher' : line.lv}`,
                      line.mk ? `mk-${line.mk}` : '',
                      hit ? 'is-hit' : '',
                      flash === line.n ? 'is-flash' : ''
                    ].join(' ')}
                    style={{ top: (start + i) * ROW }}
                  >
                    <span className="gc-n">{line.n}</span>
                    <span className="gc-text"><Highlighted text={line.text} query={query.trim()} /></span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="gc-empty">
              {loading ? (
                <span>Loading…</span>
              ) : lines.length ? (
                <span>No lines match {query ? `“${query}”` : 'this filter'}.</span>
              ) : (
                <>
                  <NativeIcon name="code" size={22} />
                  <strong>Nothing here yet</strong>
                  <span>Launch this instance and its output streams in live: launcher steps, mod loading, warnings and errors.</span>
                </>
              )}
            </div>
          )}
        </div>
        {!follow && visible.length > 0 && (
          <button
            type="button"
            className="gc-follow"
            onClick={() => {
              setFollow(true);
              const el = scrollRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
          >
            <NativeIcon name="arrow-down" size={13} />
            {live ? 'Follow live output' : 'Jump to end'}
          </button>
        )}
      </div>

      <div className="gc-foot">
        <span className="gc-foot-info">
          <span className={`gc-status is-${status.tone}`}>
            <span className="gc-status-dot" aria-hidden="true" />
            {status.text}
          </span>
          <span className="gc-foot-sep" aria-hidden="true">·</span>
          {visible.length === lines.length
            ? `${lines.length.toLocaleString()} lines`
            : `${visible.length.toLocaleString()} of ${lines.length.toLocaleString()} lines`}
          {meta.dropped > 0 && ` · ${meta.dropped.toLocaleString()} older lines trimmed`}
        </span>
        <span className="gc-foot-actions">
          {onAnalyzeCrash && (
            <button type="button" className="gc-link" onClick={() => onAnalyzeCrash(cluster)}>
              Analyze this log
            </button>
          )}
          {meta.source === 'live' && !live && lines.length > 0 && (
            <button type="button" className="gc-link" onClick={clear}>Clear</button>
          )}
        </span>
      </div>
    </div>
  );
}
