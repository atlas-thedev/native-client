import React, { useCallback, useEffect, useState } from 'react';
import { Crown, Eye, ImagePlus, LoaderCircle, Lock, Package, Plus, RotateCcw, Search, Send, Trash2, Vote, X } from 'lucide-react';
import { ItemThumb } from './AdminStore.jsx';
import Dropdown from '../../components/ui/Dropdown.jsx';
import { adminCall, formatDate, fromLocalInput, toLocalInput, useAdminAction, useConfirm } from './adminShared.jsx';

const newOption = () => ({ label: '', description: '', image: null, preview: null, itemId: null });
const blank = () => ({ title: '', description: '', kind: 'cosmetic', results: 'after_vote', status: 'open', endsAt: Date.now() + 7 * 86_400_000, options: [newOption(), newOption(), newOption()] });
const KINDS = [{ value: 'cosmetic', label: 'Cosmetic' }, { value: 'cape', label: 'Cape' }, { value: 'feature', label: 'Feature' }, { value: 'other', label: 'Other' }];
const RESULTS = [{ value: 'after_vote', label: 'After voting' }, { value: 'always', label: 'Always' }, { value: 'after_close', label: 'When closed' }];
const PUBLISH = [{ value: 'open', label: 'Open now' }, { value: 'draft', label: 'Draft' }];

const readPng = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(new Error('Couldn’t read that file.'));
  reader.readAsDataURL(file);
});

/** Pick a Store item (hidden concept pieces included) for a vote option. */
function ItemPick({ items, strips, onPick, onClose }) {
  const [q, setQ] = useState('');
  const list = (items || []).filter((it) => {
    const t = q.trim().toLowerCase();
    return !t || `${it.name} ${it.id} ${it.slot || ''}`.toLowerCase().includes(t);
  }).sort((a, b) => Number(b.kind === 'cosmetic') - Number(a.kind === 'cosmetic') || Number(b.hidden) - Number(a.hidden)).slice(0, 60);
  return (
    <div className="admin-vote-itempick">
      <div className="admin-attach-head">
        <span><Package size={13} />Use a Store item (hidden ones are fine — release the winner later)</span>
        <label className="admin-search is-small"><Search size={12} /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an item" aria-label="Find a Store item" /></label>
        <button type="button" className="admin-icon-btn" onClick={onClose} aria-label="Close"><X size={12} /></button>
      </div>
      <div className="admin-picker">
        {list.map((it) => (
          <button key={it.id} type="button" className={`admin-picker-tile${it.hidden ? ' is-hidden' : ''}`} onClick={() => onPick(it)} title={it.name}>
            <span className="admin-picker-art"><ItemThumb item={it} strips={strips} width={30} height={48} /></span>
            <span className="admin-picker-name">{it.name}</span>
          </button>
        ))}
        {!list.length && <p className="admin-note">No items match.</p>}
      </div>
    </div>
  );
}

