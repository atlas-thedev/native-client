import React, { useState } from 'react';
import {
  Check,
  CheckCheck,
  CornerUpLeft,
  Download,
  FileText,
  Maximize2,
  Pencil,
  RotateCcw,
  Smile,
  Trash2,
} from 'lucide-react';
import RelayAvatar from './RelayAvatar.jsx';
import { ReplyQuote } from './ReplyPreview.jsx';
import { safeMediaUrl } from './safeMedia.js';

import { PlusMark } from './Badges.jsx';
const countReactions = (reactions = []) => reactions.reduce((acc, item) => {
  if (!item?.reaction) return acc;
  acc[item.reaction] = (acc[item.reaction] || 0) + 1;
  return acc;
}, {});

const clock = (stamp) => new Date(stamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** "Today at 10:13 PM", "Yesterday at 10:13 PM", or a short date. */
export function stampLabel(stamp, fallback = '') {
  if (!stamp) return fallback;
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return fallback;
  const dayStart = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const diffDays = Math.round((dayStart(new Date()) - dayStart(date)) / 86_400_000);
  if (diffDays === 0) return `Today at ${clock(date)}`;
  if (diffDays === 1) return `Yesterday at ${clock(date)}`;
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric', year: diffDays > 300 ? 'numeric' : undefined })} at ${clock(date)}`;
}

/**
 * One message, chat-log style: avatar + name + time on the first line of a run,
 * plain text underneath, no bubbles. Consecutive messages from one person
 * collapse into the same block and show their time on hover.
 */
export function MessageRow({
  msg,
  isGroup,
  selfId,
  selfName = 'You',
  authorPlus = false,
  palette = [],
  canModerate = false,
  readAt = 0,
  onReply,
  onReact,
  onEdit,
  onDelete,
  onRetry,
  onOpenMedia,
  onJump
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draft, setDraft] = useState(null);

  const isMine = Boolean(msg.isMine);
  const isEditing = draft !== null;
  const groups = countReactions(msg.reactions);
  const canEdit = isMine && !msg.isDeleted && !msg.pending && Boolean(msg.content) && !msg.mediaUrl;
  // Only Native uploads (and the built-in GIFs) are ever loaded.
  const mediaUrl = safeMediaUrl(msg.mediaUrl);
  const blockedMedia = Boolean(msg.mediaUrl) && !mediaUrl;
  const canDelete = (isMine || (isGroup && canModerate)) && !msg.isDeleted && !msg.pending && !msg.isUploading;
  const isRead = isGroup ? (readAt > 0 && (msg.createdAt || 0) <= readAt) : Boolean(msg.isRead);
  const continued = Boolean(msg.groupedWithPrevious);
  const authorName = isMine ? selfName : (msg.senderName || msg.senderId || 'Member');
  const hasReceipt = isMine && !msg.pending && !msg.failed && !msg.isDeleted;
  const Receipt = isRead ? CheckCheck : Check;
  const receipt = hasReceipt && <Receipt size={12} className={`rm-receipt${isRead ? ' is-read' : ''}`} title={isRead ? 'Read' : 'Delivered'} />;

  const submitEdit = () => {
    const next = String(draft || '').trim();
    setDraft(null);
    if (next && next !== msg.content) onEdit?.(msg.id, next);
  };

  return (
    <div
      id={`msg-${msg.id}`}
      data-testid={`relay-message-${msg.id}`}
      className={[
        'rm',
        isMine ? 'is-mine' : '',
        continued ? 'is-continued' : 'is-first',
        pickerOpen ? 'has-picker-open' : '',
        msg.reply ? 'has-reply' : '',
        msg.pending ? 'is-pending' : '',
        msg.failed || msg.uploadFailed ? 'is-failed' : '',
        msg.isDeleted ? 'is-deleted' : ''
      ].filter(Boolean).join(' ')}
    >
      {msg.reply && (
        <ReplyQuote reply={msg.reply} selfId={selfId} selfName={selfName} onJump={onJump} />
      )}

      <div className="rm-gutter">
        {continued ? (
          <span className="rm-hover-time" title={stampLabel(msg.createdAt, msg.time)}>
            {msg.createdAt ? clock(msg.createdAt) : msg.time}
          </span>
        ) : (
          <RelayAvatar name={authorName} size={38} className="rm-avatar" />
        )}
      </div>

      <div className="rm-main">
        {!continued && (
          <div className="rm-head">
            <span className="rm-author">{authorName}</span>
            {authorPlus && <PlusMark size={13} />}
            <span className="rm-time">{stampLabel(msg.createdAt, msg.time)}</span>
            {receipt}
            {isMine && msg.pending && <span className="rm-state">Sending…</span>}
          </div>
        )}

        {!msg.isDeleted && !isEditing && (
          <div className="rm-tools">
            <button
              type="button"
              className="rm-tool"
              data-testid={`relay-message-react-${msg.id}`}
              onClick={() => setPickerOpen((open) => !open)}
              title="Add reaction"
            >
              <Smile size={15} />
            </button>
            <button
              type="button"
              className="rm-tool"
              data-testid={`relay-message-reply-${msg.id}`}
              onClick={() => onReply?.(msg)}
              title="Reply"
            >
              <CornerUpLeft size={15} />
            </button>
            {canEdit && (
              <button
                type="button"
                className="rm-tool"
                data-testid={`relay-message-edit-${msg.id}`}
                onClick={() => setDraft(msg.content || '')}
                title="Edit message"
              >
                <Pencil size={14} />
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                className="rm-tool is-danger"
                data-testid={`relay-message-delete-${msg.id}`}
                onClick={() => onDelete?.(msg.id)}
                title="Delete message"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        )}

        {pickerOpen && (
          <div className="rm-picker" data-testid={`relay-reaction-picker-${msg.id}`}>
            {palette.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => {
                  setPickerOpen(false);
                  onReact?.(msg.id, emoji);
                }}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}

        {msg.isDeleted ? (
          <p className="rm-text is-tombstone">This message was deleted</p>
        ) : isEditing ? (
          <div className="rm-edit" data-testid={`relay-message-editor-${msg.id}`}>
            <textarea
              value={draft}
              autoFocus
              rows={2}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  submitEdit();
                }
                if (event.key === 'Escape') setDraft(null);
              }}
            />
            <div className="rm-edit-actions">
              <span>escape to <button type="button" onClick={() => setDraft(null)}>cancel</button> · enter to <button type="button" data-testid={`relay-message-edit-save-${msg.id}`} onClick={submitEdit}>save</button></span>
            </div>
          </div>
        ) : (
          <>
            {msg.content && !msg.isVoice && !msg.isMedia && (
              <p className="rm-text">
                {msg.content}
                {msg.editedAt && <span className="rm-edited"> (edited)</span>}
              </p>
            )}

            {msg.isMedia && mediaUrl && (
              <div className={`rm-media${msg.isUploading ? ' is-uploading' : ''}`}>
                {msg.content && (
                  <p className="rm-text">
                    {msg.content}
                    {msg.editedAt && <span className="rm-edited"> (edited)</span>}
                  </p>
                )}
                <div className="rm-media-frame" onClick={() => !msg.isUploading && onOpenMedia?.(mediaUrl)}>
                  <img src={mediaUrl} referrerPolicy="no-referrer" alt={msg.mediaName || 'Attachment'} />
                  {msg.isUploading ? (
                    <div className="rm-media-uploading">
                      <span className="relay-progress-track"><i className="relay-progress-indeterminate" /></span>
                      <span>Uploading full resolution…</span>
                    </div>
                  ) : (
                    <div className="rm-media-actions">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenMedia?.(mediaUrl);
                        }}
                        title="Open full screen"
                      >
                        <Maximize2 size={14} />
                      </button>
                      <a
                        href={mediaUrl}
                        download={msg.mediaName || 'image.png'}
                        onClick={(event) => event.stopPropagation()}
                        title="Download original"
                      >
                        <Download size={14} />
                      </a>
                    </div>
                  )}
                </div>
                {msg.uploadFailed && <span className="rm-failed">Upload failed</span>}
              </div>
            )}

            {!msg.isMedia && !msg.isVoice && mediaUrl && (
              <a className="rm-file" href={mediaUrl} download={msg.mediaName || 'attachment'}>
                <FileText size={16} />
                <span>{msg.mediaName || 'Attachment'}</span>
                <Download size={14} />
              </a>
            )}

            {msg.isVoice && mediaUrl && (
              <div className="rm-voice">
                <audio controls src={mediaUrl} preload="none" />
                <span>{msg.duration || ''}</span>
              </div>
            )}
            {blockedMedia && (
              <span className="rm-file rm-file-blocked" title="This attachment points outside Native and was not loaded.">
                <FileText size={16} />
                <span>Attachment unavailable</span>
              </span>
            )}
          </>
        )}

        {Object.keys(groups).length > 0 && (
          <div className="rm-reactions">
            {Object.entries(groups).map(([emoji, count]) => {
              const mine = (msg.reactions || []).some(
                (item) => item.reaction === emoji && (item.userId === selfId || item.userId === 'me')
              );
              return (
                <button
                  key={emoji}
                  type="button"
                  className={`rm-reaction${mine ? ' is-mine' : ''}`}
                  onClick={() => onReact?.(msg.id, emoji)}
                  title="Toggle reaction"
                >
                  <span>{emoji}</span>
                  <span>{count}</span>
                </button>
              );
            })}
          </div>
        )}

        {isMine && (msg.failed || msg.uploadFailed) && (
          <button
            type="button"
            className="rm-retry"
            data-testid={`relay-message-retry-${msg.id}`}
            onClick={() => onRetry?.(msg)}
          >
            <RotateCcw size={11} />
            <span>Not sent. Retry</span>
          </button>
        )}
      </div>
      {continued && receipt && <span className="rm-receipt-gutter">{receipt}</span>}
    </div>
  );
}

export default MessageRow;
