import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import NativeIcon from '../../components/ui/NativeIcon.jsx';
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

function Icon({ src }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="ch-icon">
      {src && !broken ? <img src={src} alt="" onError={() => setBroken(true)} /> : <NativeIcon name="package" size={14} />}
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

  return (
    <div className="ch" aria-live="polite">
      {/* Problems first: they stop the game from starting */}
      {problems.list.length > 0 && (
        <div className={`ch-row ch-problems ${errors ? 'is-error' : 'is-warn'}`}>
          <div className="ch-row-head">
            <NativeIcon name="alert" size={15} className="ch-row-icon" />
            <span className="ch-row-text">
              <strong>{problems.list.length === 1 ? '1 problem' : `${problems.list.length} problems`}</strong>
              {errors ? ' will stop the game from starting' : ' may cause trouble in game'}
            </span>
            <button type="button" className="ch-btn" onClick={() => setProblemsOpen((v) => !v)} aria-expanded={problemsOpen}>
              {problemsOpen ? 'Hide' : 'Review'}
            </button>
          </div>
          {problemsOpen && (
            <ul className="ch-list">
              {problems.list.map((problem) => (
                <li key={problem.id} className={`ch-problem is-${problem.severity}`}>
                  <div className="ch-problem-text">
                    <strong>{problem.title}</strong>
                    <span>{problem.detail}</span>
                  </div>
                  {problem.fix && (
                    <button type="button" className="ch-btn is-accent" disabled={!!applying} onClick={() => health.fix(problem)}>
                      <NativeIcon name={problem.fix.type === 'install' ? 'download' : 'circle'} size={13} />
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
      <div className="ch-row">
        <div className="ch-row-head">
          {updates.status === 'checking' ? (
            <>
              <NativeIcon name="loader" size={15} className="ch-row-icon ch-spin" />
              <span className="ch-row-text is-muted">Checking {noun} for updates…</span>
            </>
          ) : applying ? (
            <>
              <NativeIcon name="loader" size={15} className="ch-row-icon ch-spin" />
              <span className="ch-row-text">Updating {applying.count} {applying.count === 1 ? 'file' : 'files'}… progress is in Downloads</span>
            </>
          ) : updates.status === 'error' ? (
            <>
              <NativeIcon name="wifi" size={15} className="ch-row-icon is-muted" />
              <span className="ch-row-text is-muted">Couldn’t check for updates: {updates.error}</span>
              <button type="button" className="ch-btn" onClick={health.check}>Retry</button>
            </>
          ) : list.length ? (
            <>
              <NativeIcon name="sparkles" size={15} className="ch-row-icon is-accent" />
              <span className="ch-row-text">
                <strong>{list.length === 1 ? '1 update' : `${list.length} updates`}</strong> available
                {deps.length > 0 && <em> · {deps.length} new {deps.length === 1 ? 'dependency' : 'dependencies'}</em>}
              </span>
              <button type="button" className="ch-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? 'Hide' : 'Review'}</button>
              <button type="button" className="ch-btn is-accent" onClick={runAll}>
                <NativeIcon name="download" size={13} /> Update all
              </button>
            </>
          ) : (
            <>
              <NativeIcon name="check-circle" size={15} className="ch-row-icon is-ok" />
              <span className="ch-row-text is-muted">
                {updates.data?.known ? `All ${updates.data.known} ${noun} from Modrinth are up to date` : `No ${noun} from Modrinth to update`}
                {updates.data?.unknown?.length ? ` · ${updates.data.unknown.length} local` : ''} · checked {ago(updates.data?.checkedAt)}
              </span>
              <button type="button" className="ch-icon-btn" onClick={health.check} aria-label="Check again" title="Check again">
                <NativeIcon name="refresh" size={14} />
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
            <button type="button" className="ch-icon-btn" onClick={health.dismissResult} aria-label="Dismiss"><NativeIcon name="close" size={12} /></button>
          </div>
        )}

        {open && list.length > 0 && !applying && (
          <div className="ch-review">
            <ul className="ch-list">
              {list.map((item) => (
                <li key={item.file} className="ch-update">
                  <input type="checkbox" checked={!skip[item.file]} onChange={() => setSkip((prev) => ({ ...prev, [item.file]: !prev[item.file] }))} aria-label={`Update ${item.title}`} />
                  <Icon src={item.iconUrl} />
                  <span className="ch-update-title">{item.title}{!item.enabled && <em> · disabled</em>}</span>
                  <span className="ch-update-ver">
                    <code>{item.from}</code>
                    <NativeIcon name="arrow-right" size={12} />
                    <code className="is-new">{item.to}</code>
                  </span>
                  <span className="ch-tags">
                    {item.fixesMismatch && <span className="ch-tag is-accent" title="The installed file was built for another Minecraft version or loader">Right build</span>}
                    {item.channel !== 'release' && <span className="ch-tag is-warn">{item.channel}</span>}
                  </span>
                </li>
              ))}
            </ul>
            {deps.length > 0 && (
              <>
                <span className="ch-sub">Also installs</span>
                <ul className="ch-list">
                  {deps.map((dep) => (
                    <li key={dep.projectId} className="ch-update">
                      <input
                        type="checkbox"
                        checked={!dep.unavailable && !skipDeps[dep.projectId]}
                        disabled={!!dep.unavailable}
                        onChange={() => setSkipDeps((prev) => ({ ...prev, [dep.projectId]: !prev[dep.projectId] }))}
                        aria-label={`Install ${dep.title}`}
                      />
                      <Icon src={dep.iconUrl} />
                      <span className="ch-update-title">{dep.title}</span>
                      <span className="ch-update-ver is-muted">{dep.unavailable || `required by ${dep.requiredBy.join(', ')}`}</span>
                      <span className="ch-tags">{dep.version && <code>{dep.version}</code>}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="ch-review-foot">
              {neededDeps.some((dep) => skipDeps[dep.projectId]) && (
                <span className="ch-warn-note"><NativeIcon name="alert" size={13} /> Skipping a required dependency stops those mods from loading.</span>
              )}
              <button type="button" className="ch-btn is-accent" disabled={!selected.length} onClick={runSelected}>
                Update {selected.length} selected
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
