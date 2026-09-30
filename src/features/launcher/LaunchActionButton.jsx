import React from 'react';
import NativeIcon from '../../components/ui/NativeIcon.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import { formatBytes } from './useLauncher.js';
import './LaunchActionButton.css';

/**
 * The one action button for a game install: Install, Download, Verify, Launch
 * and Stop are the same control in different states, so the shape, spacing and
 * colour language stay identical everywhere it appears (home hero, instance
 * cards, version picker).
 *
 * `size` — 'lg' hero · 'md' cards · 'sm' sidebars and dense rows.
 */
export default function LaunchActionButton({
  instance,
  launcherState,
  isInstalled,
  onLaunch,
  onKill,
  size = 'lg',
  installLabel = null,
  className = ''
}) {
  const { t } = useI18n();

  const status = launcherState?.status || 'idle';
  const phase = launcherState?.phase || null;
  const isRunning = status === 'running' || status === 'game-running';
  const isBusy = Boolean(launcherState?.busy) && !isRunning;
  const isVerifying = status === 'verifying' || phase === 'verifying';
  const isDownloading = !isVerifying && (status === 'downloading' || phase === 'downloading');

  const mode = isRunning
    ? 'stop'
    : isBusy
      ? isVerifying
        ? 'verify'
        : isDownloading
          ? 'download'
          : 'progress'
      : isInstalled
        ? 'launch'
        : 'install';

  const icon = {
    stop: 'stop',
    launch: 'play',
    install: 'arrow-down',
    download: 'download',
    verify: 'shield',
    progress: 'loader'
  }[mode];

  const label = isRunning
    ? t('home.kill')
    : isVerifying
      ? 'Checking game files'
      : isDownloading
        ? (isInstalled ? 'Repairing game' : 'Installing…')
        : isBusy
          ? (status === 'launching' ? 'Starting Minecraft' : 'Preparing game')
          : isInstalled
            ? t('home.launch')
            : installLabel || t('common.install') || 'Install';

  const percent = Math.max(0, Math.min(100, Number(launcherState?.percent) || 0));
  const hasPercent = isBusy && percent > 0;

  // Busy title: the current stage in plain words ("Downloading libraries").
  const stage = launcherState?.stage;
  const busyTitle =
    status === 'launching'
      ? 'Starting Minecraft'
      : status === 'preparing' || !stage
        ? String(launcherState?.detail || 'Preparing game').replace(/(\u2026|\.\.\.)$/, '')
        : stage === 'assets'
          ? (Number(launcherState?.speed) > 1024 ? 'Downloading assets' : 'Checking assets')
          : launcherState?.stageLabel || 'Downloading game files';

  // Busy details: files in this stage, downloaded size, live speed.
  const task = Number(launcherState?.task);
  const total = Number(launcherState?.total);
  const speed = Number(launcherState?.speed) || 0;
  const metaParts = isBusy
    ? [
        total > 1 && task >= 0 ? `${Math.min(task, total).toLocaleString()} / ${total.toLocaleString()} files` : null,
        formatBytes(launcherState?.bytes),
        speed > 1024 ? `${formatBytes(speed)}/s` : null
      ].filter(Boolean)
    : [];
  const busyMeta = metaParts.join('  ·  ') || (status === 'launching' ? 'Opening the game window' : 'Getting everything ready');

  if (isBusy) {
    return (
      <button
        type="button"
        className={`launch-action size-${size} is-busy is-${mode} ${className}`.trim()}
        style={{ '--progress': `${percent}%` }}
        disabled
        aria-busy="true"
        aria-label={`${busyTitle}${hasPercent ? ` ${Math.round(percent)}%` : ''}`}
        title={`${busyTitle} — ${busyMeta}`}
      >
        <span className="la-fill" aria-hidden="true" />
        <span className="launch-action-icon">
          <NativeIcon
            name={mode === 'verify' ? 'shield' : mode === 'download' ? 'download' : 'loader'}
            size={size === 'sm' ? 14 : size === 'md' ? 16 : 18}
            strokeWidth={2.2}
            className={mode === 'progress' ? 'spin' : ''}
          />
        </span>
        <span className="la-body">
          <span className="la-title">{busyTitle}</span>
          <span className="la-meta">{busyMeta}</span>
        </span>
        <span className="la-pct">{hasPercent ? `${Math.floor(percent)}%` : ''}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`launch-action size-${size} is-${mode} ${className}`.trim()}
      onClick={() => (isRunning ? onKill?.() : onLaunch?.(instance))}
      aria-label={label}
      title={label}
    >
      <span className="launch-action-icon">
        <NativeIcon name={icon} size={size === 'sm' ? 14 : size === 'md' ? 16 : 18} strokeWidth={2.2} />
      </span>
      <span className="launch-action-text">
        <span className="launch-action-label">{label}</span>
      </span>
    </button>
  );
}
