import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Layers, Plus, Settings2, SlidersHorizontal } from 'lucide-react';
import { getClusterArt } from '../../../data/versionsData.js';
import { isVanilla, loaderOf, versionOf } from '../api/modrinthApi.js';

import useVersionBanners from '../../../lib/useVersionBanners.js';
export default function InstanceSwitcher({
  instances = [],
  target = null,
  onSelect,
  onManage,
  onCreate
}) {
  useVersionBanners();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const pick = (instance) => {
    setOpen(false);
    onSelect?.(instance);
  };

  return (
    <div className="browse-switcher" ref={rootRef} data-testid="browse-instance-switcher">
      <span className="browse-switcher-label">Installing to</span>

      <button
        type="button"
        className={`browse-switcher-btn ${open ? 'is-open' : ''} ${target ? 'has-target' : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid="browse-instance-switcher-btn"
      >
        {target ? (
          <>
            <img className="browse-switcher-thumb" src={getClusterArt(target)} alt="" />
            <span className="browse-switcher-text">
              <span className="browse-switcher-name">{target.name}</span>
              <span className="browse-switcher-meta">
                {versionOf(target)} · {loaderOf(target)}
              </span>
            </span>
          </>
        ) : (
          <>
            <span className="browse-switcher-thumb is-any">
              <Layers size={15} />
            </span>
            <span className="browse-switcher-text">
              <span className="browse-switcher-name">Ask me each time</span>
              <span className="browse-switcher-meta">Pick an instance on install</span>
            </span>
          </>
        )}
        <ChevronDown size={14} className="browse-switcher-chevron" />
      </button>

      {target && (
        <button
          type="button"
          className="browse-switcher-settings"
          onClick={() => onManage?.(target)}
          title="Open instance settings"
          aria-label="Open instance settings"
          data-testid="browse-instance-settings-btn"
        >
          <SlidersHorizontal size={15} />
        </button>
      )}

      {open && (
        <div className="browse-switcher-menu" role="listbox" data-testid="browse-instance-switcher-menu">
          <button
            type="button"
            role="option"
            aria-selected={!target}
            className={`browse-switcher-item ${!target ? 'is-selected' : ''}`}
            onClick={() => pick(null)}
          >
            <span className="browse-switcher-thumb is-any">
              <Layers size={15} />
            </span>
            <span className="browse-switcher-text">
              <span className="browse-switcher-name">Ask me each time</span>
              <span className="browse-switcher-meta">Choose an instance when installing</span>
            </span>
            {!target && <Check size={14} className="browse-switcher-check" />}
          </button>

          {instances.length > 0 && <div className="browse-switcher-divider" />}

          <div className="browse-switcher-list">
            {instances.map((inst) => {
              const selected = target?.id === inst.id;
              return (
                <button
                  key={inst.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`browse-switcher-item ${selected ? 'is-selected' : ''}`}
                  onClick={() => pick(inst)}
                >
                  <img className="browse-switcher-thumb" src={getClusterArt(inst)} alt="" loading="lazy" />
                  <span className="browse-switcher-text">
                    <span className="browse-switcher-name">{inst.name}</span>
                    <span className={`browse-switcher-meta ${isVanilla(inst) ? 'is-vanilla' : ''}`}>
                      {versionOf(inst)} · {loaderOf(inst)}
                    </span>
                  </span>
                  {selected && <Check size={14} className="browse-switcher-check" />}
                </button>
              );
            })}
          </div>

          <div className="browse-switcher-divider" />

          <div className="browse-switcher-footer">
            <button
              type="button"
              className="browse-switcher-action"
              onClick={() => {
                setOpen(false);
                onManage?.(null);
              }}
              data-testid="browse-manage-instances-btn"
            >
              <Settings2 size={13} /> Manage instances
            </button>
            {onCreate && (
              <button
                type="button"
                className="browse-switcher-action"
                onClick={() => {
                  setOpen(false);
                  onCreate();
                }}
              >
                <Plus size={13} /> New instance
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
