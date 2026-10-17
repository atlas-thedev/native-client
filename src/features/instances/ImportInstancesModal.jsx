import React, { useCallback, useEffect, useMemo, useState } from 'react';
import NativeIcon from '../../components/ui/NativeIcon.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import { LAUNCHERS, launcherById } from './importLaunchers.js';
import fabricIcon from '../../assets/icons/fabric.png';
import forgeIcon from '../../assets/icons/forge.jpg';
import vanillaIcon from '../../assets/icons/vanilla.png';
import './ImportInstancesModal.css';

const PARTS = [
  { id: 'mods', label: 'Mods & configs', hint: 'Mods, their configs and data', on: true },
  { id: 'worlds', label: 'Worlds', hint: 'Your singleplayer saves', on: true },
  { id: 'packs', label: 'Resource & shader packs', hint: 'Textures and shaders', on: true },
  { id: 'settings', label: 'Game settings', hint: 'Options, keybinds, server list', on: true },
  { id: 'screenshots', label: 'Screenshots', hint: 'Can be big', on: false }
];
const LOADER_ICON = { Fabric: fabricIcon, Forge: forgeIcon, Vanilla: vanillaIcon };

/** "My Pack" -> "My Pack (2)" when the name is taken (case-insensitive). */
function freeName(base, taken) {
  const name = String(base || 'Imported').trim().slice(0, 56) || 'Imported';
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; n < 100; n += 1) if (!taken.has(`${name} (${n})`.toLowerCase())) return `${name} (${n})`;
  return name;
}

