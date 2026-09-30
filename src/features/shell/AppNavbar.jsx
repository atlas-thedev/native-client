import React from 'react';
import { AlertTriangle, ArrowUp, Blocks, CircleHelp, Compass, Download, Home, Layers3, Lock, MessageSquare, Minus, PackageOpen, Radio, RefreshCw, Settings, ShieldCheck, User, WifiOff, X } from 'lucide-react';
import Logo from '../../components/ui/Logo.jsx';
import NativeIcon from '../../components/ui/NativeIcon.jsx';
import PlayerAvatar from '../../components/ui/PlayerAvatar.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import DownloadManagerButton from './DownloadManagerButton.jsx';
import packageInfo from '../../../package.json';
import './AppNavbar.css';

/** Launcher workflow first, personal tools second. */
export const CORE_NAV_ITEMS = [
  { id: 'home', labelKey: 'nav.home', icon: Home },
  { id: 'instances', labelKey: 'nav.instances', icon: Layers3 },
  { id: 'versions', labelKey: 'nav.versions', icon: Blocks },
  { id: 'discover', labelKey: 'nav.discover', icon: Compass }
];

export const PERSONAL_NAV_ITEMS = [
  { id: 'skins', labelKey: 'nav.locker', icon: User },
  { id: 'relay', labelKey: 'nav.relay', icon: MessageSquare }
];

export const NAV_ITEMS = [...CORE_NAV_ITEMS, ...PERSONAL_NAV_ITEMS];

function RailButton({ icon: Icon, active, onClick, label, badge = 0, status = null, tone = null, children, className = '', locked = false, lockTooltip = '', tourId = null }) {
  return (
    <button
      type="button"
      className={`rail-btn${active ? ' is-active' : ''}${locked ? ' is-locked' : ''}${tone ? ` tone-${tone}` : ''} ${className}`.trim()}
      onClick={onClick}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      data-tooltip={lockTooltip || label}
      data-tour={tourId || undefined}
    >
      {children || (
        <>
          {Icon ? <Icon size={21} strokeWidth={1.9} aria-hidden="true" /> : null}
        </>
      )}
      {badge > 0 && <em className="rail-badge">{badge > 99 ? '99+' : badge}</em>}
      {locked && (
        <span className="rail-lock-badge" aria-hidden="true">
          <Lock size={10} strokeWidth={2.4} />
        </span>
      )}
      {status ? <i className={`rail-status ${status}`} aria-hidden="true" /> : null}
    </button>
  );
}

/**
 * Maps an updater status payload to a compact titlebar pill — or null when there
 * is nothing worth surfacing (idle, up to date, or disabled in unpackaged builds).
 * Reuses the fully-localized `update.*` catalog so every locale is covered.
 */
function deriveUpdatePill(status, t) {
  const type = status?.type;
  switch (type) {
    case 'checking':
      return { variant: 'checking', Icon: RefreshCw, spin: true, label: t('update.checking'), tooltip: t('update.checking') };
    case 'available': {
      const label = t('update.pillAvailable');
      const version = status.version || null;
      return { variant: 'available', Icon: ArrowUp, spin: false, label, version, tooltip: version ? `${label} · ${version}` : label };
    }
    case 'preparing':
    case 'downloading': {
      const percent = Math.max(0, Math.min(100, Math.round(status.percent || 0)));
      const label = t('update.downloadingPercent', { percent });
      return { variant: 'downloading', Icon: Download, spin: false, label, tooltip: label };
    }
    case 'downloaded':
    case 'installing': {
      const label = t('update.pillReady');
      return { variant: 'ready', Icon: RefreshCw, spin: type === 'installing', label, tooltip: label };
    }
    default:
      return null;
  }
}

/**
 * Maps the connectivity status to a compact titlebar pill — or null when the
 * connection is healthy, so the titlebar only speaks up when something is wrong.
 * `offline` means the browser reports no connection; `degraded` means an
 * interface is up but our reachability probe could not reach the internet.
 */
function deriveNetworkPill(status, t) {
  switch (status?.state) {
    case 'offline':
      return { variant: 'offline', Icon: WifiOff, label: t('network.offline'), tooltip: t('network.offlineTooltip') };
    case 'degraded':
      return { variant: 'degraded', Icon: AlertTriangle, label: t('network.degraded'), tooltip: t('network.degradedTooltip') };
    default:
      return null;
  }
}

