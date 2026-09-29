import React from 'react';
import { ArrowDownToLine, Check, Loader2, Trash2 } from 'lucide-react';

export default function InstallButton({
  project,
  isModOnVanilla = false,
  isInstalled = false,
  isBusy = false,
  isFetching = false,
  packProgress = null,
  large = false,
  onInstall,
  onRemove
}) {
  const sizeClass = large ? ' is-large' : '';

  if (isModOnVanilla) {
    return (
      <button
        type="button"
        className={`browse-btn browse-btn-install is-disabled-vanilla${sizeClass}`}
        disabled
        title="Minecraft Vanilla does not support mods"
      >
        Vanilla (No Mods)
      </button>
    );
  }

  if (isFetching) {
    return (
      <button type="button" className={`browse-btn browse-btn-busy${sizeClass}`} disabled>
        <Loader2 size={13} className="browse-spin-icon" />
        <span>Loading versions…</span>
      </button>
    );
  }

  if (isBusy) {
    return (
      <button type="button" className={`browse-btn browse-btn-busy${sizeClass}`} disabled>
        <Loader2 size={13} className="browse-spin-icon" />
        <span>{packProgress ? `${Math.round(packProgress.percent || 0)}%` : 'Installing…'}</span>
      </button>
    );
  }

  if (isInstalled) {
    return (
      <button
        type="button"
        className={`browse-btn browse-btn-installed${sizeClass}`}
        onClick={(e) => {
          e.stopPropagation();
          onRemove?.(project);
        }}
        title="Remove from instance"
      >
        <span className="browse-btn-text-installed">
          <Check size={13} /> Installed
        </span>
        <span className="browse-btn-text-remove">
          <Trash2 size={13} /> Remove
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`browse-btn browse-btn-install${sizeClass}`}
      onClick={(e) => {
        e.stopPropagation();
        onInstall?.(project);
      }}
    >
      <ArrowDownToLine size={13} />
      <span>Install</span>
    </button>
  );
}