function ago(ms, formatDate) {
  if (!ms) return null;
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days < 1) return 'Played today';
  if (days < 2) return 'Played yesterday';
  if (days < 30) return `Played ${days} days ago`;
  return `Played ${formatDate(new Date(ms), { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

/**
 * Import instances from Modrinth App, CurseForge, Prism, MultiMC, PolyMC, ATLauncher, TLauncher or the
 * Minecraft Launcher, or from a pack file / folder. Copies; the other launcher keeps its files.
 */
export default function ImportInstancesModal({ open, instances = [], initialLauncher = null, onClose, onImported, onNotify }) {
  const { formatDate } = useI18n();
  const [scan, setScan] = useState(null); // null = scanning
  const [scanError, setScanError] = useState('');
  const [active, setActive] = useState(initialLauncher);
  const [picked, setPicked] = useState(() => new Set());
  const [parts, setParts] = useState(() => Object.fromEntries(PARTS.map((p) => [p.id, p.on])));
  const [jobs, setJobs] = useState(null); // [{ key, name, icon, percent, detail, state }]
  const busy = Boolean(jobs?.some((job) => job.state === 'running'));

  const rescan = useCallback(() => {
    setScan(null);
    setScanError('');
    Promise.resolve(window.native?.imports?.scan?.())
      .then((list) => setScan(Array.isArray(list) ? list : []))
      .catch((error) => { setScan([]); setScanError(error?.message || 'Could not look for other launchers.'); });
  }, []);

  useEffect(() => {
    if (!open) return;
    setPicked(new Set());
    setJobs(null);
    setActive(initialLauncher);
    rescan();
  }, [open, initialLauncher, rescan]);

  // the first launcher that has something, unless one was asked for
  const launchers = useMemo(() => {
    const byId = new Map((scan || []).map((entry) => [entry.id, entry]));
    return LAUNCHERS.map((meta) => ({ ...meta, ...(byId.get(meta.id) || { found: false, instances: [] }) }))
      .filter((entry) => entry.found || entry.id !== 'minecraft');
  }, [scan]);
  useEffect(() => {
    if (!scan || active) return;
    const first = launchers.find((entry) => entry.instances.length) || launchers[0];
    if (first) setActive(first.id);
  }, [scan, active, launchers]);

  useEffect(() => {
    if (!open) return undefined;
    return window.native?.imports?.onProgress?.((event) => {
      setJobs((list) => list && list.map((job) => (job.key === event.key && job.state === 'running'
        ? { ...job, percent: Math.max(job.percent, Number(event.percent) || 0), detail: event.detail || job.detail }
        : job)));
    });
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => { if (event.key === 'Escape' && !busy) onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const current = launchers.find((entry) => entry.id === active) || null;
  const list = current?.instances || [];
  const allPicked = list.length > 0 && list.every((item) => picked.has(item.key));
  const toggle = (key) => setPicked((set) => { const next = new Set(set); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const toggleAll = () => setPicked((set) => { const next = new Set(set); list.forEach((item) => (allPicked ? next.delete(item.key) : next.add(item.key))); return next; });
  const chosen = launchers.flatMap((entry) => entry.instances.filter((item) => picked.has(item.key)).map((item) => ({ ...item, source: entry.id })));
  const anyPart = Object.values(parts).some(Boolean);

  const run = async (tasks) => {
    const taken = new Set(instances.map((item) => String(item.name || '').trim().toLowerCase()));
    setJobs(tasks.map((task) => ({ key: task.key, name: task.name, icon: task.icon, percent: 0, detail: 'Waiting…', state: 'running' })));
    const made = [];
    for (const task of tasks) {
      try {
        const created = await task.run();
        if (created?.id) {
          const name = freeName(created.name || task.name, taken);
          taken.add(name.toLowerCase());
          made.push({ ...created, name });
        }
        setJobs((all) => all.map((job) => (job.key === task.key ? { ...job, percent: 100, detail: 'Imported', state: 'done' } : job)));
      } catch (error) {
        const message = String(error?.message || 'Import failed').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        setJobs((all) => all.map((job) => (job.key === task.key ? { ...job, detail: message, state: 'error' } : job)));
      }
    }
    if (made.length) {
      onImported?.(made);
      onNotify?.('Imported', made.length === 1 ? `${made[0].name} is ready to play.` : `${made.length} instances are ready to play.`);
    }
  };

  const importChosen = () => {
    if (!chosen.length || !anyPart) return;
    run(chosen.map((item) => ({
      key: item.key, name: item.name, icon: item.icon || launcherById(item.source)?.icon,
      run: () => window.native.imports.instance({ ...item, include: parts })
    })));
  };

  const importPath = async (kind) => {
    const file = await window.native?.imports?.pick?.(kind);
    if (!file) return;
    const name = file.split(/[\\/]/).pop();
    run([{ key: `file:${file}`, name, icon: null, run: () => window.native.imports.file({ path: file, include: parts }) }]);
  };

  const done = jobs && !busy;
  const okCount = jobs?.filter((job) => job.state === 'done').length || 0;

  return (
    <div className="imp-backdrop" onClick={() => !busy && onClose?.()}>
      <div className="imp" role="dialog" aria-modal="true" aria-label="Import instances" onClick={(event) => event.stopPropagation()}>
        <header className="imp-head">
          <div>
            <h2>Import from another launcher</h2>
            <p>Bring your instances over with their mods, worlds and settings. The other launcher keeps its copy.</p>
          </div>
          <button type="button" className="imp-close" onClick={onClose} disabled={busy} aria-label="Close"><NativeIcon name="close" size={16} /></button>
        </header>

        {jobs ? (
          <section className="imp-jobs">
            {jobs.map((job) => (
              <div key={job.key} className={`imp-job is-${job.state}`}>
                <span className="imp-thumb">{job.icon ? <img src={job.icon} alt="" /> : <NativeIcon name="package" size={18} />}</span>
                <div className="imp-job-body">
                  <strong>{job.name}</strong>
                  <div className="imp-bar"><i style={{ width: `${job.state === 'error' ? 100 : job.percent}%` }} /></div>
                  <small>{job.detail}</small>
                </div>
                <span className="imp-job-state">
                  {job.state === 'done' ? <NativeIcon name="check-circle" size={18} /> : job.state === 'error' ? <NativeIcon name="alert" size={18} /> : `${Math.round(job.percent)}%`}
                </span>
              </div>
            ))}
            {done && (
              <footer className="imp-foot">
                <span className="imp-foot-note">{okCount ? `${okCount} imported${okCount < jobs.length ? `, ${jobs.length - okCount} failed` : ''}.` : 'Nothing was imported.'}</span>
                <button type="button" className="imp-ghost" onClick={() => { setJobs(null); setPicked(new Set()); rescan(); }}>Import more</button>
                <button type="button" className="imp-primary" onClick={onClose}><NativeIcon name="check" size={15} />Done</button>
              </footer>
            )}
          </section>
        ) : (
          <div className="imp-main">
            <nav className="imp-rail" aria-label="Launchers">
              {launchers.map((entry) => (
                <button key={entry.id} type="button" className={`imp-launcher${active === entry.id ? ' is-on' : ''}${entry.found ? '' : ' is-missing'}`} onClick={() => setActive(entry.id)}>
                  <img src={entry.icon} alt="" />
                  <span><strong>{entry.name}</strong><small>{scan === null ? 'Looking…' : !entry.found ? 'Not installed' : entry.instances.length ? `${entry.instances.length} instance${entry.instances.length === 1 ? '' : 's'}` : 'No instances'}</small></span>
                  {entry.instances.some((item) => picked.has(item.key)) && <em>{entry.instances.filter((item) => picked.has(item.key)).length}</em>}
                </button>
              ))}
              <div className="imp-rail-sep" />
              <button type="button" className="imp-launcher" onClick={() => importPath('file')}>
                <span className="imp-file-icon"><NativeIcon name="file" size={16} /></span>
                <span><strong>From a file</strong><small>.mrpack or .zip</small></span>
              </button>
              <button type="button" className="imp-launcher" onClick={() => importPath('folder')}>
                <span className="imp-file-icon"><NativeIcon name="folder-open" size={16} /></span>
                <span><strong>From a folder</strong><small>Any instance folder</small></span>
              </button>
            </nav>

            <section className="imp-list">
              {scan === null ? (
                <div className="imp-empty"><NativeIcon name="refresh" size={18} className="is-spinning" /><span>Looking for other launchers…</span></div>
              ) : !current ? null : !current.found ? (
                <div className="imp-empty">
                  <img src={current.icon} alt="" className="imp-empty-logo" />
                  <strong>{current.name} isn’t installed here</strong>
                  <span>If it lives somewhere else, export the instance from {current.name} and import the file, or pick its folder.</span>
                  <div className="imp-empty-actions">
                    <button type="button" className="imp-ghost" onClick={() => importPath('file')}><NativeIcon name="file" size={14} />Import a file</button>
                    <button type="button" className="imp-ghost" onClick={() => importPath('folder')}><NativeIcon name="folder-open" size={14} />Pick a folder</button>
                  </div>
                </div>
              ) : list.length === 0 ? (
                <div className="imp-empty">
                  <img src={current.icon} alt="" className="imp-empty-logo" />
                  <strong>No instances in {current.name}</strong>
                  <span>Make one there first, or import a pack file instead.</span>
                </div>
              ) : (
                <>
                  <div className="imp-list-head">
                    <button type="button" className={`imp-check${allPicked ? ' is-on' : ''}`} onClick={toggleAll} aria-label="Select all"><NativeIcon name="check" size={11} /></button>
                    <span>{list.length} in {current.name}</span>
                    <button type="button" className="imp-link" onClick={rescan}><NativeIcon name="refresh" size={12} />Refresh</button>
                  </div>
                  <div className="imp-rows">
                    {list.map((item) => {
                      const on = picked.has(item.key);
                      const played = ago(item.lastPlayed, formatDate);
                      return (
                        <button key={item.key} type="button" className={`imp-row${on ? ' is-on' : ''}`} onClick={() => toggle(item.key)} aria-pressed={on}>
                          <span className={`imp-check${on ? ' is-on' : ''}`}><NativeIcon name="check" size={11} /></span>
                          <span className="imp-thumb">{item.icon ? <img src={item.icon} alt="" /> : <img src={current.icon} alt="" className="is-launcher" />}</span>
                          <span className="imp-row-body">
                            <strong>{item.name}</strong>
                            <small>
                              {[item.mods ? `${item.mods} mod${item.mods === 1 ? '' : 's'}` : null, item.worlds ? `${item.worlds} world${item.worlds === 1 ? '' : 's'}` : null, played].filter(Boolean).join(' · ') || 'Empty'}
                              {item.shared && <em title="This version shares one .minecraft folder with the others">Shared folder</em>}
                            </small>
                          </span>
                          <span className="imp-tags">
                            <span className="imp-tag">{item.version}</span>
                            <span className="imp-tag is-loader">{LOADER_ICON[item.loader] && <img src={LOADER_ICON[item.loader]} alt="" />}{item.loader}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
              {scanError && <p className="imp-note"><NativeIcon name="alert" size={13} />{scanError}</p>}
            </section>

            <aside className="imp-side">
              <h3>Bring along</h3>
              {PARTS.map((part) => (
                <button key={part.id} type="button" role="switch" aria-checked={parts[part.id]} className={`imp-part${parts[part.id] ? ' is-on' : ''}`} onClick={() => setParts((all) => ({ ...all, [part.id]: !all[part.id] }))}>
                  <span><strong>{part.label}</strong><small>{part.hint}</small></span>
                  <i><b /></i>
                </button>
              ))}
              <p className="imp-side-note">Native makes a copy. Nothing in the other launcher changes, so you can keep using it.</p>
              <button type="button" className="imp-primary is-wide" disabled={!chosen.length || !anyPart} onClick={importChosen}>
                <NativeIcon name="download" size={15} />
                <span>{chosen.length ? `Import ${chosen.length} instance${chosen.length === 1 ? '' : 's'}` : 'Pick instances to import'}</span>
              </button>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

/** A small row of launcher icons that opens the importer (used on empty pages). */
export function ImportFromLaunchers({ onOpen, launchers, label = 'Import from another launcher', className = '' }) {
  return (
    <div className={`imp-strip ${className}`}>
      <button type="button" className="imp-strip-main" onClick={() => onOpen?.(null)}>
        <NativeIcon name="download" size={15} />
        <span>{label}</span>
      </button>
      <div className="imp-strip-icons">
        {launchers.map((entry) => (
          <button key={entry.id} type="button" className="imp-strip-icon" onClick={() => onOpen?.(entry.id)} title={`Import from ${entry.name}`} aria-label={`Import from ${entry.name}`}>
            <img src={entry.icon} alt="" />
          </button>
        ))}
      </div>
    </div>
  );
}
