import { nativeSupport } from '../../lib/nativeSupport.js';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import NativeIcon from '../../components/ui/NativeIcon.jsx';
import Logo from '../../components/ui/Logo.jsx';
import { RELEASE_LINES, getClusterArt } from '../../data/versionsData.js';
import {
  LOADERS,
  getFabricGameVersions,
  getVersionManifest,
  loaderAvailability,
  versionLine
} from '../../lib/mojang.js';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import { PRESETS, PRESET_LOADERS, checkPresetCompat, getPreset } from './presets.js';
import fabricIcon from '../../assets/icons/fabric.png';
import forgeIcon from '../../assets/icons/forge.jpg';
import vanillaIcon from '../../assets/icons/vanilla.png';
import PixelIcon from './PixelIcons.jsx';
import './CreateInstanceModal.css';
import './Presets.css';

const MAX_LINES = 24;
const RAM_MIN = 1024;
const RAM_MAX = 16384;
const RAM_STEP = 512;

const STEPS = [
  { id: 'version', label: 'Version', hint: 'Which Minecraft', icon: 'grass' },
  { id: 'loader', label: 'Loader', hint: 'Mods or vanilla', icon: 'table' },
  { id: 'extras', label: 'Extras', hint: 'Mods, memory, Native', icon: 'chest' }
];

const LOADER_INFO = {
  Vanilla: { icon: vanillaIcon, blurb: 'Plain Minecraft, exactly as Mojang ships it.' },
  Fabric: { icon: fabricIcon, blurb: 'Fast and light. Sodium, Iris and the Native mod.', recommended: true },
  Quilt: { mark: 'Q', tint: '#a855f7', blurb: 'Fabric-compatible, with its own extras.' },
  Forge: { icon: forgeIcon, blurb: 'The classic loader for big modpacks.' },
  NeoForge: { mark: 'N', tint: '#f97316', blurb: 'Modern Forge, for 1.20.2 and newer packs.' },
  'Legacy Fabric': { mark: 'L', tint: '#38bdf8', blurb: 'Fabric for old versions (1.3 to 1.13).' }
};

function lineFor(versionId) {
  const line = versionLine(versionId);
  return (
    RELEASE_LINES.find(
      (entry) =>
        entry.id === line ||
        String(entry.major) === line ||
        '1.' + entry.major === line
    ) || null
  );
}

function artFor(versionId) {
  const line = lineFor(versionId);
  const exact = line?.versions?.find((entry) => entry.version === versionId);
  return (
    exact?.art ||
    line?.art ||
    getClusterArt({ version: versionId, mc_version: versionId, artKey: line?.artKey })
  );
}

const presetPlaceholder = (preset) => [
  ...preset.mods.map((slug) => ({ slug, kind: 'mod', title: slug, iconUrl: '', status: 'checking', versionNumber: '' })),
  ...(preset.shaders || []).map((slug) => ({ slug, kind: 'shader', title: slug, iconUrl: '', status: 'checking', versionNumber: '' }))
];

/** "1.21.4 Fabric", or "1.21.4 Fabric (2)" when that name is taken. */
function uniqueName(base, taken) {
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 100; n += 1) {
    const next = `${base} (${n})`;
    if (!taken.has(next.toLowerCase())) return next;
  }
  return base;
}

const gb = (mb) => `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB`;

