import React, { useEffect, useMemo, useRef, useState } from 'react';
import NativeIcon from '../../components/ui/NativeIcon.jsx';
import MemoryRange from './MemoryRange.jsx';
import { ArchBadge, JavaPicker, runtimeMeta, runtimeTitle, useJavaRuntimes } from './javaUi.jsx';
import { GC_PRESETS, buildJvmArgs } from '../../lib/jvmFlags.js';
import './JavaPanel.css';

const SLOTS = [
  { slot: 25, range: 'Minecraft 26.1 and newer' },
  { slot: 21, range: 'Minecraft 1.20.5 – 1.21.x' },
  { slot: 17, range: 'Minecraft 1.17 – 1.20.4' },
  { slot: 8, range: 'Minecraft 1.16.5 and older' }
];
const fits = (slot, major) => (slot === 8 ? major === 8 : major >= slot);

async function patchSettings(patch) {
  const api = window.native?.settings;
  if (!api) return null;
  const current = await api.load();
  return api.save({ ...current, ...patch(current) });
}

/** Launcher-wide memory (min/max heap), used by every instance without an override. */
export function GlobalMemory() {
  const [memory, setMemory] = useState(null);
  const [total, setTotal] = useState(16);
  const saveTimer = useRef(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([window.native?.settings?.load?.(), window.native?.settings?.systemMemory?.()])
      .then(([settings, mem]) => {
        if (cancelled) return;
        setMemory(settings?.memory || { min: 1, max: 4 });
        if (mem?.totalGb) setTotal(mem.totalGb);
      })
      .catch(() => setMemory({ min: 1, max: 4 }));
    return () => {
      cancelled = true;
      clearTimeout(saveTimer.current);
    };
  }, []);

  if (!memory) return null;
  const change = (next) => {
    setMemory(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => patchSettings(() => ({ memory: next })).catch(() => {}), 250);
  };
  return <MemoryRange min={memory.min} max={memory.max} total={total} onChange={change} />;
}

