import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GlyphBlock, GlyphChevron, GlyphClose, GlyphDownload, GlyphFromTo, GlyphOffline, GlyphProblem, GlyphRefresh, GlyphSpinner, GlyphUpdate, GlyphUpToDate, Tick } from './HealthGlyphs.jsx';
import './ContentHealth.css';

const UPDATABLE = { mods: 'mods', shaders: 'shaderpacks', textures: 'resourcepacks' };

function ago(at) {
  if (!at) return '';
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

/**
 * Update checks and pre-launch problem detection for one content folder.
 * `revision` re-runs both after anything in the folder changed.
 */
export function useContentHealth({ cluster, type, revision = 0, onChanged }) {
  const folder = UPDATABLE[type] || null;
  const api = window.native?.mods;
  const supported = Boolean(folder && api?.checkUpdates);
  const loader = cluster.loader || cluster.mc_loader || 'Vanilla';
  const mcVersion = cluster.version || cluster.mc_version;
  const [updates, setUpdates] = useState({ status: supported ? 'checking' : 'off', data: null, error: '' });
  const [problems, setProblems] = useState({ status: 'idle', list: [] });
  const [applying, setApplying] = useState(null);
  const [result, setResult] = useState(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const check = useCallback(async () => {
    if (!supported) return;
    setUpdates((prev) => ({ ...prev, status: 'checking', error: '' }));
    try {
      const data = await api.checkUpdates({ instanceId: cluster.id, folder, loader, mcVersion });
      if (alive.current) setUpdates({ status: 'ok', data, error: '' });
    } catch (error) {
      if (alive.current) setUpdates((prev) => ({ ...prev, status: 'error', error: error?.message || 'Could not check for updates' }));
    }
  }, [supported, api, cluster.id, folder, loader, mcVersion]);

  const scan = useCallback(async () => {
    if (type !== 'mods' || !api?.problems || String(loader).toLowerCase() === 'vanilla') return;
    setProblems((prev) => ({ ...prev, status: 'checking' }));
    try {
      const data = await api.problems({ instanceId: cluster.id, loader, mcVersion });
      if (alive.current) setProblems({ status: 'ok', list: data?.problems || [], offline: data?.offline });
    } catch {
      if (alive.current) setProblems({ status: 'error', list: [] });
    }
  }, [type, api, cluster.id, loader, mcVersion]);

  useEffect(() => { check(); }, [check, revision]);
  useEffect(() => { scan(); }, [scan, revision]);

  const apply = useCallback(async (list, installs = []) => {
    if (!list.length && !installs.length) return;
    setApplying({ count: list.length + installs.length });
    setResult(null);
    try {
      const done = await api.applyUpdates({ instanceId: cluster.id, folder: folder || 'mods', updates: list, installs });
      if (alive.current) setResult(done);
    } catch (error) {
      if (alive.current) setResult({ updated: [], installed: [], failed: [{ title: 'Update', error: error?.message || 'failed' }] });
    } finally {
      if (alive.current) setApplying(null);
      onChanged?.();
    }
  }, [api, cluster.id, folder, onChanged]);

  const fix = useCallback(async (problem) => {
    if (!problem?.fix) return;
    setApplying({ count: 1 });
    try {
      if (problem.fix.type === 'disable') {
        await window.native.loaders.disableMods({ instanceId: cluster.id, files: problem.fix.files });
      } else if (problem.fix.type === 'install') {
        await api.applyUpdates({ instanceId: cluster.id, folder: 'mods', updates: [], installs: [problem.fix.item] });
      }
    } finally {
      if (alive.current) setApplying(null);
      onChanged?.();
    }
  }, [api, cluster.id, onChanged]);

  const updatesByFile = useMemo(() => Object.fromEntries((updates.data?.updates || []).map((item) => [item.file, item])), [updates.data]);

  return { supported, folder, updates, problems, applying, result, check, apply, fix, updatesByFile, dismissResult: () => setResult(null) };
}

function ModIcon({ src, className = 'ch-icon' }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className={className}>
      {src && !broken ? <img src={src} alt="" onError={() => setBroken(true)} /> : <GlyphBlock size={14} />}
    </span>
  );
}

// "Sodium", "Sodium and Lithium", "Sodium, Lithium and 3 more"
function names(list) {
  const titles = list.map((item) => item.title);
  if (titles.length <= 2) return titles.join(' and ');
  if (titles.length === 3) return `${titles[0]}, ${titles[1]} and ${titles[2]}`;
  return `${titles[0]}, ${titles[1]} and ${titles.length - 2} more`;
}

function Stack({ items }) {
  const shown = items.slice(0, 3);
  const extra = items.length - shown.length;
  return (
    <span className="ch-stack" aria-hidden="true">
      {shown.map((item) => <ModIcon key={item.file || item.projectId} src={item.iconUrl} className="ch-stack-icon" />)}
      {extra > 0 && <span className="ch-stack-icon ch-stack-more">+{extra}</span>}
    </span>
  );
}

export default function ContentHealth({ health, noun = 'mods' }) {
  const { updates, problems, applying, result } = health;
  const list = updates.data?.updates || [];
  const deps = updates.data?.dependencies || [];
  const [open, setOpen] = useState(false);
  const [problemsOpen, setProblemsOpen] = useState(true);
  const [skip, setSkip] = useState({});
  const [skipDeps, setSkipDeps] = useState({});

  useEffect(() => { setSkip({}); setSkipDeps({}); }, [updates.data]);

  if (!health.supported) return null;

  const selected = list.filter((item) => !skip[item.file]);
  const neededDeps = deps.filter((dep) => !dep.unavailable && selected.some((item) => dep.requiredBy.includes(item.title)));
  const chosenDeps = neededDeps.filter((dep) => !skipDeps[dep.projectId]);
  const errors = problems.list.filter((p) => p.severity === 'error').length;

  const runSelected = () => health.apply(selected, chosenDeps);
  const runAll = () => health.apply(list, deps.filter((dep) => !dep.unavailable));
  const hasUpdates = list.length > 0 && !applying && updates.status !== 'checking' && updates.status !== 'error';

  return (
    <div className="ch" aria-live="polite">
      {/* Problems first: they stop the game from starting */}
      {problems.list.length > 0 && (
        <div className={`ch-card ch-problems ${errors ? 'is-error' : 'is-warn'}`}>
          <div className="ch-head">
            <GlyphProblem size={22} className="ch-glyph" />
            <div className="ch-text">
              <strong>{problems.list.length === 1 ? '1 problem' : `${problems.list.length} problems`}</strong>
              <span>{errors ? 'These will stop the game from starting' : 'These may cause trouble in game'}</span>
            </div>
            <button type="button" className="ch-btn is-ghost" onClick={() => setProblemsOpen((v) => !v)} aria-expanded={problemsOpen}>
              {problemsOpen ? 'Hide' : 'Review'} <GlyphChevron size={14} open={problemsOpen} />
            </button>
          </div>
          {problemsOpen && (
            <ul className="ch-list">
              {problems.list.map((problem) => (
                <li key={problem.id} className={`ch-problem is-${problem.severity}`}>
                  <span className="ch-dot" />
                  <div className="ch-problem-text">
                    <strong>{problem.title}</strong>
                    <span>{problem.detail}</span>
                  </div>
                  {problem.fix && (
                    <button type="button" className="ch-btn is-soft" disabled={!!applying} onClick={() => health.fix(problem)}>
                      {problem.fix.type === 'install' && <GlyphDownload size={14} />}
                      {problem.fix.label}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Updates */}
      <div className={`ch-card ch-updates ${hasUpdates ? 'has-updates' : ''} ${open && hasUpdates ? 'is-open' : ''}`}>
        <div className="ch-head">
          {updates.status === 'checking' ? (
            <>
              <GlyphSpinner size={18} className="ch-glyph is-muted" />
              <div className="ch-text is-quiet"><span>Checking {noun} for updates…</span></div>
            </>
          ) : applying ? (
            <>
              <GlyphSpinner size={18} className="ch-glyph is-accent" />
              <div className="ch-text is-quiet">
                <span>Updating {applying.count} {applying.count === 1 ? 'file' : 'files'} · progress is in Downloads</span>
              </div>
            </>
          ) : updates.status === 'error' ? (
            <>
              <GlyphOffline size={20} className="ch-glyph is-muted" />
              <div className="ch-text is-quiet"><span>Couldn’t check for updates: {updates.error}</span></div>
              <button type="button" className="ch-btn is-ghost" onClick={health.check}>Retry</button>
            </>
          ) : list.length ? (
            <>
              <GlyphUpdate size={22} className="ch-glyph is-accent" />
              <div className="ch-text">
                <strong>
                  {list.length === 1 ? '1 update ready' : `${list.length} updates ready`}
                  {deps.length > 0 && <em> · +{deps.length} {deps.length === 1 ? 'library' : 'libraries'}</em>}
                </strong>
                <span>{names(list)}</span>
              </div>
              <Stack items={list} />
              <button type="button" className="ch-btn is-ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
                {open ? 'Hide' : 'Review'} <GlyphChevron size={14} open={open} />
              </button>
              <button type="button" className="ch-btn is-accent" onClick={runAll}>
                <GlyphDownload size={14} /> Update all
              </button>
            </>
          ) : (
            <>
              <GlyphUpToDate size={20} className="ch-glyph is-ok" />
              <div className="ch-text is-quiet">
                <span>
                  {updates.data?.known ? `All ${updates.data.known} ${noun} from Modrinth are up to date` : `No ${noun} from Modrinth to update`}
                  {updates.data?.unknown?.length ? ` · ${updates.data.unknown.length} local` : ''} · checked {ago(updates.data?.checkedAt)}
                </span>
              </div>
              <button type="button" className="ch-icon-btn" onClick={health.check} aria-label="Check again" title="Check again">
                <GlyphRefresh size={15} />
              </button>
            </>
          )}
        </div>

        {result && !applying && (
          <div className={`ch-result ${result.failed.length ? 'is-warn' : ''}`} role="status">
            <span>
              {[result.updated.length && `${result.updated.length} updated`, result.installed.length && `${result.installed.length} installed`, result.failed.length && `${result.failed.length} failed`].filter(Boolean).join(' · ') || 'Nothing changed'}
              {result.failed.length > 0 && `: ${result.failed.map((f) => `${f.title} (${f.error})`).slice(0, 2).join(', ')}`}
            </span>
            <button type="button" className="ch-icon-btn" onClick={health.dismissResult} aria-label="Dismiss"><GlyphClose size={13} /></button>
          </div>
        )}

        {open && hasUpdates && (
          <div className="ch-review">
            <ul className="ch-list">
              {list.map((item) => {
                const on = !skip[item.file];
                return (
                  <li key={item.file} className={`ch-update ${on ? '' : 'is-off'}`}>
                    <Tick checked={on} onChange={() => setSkip((prev) => ({ ...prev, [item.file]: !prev[item.file] }))} label={`Update ${item.title}`} />
                    <ModIcon src={item.iconUrl} />
                    <span className="ch-update-title">{item.title}{!item.enabled && <em> · disabled</em>}</span>
                    <span className="ch-tags">
                      {item.fixesMismatch && <span className="ch-tag is-accent" title="The installed file was built for another Minecraft version or loader">Right build</span>}
                      {item.channel !== 'release' && <span className="ch-tag is-warn">{item.channel}</span>}
                    </span>
                    <span className="ch-ver">
                      <code className="is-old">{item.from}</code>
                      <GlyphFromTo size={13} className="ch-ver-arrow" />
                      <code className="is-new">{item.to}</code>
                    </span>
                  </li>
                );
              })}
            </ul>
            {deps.length > 0 && (
              <>
                <span className="ch-sub">Also installs</span>
                <ul className="ch-list">
                  {deps.map((dep) => {
                    const on = !dep.unavailable && !skipDeps[dep.projectId];
                    return (
                      <li key={dep.projectId} className={`ch-update ${on ? '' : 'is-off'}`}>
                        <Tick
                          checked={on}
                          disabled={!!dep.unavailable}
                          onChange={() => setSkipDeps((prev) => ({ ...prev, [dep.projectId]: !prev[dep.projectId] }))}
                          label={`Install ${dep.title}`}
                        />
                        <ModIcon src={dep.iconUrl} />
                        <span className="ch-update-title">{dep.title}<em> · {dep.unavailable || `for ${dep.requiredBy.join(', ')}`}</em></span>
                        <span className="ch-tags" />
                        <span className="ch-ver">{dep.version && <code className="is-new">{dep.version}</code>}</span>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            <div className="ch-review-foot">
              {neededDeps.some((dep) => skipDeps[dep.projectId]) ? (
                <span className="ch-warn-note"><GlyphProblem size={15} /> Skipping a required library stops those mods from loading.</span>
              ) : (
                <span className="ch-count">{selected.length} of {list.length} selected</span>
              )}
              <button type="button" className="ch-btn is-accent" disabled={!selected.length} onClick={runSelected}>
                <GlyphDownload size={14} /> Update {selected.length}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