/** Community votes (like the Minecraft mob vote): players vote in the launcher’s Community tab and on the website’s /vote page. */
export default function AdminVotes({ items = [], strips = {}, onNotify, onAccessRevoked }) {
  const [picking, setPicking] = useState(null);
  const itemById = React.useMemo(() => new Map((items || []).map((it) => [it.id, it])), [items]);
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
  const ready = draft.title.trim().length >= 3 && draft.options.filter((option) => option.label.trim() || option.itemId).length >= 2;
  const pickItem = (index, item) => { setOption(index, { itemId: item.id, label: draft.options[index].label || item.name.slice(0, 40), image: null, preview: null }); setPicking(null); };
  const setWinner = (poll, optionId) => patch(poll.id, { winnerOptionId: optionId }, optionId ? 'Winner set — it shows under Past campaigns.' : 'Winner cleared.');
  const release = (item) => run(`rel:${item.id}`, async () => {
    const r = await window.native?.admin?.storeUpdate?.(item.id, { hidden: false });
    if (!r?.ok) throw new Error(r?.error || 'Could not release it.');
    await load();
  }, `${item.name} is now in the Store.`);
  const create = () => run('create', async () => {
    const result = await adminCall('POST', '/polls', { ...draft, options: draft.options.filter((o) => o.label.trim() || o.itemId).map(({ label, description, image, itemId }) => ({ label, description, image: itemId ? null : image, itemId })) }, onAccessRevoked);
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
        <p className="admin-note"><strong>Options</strong>&nbsp;2 to 8. Pick a Store cosmetic or cloak (shown in 3D), or upload a PNG concept image.</p>
        <div className="admin-vote-options">
          {draft.options.map((option, index) => (
            <div key={index} className="admin-vote-option">
              {option.itemId && itemById.get(option.itemId) ? (
                <button type="button" className="admin-vote-image" title="Change Store item" onClick={() => setPicking(index)}>
                  <ItemThumb item={itemById.get(option.itemId)} strips={strips} width={30} height={48} />
                </button>
              ) : (
                <label className="admin-vote-image" title="Upload PNG">
                  {option.preview ? <img src={option.preview} alt="" /> : <ImagePlus size={18} />}
                  <input type="file" accept="image/png" onChange={(event) => { pickImage(index, event.target.files?.[0]); event.target.value = ''; }} />
                </label>
              )}
              <div className="admin-vote-option-fields">
                <input maxLength={40} placeholder={`Option ${index + 1}`} value={option.label} onChange={(event) => setOption(index, { label: event.target.value })} />
                <input maxLength={200} placeholder="Short description" value={option.description} onChange={(event) => setOption(index, { description: event.target.value })} />
                <span className="admin-vote-option-tools">
                  <button type="button" className="admin-link-btn" onClick={() => setPicking(picking === index ? null : index)}><Package size={11} />{option.itemId ? 'Change Store item' : 'Use a Store item'}</button>
                  {option.itemId && <button type="button" className="admin-link-btn" onClick={() => setOption(index, { itemId: null })}><X size={11} />Remove item</button>}
                </span>
              </div>
              {draft.options.length > 2 && (
                <button type="button" className="admin-vote-remove" aria-label="Remove option" onClick={() => setDraft((current) => ({ ...current, options: current.options.filter((_, i) => i !== index) }))}><X size={12} /></button>
              )}
            </div>
          ))}
          {picking != null && <ItemPick items={items} strips={strips} onPick={(it) => pickItem(picking, it)} onClose={() => setPicking(null)} />}
          {draft.options.length < 8 && (
            <button type="button" className="admin-vote-add" onClick={() => setDraft((current) => ({ ...current, options: [...current.options, newOption()] }))}><Plus size={14} />Add option</button>
          )}
        </div>
      </section>

      <section className="admin-card">
        <div className="admin-card-head"><h3><Vote size={14} />All votes</h3><span>{polls ? `${polls.length} total · shown in the launcher’s Community tab and on the website’s /vote page` : ''}</span></div>
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
                      const item = option.itemId ? itemById.get(option.itemId) : null;
                      const won = poll.winnerId === option.id;
                      return (
                        <div key={option.id} className={`admin-vote-result${won ? ' is-winner' : ''}`}>
                          {item ? <span className="admin-vote-thumb"><ItemThumb item={item} strips={strips} width={24} height={38} /></span> : option.image ? <img src={option.image} alt="" /> : <span className="admin-vote-letter">{String(option.label || '?')[0]}</span>}
                          <div>
                            <p><span>{won && <Crown size={11} />}{option.label}{item?.hidden && <em className="admin-chip is-inline is-muted">hidden</em>}</span><small>{option.votes ?? 0} · {pct}%</small></p>
                            <span className="admin-bar"><i style={{ width: `${pct}%` }} /></span>
                          </div>
                          {state === 'Closed' && (
                            <span className="admin-vote-result-actions">
                              {won
                                ? (poll.winnerPicked && <button type="button" className="admin-link-btn" disabled={Boolean(busy)} onClick={() => setWinner(poll, null)}>Auto</button>)
                                : <button type="button" className="admin-link-btn" disabled={Boolean(busy)} onClick={() => setWinner(poll, option.id)} title="Make this the winner"><Crown size={11} />Winner</button>}
                              {won && item?.hidden && <button type="button" className="admin-link-btn is-strong" disabled={Boolean(busy)} onClick={() => release(item)}>{busy === `rel:${item.id}` ? <LoaderCircle size={11} className="is-spinning" /> : <Eye size={11} />}Release in Store</button>}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {state === 'Closed' && !poll.winnerId && <p className="admin-note">No clear winner (tie or no votes). Pick one with the crown.</p>}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
