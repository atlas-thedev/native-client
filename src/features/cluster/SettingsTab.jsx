import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Cloud,
  Code2,
  Coffee,
  Cpu,
  Maximize2,
  Minus,
  Monitor,
  Plus,
  RotateCcw,
  Save,
  SquareDashed,
  Square
} from 'lucide-react';
import MemoryRange from '../settings/MemoryRange.jsx';
import { CompatNote, JavaPicker, useJavaCheck, useJavaRuntimes } from '../settings/javaUi.jsx';
import { GC_PRESETS, buildJvmArgs } from '../../lib/jvmFlags.js';
import './SettingsTab.css';

/* ============================================================
   Instance settings — per-instance overrides.

   Rebuilt from scratch. Every interactive control in this screen
   is a bespoke, self-contained primitive defined in this file
   (NisToggle, NisSegmented, NisSlider, NisStepper, NisButton,
   NisPill, NisField) — nothing is imported from the shared UI
   library, so the whole surface can evolve independently.

   Structure follows settings-UX best practice: three "override
   models" (Display, Memory, Java), each a card that can be toggled
   on to override the launcher-wide default. Related controls are
   grouped, each value uses the control best suited to it, the
   global default stays obvious, saving is explicit, and resets
   are always one click away.
   ============================================================ */

/* ----------------------------------------------------------------
   From-scratch UI primitives (no shared imports)
   ---------------------------------------------------------------- */

function NisToggle({ checked = false, onChange = () => {}, disabled = false, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`nis-toggle ${checked ? 'is-on' : ''}`}
      onClick={() => !disabled && onChange(!checked)}
    >
      <span className="nis-toggle-track" />
      <span className="nis-toggle-thumb" />
    </button>
  );
}

