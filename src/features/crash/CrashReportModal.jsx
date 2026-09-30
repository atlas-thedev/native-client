import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Check, ChevronDown, CircleArrowUp, Coffee, Copy, Cpu, Download, ExternalLink, FileText, FileWarning,
  FolderOpen, Gamepad2, Globe, History, Layers, LoaderCircle, MemoryStick, Monitor, MonitorX, Play, PowerOff, Puzzle,
  RefreshCw, RotateCcw, Search, Settings2, Share2, Sparkles, Terminal, Wrench, X, Zap
} from 'lucide-react';
import './CrashReportModal.css';

const RENDERER_KINDS = new Set(['memory', 'java-auto', 'jvm-reset', 'jvm-add', 'loader-latest']);

const CATEGORY = {
  mods: { icon: Puzzle, label: 'Mods' },
  java: { icon: Coffee, label: 'Java' },
  memory: { icon: MemoryStick, label: 'Memory' },
  graphics: { icon: MonitorX, label: 'Graphics' },
  files: { icon: FileWarning, label: 'Game files' },
  world: { icon: Globe, label: 'World' },
  config: { icon: Settings2, label: 'Config' },
  system: { icon: Cpu, label: 'System' },
  game: { icon: Gamepad2, label: 'Game' }
};

const FIX_ICON = {
  'disable-mod': PowerOff,
  'update-mod': RefreshCw,
  'install-mod': Download,
  memory: MemoryStick,
  java: Coffee,
  'java-auto': Coffee,
  'jvm-reset': Terminal,
  'jvm-add': Terminal,
  'loader-latest': CircleArrowUp,
  'reset-config': RotateCcw,
  repair: Wrench,
  'open-url': ExternalLink,
  'open-folder': FolderOpen,
  'disable-shaders': Sparkles,
  'reset-resourcepacks': Layers,
  'forge-early-window': Monitor
};

const FIX_VERB = {
  'disable-mod': 'Disable',
  'update-mod': 'Update',
  'install-mod': 'Install',
  memory: 'Apply',
  java: 'Use',
  'java-auto': 'Apply',
  'jvm-reset': 'Remove',
  'jvm-add': 'Add',
  'loader-latest': 'Update',
  'reset-config': 'Reset',
  repair: 'Repair',
  'open-url': 'Open',
  'open-folder': 'Open',
  'disable-shaders': 'Turn off',
  'reset-resourcepacks': 'Turn off',
  'forge-early-window': 'Turn off'
};

function confidenceLabel(value) {
  if (value >= 90) return 'Certain';
  if (value >= 75) return 'Very likely';
  if (value >= 55) return 'Likely';
  return 'Best guess';
}

function timeAgo(at) {
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (secs < 45) return 'just now';
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
  return new Date(at).toLocaleDateString();
}

function cleanError(error) {
  return String(error?.message || error || 'Something went wrong').replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
}

function FixRow({ fix, state, onRun, compact = false }) {
  const Icon = FIX_ICON[fix.kind] || Wrench;
  const status = state?.status || 'idle';
  const done = status === 'done';
  return (
    <div className={`crash-fix${fix.recommended ? ' is-recommended' : ''}${done ? ' is-done' : ''}${compact ? ' is-compact' : ''}`}>
      <span className="crash-fix-icon"><Icon size={compact ? 14 : 16} strokeWidth={2.1} /></span>
      <span className="crash-fix-text">
        <span className="crash-fix-label">
          {fix.label}
          {fix.recommended && !done && <span className="crash-fix-badge">Recommended</span>}
        </span>
        {(state?.message || fix.detail) && (
          <span className={`crash-fix-detail${status === 'failed' ? ' is-error' : ''}`}>{state?.message || fix.detail}</span>
        )}
      </span>
      <button
        type="button"
        className={`crash-pill${fix.recommended && !done ? ' is-accent' : ''}${done ? ' is-done' : ''}`}
        disabled={status === 'working' || done}
        onClick={() => onRun(fix)}
      >
        {status === 'working' ? <LoaderCircle size={14} className="crash-spin" /> : done ? <Check size={14} strokeWidth={2.6} /> : null}
        <span>{status === 'working' ? 'Working' : done ? 'Done' : status === 'failed' ? 'Retry' : FIX_VERB[fix.kind] || 'Apply'}</span>
      </button>
    </div>
  );
}

function Evidence({ rows }) {
  if (!rows?.length) return null;
  return (
    <div className="crash-code" role="region" aria-label="Evidence from the logs">
      {rows.map((row, index) => row.gap
        ? <div key={`g${index}`} className="crash-code-gap">···</div>
        : (
          <div key={`${row.src}-${row.n}-${index}`} className={`crash-code-line${row.hit ? ' is-hit' : ''}`}>
            <span className="crash-code-n">{row.n}</span>
            <span className="crash-code-t">{row.text || ' '}</span>
          </div>
        ))}
    </div>
  );
}