export default function JavaPanel() {
  const { list, scanning, host, rescan } = useJavaRuntimes();
  const [paths, setPaths] = useState(null);
  const [slotInfo, setSlotInfo] = useState({});
  const [jvm, setJvm] = useState({ preset: 'none', args: '' });
  const [installing, setInstalling] = useState({});
  const [memoryMax, setMemoryMax] = useState(4);
  const argsTimer = useRef(null);

  const loadSlots = async () => {
    const api = window.native?.java;
    if (!api?.slots) return;
    const slots = await api.slots().catch(() => []);
    setSlotInfo(Object.fromEntries(slots.map((s) => [s.slot, s])));
  };

  useEffect(() => {
    window.native?.settings?.load?.().then((settings) => {
      setPaths(settings?.java?.paths || {});
      setJvm({ preset: settings?.jvm?.preset || 'none', args: settings?.jvm?.args || '' });
      setMemoryMax(Number(settings?.memory?.max) || 4);
    }).catch(() => setPaths({}));
    loadSlots();
    const off = window.native?.java?.onProgress?.(({ major, percent }) => {
      setInstalling((prev) => (prev[major] === undefined ? prev : { ...prev, [major]: percent?.percent ?? percent }));
    });
    return () => {
      off?.();
      clearTimeout(argsTimer.current);
    };
  }, []);

  const setSlot = async (slot, javaPath) => {
    setPaths((prev) => ({ ...prev, [slot]: javaPath }));
    await window.native?.java?.setSlot?.(slot, javaPath);
    loadSlots();
  };

  const install = async (slot) => {
    setInstalling((prev) => ({ ...prev, [slot]: 0 }));
    try {
      const binary = await window.native.java.install(slot);
      setPaths((prev) => ({ ...prev, [slot]: binary }));
      await loadSlots();
      rescan();
    } catch {
      /* the slot row keeps showing "Not installed" */
    } finally {
      setInstalling((prev) => {
        const next = { ...prev };
        delete next[slot];
        return next;
      });
    }
  };

  const saveJvm = (next, delay = 0) => {
    setJvm(next);
    clearTimeout(argsTimer.current);
    argsTimer.current = setTimeout(() => patchSettings(() => ({ jvm: next })).catch(() => {}), delay);
  };

  const preview = useMemo(() => buildJvmArgs({ preset: jvm.preset, args: jvm.args, major: 21, memoryMaxGb: memoryMax }), [jvm, memoryMax]);
  const presetInfo = GC_PRESETS.find((p) => p.id === jvm.preset) || GC_PRESETS[0];

  return (
    <>
      <div className="settings-section-block">
        <div className="settings-section-title-wrap">
          <span className="settings-section-title">Java runtimes</span>
          <div className="settings-section-line" />
        </div>
        <p className="jp-lead">
          Each Minecraft version needs a specific Java. Native picks the right one automatically, preferring a native 64-bit
          build, and downloads Eclipse Temurin when nothing suitable is installed. Pin a runtime here to override that.
        </p>
        <div className="jp-rows">
          {SLOTS.map(({ slot, range }) => {
            const info = slotInfo[slot];
            const rt = info?.runtime;
            const busy = installing[slot] !== undefined;
            return (
              <div className="jp-row" key={slot}>
                <div className="jp-row-id">
                  <strong>Java {slot}</strong>
                  <span>{range}</span>
                </div>
                <div className="jp-row-state">
                  {busy ? (
                    <span className="jp-state">Downloading Temurin {slot}{installing[slot] ? ` · ${Math.round(installing[slot])}%` : '…'}</span>
                  ) : rt ? (
                    <>
                      <span className="jp-state">
                        {runtimeTitle(rt)} <em>{runtimeMeta(rt)}</em>
                      </span>
                      <ArchBadge runtime={rt} host={host} />
                    </>
                  ) : (
                    <span className="jp-state is-muted">Chosen at launch{list.some((r) => fits(slot, r.major)) ? ' from detected runtimes' : ' · will download'}</span>
                  )}
                </div>
                <div className="jp-row-pick">
                  <JavaPicker
                    value={paths?.[slot] || ''}
                    runtimes={list}
                    filter={(r) => r.major !== null && fits(slot, r.major)}
                    autoLabel="Automatic"
                    onChange={(p) => setSlot(slot, p)}
                    disabled={busy || !paths}
                  />
                  {!rt && !busy && (
                    <button type="button" className="jp-btn" onClick={() => install(slot)}>
                      <NativeIcon name="download" size={14} />
                      Download
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="settings-section-block">
        <div className="settings-section-title-wrap">
          <span className="settings-section-title">Found on this computer</span>
          <div className="settings-section-line" />
        </div>
        <div className="jp-found-head">
          <span>
            {scanning
              ? 'Scanning drives, PATH, JAVA_HOME, the registry and other launchers…'
              : `${list.length} Java runtime${list.length === 1 ? '' : 's'} · each one verified by running it`}
          </span>
          <button type="button" className="jp-btn" onClick={rescan} disabled={scanning}>
            <NativeIcon name={scanning ? 'loader' : 'refresh'} size={14} className={scanning ? 'jx-spin' : ''} />
            {scanning ? 'Scanning…' : 'Rescan'}
          </button>
        </div>
        <div className="jp-found">
          {list.map((rt) => (
            <div className="jp-found-row" key={rt.path}>
              <span className="jp-found-major">{rt.major ?? '?'}</span>
              <div className="jp-found-text">
                <strong>
                  {runtimeTitle(rt)} <em>{rt.vendor}</em>
                </strong>
                <code title={rt.path}>{rt.path}</code>
              </div>
              <span className="jp-found-source">{rt.source}</span>
              <ArchBadge runtime={rt} host={host} />
            </div>
          ))}
          {!scanning && list.length === 0 && (
            <div className="jp-found-empty">No Java installations found. Native downloads the right one the first time you launch.</div>
          )}
        </div>
      </div>

      <div className="settings-section-block">
        <div className="settings-section-title-wrap">
          <span className="settings-section-title">JVM arguments</span>
          <div className="settings-section-line" />
        </div>
        <p className="jp-lead">Used by every instance that doesn’t set its own. Flags a Java version can’t handle are caught before launch.</p>
        <div className="jp-presets" role="radiogroup" aria-label="Garbage collector preset">
          {GC_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={jvm.preset === preset.id}
              className={`jp-preset${jvm.preset === preset.id ? ' is-on' : ''}`}
              onClick={() => saveJvm({ ...jvm, preset: preset.id })}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <p className="jp-preset-desc">{presetInfo.description}</p>
        <label className="jp-field">
          <span>Custom arguments</span>
          <input
            type="text"
            className="noctra-code-input"
            placeholder="-Dsodium.checks.issue2561=false -Xss2M"
            value={jvm.args}
            spellCheck={false}
            onChange={(e) => saveJvm({ ...jvm, args: e.target.value }, 500)}
          />
        </label>
        {preview.length > 0 && (
          <div className="jp-preview">
            <span>Passed to Java{jvm.preset === 'zgc' ? ' (Java 21 shown — adjusted per version)' : ''}</span>
            <code>{preview.join(' ')}</code>
          </div>
        )}
      </div>
    </>
  );
}
