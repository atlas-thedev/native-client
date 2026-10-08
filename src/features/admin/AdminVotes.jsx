import React, { useCallback, useEffect, useState } from 'react';
import { ImagePlus, LoaderCircle, Lock, Plus, RotateCcw, Send, Trash2, Vote, X } from 'lucide-react';
import Dropdown from '../../components/ui/Dropdown.jsx';
import { adminCall, formatDate, fromLocalInput, toLocalInput, useAdminAction, useConfirm } from './adminShared.jsx';

const newOption = () => ({ label: '', description: '', image: null, preview: null });
const blank = () => ({ title: '', description: '', kind: 'cape', results: 'after_vote', status: 'open', endsAt: Date.now() + 7 * 86_400_000, options: [newOption(), newOption(), newOption()] });
const KINDS = [{ value: 'cape', label: 'Cape' }, { value: 'feature', label: 'Feature' }, { value: 'other', label: 'Other' }];
const RESULTS = [{ value: 'after_vote', label: 'After voting' }, { value: 'always', label: 'Always' }, { value: 'after_close', label: 'When closed' }];
const PUBLISH = [{ value: 'open', label: 'Open now' }, { value: 'draft', label: 'Draft' }];

const readPng = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(new Error('Couldn’t read that file.'));
  reader.readAsDataURL(file);
});

