import RelayAvatar from './RelayAvatar.jsx';
import './relay-groups.css';

const snippet = (message) => {
  if (!message) return '';
  if (message.deleted) return 'Original message was deleted';
  if (message.content) return message.content;
  if (message.mediaName) return /\.gif$/i.test(message.mediaName) ? 'GIF' : /\.(png|jpe?g|webp)$/i.test(message.mediaName) ? 'Photo' : message.mediaName;
  return 'Attachment';
};

/** The quoted line above a reply: a curved spine from the avatar, mini avatar, name, snippet. */
export function ReplyQuote({ reply, selfId, selfName = 'You', onJump }) {
  if (!reply) return null;
  const mine = reply.senderId === selfId;
  const name = mine ? selfName : reply.senderName || 'Unknown';
  return (
    <button type="button" className="rm-reply" onClick={() => onJump?.(reply.id)}>
      <RelayAvatar name={name} size={16} className="rm-reply-avatar" />
      <span className="rm-reply-author">{name}</span>
      <span className="rm-reply-text">{snippet(reply)}</span>
    </button>
  );
}

/** The composer strip shown while a reply is staged. */
export function ReplyComposerBar({ target, selfId, onCancel }) {
  if (!target) return null;
  return (
    <div className="relay-reply-bar">
      <div className="relay-reply-bar__body">
        <span className="relay-reply-bar__label">
          Replying to <strong>{target.senderId === selfId ? 'yourself' : target.senderName || 'Unknown'}</strong>
        </span>
        <span className="relay-reply-bar__text">{snippet(target)}</span>
      </div>
      <button type="button" className="relay-reply-bar__close" onClick={onCancel} aria-label="Cancel reply">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
        </svg>
      </button>
    </div>
  );
}

export default ReplyQuote;
