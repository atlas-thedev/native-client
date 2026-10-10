import React from 'react';
import Icon from '../../components/ui/Icon.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import './NotificationDrawer.css';

export default function NotificationDrawer({
  open,
  onClose,
  notifications = [],
  onClear,
  onOpen
}) {
  const { t } = useI18n();
  if (!open) return null;

  return (
    <>
      <div className="notifications-drawer-backdrop" onClick={onClose} />
      <div className="notifications-drawer-panel" onClick={(e) => e.stopPropagation()}>
        <div className="notifications-header">
          <span className="notifications-title">{t('window.notifications')}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {notifications.length > 0 && (
              <button className="sub-btn" onClick={onClear}>
                {t('notifications.clear')}
              </button>
            )}
            <button className="icon-ctrl-btn" onClick={onClose}>
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>

        <div className="notifications-list">
          {notifications.length === 0 ? (
            <div className="tab-empty-placeholder">
              <Icon name="bell-01" size={28} />
              <p>{t('notifications.empty')}</p>
              <span>{t('notifications.caughtUp')}</span>
            </div>
          ) : (
            notifications.map((n) => (
              <div
                key={n.id}
                className={`notif-item${n.target && onOpen ? ' is-clickable' : ''}`}
                role={n.target && onOpen ? 'button' : undefined}
                tabIndex={n.target && onOpen ? 0 : undefined}
                onClick={n.target && onOpen ? () => onOpen(n) : undefined}
                onKeyDown={n.target && onOpen ? (event) => { if (event.key === 'Enter') onOpen(n); } : undefined}
              >
                <span className="notif-item-title">{n.title}{n.count > 1 && <span className="notif-item-count">{n.count}</span>}</span>
                <p className="notif-item-body">{n.body}</p>
                <span className="notif-item-time">{n.time}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
