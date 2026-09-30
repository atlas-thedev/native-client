import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, History, LoaderCircle, X } from 'lucide-react';
import './CrashReportModal.css';

const RENDERER_KINDS = new Set(['memory', 'java-auto', 'jvm-reset', 'jvm-add', 'loader-latest']);

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

const STEPS = ['Reading the game log', 'Indexing your mods', 'Matching known crash signatures', 'Preparing fixes'];

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

function FixRow({ fix, state, onRun }) {
  const status = state?.status || 'idle';
  const done = status === 'done';
  return (
    <div className={`crash-fix${done ? ' is-done' : ''}`}>
      <div className="crash-fix-text">
        <div className="crash-fix-label">{fix.label}</div>
        {(state?.message || fix.detail) && (
          <div className={`crash-fix-detail${status === 'failed' ? ' is-error' : ''}`}>{state?.message || fix.detail}</div>
        )}
      </div>
      <button
        type="button"
        className={`crash-pill${done ? ' is-done' : ''}`}
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
  const [showDetails, setShowDetails] = useState(false);
  const [step, setStep] = useState(0);
  const [expanded, setExpanded] = useState(null);
  const [toast, setToast] = useState(null);
  const [shareState, setShareState] = useState('idle');
  const toastTimer = useRef(null);
  const report = record?.report;

  useEffect(() => {
    setFixState(Object.fromEntries((record?.applied || []).map((id) => [id, { status: 'done' }])));
    setShowLog(false);
    setShowDetails(false);
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

  useEffect(() => {
    if (!analyzing) { setStep(0); return undefined; }
    const timer = setInterval(() => setStep((value) => Math.min(value + 1, STEPS.length - 1)), 1100);
    return () => clearInterval(timer);
  }, [analyzing]);

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
  const facts = report?.facts || {};
  const factRows = [
    ['Java', facts.java],
    ['Memory', facts.memory],
    ['Graphics', facts.gpu],
    ['System', facts.os],
    ['Mods', report?.modCount ? String(report.modCount) : null],
    ['Exit code', record?.exitCode !== null && record?.exitCode !== undefined ? String(record.exitCode) : null]
  ].filter(([, value]) => value);
  const earlier = history.filter((item) => item.id !== record?.id).slice(0, 8);
  const meta = [
    instance?.name,
    instance?.version ? `${instance.loader && instance.loader !== 'Vanilla' ? `${instance.loader} ` : ''}${instance.version}` : null,
    record?.at ? timeAgo(record.at) : null
  ].filter(Boolean).join(' \u00b7 ');
  const suspects = report?.suspects || [];
  const unsure = report && report.confidence < 75;

  return (
    <div className="crash-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
      <div className="crash-modal" role="dialog" aria-modal="true" aria-label="Crash report">
        <header className="crash-head">
          <div className="crash-head-text">
            <h2 className="crash-title">
              {analyzing ? 'Analyzing the crash' : error ? 'Could not analyze the crash' : report?.headline || 'Crash report'}
            </h2>
            {meta && <div className="crash-meta">{meta}</div>}
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
                      <span className="crash-history-meta">{item.instance?.name} &middot; {timeAgo(item.at)}</span>
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
            <LoaderCircle size={16} className="crash-spin" />
            <span key={step} className="crash-step">{STEPS[step]}</span>
          </div>
        )}

        {error && !analyzing && <div className="crash-body-empty">{error}</div>}

        {report && !analyzing && (
          <div className="crash-body">
            <p className="crash-summary">{report.summary}</p>
            {(unsure || suspects.length > 1) && (
              <p className="crash-note">
                {unsure ? 'This is a best guess. ' : ''}
                {suspects.length > 1 ? `Suspects: ${suspects.map((mod) => mod.name).join(', ')}.` : ''}
              </p>
            )}

            {primary?.fixes?.length > 0 && (
              <section className="crash-section">
                <h3 className="crash-h3">Fix</h3>
                <div className="crash-fixes">
                  {primary.fixes.map((fix) => <FixRow key={fix.id} fix={fix} state={fixState[fix.id]} onRun={runFix} />)}
                </div>
              </section>
            )}

            {report.issues.length > 1 && (
              <section className="crash-section">
                <h3 className="crash-h3">Also found</h3>
                <div className="crash-fixes">
                  {report.issues.slice(1).map((issue, index) => {
                    const isOpen = expanded === index;
                    return (
                      <div key={`${issue.id}-${index}`} className="crash-issue">
                        <button type="button" className="crash-issue-head" onClick={() => setExpanded(isOpen ? null : index)} aria-expanded={isOpen}>
                          <span className="crash-issue-title">{issue.title}</span>
                          <ChevronDown size={15} className={`crash-chev${isOpen ? ' is-open' : ''}`} />
                        </button>
                        {isOpen && (
                          <div className="crash-issue-body">
                            <p>{issue.explanation}</p>
                            {issue.fixes.map((fix) => <FixRow key={fix.id} fix={fix} state={fixState[fix.id]} onRun={runFix} />)}
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
                <h3 className="crash-h3">{showLog ? 'Full log' : 'From the log'}</h3>
                <button type="button" className="crash-link" onClick={() => setShowLog((v) => !v)}>{showLog ? 'Back to excerpt' : 'Full log'}</button>
              </div>
              {showLog ? <FullLog id={record.id} /> : report.excerpt?.length ? <Evidence rows={report.excerpt} /> : <div className="crash-muted">No log lines were captured for this crash.</div>}
            </section>

            <section className="crash-section">
              <button type="button" className="crash-disclosure" onClick={() => setShowDetails((v) => !v)} aria-expanded={showDetails}>
                <ChevronDown size={14} className={`crash-chev${showDetails ? ' is-open' : ''}`} /> Technical details
              </button>
              {showDetails && (
                <div className="crash-details">
                  <dl>
                    {factRows.map(([key, value]) => (<div key={key}><dt>{key}</dt><dd title={value}>{value}</dd></div>))}
                  </dl>
                  {report.exitMeaning && <p>{report.exitMeaning}</p>}
                  {report.exception && (
                    <p title={`${report.exception.type}: ${report.exception.message}`}>
                      <code>{report.exception.type.split('.').pop()}</code>{report.exception.message ? ` ${report.exception.message.slice(0, 160)}` : ''}
                    </p>
                  )}
                  <div className="crash-files">
                    {record.files?.crashReport && <button type="button" className="crash-link" onClick={() => window.native.crash.open(record.id, 'crash')}>Crash report</button>}
                    {record.files?.hsErr && <button type="button" className="crash-link" onClick={() => window.native.crash.open(record.id, 'jvm')}>JVM error log</button>}
                    <button type="button" className="crash-link" onClick={() => window.native.crash.open(record.id, 'log')}>Captured log</button>
                    <button type="button" className="crash-link" onClick={() => window.native.crash.open(record.id, 'mods')}>Mods folder</button>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}

        {report && !analyzing && (
          <footer className="crash-foot">
            <button type="button" className="crash-text-btn" onClick={shareLog} disabled={shareState === 'working'}>
              {shareState === 'working' ? 'Sharing' : shareState === 'done' ? 'Link copied' : 'Share log'}
            </button>
            <button type="button" className="crash-text-btn" onClick={copyReport}>Copy report</button>
            <span className="crash-foot-space" />
            {toast && <span className="crash-toast">{toast}</span>}
            <button type="button" className={`crash-pill is-strong${!recommended || recommendedDone ? ' is-accent' : ''}`} onClick={() => onRelaunch?.(record)}>Relaunch</button>
            {recommended && !recommendedDone && (
              <button type="button" className="crash-pill is-accent is-strong" onClick={fixAndRelaunch} disabled={fixState[recommended.id]?.status === 'working'}>
                {fixState[recommended.id]?.status === 'working' ? <LoaderCircle size={14} className="crash-spin" /> : null}
                <span>Fix and relaunch</span>
              </button>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}