function FullLog({ id }) {
  const [text, setText] = useState(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    let alive = true;
    window.native?.crash?.log(id).then((value) => { if (alive) setText(value || ''); }).catch(() => { if (alive) setText(''); });
    return () => { alive = false; };
  }, [id]);
  const lines = useMemo(() => {
    const all = (text || '').split('\n');
    const q = query.trim().toLowerCase();
    const picked = q ? all.map((t, i) => [t, i]).filter(([t]) => t.toLowerCase().includes(q)) : all.map((t, i) => [t, i]);
    return picked.slice(-4000);
  }, [text, query]);
  if (text === null) return <div className="crash-muted"><LoaderCircle size={14} className="crash-spin" /> Loading log</div>;
  return (
    <div className="crash-fulllog">
      <label className="crash-search">
        <Search size={14} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter log lines" spellCheck={false} />
        <span>{lines.length.toLocaleString()} lines</span>
      </label>
      <div className="crash-code is-tall">
        {lines.map(([t, i]) => (
          <div key={i} className={`crash-code-line${/\b(?:ERROR|FATAL|Exception|Error:|Caused by)\b/.test(t) ? ' is-warn' : ''}`}>
            <span className="crash-code-n">{i + 1}</span>
            <span className="crash-code-t">{t || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function CrashReportModal({ open, analyzing, record, error, onClose, onOpenReport, onApplyInstanceFix, onRelaunch }) {
  const [fixState, setFixState] = useState({});
  const [history, setHistory] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [toast, setToast] = useState(null);
  const [shareState, setShareState] = useState('idle');
  const toastTimer = useRef(null);
  const report = record?.report;

  useEffect(() => {
    setFixState(Object.fromEntries((record?.applied || []).map((id) => [id, { status: 'done' }])));
    setShowLog(false);
    setExpanded(null);
    setShareState(record?.shareUrl ? 'done' : 'idle');
  }, [record?.id]);

  useEffect(() => {
    if (!open) return undefined;
    window.native?.crash?.list().then((items) => setHistory(items || [])).catch(() => {});
    const onKey = (event) => { if (event.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, record?.id, onClose]);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const flash = (text) => {
    clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  };

  const runFix = async (fix) => {
    if (!record) return null;
    setFixState((prev) => ({ ...prev, [fix.id]: { status: 'working' } }));
    try {
      let result;
      if (RENDERER_KINDS.has(fix.kind)) {
        result = await onApplyInstanceFix(record, fix);
      } else {
        result = await window.native.crash.applyFix(record.id, fix);
        if (result?.ok && result.instancePatch) await onApplyInstanceFix(record, { kind: 'patch', patch: result.instancePatch });
      }
      setFixState((prev) => ({
        ...prev,
        [fix.id]: { status: result?.ok ? (result.silent ? 'idle' : 'done') : 'failed', message: result?.message }
      }));
      return result;
    } catch (err) {
      setFixState((prev) => ({ ...prev, [fix.id]: { status: 'failed', message: cleanError(err) } }));
      return { ok: false };
    }
  };

  const primary = report?.issues?.[0];
  const recommended = primary?.fixes?.find((fix) => fix.recommended && !['open-url', 'open-folder'].includes(fix.kind));
  const recommendedDone = recommended && fixState[recommended.id]?.status === 'done';

  const fixAndRelaunch = async () => {
    if (recommended && !recommendedDone) {
      const result = await runFix(recommended);
      if (!result?.ok) return;
    }
    onRelaunch?.(record);
  };

  const copyReport = async () => {
    try {
      const text = await window.native.crash.text(record.id);
      await navigator.clipboard.writeText(text);
      flash('Report copied');
    } catch (err) {
      flash(cleanError(err));
    }
  };

  const shareLog = async () => {
    setShareState('working');
    try {
      const { url } = await window.native.crash.share(record.id);
      await navigator.clipboard.writeText(url).catch(() => {});
      setShareState('done');
      flash('Link copied: ' + url.replace(/^https?:\/\//, ''));
    } catch (err) {
      setShareState('idle');
      flash(cleanError(err));
    }
  };

  if (!open) return null;

  const instance = record?.instance || analyzing?.instance;
  const Category = CATEGORY[report?.category]?.icon || AlertTriangle;
  const facts = report?.facts || {};
  const factRows = [
    ['Java', facts.java],
    ['Memory', facts.memory],
    ['GPU', facts.gpu],
    ['System', facts.os],
    ['Mods', report?.modCount ? String(report.modCount) : null],
    ['Exit code', record?.exitCode !== null && record?.exitCode !== undefined ? String(record.exitCode) : null]
  ].filter(([, value]) => value);
  const earlier = history.filter((item) => item.id !== record?.id).slice(0, 8);

  return (
    <div className="crash-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
      <div className="crash-modal" role="dialog" aria-modal="true" aria-label="Crash report">
        <header className="crash-head">
          <span className={`crash-head-icon${analyzing ? ' is-busy' : ''}`}>
            {analyzing ? <LoaderCircle size={20} className="crash-spin" /> : <Category size={20} strokeWidth={2} />}
          </span>
          <div className="crash-head-text">
            <div className="crash-eyebrow">
              <span className="crash-dot" />
              {record?.manual ? 'Crash analysis' : 'Minecraft crashed'}
              {instance?.name && <><span className="crash-sep">/</span>{instance.name}</>}
              {instance?.version && <><span className="crash-sep">/</span>{instance.version} {instance.loader !== 'Vanilla' ? instance.loader : ''}</>}
              {record?.at && <><span className="crash-sep">/</span>{timeAgo(record.at)}</>}
            </div>
            <h2 className="crash-title">
              {analyzing ? 'Analyzing the crash' : error ? 'Could not analyze the crash' : report?.headline || 'Crash report'}
            </h2>
          </div>
          {earlier.length > 0 && (
            <div className="crash-history">
              <button type="button" className="crash-icon-btn" onClick={() => setHistoryOpen((v) => !v)} aria-label="Earlier crashes" title="Earlier crashes">
                <History size={16} />
              </button>
              {historyOpen && (
                <div className="crash-history-menu">
                  <div className="crash-history-title">Earlier crashes</div>
                  {earlier.map((item) => (
                    <button key={item.id} type="button" className="crash-history-item" onClick={() => { setHistoryOpen(false); onOpenReport?.(item.id); }}>
                      <span className="crash-history-head">{item.headline || 'Crash'}</span>
                      <span className="crash-history-meta">{item.instance?.name} / {timeAgo(item.at)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button type="button" className="crash-icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>

        {analyzing && (
          <div className="crash-analyzing">
            {['Reading the game log and crash report', 'Indexing your mods', 'Matching known crash signatures', 'Preparing fixes'].map((step, index) => (
              <div key={step} className="crash-step" style={{ animationDelay: `${index * 0.45}s` }}>
                <span className="crash-step-dot" />{step}
              </div>
            ))}
          </div>
        )}

        {error && !analyzing && <div className="crash-body-empty">{error}</div>}

        {report && !analyzing && (
          <div className="crash-body">
            <div className="crash-main">
              <section className="crash-diagnosis">
                <p className="crash-summary">{report.summary}</p>
                <div className="crash-meter" title={`${report.confidence}% confidence`}>
                  <span className="crash-meter-track"><span className="crash-meter-fill" style={{ width: `${report.confidence}%` }} /></span>
                  <span className="crash-meter-label">{confidenceLabel(report.confidence)}</span>
                  <span className="crash-chip">{CATEGORY[report.category]?.label || 'Game'}</span>
                  {primary?.fromMetadata && <span className="crash-chip">From mod files</span>}
                </div>
              </section>

              {primary?.fixes?.length > 0 && (
                <section className="crash-section">
                  <h3 className="crash-h3"><Zap size={14} /> Quick fixes</h3>
                  <div className="crash-fixes">
                    {primary.fixes.map((fix) => <FixRow key={fix.id} fix={fix} state={fixState[fix.id]} onRun={runFix} />)}
                  </div>
                </section>
              )}

              {report.issues.length > 1 && (
                <section className="crash-section">
                  <h3 className="crash-h3">Also found</h3>
                  <div className="crash-issues">
                    {report.issues.slice(1).map((issue, index) => {
                      const Icon = CATEGORY[issue.category]?.icon || AlertTriangle;
                      const isOpen = expanded === index;
                      return (
                        <div key={`${issue.id}-${index}`} className={`crash-issue${isOpen ? ' is-open' : ''}`}>
                          <button type="button" className="crash-issue-head" onClick={() => setExpanded(isOpen ? null : index)}>
                            <Icon size={15} />
                            <span className="crash-issue-title">{issue.title}</span>
                            <span className="crash-issue-conf">{confidenceLabel(issue.confidence)}</span>
                            <ChevronDown size={15} className="crash-chev" />
                          </button>
                          {isOpen && (
                            <div className="crash-issue-body">
                              <p>{issue.explanation}</p>
                              {issue.fixes.map((fix) => <FixRow key={fix.id} fix={fix} state={fixState[fix.id]} onRun={runFix} compact />)}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              <section className="crash-section">
                <div className="crash-h3-row">
                  <h3 className="crash-h3"><FileText size={14} /> {showLog ? 'Full log' : 'Evidence'}</h3>
                  <button type="button" className="crash-link" onClick={() => setShowLog((v) => !v)}>{showLog ? 'Show evidence' : 'Show full log'}</button>
                </div>
                {showLog ? <FullLog id={record.id} /> : report.excerpt?.length ? <Evidence rows={report.excerpt} /> : <div className="crash-muted">No log lines were captured for this crash.</div>}
              </section>
            </div>

            <aside className="crash-aside">
              {report.suspects?.length > 0 && (
                <section className="crash-card">
                  <h3 className="crash-h3">Suspected mods</h3>
                  {report.suspects.map((mod, index) => {
                    const fix = { kind: 'disable-mod', file: mod.file, name: mod.name, label: `Disable ${mod.name}`, id: `disable-mod:${mod.file}` };
                    const st = fixState[fix.id];
                    return (
                      <div key={mod.file} className="crash-suspect">
                        <span className="crash-suspect-rank">{index + 1}</span>
                        <span className="crash-suspect-text">
                          <span className="crash-suspect-name">{mod.name}{mod.version ? <em> {mod.version}</em> : null}</span>
                          <span className="crash-suspect-file" title={mod.file}>{mod.file}</span>
                        </span>
                        <button type="button" className={`crash-mini${st?.status === 'done' ? ' is-done' : ''}`} disabled={st?.status === 'working' || st?.status === 'done'} onClick={() => runFix(fix)} title={st?.message || 'Disable this mod'}>
                          {st?.status === 'working' ? <LoaderCircle size={13} className="crash-spin" /> : st?.status === 'done' ? <Check size={13} /> : <PowerOff size={13} />}
                        </button>
                      </div>
                    );
                  })}
                </section>
              )}

              {(factRows.length > 0 || report.exitMeaning) && (
                <section className="crash-card">
                  <h3 className="crash-h3">Details</h3>
                  {factRows.map(([key, value]) => (
                    <div key={key} className="crash-fact"><span>{key}</span><span title={value}>{value}</span></div>
                  ))}
                  {report.exitMeaning && <p className="crash-exit">{report.exitMeaning}</p>}
                  {report.exception && (
                    <p className="crash-exception" title={`${report.exception.type}: ${report.exception.message}`}>
                      <code>{report.exception.type.split('.').pop()}</code>{report.exception.message ? ` ${report.exception.message.slice(0, 160)}` : ''}
                    </p>
                  )}
                </section>
              )}

              <section className="crash-card crash-files">
                {record.files?.crashReport && <button type="button" className="crash-file-btn" onClick={() => window.native.crash.open(record.id, 'crash')}><FileText size={14} /> Crash report</button>}
                {record.files?.hsErr && <button type="button" className="crash-file-btn" onClick={() => window.native.crash.open(record.id, 'jvm')}><FileWarning size={14} /> JVM error log</button>}
                <button type="button" className="crash-file-btn" onClick={() => window.native.crash.open(record.id, 'log')}><Terminal size={14} /> Captured log</button>
                <button type="button" className="crash-file-btn" onClick={() => window.native.crash.open(record.id, 'mods')}><FolderOpen size={14} /> Mods folder</button>
              </section>
            </aside>
          </div>
        )}

        {report && !analyzing && (
          <footer className="crash-foot">
            <button type="button" className="crash-pill is-ghost" onClick={shareLog} disabled={shareState === 'working'}>
              {shareState === 'working' ? <LoaderCircle size={14} className="crash-spin" /> : shareState === 'done' ? <Check size={14} /> : <Share2 size={14} />}
              <span>{shareState === 'done' ? 'Link copied' : 'Share log'}</span>
            </button>
            <button type="button" className="crash-pill is-ghost" onClick={copyReport}><Copy size={14} /><span>Copy report</span></button>
            <span className="crash-foot-space" />
            {toast && <span className="crash-toast">{toast}</span>}
            <button type="button" className={`crash-pill${!recommended || recommendedDone ? ' is-accent is-strong' : ''}`} onClick={() => onRelaunch?.(record)}><Play size={14} /><span>Relaunch</span></button>
            {recommended && !recommendedDone && (
              <button type="button" className="crash-pill is-accent is-strong" onClick={fixAndRelaunch} disabled={fixState[recommended.id]?.status === 'working'}>
                {fixState[recommended.id]?.status === 'working' ? <LoaderCircle size={14} className="crash-spin" /> : <Zap size={14} />}
                <span>Fix and relaunch</span>
              </button>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}
