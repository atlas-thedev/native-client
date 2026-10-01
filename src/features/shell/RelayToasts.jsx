import React from 'react';
import { X } from 'lucide-react';
import './RelayToasts.css';

/** Small in-app pings for Relay while the window is focused. Click to open. */
export default function RelayToasts({ toasts, onOpen, onDismiss }) {
  if (!toasts?.length) return null;
  return (
    <div className="relay-toasts" role="region" aria-label="Relay notifications" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="relay-toast">
          <button type="button" className="relay-toast-main" onClick={() => onOpen?.(toast)}>
            <strong>{toast.title}</strong>
            <span>{toast.body}</span>
          </button>
          <button type="button" className="relay-toast-x" onClick={() => onDismiss?.(toast.id)} aria-label="Dismiss"><X size={12} /></button>
        </div>
      ))}
    </div>
  );
}