/** Community votes (like the Minecraft mob vote): players pick one option on the website’s /vote page. */
export default function AdminVotes({ onNotify, onAccessRevoked }) {
  const { busy, error, setError, run } = useAdminAction(onNotify, 'Votes');
  const { armed, ask } = useConfirm();
  const [polls, setPolls] = useState(null);
  const [draft, setDraft] = useState(blank);
  const set = (key, value) => setDraft((current) => ({ ...current, [key]: value?.target ? value.target.value : value }));
  const setOption = (index, patch) => setDraft((current) => ({ ...current, options: current.options.map((option, i) => (i === index ? { ...option, ...patch } : option)) }));

  const load = useCallback(async () => setPolls((await adminCall('GET', '/polls', undefined, onAccessRevoked)).polls || []), [onAccessRevoked]);
  useEffect(() => { load().catch((reason) => { setPolls([]); setError(reason.message); }); }, [load, setError]);

  const pickImage = async (index, file) => {
    if (!file) return;
    if (file.type !== 'image/png') return setError('Use a PNG image.');
    if (file.size > 5 * 1024 * 1024) return setError('Images must be under 5 MB.');
    const url = await readPng(file);
    return setOption(index, { image: url.replace(/^data:[^,]+,/, ''), preview: url });
  };
  const ready = draft.title.trim().length >= 3 && draft.options.filter((option) => option.label.trim()).length >= 2;
  const create = () => run('create', async () => {
    const result = await adminCall('POST', '/polls', { ...draft, options: draft.options.filter((o) => o.label.trim()).map(({ label, description, image }) => ({ label, description, image })) }, onAccessRevoked);
    setPolls(result.polls || []);
    setDraft(blank());
  }, 'Vote created.');
  const patch = (id, body, ok) => run(id, async () => setPolls((await adminCall('PATCH', `/polls/${encodeURIComponent(id)}`, body, onAccessRevoked)).polls || []), ok);
  const remove = (id) => ask(`del:${id}`) && run(`del:${id}`, async () => setPolls((await adminCall('DELETE', `/polls/${encodeURIComponent(id)}`, undefined, onAccessRevoked)).polls || []), 'Vote deleted.');
  const reset = (id) => ask(`reset:${id}`) && patch(id, { resetVotes: true }, 'Votes reset.');

  return (
    <div className="admin-scroll">
      {error && <div className="admin-error" role="alert"><span>{error}</span></div>}
      <section className="admin-card">
        <div className="admin-card-head">
          <h3><Plus size={14} />New community vote</h3>
          <span>Players pick one option and can switch while it’s open</span>
          <span className="admin-head-spacer" />
          <button type="button" className="admin-btn primary" disabled={!ready || Boolean(busy)} onClick={create}>
            {busy === 'create' ? <LoaderCircle size={13} className="is-spinning" /> : <Plus size={13} />}Create vote
          </button>
        </div>
        <div className="admin-form-grid">
          <label className="admin-field"><span>Title</span><input maxLength={80} placeholder="Which cape should we make next?" value={draft.title} onChange={set.bind(null, 'title')} /></label>
          <label className="admin-field"><span>Closes at (empty = when you close it)</span><input type="datetime-local" value={toLocalInput(draft.endsAt)} onChange={(event) => set('endsAt', fromLocalInput(event.target.value))} /></label>
          <label className="admin-field"><span>Description (optional)</span><textarea rows={3} maxLength={500} value={draft.description} onChange={set.bind(null, 'description')} /></label>
          <div className="admin-field-row is-three">
            <label className="admin-field"><span>Type</span><Dropdown className="admin-dropdown" value={draft.kind} onChange={(v) => set('kind', v)} options={KINDS} /></label>
            <label className="admin-field"><span>Results</span><Dropdown className="admin-dropdown" value={draft.results} onChange={(v) => set('results', v)} options={RESULTS} /></label>
            <label className="admin-field"><span>Publish</span><Dropdown className="admin-dropdown" value={draft.status} onChange={(v) => set('status', v)} options={PUBLISH} /></label>
          </div>
        </div>
        <p className="admin-note"><strong>Options</strong>&nbsp;2 to 8. Add a PNG concept image for each cape.</p>
        <div className="admin-vote-options">
          {draft.options.map((option, index) => (
            <div key={index} className="admin-vote-option">
              <label className="admin-vote-image" title="Upload PNG">
                {option.preview ? <img src={option.preview} alt="" /> : <ImagePlus size={18} />}
                <input type="file" accept="image/png" onChange={(event) => { pickImage(index, event.target.files?.[0]); event.target.value = ''; }} />
              </label>
              <div className="admin-vote-option-fields">
                <input maxLength={40} placeholder={`Option ${index + 1}`} value={option.label} onChange={(event) => setOption(index, { label: event.target.value })} />
                <input maxLength={200} placeholder="Short description" value={option.description} onChange={(event) => setOption(index, { description: event.target.value })} />
              </div>
              {draft.options.length > 2 && (
                <button type="button" className="admin-vote-remove" aria-label="Remove option" onClick={() => setDraft((current) => ({ ...current, options: current.options.filter((_, i) => i !== index) }))}><X size={12} /></button>
              )}
            </div>
          ))}
          {draft.options.length < 8 && (
            <button type="button" className="admin-vote-add" onClick={() => setDraft((current) => ({ ...current, options: [...current.options, newOption()] }))}><Plus size={14} />Add option</button>
          )}
        </div>
      </section>

      <section className="admin-card">
        <div className="admin-card-head"><h3><Vote size={14} />All votes</h3><span>{polls ? `${polls.length} total · shown on the website’s /vote page` : ''}</span></div>
        {!polls ? <p className="admin-note"><LoaderCircle size={12} className="is-spinning" /> Loading…</p> : !polls.length ? <p className="admin-note">No votes yet. Create the first one above.</p> : (
          <div className="admin-vote-list">
            {polls.map((poll) => {
              const total = poll.total ?? 0;
              const state = poll.rawStatus === 'draft' ? 'Draft' : poll.status === 'open' ? 'Open' : 'Closed';
              return (
                <article key={poll.id} className="admin-vote">
                  <header>
                    <div className="admin-code-main">
                      <strong className="is-plain">{poll.title} <span className={`admin-chip ${state === 'Open' ? 'is-live' : 'is-test'} is-inline`}>{state}</span> <span className="admin-chip is-inline is-muted">{poll.kind}</span></strong>
                      <small>{total} vote{total === 1 ? '' : 's'} · closes {poll.endsAt ? formatDate(poll.endsAt) : 'manually'} · results {String(poll.results || '').replace('_', ' ')}</small>
                    </div>
                    <div className="admin-row-actions">
                      {state !== 'Open' && (
                        <button type="button" className="admin-btn ghost" disabled={Boolean(busy)} onClick={() => patch(poll.id, { status: 'open', ...(poll.endsAt && poll.endsAt < Date.now() ? { endsAt: Date.now() + 7 * 86_400_000 } : {}) }, 'Vote is open.')}>
                          {busy === poll.id ? <LoaderCircle size={13} className="is-spinning" /> : <Send size={13} />}{state === 'Draft' ? 'Publish' : 'Reopen'}
                        </button>
                      )}
                      {state === 'Open' && (
                        <button type="button" className="admin-btn ghost" disabled={Boolean(busy)} onClick={() => patch(poll.id, { status: 'closed' }, 'Vote closed.')}>
                          {busy === poll.id ? <LoaderCircle size={13} className="is-spinning" /> : <Lock size={13} />}Close now
                        </button>
                      )}
                      <button type="button" className={`admin-icon-btn${armed === `reset:${poll.id}` ? ' is-danger' : ''}`} title={armed === `reset:${poll.id}` ? 'Click again to reset every vote' : 'Reset votes'} aria-label="Reset votes" onClick={() => reset(poll.id)}><RotateCcw size={13} /></button>
                      <button type="button" className={`admin-icon-btn${armed === `del:${poll.id}` ? ' is-danger' : ''}`} title={armed === `del:${poll.id}` ? 'Click again to delete' : 'Delete vote'} aria-label="Delete vote" onClick={() => remove(poll.id)}>
                        {busy === `del:${poll.id}` ? <LoaderCircle size={13} className="is-spinning" /> : <Trash2 size={13} />}
                      </button>
                    </div>
                  </header>
                  <div className="admin-vote-results">
                    {(poll.options || []).map((option) => {
                      const pct = total ? Math.round(((option.votes ?? 0) / total) * 100) : 0;
                      return (
                        <div key={option.id} className="admin-vote-result">
                          {option.image ? <img src={option.image} alt="" /> : <span className="admin-vote-letter">{String(option.label || '?')[0]}</span>}
                          <div>
                            <p><span>{option.label}</span><small>{option.votes ?? 0} · {pct}%</small></p>
                            <span className="admin-bar"><i style={{ width: `${pct}%` }} /></span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
