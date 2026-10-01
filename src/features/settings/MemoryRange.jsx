import React from 'react';
import './MemoryRange.css';

const fmt = (gb) => (Number.isInteger(gb) ? `${gb} GB` : `${gb.toFixed(1)} GB`);
const snap = (value, step) => Math.round(value / step) * step;

function Stepper({ label, flag, value, min, max, step, disabled, onChange }) {
  return (
    <div className={`mr-stepper${disabled ? ' is-off' : ''}`}>
      <span className="mr-stepper-label">
        {label} <code>{flag}</code>
      </span>
      <div className="mr-stepper-box">
        <button type="button" aria-label={`Decrease ${label}`} disabled={disabled || value <= min} onClick={() => onChange(Math.max(min, snap(value - step, step)))}>−</button>
        <span className="mr-stepper-value">{fmt(value)}</span>
        <button type="button" aria-label={`Increase ${label}`} disabled={disabled || value >= max} onClick={() => onChange(Math.min(max, snap(value + step, step)))}>+</button>
      </div>
    </div>
  );
}

/**
 * Minimum (-Xms) and maximum (-Xmx) heap on one dual-thumb track.
 * Values are GB in half-GB steps; the minimum can never pass the maximum.
 */
export default function MemoryRange({ min = 1, max = 4, total = 16, step = 0.5, presets = [2, 4, 6, 8, 12, 16], disabled = false, onChange }) {
  const ceiling = Math.max(2, Math.floor(total * 2) / 2);
  const lo = Math.min(Math.max(0.5, Number(min) || 0.5), ceiling);
  const hi = Math.min(Math.max(lo, Number(max) || 4), ceiling);
  const pct = (v) => ((v - 0.5) / (ceiling - 0.5)) * 100;
  const set = (next) => onChange?.(next);
  const share = hi / total;

  return (
    <div className={`mr${disabled ? ' is-disabled' : ''}`}>
      <div className="mr-steppers">
        <Stepper label="Minimum" flag="-Xms" value={lo} min={0.5} max={hi} step={step} disabled={disabled} onChange={(v) => set({ min: v, max: hi })} />
        <Stepper label="Maximum" flag="-Xmx" value={hi} min={Math.max(0.5, lo)} max={ceiling} step={step} disabled={disabled} onChange={(v) => set({ min: Math.min(lo, v), max: v })} />
        <div className="mr-presets" role="group" aria-label="Maximum memory presets">
          {presets.filter((g) => g <= ceiling).map((g) => (
            <button key={g} type="button" disabled={disabled} className={`mr-chip${hi === g ? ' is-on' : ''}`} onClick={() => set({ min: Math.min(lo, g), max: g })}>
              {g} GB
            </button>
          ))}
        </div>
      </div>

      <div className="mr-track-wrap">
        <div className="mr-track">
          <div className="mr-fill" style={{ left: `${pct(lo)}%`, width: `${Math.max(0, pct(hi) - pct(lo))}%` }} />
        </div>
        <input
          type="range"
          className="mr-input"
          min={0.5}
          max={ceiling}
          step={step}
          value={lo}
          disabled={disabled}
          aria-label="Minimum memory"
          onChange={(e) => {
            const v = Number(e.target.value);
            set({ min: Math.min(v, hi), max: hi });
          }}
        />
        <input
          type="range"
          className="mr-input"
          min={0.5}
          max={ceiling}
          step={step}
          value={hi}
          disabled={disabled}
          aria-label="Maximum memory"
          onChange={(e) => {
            const v = Math.max(Number(e.target.value), 0.5);
            set({ min: Math.min(lo, v), max: v });
          }}
        />
      </div>
      <div className="mr-ticks">
        <span>0.5 GB</span>
        <span>{fmt(Math.round(ceiling / 4))}</span>
        <span>{fmt(Math.round(ceiling / 2))}</span>
        <span>{fmt(Math.round((ceiling * 3) / 4))}</span>
        <span>{fmt(ceiling)}</span>
      </div>

      {hi > total ? (
        <p className="mr-note is-bad">More than this computer has ({fmt(Math.floor(total))}). The game will fail to start.</p>
      ) : share > 0.75 ? (
        <p className="mr-note is-warn">Leaves little memory for your system and other apps. Most modpacks are happy with 6–8 GB.</p>
      ) : lo === hi ? (
        <p className="mr-note">Minimum equals maximum: Java reserves the whole heap up front, which some GC presets prefer.</p>
      ) : null}
    </div>
  );
}