function NisSegmented({ value, options, onChange = () => {}, disabled = false, label }) {
  return (
    <div className="nis-seg" role="radiogroup" aria-label={label}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            type="button"
            key={opt.value}
            role="radio"
            aria-checked={active}
            disabled={disabled}
            className={`nis-seg-item ${active ? 'is-active' : ''}`}
            onClick={() => onChange(opt.value)}
          >
            {opt.icon}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function NisSlider({ value, min = 0, max = 100, step = 1, onChange = () => {}, disabled = false, label }) {
  return (
    <input
      type="range"
      className="nis-slider"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={label}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  );
}

function NisStepper({ value, min = 1, max = 99, step = 1, onChange = () => {}, disabled = false, suffix }) {
  const clamp = (n) => Math.max(min, Math.min(max, n));
  return (
    <div className={`nis-stepper ${disabled ? 'is-off' : ''}`}>
      <button
        type="button"
        className="nis-stepper-btn"
        aria-label="Decrease"
        disabled={disabled || Number(value) <= min}
        onClick={() => onChange(clamp(Number(value) - step))}
      >
        <Minus size={13} />
      </button>
      <span className="nis-stepper-value">
        {value}
        {suffix ? <em>{suffix}</em> : null}
      </span>
      <button
        type="button"
        className="nis-stepper-btn"
        aria-label="Increase"
        disabled={disabled || Number(value) >= max}
        onClick={() => onChange(clamp(Number(value) + step))}
      >
        <Plus size={13} />
      </button>
    </div>
  );
}

function NisButton({ variant = 'ghost', children, ...props }) {
  return (
    <button className={`nis-btn nis-btn-${variant}`} {...props}>
      {children}
    </button>
  );
}

function NisPill({ active = false, children, ...props }) {
  return (
    <button type="button" className={`nis-pill ${active ? 'is-active' : ''}`} {...props}>
      {children}
    </button>
  );
}

function NisNumber({ label, value, min, max, disabled, onChange }) {
  return (
    <label className={`nis-dim ${disabled ? 'is-off' : ''}`}>
      <span className="nis-dim-label">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        disabled={disabled}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

/* ----------------------------------------------------------------
   Static config
   ---------------------------------------------------------------- */

const RES_PRESETS = [
  ['720p', 1280, 720],
  ['1080p', 1920, 1080],
  ['1440p', 2560, 1440],
  ['4K', 3840, 2160]
];

const DISPLAY_MODES = [
  { value: 'windowed', label: 'Windowed', icon: <Square size={13} /> },
  { value: 'borderless', label: 'Borderless', icon: <SquareDashed size={13} /> },
  { value: 'fullscreen', label: 'Fullscreen', icon: <Maximize2 size={13} /> }
];

/* Search haystacks so the toolbar search box can filter sections. */
const SECTION_TERMS = {
  display: 'game resolution display fullscreen borderless window size aspect ratio',
  memory: 'allocated memory ram heap gigabytes xms xmx minimum maximum',
  java: 'java runtime executable version jdk jre architecture x64 x86 arm64 compatibility path',
  jvm: 'jvm arguments flags garbage collection gc zgc shenandoah aikar g1 performance'
};

function safeRatio(width, height) {
  const ratio = Number(width) / Number(height);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 16 / 9;
}

function initialDraft(cluster, global) {
  const ov = cluster.overrides || {};
  return {
    resolution: {
      ...(global.resolution || { width: 854, height: 480, fullscreen: false }),
      ...ov.resolution,
      enabled: !!ov.resolution?.enabled,
      lockAspect: ov.resolution?.lockAspect ?? true,
      borderless: ov.resolution?.borderless ?? false
    },
    memory: {
      ...(global.memory || { min: 1, max: 4 }),
      ...ov.memory,
      enabled: !!ov.memory?.enabled
    },
    javaEnabled: !!ov.java?.enabled,
    javaPath: ov.java?.path || '',
    jvmEnabled: ov.jvmEnabled ?? !!ov.jvmArgs,
    jvmPreset: ov.jvmPreset || 'none',
    jvmArgs: ov.jvmArgs || ''
  };
}

export default function SettingsTab({ cluster, onUpdateCluster, query = '', enabledOnly = false, onDirtyChange }) {
  const [draft, setDraft] = useState(() => initialDraft(cluster, {}));
  const [baseline, setBaseline] = useState(() => JSON.stringify(initialDraft(cluster, {})));
  const [systemRam, setSystemRam] = useState(32);
  const [systemRamExact, setSystemRamExact] = useState(32);
  const runtimes = useJavaRuntimes();
  const [globals, setGlobals] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const ratio = useRef(16 / 9);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError('');
    Promise.all([window.native.settings.load(), window.native.settings.systemMemory()])
      .then(([global, memory]) => {
        if (cancelled) return;
        const next = initialDraft(cluster, global);
        setGlobals(global);
        setSystemRam(Math.max(1, Math.floor(memory.totalGb)));
        setSystemRamExact(Math.max(1, memory.totalGb));
        setDraft(next);
        setBaseline(JSON.stringify(next));
        ratio.current = safeRatio(next.resolution.width, next.resolution.height);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Could not read settings.');
      });
    return () => {
      cancelled = true;
    };
  }, [cluster.id, retry]);

  const dirty = !!draft && JSON.stringify(draft) !== baseline;
  useEffect(() => {
    onDirtyChange?.(dirty || saving);
  }, [dirty, saving, onDirtyChange]);

  const change = (key, value) => {
    setSaved(false);
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const resolution = (values) => change('resolution', { ...draft.resolution, ...values });
  const memory = (values) => {
    const next = { ...draft.memory, ...values };
    // A global default above this machine's RAM must not be carried into an override.
    if (next.max > systemRamExact) next.max = Math.floor(systemRamExact * 2) / 2;
    if (!(next.max >= 0.5)) next.max = 0.5;
    if (!(next.min >= 0.5)) next.min = 0.5;
    if (next.min > next.max) next.min = next.max;
    change('memory', next);
  };

  const applySize = (width, height) => {
    resolution({ width, height });
    ratio.current = safeRatio(width, height);
  };

  const changeDimension = (key, value) => {
    const next = { [key]: value };
    if (draft.resolution.lockAspect && Number(value) > 0) {
      next[key === 'width' ? 'height' : 'width'] = Math.round(
        key === 'width' ? Number(value) / ratio.current : Number(value) * ratio.current
      );
    }
    resolution(next);
  };

  const setDisplayMode = (mode) =>
    resolution({ fullscreen: mode === 'fullscreen', borderless: mode === 'borderless' });

  const resetAll = () => {
    setSaved(false);
    setDraft((cur) => ({
      ...cur,
      resolution: { ...cur.resolution, enabled: false },
      memory: { ...cur.memory, enabled: false },
      javaEnabled: false,
      jvmEnabled: false
    }));
  };

  const discard = () => {
    setSaved(false);
    try {
      setDraft(JSON.parse(baseline));
    } catch {
      /* keep current draft if baseline is unreadable */
    }
  };

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const next = {
        ...draft,
        resolution: {
          ...draft.resolution,
          width: Number(draft.resolution.width),
          height: Number(draft.resolution.height)
        }
      };
      if (
        next.resolution.enabled &&
        (!Number.isInteger(next.resolution.width) ||
          !Number.isInteger(next.resolution.height) ||
          next.resolution.width < 320 ||
          next.resolution.width > 7680 ||
          next.resolution.height < 240 ||
          next.resolution.height > 4320)
      ) {
        throw new Error('Resolution must be 320\u20137680 px wide and 240\u20134320 px high.');
      }
      await onUpdateCluster(cluster.id, {
        overrides: {
          ...cluster.overrides,
          resolution: next.resolution,
          memory: { ...next.memory, min: Math.min(next.memory.min || 1, next.memory.max) },
          java: { enabled: next.javaEnabled && !!next.javaPath.trim(), path: next.javaPath.trim() },
          jvmEnabled: next.jvmEnabled,
          jvmPreset: next.jvmPreset,
          jvmArgs: next.jvmArgs.trim()
        }
      });
      setDraft(next);
      setBaseline(JSON.stringify(next));
      setSaved(true);
    } catch (err) {
      setError(err.message || 'Settings could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  // What this instance would launch with right now, checked live.
  const effMemoryMax = draft.memory?.enabled ? Number(draft.memory.max) : Number(globals.memory?.max) || 4;
  const effPreset = draft.jvmEnabled ? draft.jvmPreset : globals.jvm?.preset || 'none';
  const effArgs = draft.jvmEnabled ? draft.jvmArgs : globals.jvm?.args || '';
  const javaCheck = useJavaCheck({
    javaPath: draft.javaEnabled && draft.javaPath.trim() ? draft.javaPath.trim() : null,
    mcVersion: cluster.version || cluster.mc_version,
    loader: cluster.loader || cluster.mc_loader || 'vanilla',
    memoryMaxGb: effMemoryMax,
    preset: effPreset,
    args: effArgs
  });

  if (!draft) {
    return (
      <div className="nis-loading">
        {error ? (
          <>
            <AlertCircle size={18} />
            <span role="alert">{error}</span>
            <NisButton type="button" onClick={() => setRetry((v) => v + 1)}>
              Retry
            </NisButton>
          </>
        ) : (
          'Loading settings\u2026'
        )}
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const show = (id, enabled) => SECTION_TERMS[id].includes(q) && (!enabledOnly || enabled);

  const r = draft.resolution;
  const m = draft.memory;
  const displayMode = r.fullscreen ? 'fullscreen' : r.borderless ? 'borderless' : 'windowed';
  const sizeLocked = displayMode === 'fullscreen';
  const memWarn = m.enabled && m.max > systemRamExact;
  const activeOverrides = [r.enabled, m.enabled, draft.javaEnabled, draft.jvmEnabled].filter(Boolean).length;
  const anyVisible = show('display', r.enabled) || show('memory', m.enabled) || show('java', draft.javaEnabled) || show('jvm', draft.jvmEnabled);
  const mcVersion = cluster.version || cluster.mc_version;
  const presetInfo = GC_PRESETS.find((p) => p.id === draft.jvmPreset) || GC_PRESETS[0];
  const flagPreview = javaCheck.result?.flags
    || buildJvmArgs({ preset: effPreset, args: effArgs, major: null, memoryMaxGb: effMemoryMax });

  return (
    <form className="nis" onSubmit={save} noValidate>
      <div className="nis-scroll">
        {/* Caution + override scope banner */}
        <div className="nis-banner" role="note">
          <div className="nis-banner-left">
            <AlertTriangle size={18} className="nis-banner-icon" />
            <span className="nis-banner-text">
              These overrides apply only to <strong>{cluster.name || cluster.version}</strong>. Aggressive changes may make the game unstable.
            </span>
          </div>
          <div className="nis-banner-status">
            <Cloud size={12} />
            <span>{activeOverrides} of 4 overriding global</span>
          </div>
        </div>

        {/* Section 1 — Display */}
        {show('display', r.enabled) && (
          <section className={`nis-card ${r.enabled ? 'is-active' : ''}`}>
            <header className="nis-card-head">
              <div className="nis-card-id">
                <div className="nis-card-icon">
                  <Maximize2 size={18} />
                </div>
                <div>
                  <h3 className="nis-card-title">Game Resolution</h3>
                  <p className="nis-card-desc">Set a custom launch window size and display mode for this instance.</p>
                </div>
              </div>
              <NisToggle checked={r.enabled} onChange={(enabled) => resolution({ enabled })} label="Override display" />
            </header>

            <fieldset className="nis-card-body" disabled={!r.enabled || saving}>
              <div className="nis-field">
                <span className="nis-field-label">Display mode</span>
                <NisSegmented
                  value={displayMode}
                  options={DISPLAY_MODES}
                  onChange={setDisplayMode}
                  disabled={!r.enabled || saving}
                  label="Display mode"
                />
              </div>

              <div className="nis-row">
                <NisNumber label="W" min="320" max="7680" value={r.width} disabled={sizeLocked} onChange={(v) => changeDimension('width', v)} />
                <span className="nis-x">{'\u00d7'}</span>
                <NisNumber label="H" min="240" max="4320" value={r.height} disabled={sizeLocked} onChange={(v) => changeDimension('height', v)} />

                <div className="nis-toggle-line">
                  <span>Lock aspect ratio</span>
                  <NisToggle
                    checked={r.lockAspect}
                    disabled={sizeLocked}
                    label="Lock aspect ratio"
                    onChange={(lockAspect) => {
                      ratio.current = safeRatio(r.width, r.height);
                      resolution({ lockAspect });
                    }}
                  />
                </div>

                <button
                  type="button"
                  className="nis-reset"
                  title="Reset to global resolution"
                  aria-label="Reset to global resolution"
                  onClick={() => applySize(globals.resolution?.width || 854, globals.resolution?.height || 480)}
                >
                  <RotateCcw size={14} />
                </button>
              </div>

              <div className={`nis-presets ${sizeLocked ? 'is-off' : ''}`}>
                <span className="nis-presets-label">Presets</span>
                {RES_PRESETS.map(([label, width, height]) => (
                  <NisPill
                    key={label}
                    active={Number(r.width) === width && Number(r.height) === height}
                    disabled={sizeLocked}
                    onClick={() => applySize(width, height)}
                  >
                    {label}
                  </NisPill>
                ))}
                <NisPill
                  disabled={sizeLocked}
                  onClick={() =>
                    applySize(
                      Math.round(screen.width * (window.devicePixelRatio || 1)),
                      Math.round(screen.height * (window.devicePixelRatio || 1))
                    )
                  }
                >
                  <Monitor size={12} /> Native display
                </NisPill>
              </div>
            </fieldset>
          </section>
        )}

        {/* Section 2 — Memory */}
        {show('memory', m.enabled) && (
          <section className={`nis-card ${m.enabled ? 'is-active' : ''}`}>
            <header className="nis-card-head">
              <div className="nis-card-id">
                <div className="nis-card-icon">
                  <Cpu size={18} />
                </div>
                <div>
                  <h3 className="nis-card-title">Allocated Memory (RAM)</h3>
                  <p className="nis-card-desc">Override how much RAM the JVM may use for this instance.</p>
                </div>
              </div>
              <NisToggle checked={m.enabled} onChange={(enabled) => memory({ enabled })} label="Override memory" />
            </header>

            <fieldset className="nis-card-body" disabled={!m.enabled || saving}>
              <MemoryRange
                min={Number(m.min) || 1}
                max={Number(m.max) || 4}
                total={systemRamExact}
                presets={[2, 4, 6, 8, 12, 16]}
                disabled={!m.enabled || saving}
                onChange={(next) => memory(next)}
              />
              {!m.enabled && (
                <p className="nis-field-hint">
                  Using the launcher default: {globals.memory?.min ?? 1}–{globals.memory?.max ?? 4} GB.
                </p>
              )}
            </fieldset>
          </section>
        )}

        {/* Section 3 — Java runtime */}
        {show('java', draft.javaEnabled) && (
          <section className={`nis-card ${draft.javaEnabled ? 'is-active' : ''}`}>
            <header className="nis-card-head">
              <div className="nis-card-id">
                <div className="nis-card-icon">
                  <Coffee size={18} />
                </div>
                <div>
                  <h3 className="nis-card-title">Java Runtime</h3>
                  <p className="nis-card-desc">Pin a specific Java for this instance instead of the automatic choice.</p>
                </div>
              </div>
              <NisToggle checked={draft.javaEnabled} onChange={(value) => change('javaEnabled', value)} label="Override Java" />
            </header>

            <div className="nis-card-body">
              {draft.javaEnabled && (
                <div className="nis-field">
                  <span className="nis-field-label">Java executable</span>
                  <JavaPicker
                    value={draft.javaPath}
                    onChange={(value) => change('javaPath', value)}
                    runtimes={runtimes.list}
                    scanning={runtimes.scanning}
                    onRescan={runtimes.rescan}
                    autoLabel="Choose a Java…"
                    disabled={saving}
                  />
                </div>
              )}
              <CompatNote check={javaCheck.result} loading={javaCheck.loading} mcVersion={mcVersion} />
            </div>
          </section>
        )}

        {/* Section 4 — JVM arguments */}
        {show('jvm', draft.jvmEnabled) && (
          <section className={`nis-card ${draft.jvmEnabled ? 'is-active' : ''}`}>
            <header className="nis-card-head">
              <div className="nis-card-id">
                <div className="nis-card-icon">
                  <Code2 size={18} />
                </div>
                <div>
                  <h3 className="nis-card-title">JVM Arguments</h3>
                  <p className="nis-card-desc">Garbage collector preset and extra flags for this instance.</p>
                </div>
              </div>
              <NisToggle checked={draft.jvmEnabled} onChange={(value) => change('jvmEnabled', value)} label="Override JVM arguments" />
            </header>

            <fieldset className="nis-card-body" disabled={!draft.jvmEnabled || saving}>
              <div className="nis-field">
                <span className="nis-field-label">Garbage collector</span>
                <div className="nis-mem-quick">
                  {GC_PRESETS.map((preset) => (
                    <NisPill key={preset.id} active={draft.jvmPreset === preset.id} onClick={() => change('jvmPreset', preset.id)}>
                      {preset.label}
                    </NisPill>
                  ))}
                </div>
                <span className="nis-field-hint">{presetInfo.description}</span>
              </div>

              <label className="nis-field">
                <span className="nis-field-label">Custom arguments</span>
                <textarea
                  className="nis-textarea"
                  rows={2}
                  value={draft.jvmArgs}
                  onChange={(event) => change('jvmArgs', event.target.value)}
                  placeholder="-Dsodium.checks.issue2561=false -Xss2M"
                  spellCheck={false}
                />
                <span className="nis-field-hint">
                  Separate flags with spaces; quote values that contain spaces. Memory is set above, so -Xmx/-Xms here are ignored.
                </span>
              </label>
            </fieldset>
            {flagPreview.length > 0 && (
              <div className="nis-flags">
                <span>{draft.jvmEnabled ? 'Passed to Java' : 'Passed to Java (launcher default)'}</span>
                <code>{flagPreview.join(' ')}</code>
              </div>
            )}
          </section>
        )}

        {!anyVisible && <div className="nis-empty">No matching settings found.</div>}
      </div>

      {/* Sticky footer */}
      <footer className="nis-footer">
        <span
          className={`nis-status ${error ? 'is-error' : saved ? 'is-saved' : dirty ? 'is-dirty' : ''}`}
          role={error ? 'alert' : 'status'}
        >
          {error ||
            (saved
              ? 'Changes saved \u2014 applies on next launch.'
              : dirty
                ? 'You have unsaved changes.'
                : 'Disabled overrides inherit the global defaults.')}
        </span>

        <div className="nis-footer-actions">
          {activeOverrides > 0 && (
            <NisButton type="button" onClick={resetAll} disabled={saving}>
              Reset all to global
            </NisButton>
          )}
          {dirty && (
            <NisButton type="button" onClick={discard} disabled={saving}>
              Discard
            </NisButton>
          )}
          <NisButton variant="primary" type="submit" disabled={saving || !dirty || memWarn}>
            {saved ? <Check size={15} /> : <Save size={15} />}
            <span>{saving ? 'Saving\u2026' : saved ? 'Saved' : 'Save changes'}</span>
          </NisButton>
        </div>
      </footer>
    </form>
  );
}