export default function AppNavbar({
  currentTab,
  onSelectTab,
  onOpenSettings,
  onOpenAccountSwitcher,
  isAccountOpen = false,
  onOpenNotifications,
  account,
  isNoctra = false,
  notifications = 0,
  isMaximized,
  onMinimize,
  onMaximize,
  onClose,
  updateStatus = null,
  networkStatus = null,
  onOpenUpdater,
  onOpenTutorial,
  isTutorialOpen = false,
  friendsBadge = 0,
  liveUserCount = null,
  isAdmin = false
}) {
  const { t } = useI18n();
  const buildVersion = window.native?.version || packageInfo.version;
  const updatePill = deriveUpdatePill(updateStatus, t);
  const networkPill = deriveNetworkPill(networkStatus, t);
  const settingsStatus = updateStatus?.type === 'available' || updateStatus?.type === 'downloaded' ? 'brand' : null;
  return (
    <>
      <header className="noctra-titlebar">
        <div className="noctra-build">
          <span className="noctra-wordmark"><Logo height={11} variant="mark" /> Noctra Client</span>
          <i />
          <span>Build <b>{buildVersion}</b></span>
          {Number.isFinite(liveUserCount) && (
            <>
              <i />
              <strong className="noctra-live-users" title={`${liveUserCount.toLocaleString()} Noctra users currently connected`} aria-live="polite">
                <Radio size={11} aria-hidden="true" />
                <b>{liveUserCount.toLocaleString()}</b> online
              </strong>
            </>
          )}
          {networkPill && (
            <>
              <i />
              <span
                className={`noctra-net-pill ${networkPill.variant}`}
                role="status"
                title={networkPill.tooltip}
                aria-label={networkPill.tooltip}
              >
                <networkPill.Icon size={12} strokeWidth={2.3} aria-hidden="true" />
                <span>{networkPill.label}</span>
              </span>
            </>
          )}
          {updatePill && (
            <>
              <i />
              <button
                type="button"
                className={`noctra-update-pill ${updatePill.variant}`}
                onClick={onOpenUpdater}
                title={updatePill.tooltip}
                aria-label={updatePill.tooltip}
              >
                <updatePill.Icon size={12} strokeWidth={2.3} className={updatePill.spin ? 'noctra-update-spin' : ''} aria-hidden="true" />
                <span>{updatePill.label}</span>
                {updatePill.version && <b>{updatePill.version}</b>}
              </button>
            </>
          )}
        </div>
        <div className="titlebar-actions">
          <DownloadManagerButton />
          <button
            type="button"
            className={`quick-tutorial-btn${isTutorialOpen ? ' is-active' : ''}`}
            onClick={onOpenTutorial}
            aria-label="Open quick tutorial"
            title="Open quick tutorial"
            data-tour="tutorial"
          >
            <CircleHelp size={13} />
            <span>Quick tour</span>
          </button>
          <div className="window-controls-group">
            <button className="window-ctrl-btn" onClick={onMinimize} aria-label={t('window.minimize')}><Minus size={14} /></button>
            <button className="window-ctrl-btn" onClick={onMaximize} aria-label={t(isMaximized ? 'window.restore' : 'window.maximize')}><NativeIcon name={isMaximized ? 'restore' : 'maximize'} size={12} /></button>
            <button className="window-ctrl-btn close" onClick={onClose} aria-label={t('common.close')}><X size={15} /></button>
          </div>
        </div>
      </header>

      <aside className="noctra-rail" aria-label={t('nav.primary')}>
        <button
          type="button"
          className="noctra-rail-logo"
          onClick={() => onSelectTab('home')}
          aria-label="Noctra Client"
          data-tooltip="Noctra Client"
          data-tour="brand"
        >
          <Logo height={28} variant="mark" />
        </button>

        <nav className="rail-group rail-core-group" aria-label="Launcher">
          {CORE_NAV_ITEMS.map(({ id, labelKey, icon }) => {
            return (
              <RailButton
                key={id}
                icon={icon}
                active={currentTab === id}
                onClick={() => onSelectTab(id)}
                label={t(labelKey)}
                tourId={id}
              />
            );
          })}
        </nav>

        <span className="rail-divider" aria-hidden="true" />

        <nav className="rail-group rail-personal-group" aria-label="Personal tools">
          {PERSONAL_NAV_ITEMS.map(({ id, labelKey, icon }) => {
            const isRestricted = (id === 'skins' || id === 'relay') && !isNoctra;
            return (
              <RailButton
                key={id}
                icon={icon}
                badge={id === 'relay' && isNoctra ? friendsBadge : 0}
                active={currentTab === id}
                onClick={() => onSelectTab(id)}
                label={t(labelKey)}
                className={id === 'relay' ? 'rail-relay-btn' : ''}
                tone={id === 'relay' && isNoctra && friendsBadge > 0 ? 'alert' : null}
                locked={isRestricted}
                lockTooltip={isRestricted ? `${t(labelKey)} · Noctra Account Required` : null}
                tourId={id}
              />
            );
          })}
        </nav>

        {isAdmin && <span className="rail-divider" aria-hidden="true" />}

        {isAdmin && (
          <div className="rail-group" aria-label="Administration">
            <RailButton icon={ShieldCheck} active={currentTab === 'admin'} onClick={() => onSelectTab('admin')} label="Admin control room" className="rail-admin-btn" />
          </div>
        )}

        <div className="rail-spacer" />

        <div className="rail-group rail-foot">
          <RailButton
            icon={Settings}
            active={currentTab === 'settings'}
            onClick={() => {
              if (onSelectTab) onSelectTab('settings');
              else onOpenSettings?.();
            }}
            label={t('common.settings')}
            status={settingsStatus}
            tourId="settings"
          />
          <RailButton
            className="rail-account-btn"
            active={isAccountOpen}
            onClick={onOpenAccountSwitcher}
            label={account?.name ? `${account.name} (${t('account.accounts')})` : t('account.accounts')}
            status={account?.isMicrosoft ? 'gold' : null}
            tourId="account"
          >
            {account?.name ? (
              <PlayerAvatar account={account} size={32} radius={9} className="rail-avatar" />
            ) : (
              <span className="rail-avatar-fallback"><User size={18} strokeWidth={1.9} aria-hidden="true" /></span>
            )}
          </RailButton>
        </div>
      </aside>
    </>
  );
}
