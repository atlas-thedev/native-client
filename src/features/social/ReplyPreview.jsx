import './relay-groups.css';

const snippet = (message) => {
  if (!message) return '';
  if (message.deleted) return 'Original message was deleted';
  if (message.content) return message.content;
  if (message.mediaName) return /\.gif$/i.test(message.mediaName) ? 'GIF' : /\.(png|jpe?g|webp)$/i.test(message.mediaName) ? 'Photo' : message.mediaName;
  return 'Attachment';
};

/** The quoted line rendered above a reply bubble. Click to jump to the source. */
export function ReplyQuote({ reply, selfId, onJump }) {
  if (!reply) return null;
  return (
    <button type="button" className="relay-reply-quote" onClick={() => onJump?.(reply.id)}>
      <span className="relay-reply-quote__spine" aria-hidden="true" />
      <span className="relay-reply-quote__author">
        {reply.senderId === selfId ? 'You' : reply.senderName || 'Unknown'}
      </span>
      <span className="relay-reply-quote__text">{snippet(reply)}</span>
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