export default function CreateInstanceModal({
  open,
  instances = [],
  onClose,
  onCreate,
  initialVersion = null,
  initialLoader = null,
  initialName = null,
  initialPreset = null,
  initialPlay = false
}) {
  const { t, formatDate } = useI18n();
  const [manifest, setManifest] = useState(null);
  const [fabricSet, setFabricSet] = useState(null);
  const [loading, setLoading] = useState(true);
  const [systemGb, setSystemGb] = useState(null);

  const [step, setStep] = useState('version');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [version, setVersion] = useState('');
  const [loader, setLoader] = useState('Fabric');
  const [memoryMb, setMemoryMb] = useState(4096);
  const [search, setSearch] = useState('');
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [preset, setPreset] = useState('');
  const [nativeMod, setNativeMod] = useState(true);
  const nameRef = useRef(null);

  const takenNames = useMemo(() => new Set(instances.map((instance) => String(instance.name || '').trim().toLowerCase())), [instances]);

  /* Reset every time the modal is opened so it never shows stale input. */
  useEffect(() => {
    if (!open) return;
    // A premade card (Create & Play) opens the modal with its own name,
    // version and loader so what you picked is exactly what gets created.
    setName(initialName || '');
    setNameTouched(Boolean(initialName));
    setSearch('');
    setShowSnapshots(Boolean(initialVersion && !/^\d+\.\d+(?:\.\d+)?$/.test(initialVersion)));
    setLoader(initialLoader || 'Fabric');
    setNativeMod(true);
    const seededPreset = getPreset(initialPreset);
    setPreset(seededPreset ? seededPreset.id : '');
    setMemoryMb(seededPreset?.memoryMb || 4096);
    setVersion(initialVersion || '');
    // Seeded from a card or quick search: the version is chosen, start on the next step.
    setStep(initialVersion ? (initialLoader ? 'extras' : 'loader') : 'version');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    getVersionManifest()
      .then((data) => {
        if (cancelled) return;
        setManifest(data);
        setVersion((current) => current || data.latest?.release || data.versions[0]?.id || '');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    getFabricGameVersions()
      .then((result) => { if (!cancelled) setFabricSet(result); })
      .catch(() => {});
    window.native?.settings?.systemMemory?.()
      .then((info) => { if (!cancelled && info?.totalGb) setSystemGb(info.totalGb); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open]);

  /* Suggest a (free) name until the user types their own. */
  useEffect(() => {
    if (nameTouched || !version) return;
    setName(uniqueName(`${version} ${loader}`, takenNames));
  }, [version, loader, nameTouched, takenNames]);

  /* Versions grouped by release line, newest first. */
  const groups = useMemo(() => {
    const all = manifest?.versions || [];
    const query = search.trim().toLowerCase();
    const map = new Map();
    for (const entry of all) {
      if (!showSnapshots && entry.type !== 'release') continue;
      if (query && !entry.id.toLowerCase().includes(query)) continue;
      const key = entry.type === 'release' ? versionLine(entry.id) : entry.type === 'snapshot' ? 'Snapshots' : 'Old versions';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(entry);
    }
    return Array.from(map.entries()).slice(0, MAX_LINES).map(([key, entries]) => {
      const line = entries[0]?.type === 'release' ? lineFor(entries[0].id) : null;
      return { key, title: line?.name || (key === 'Snapshots' || key === 'Old versions' ? key : `Minecraft ${key}`), art: entries[0]?.type === 'release' ? artFor(entries[0].id) : null, entries };
    });
  }, [manifest, search, showSnapshots]);

  /* One-click picks: the newest release plus the versions people play most. */
  const quickPicks = useMemo(() => {
    const releases = (manifest?.versions || []).filter((entry) => entry.type === 'release').map((entry) => entry.id);
    if (!releases.length) return [];
    const picks = [{ id: releases[0], label: 'Latest' }];
    for (const [id, label] of [['1.21.1', 'Modded'], ['1.20.1', 'Modpacks'], ['1.8.9', 'PvP']]) {
      if (releases.includes(id) && id !== releases[0]) picks.push({ id, label });
    }
    return picks;
  }, [manifest]);

  const availability = version ? loaderAvailability(loader, version, fabricSet) : { available: true };
  const trimmedName = name.trim();
  const duplicateName = Boolean(trimmedName) && takenNames.has(trimmedName.toLowerCase());
  const activePreset = getPreset(preset);

  /* Which of the preset's mods have a build for the chosen version + loader. */
  const [compat, setCompat] = useState(null);
  useEffect(() => {
    if (!open || !preset || !version || !PRESET_LOADERS.includes(loader)) {
      setCompat(null);
      return undefined;
    }
    let cancelled = false;
    setCompat(null);
    const timer = window.setTimeout(() => {
      checkPresetCompat(preset, version, loader)
        .then((items) => { if (!cancelled) setCompat({ items }); })
        .catch(() => { if (!cancelled) setCompat({ items: null, error: true }); });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [open, preset, version, loader]);

  const compatSummary = compat?.items
    ? { ok: compat.items.filter((item) => item.status === 'compatible').length, total: compat.items.length }
    : null;

  const presetUsable = !preset || PRESET_LOADERS.includes(loader);
  const native = nativeSupport(loader, version);
  const problem = !version ? 'Pick a Minecraft version.'
    : !availability.available ? (availability.reasonKey ? t(availability.reasonKey, availability.reasonVars) : availability.reason || `${loader} doesn’t support ${version}.`)
    : !trimmedName ? 'Give your instance a name.'
    : duplicateName ? 'You already have an instance with this name.'
    : !presetUsable ? 'Mod presets need Fabric or Quilt.'
    : '';
  const canSubmit = !problem;

  const maxRam = systemGb ? Math.min(RAM_MAX, Math.max(RAM_MIN * 2, Math.floor((systemGb * 1024 * 0.75) / RAM_STEP) * RAM_STEP)) : RAM_MAX;
  const recommendedRam = activePreset?.memoryMb || (loader === 'Vanilla' ? 2048 : 4096);
  const ramWarn = systemGb && memoryMb > systemGb * 1024 * 0.6;

  const submit = () => {
    if (!canSubmit) return;
    const line = lineFor(version);
    onCreate?.({
      name: trimmedName,
      version,
      loader,
      memoryMb,
      art: artFor(version),
      description: line?.description || `Minecraft ${version}`,
      tags: line?.tags?.length ? line.tags.slice(0, 3) : [loader],
      preset: preset || null,
      play: Boolean(initialPlay),
      disableNativeMod: !nativeMod,
      nativeMod
    });
    onClose?.();
  };

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });

  if (!open) return null;

  const stepIndex = STEPS.findIndex((entry) => entry.id === step);
  const goto = (delta) => setStep(STEPS[Math.max(0, Math.min(STEPS.length - 1, stepIndex + delta))].id);
  const line = version ? lineFor(version) : null;
  const pickLoader = (option) => {
    setLoader(option);
    if (!PRESET_LOADERS.includes(option)) setPreset('');
  };

  return (
    <div className="create-instance-backdrop" onClick={onClose}>
      <div className="cim" role="dialog" aria-modal="true" aria-label={t('instances.new')} onClick={(event) => event.stopPropagation()}>
        {/* ── live preview ───────────────────────────────────────── */}
        <aside className="cim-stage">
          {version ? <img key={version} className="cim-stage-art" src={artFor(version)} alt="" /> : <div className="cim-stage-art is-blank" />}
          <div className="cim-stage-shade" />
          <div className="cim-stage-body">
            <span className="cim-eyebrow">{initialPlay ? 'Create & Play' : t('instances.new')}</span>
            <label className="cim-name">
              <input
                ref={nameRef}
                value={name}
                maxLength={60}
                spellCheck={false}
                placeholder={t('create.namePlaceholder')}
                aria-label="Instance name"
                onChange={(event) => { setName(event.target.value); setNameTouched(true); }}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }}
              />
              <NativeIcon name="edit" size={14} />
            </label>
            <div className="cim-chips">
              <span className="cim-chip is-mono">{version || '—'}</span>
              <span className="cim-chip is-brand">{loader}</span>
              {activePreset && <span className="cim-chip">{activePreset.name}</span>}
            </div>
            {line?.description && <p className="cim-stage-desc">{line.description}</p>}

            <dl className="cim-specs">
              <div><dt>Native mod</dt><dd className={native.ok && nativeMod ? 'is-on' : ''}>{!native.ok ? 'Not supported' : nativeMod ? 'On' : 'Off'}</dd></div>
              <div><dt>Memory</dt><dd>{gb(memoryMb)}</dd></div>
              <div><dt>Mods</dt><dd>{activePreset ? (compatSummary ? `${compatSummary.ok} of ${compatSummary.total}` : 'Checking…') : 'None yet'}</dd></div>
            </dl>

            <div className="cim-stage-foot">
              {problem && <p className="cim-problem"><NativeIcon name="alert" size={13} />{problem}</p>}
              <div className="cim-stage-actions">
                <button type="button" className="cim-ghost" onClick={onClose}>{t('common.cancel')}</button>
                <button type="button" className="cim-create" onClick={submit} disabled={!canSubmit} title="Ctrl + Enter">
                  <NativeIcon name={initialPlay ? 'play' : 'plus'} size={15} />
                  <span>{initialPlay ? 'Create & Play' : 'Create instance'}</span>
                </button>
              </div>
            </div>
          </div>
        </aside>

        {/* ── steps ─────────────────────────────────────────────── */}
        <section className="cim-main">
          <header className="cim-head">
            <nav className="cim-steps" aria-label="Steps">
              {STEPS.map((entry, index) => (
                <button
                  key={entry.id}
                  type="button"
                  className={`cim-step${entry.id === step ? ' is-on' : ''}${index < stepIndex ? ' is-done' : ''}`}
                  aria-current={entry.id === step ? 'step' : undefined}
                  onClick={() => setStep(entry.id)}
                >
                  <i><PixelIcon name={entry.icon} size={18} />{index < stepIndex && <b className="cim-step-done"><NativeIcon name="check" size={8} /></b>}</i>
                  <span><strong>{entry.label}</strong><small>{entry.hint}</small></span>
                </button>
              ))}
              <span className="cim-steps-bar" style={{ '--p': stepIndex / (STEPS.length - 1) }} aria-hidden="true" />
            </nav>
            <button type="button" className="cim-close" onClick={onClose} title={t('common.close')} aria-label={t('common.close')}>
              <NativeIcon name="close" size={16} />
            </button>
          </header>

          <div className="cim-body" key={step}>
            {step === 'version' && (
              <>
                {quickPicks.length > 0 && (
                  <div className="cim-quick">
                    {quickPicks.map((pick) => (
                      <button key={pick.id} type="button" className={`cim-quick-btn${version === pick.id ? ' is-on' : ''}`} onClick={() => setVersion(pick.id)}>
                        <img src={artFor(pick.id)} alt="" />
                        <span><small>{pick.label}</small><strong>{pick.id}</strong></span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="cim-toolbar">
                  <label className="cim-search">
                    <NativeIcon name="search" size={15} />
                    <input type="text" value={search} placeholder={t('create.searchVersions')} onChange={(event) => setSearch(event.target.value)} autoFocus />
                  </label>
                  <button type="button" role="switch" aria-checked={showSnapshots} className={`cim-switch${showSnapshots ? ' is-on' : ''}`} onClick={() => setShowSnapshots((value) => !value)}>
                    <i><b /></i>{t('create.showSnapshots')}
                  </button>
                </div>
                <div className="cim-lines">
                  {loading && !manifest && <div className="cim-empty"><NativeIcon name="refresh" size={16} className="is-spinning" /><span>Loading versions…</span></div>}
                  {!loading && groups.length === 0 && <div className="cim-empty">{t('create.noVersionsMatch')}</div>}
                  {groups.map((group) => (
                    <section key={group.key} className="cim-line">
                      <header>
                        {group.art ? <img src={group.art} alt="" /> : <span className="cim-line-dot" />}
                        <strong>{group.title}</strong>
                        <small>{group.entries.length}</small>
                      </header>
                      <div className="cim-line-versions">
                        {group.entries.slice(0, 40).map((entry) => (
                          <button
                            key={entry.id}
                            type="button"
                            data-version={entry.id}
                            className={`cim-ver${version === entry.id ? ' is-on' : ''}`}
                            title={entry.releaseTime ? formatDate(new Date(entry.releaseTime), { year: 'numeric', month: 'short', day: 'numeric' }) : entry.id}
                            onClick={() => setVersion(entry.id)}
                            onDoubleClick={() => { setVersion(entry.id); setStep('loader'); }}
                          >
                            {entry.id}
                            {entry.type !== 'release' && <em>{entry.type.replace('old_', '')}</em>}
                          </button>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
                {manifest?.offline && <p className="cim-note is-warn"><NativeIcon name="alert" size={13} />{t('create.offlineCache')}</p>}
              </>
            )}

            {step === 'loader' && (
              <div className="cim-loaders" role="radiogroup" aria-label="Mod loader">
                {LOADERS.map((option) => {
                  const state = version ? loaderAvailability(option, version, fabricSet) : { available: true };
                  const info = LOADER_INFO[option] || { mark: option[0], blurb: '' };
                  const runsNative = nativeSupport(option, version).ok;
                  return (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={loader === option}
                      disabled={!state.available}
                      className={`cim-loader${loader === option ? ' is-on' : ''}${state.available ? '' : ' is-off'}`}
                      style={info.tint ? { '--tint': info.tint } : undefined}
                      onClick={() => pickLoader(option)}
                      onDoubleClick={() => { pickLoader(option); setStep('extras'); }}
                    >
                      <span className="cim-loader-icon">{info.icon ? <img src={info.icon} alt="" /> : <b>{info.mark}</b>}</span>
                      <span className="cim-loader-text">
                        <strong>{option}{info.recommended && <em>Recommended</em>}</strong>
                        <small>{state.available ? info.blurb : (state.reasonKey ? t(state.reasonKey, state.reasonVars) : state.reason || `Not available for ${version}`)}</small>
                      </span>
                      {state.available && runsNative && <span className="cim-loader-native" title="Runs the Native mod: cosmetics, Relay and HUD in game"><Logo height={11} variant="mark" />Native</span>}
                      <span className="cim-radio" aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            )}

            {step === 'extras' && (
              <div className="cim-extras">
                <section className={`cim-card cim-native${native.ok && nativeMod ? ' is-on' : ''}`}>
                  <span className="cim-native-mark"><Logo height={22} variant="mark" /></span>
                  <div>
                    <strong>Native Client mod</strong>
                    <small>
                      {!native.ok
                        ? `Not available on ${native.loader ? loader : `Minecraft ${version}`}. Pick Fabric on 1.16 or newer for cosmetics, Relay and HUD mods in game.`
                        : nativeMod ? 'Your capes and 3D cosmetics, Relay chat and HUD mods, in game.' : 'Off: no cosmetics, Relay chat or HUD mods in this instance.'}
                    </small>
                  </div>
                  {native.ok && (
                    <button type="button" role="switch" aria-checked={nativeMod} className={`cim-switch is-bare${nativeMod ? ' is-on' : ''}`} onClick={() => setNativeMod((value) => !value)} aria-label="Native Client mod">
                      <i><b /></i>
                    </button>
                  )}
                </section>

                <section className="cim-card">
                  <div className="cim-card-head">
                    <strong>Mod preset</strong>
                    {preset && compatSummary && <small>{compatSummary.ok} of {compatSummary.total} work on {version}</small>}
                  </div>
                  <div className="cim-presets">
                    <button type="button" className={`cim-preset${preset ? '' : ' is-on'}`} onClick={() => setPreset('')}>
                      <strong>None</strong><small>Start clean, add mods later</small>
                    </button>
                    {PRESETS.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        className={`cim-preset${preset === entry.id ? ' is-on' : ''}`}
                        onClick={() => {
                          setPreset(entry.id);
                          if (!PRESET_LOADERS.includes(loader)) setLoader('Fabric');
                          setMemoryMb((current) => Math.max(current, entry.memoryMb));
                        }}
                      >
                        <strong>{entry.name}</strong><small>{entry.tagline}</small>
                      </button>
                    ))}
                  </div>
                  {activePreset && (
                    <div className="cim-mods" role="list">
                      {(compat?.items || presetPlaceholder(activePreset)).map((item) => (
                        <div key={`${item.kind}-${item.slug}`} className={`cim-mod is-${item.status}`} role="listitem">
                          <span className="cim-mod-icon">{item.iconUrl ? <img src={item.iconUrl} alt="" loading="lazy" /> : item.title.slice(0, 1).toUpperCase()}</span>
                          <span className="cim-mod-name">{item.title}{item.kind === 'shader' && <em>Shader</em>}</span>
                          <span className="cim-mod-state">{item.status === 'compatible' ? item.versionNumber || 'Ready' : item.status === 'unavailable' ? 'Skipped' : 'Checking…'}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {compat?.error && <p className="cim-note is-warn"><NativeIcon name="alert" size={13} />Could not check compatibility (offline?). Mods are checked again when installing.</p>}
                </section>

                <section className="cim-card">
                  <div className="cim-card-head">
                    <strong>Memory</strong>
                    <small>{gb(memoryMb)}{systemGb ? ` of ${Math.round(systemGb)} GB on this PC` : ''}</small>
                  </div>
                  <input
                    className="cim-range"
                    type="range"
                    min={RAM_MIN}
                    max={maxRam}
                    step={RAM_STEP}
                    value={Math.min(memoryMb, maxRam)}
                    style={{ '--p': (Math.min(memoryMb, maxRam) - RAM_MIN) / (maxRam - RAM_MIN), '--r': (Math.min(recommendedRam, maxRam) - RAM_MIN) / (maxRam - RAM_MIN) }}
                    onChange={(event) => setMemoryMb(Number(event.target.value))}
                    aria-label="Memory"
                  />
                  <div className="cim-ram-picks">
                    {[2048, 4096, 6144, 8192].filter((mb) => mb <= maxRam).map((mb) => (
                      <button key={mb} type="button" className={memoryMb === mb ? 'is-on' : ''} onClick={() => setMemoryMb(mb)}>
                        {gb(mb)}{mb === recommendedRam && <em>Best</em>}
                      </button>
                    ))}
                  </div>
                  {ramWarn && <p className="cim-note is-warn"><NativeIcon name="alert" size={13} />That’s a lot of this PC’s memory. Leave some for Windows and the launcher.</p>}
                </section>
              </div>
            )}
          </div>

          <footer className="cim-foot">
            <button type="button" className="cim-ghost" onClick={() => goto(-1)} disabled={stepIndex === 0}>
              <NativeIcon name="chevron-left" size={14} />Back
            </button>
            <span className="cim-foot-hint">{step === 'version' ? 'Double-click a version to continue' : step === 'loader' ? 'Fabric runs the Native mod on 1.16+' : 'Ctrl + Enter creates it'}</span>
            {/* creating happens from the one button in the preview panel; the footer only moves between steps */}
            <button type="button" className="cim-next" onClick={() => goto(1)} disabled={stepIndex >= STEPS.length - 1} style={stepIndex >= STEPS.length - 1 ? { visibility: 'hidden' } : undefined} aria-hidden={stepIndex >= STEPS.length - 1 || undefined}>
              Next<NativeIcon name="chevron-right" size={14} />
            </button>
          </footer>
        </section>
      </div>
    </div>
  );
}
