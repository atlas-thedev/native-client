import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, Gift, LoaderCircle, Pencil, Plus, Search, Star, Trash2, Upload, X } from 'lucide-react';
import { drawCapeFront, firstFrameDataUrl, guessFrames, isNativeCapeRatio, MAX_FPS, MAX_FRAMES } from '../../lib/animatedCape.js';

const MAX_ANIM_MB = 16;
const MAX_STATIC_MB = 5;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not read that image.'));
    image.src = src;
  });
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

/** Front of a cape, animated when it has several frames. */
export function CapeThumb({ src, frames = 1, fps = 0, width = 40, height = 64 }) {
  const ref = useRef(null);
  useEffect(() => {
    let stopped = false;
    let timer = null;
    if (!src) return undefined;
    loadImage(src).then((image) => {
      if (stopped || !ref.current) return;
      const count = Math.max(1, frames || 1);
      let index = 0;
      const paint = () => {
        if (stopped || !ref.current) return;
        try { drawCapeFront(ref.current, image, count, index); } catch {}
        index = (index + 1) % count;
        if (count > 1) timer = setTimeout(paint, 1000 / Math.max(1, fps || 12));
      };
      paint();
    }).catch(() => {});
    return () => { stopped = true; clearTimeout(timer); };
  }, [src, frames, fps]);
  return <canvas ref={ref} width={width} height={height} className="admin-cape-thumb" />;
}

/** Who owns a cape, plus "give to a player" (the only way to get an exclusive cape). */
function CapeOwners({ item, onNotify, onChanged }) {
  const [owners, setOwners] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setOwners(null);
    window.native?.admin?.storeOwners?.(item.id).then((result) => {
      if (!alive) return;
      if (result?.ok) setOwners(result.owners || []); else { setOwners([]); setError(result?.error || 'Could not load owners.'); }
    }).catch(() => alive && setOwners([]));
    return () => { alive = false; };
  }, [item.id]);
  const act = async (kind, username) => {
    const who = String(username || '').trim();
    if (!who || busy) return;
    setBusy(`${kind}:${who}`);
    setError('');
    try {
      const result = kind === 'grant' ? await window.native.admin.storeGrant(item.id, who) : await window.native.admin.storeRevoke(item.id, who);
      if (!result?.ok) throw new Error(result?.error || 'That didn’t work.');
      setOwners(result.owners || []);
      onChanged?.(result.items);
      if (kind === 'grant') setName('');
      onNotify?.('Store', kind === 'grant' ? `${who} now has ${item.name}.` : `${item.name} was taken from ${who}.`);
    } catch (reason) { setError(reason?.message || 'That didn’t work.'); }
    finally { setBusy(''); }
  };
  return (
    <section className="admin-cape-owners">
      <h3>Give this cape <small>{owners ? `${owners.length} ${owners.length === 1 ? 'owner' : 'owners'}` : ''}</small></h3>
      <form className="admin-cape-grant" onSubmit={(event) => { event.preventDefault(); act('grant', name); }}>
        <input value={name} maxLength={32} onChange={(event) => setName(event.target.value)} placeholder="Native username"/>
        <button type="submit" disabled={!name.trim() || Boolean(busy)}>{busy.startsWith('grant:') ? <LoaderCircle size={13} className="is-spinning"/> : <Gift size={13}/>}Give</button>
      </form>
      {error && <div className="admin-error" role="alert"><span>{error}</span></div>}
      <div className="admin-cape-owner-list">
        {!owners ? <span className="admin-note"><LoaderCircle size={12} className="is-spinning"/> Loading…</span>
          : owners.length ? owners.map((owner) => (
            <div key={owner.userId} className="admin-cape-owner">
              <strong>{owner.username || owner.userId}</strong>
              <small>{owner.source === 'admin' ? 'given' : owner.source} · {new Date(owner.acquiredAt).toLocaleDateString()}</small>
              {owner.username && <button type="button" title={`Take it from ${owner.username}`} aria-label={`Take it from ${owner.username}`} disabled={Boolean(busy)} onClick={() => act('revoke', owner.username)}>{busy === `revoke:${owner.username}` ? <LoaderCircle size={12} className="is-spinning"/> : <X size={12}/>}</button>}
            </div>
          )) : <span className="admin-note">Nobody has it yet.</span>}
      </div>
    </section>
  );
}

/** Matches the server: the Store hero rotates through at most 5 featured capes. */
const MAX_FEATURED = 5;
const emptyDraft = () => ({ name: '', id: '', description: '', tags: '', author: 'Native', order: '', featured: false, hidden: false, exclusive: false, price: '', fps: 12, frames: 1, texture: null });

/** Admin -> Store: add, edit, hide, feature and delete Native capes. */
export default function AdminStore({ onNotify, onError }) {
  const [items, setItems] = useState(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [editing, setEditing] = useState(null); // null | 'new' | item id
  const [draft, setDraft] = useState(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState('');
  const [confirmDelete, setConfirmDelete] = useState('');
  const [strips, setStrips] = useState({});
  const [fileError, setFileError] = useState('');
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    const result = await window.native?.admin?.storeItems?.();
    if (!result?.ok) { onError?.(result?.error || 'Could not load the store.'); setItems((current) => current || []); return; }
    setItems(result.items || []);
  }, [onError]);

  useEffect(() => { load(); }, [load]);

  // Animated thumbnails for public animated items (hidden ones show their first frame).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const item of items || []) {
        if (!item.animated || item.hidden || strips[item.id]) continue;
        const res = await window.native?.store?.strip?.(item.id).catch(() => null);
        if (cancelled) return;
        if (res?.ok) setStrips((current) => ({ ...current, [item.id]: res.url }));
      }
    })();
    return () => { cancelled = true; };
  }, [items]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (items || []).filter((item) => {
      if (filter === 'animated' && !item.animated) return false;
      if (filter === 'paid' && !item.paid) return false;
      if (filter === 'hidden' && !item.hidden) return false;
      if (filter === 'exclusive' && !item.exclusive) return false;
      if (!needle) return true;
      return [item.name, item.id, item.author, ...(item.tags || [])].some((value) => String(value || '').toLowerCase().includes(needle));
    });
  }, [items, query, filter]);

  const totals = useMemo(() => ({
    capes: (items || []).length,
    animated: (items || []).filter((item) => item.animated).length,
    owners: (items || []).reduce((sum, item) => sum + (item.owners || 0), 0),
    featured: (items || []).filter((item) => item.featured).length
  }), [items]);
  const featuredFull = totals.featured >= MAX_FEATURED;

  const openNew = () => { setDraft(emptyDraft()); setFileError(''); setEditing('new'); };
  const openEdit = (item) => {
    setDraft({ name: item.name, id: item.id, description: item.description || '', tags: (item.tags || []).join(', '), author: item.author || 'Native', order: String(item.order ?? ''), featured: Boolean(item.featured), hidden: Boolean(item.hidden), exclusive: Boolean(item.exclusive), price: item.price > 0 ? String(item.price) : '', fps: item.fps || 12, frames: item.frames || 1, texture: null });
    setFileError('');
    setEditing(item.id);
  };
  const close = () => { setEditing(null); setDraft(emptyDraft()); setFileError(''); };
  const set = (key) => (event) => { const value = event?.target ? (event.target.type === 'checkbox' ? event.target.checked : event.target.value) : event; setDraft((current) => ({ ...current, [key]: value })); };

  const pickTexture = async (file) => {
    setFileError('');
    if (!file) return;
    try {
      if (file.type && file.type !== 'image/png') throw new Error('Choose a PNG file.');
      if (file.size > MAX_ANIM_MB * 1024 * 1024) throw new Error(`Choose a PNG smaller than ${MAX_ANIM_MB} MB.`);
      const dataUrl = await readFile(file);
      const image = await loadImage(dataUrl);
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      const guess = guessFrames(width, height);
      if (guess) {
        if (guess.frames > MAX_FRAMES) throw new Error(`That strip has ${guess.frames} frames — the limit is ${MAX_FRAMES}.`);
        const still = firstFrameDataUrl(image, guess.frames);
        setDraft((current) => ({ ...current, frames: guess.frames, fps: current.fps || 12, texture: { animated: true, strip: dataUrl, still, width, height, frameHeight: guess.frameHeight, size: file.size, fileName: file.name } }));
      } else if (isNativeCapeRatio(width, height)) {
        if (file.size > MAX_STATIC_MB * 1024 * 1024) throw new Error(`A static cape must be smaller than ${MAX_STATIC_MB} MB.`);
        setDraft((current) => ({ ...current, frames: 1, texture: { animated: false, still: dataUrl, width, height, frameHeight: height, size: file.size, fileName: file.name } }));
      } else {
        throw new Error(`${width}×${height} isn’t a cape. Use a 2:1 cape (e.g. 64×32), or a vertical strip of 2:1 frames for an animated cape.`);
      }
      if (!draft.name) setDraft((current) => ({ ...current, name: current.name || file.name.replace(/\.png$/i, '').replace(/[-_]+/g, ' ').slice(0, 40) }));
    } catch (reason) {
      setFileError(reason?.message || 'Could not use that file.');
    }
  };

  const save = async () => {
    if (saving) return;
    const creating = editing === 'new';
    if (draft.name.trim().length < 2) { setFileError('Give the cape a name.'); return; }
    if (creating && !draft.texture) { setFileError('Choose the cape PNG first.'); return; }
    const fps = Math.max(1, Math.min(MAX_FPS, Math.round(Number(draft.fps) || 12)));
    const body = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      tags: draft.tags,
      author: draft.author.trim() || 'Native',
      featured: draft.featured,
      hidden: draft.hidden,
      exclusive: draft.exclusive,
      price: draft.exclusive ? 0 : Math.max(0, Number(draft.price) || 0),
      ...(draft.order !== '' && Number.isFinite(Number(draft.order)) ? { order: Number(draft.order) } : {}),
      fps
    };
    if (creating && draft.id.trim()) body.id = draft.id.trim();
    if (draft.texture) {
      body.animated = draft.texture.animated;
      body.still = draft.texture.still;
      if (draft.texture.animated) { body.strip = draft.texture.strip; body.frames = draft.frames; }
    }
    setSaving(true);
    setFileError('');
    try {
      const result = creating ? await window.native.admin.storeCreate(body) : await window.native.admin.storeUpdate(editing, body);
      if (!result?.ok) throw new Error(result?.error || 'Could not save that cape.');
      if (result.items) setItems(result.items); else await load();
      setStrips((current) => { const next = { ...current }; delete next[result.item?.id || editing]; return next; });
      onNotify?.(creating ? 'Cape added' : 'Cape saved', `${body.name} ${body.hidden ? 'is saved (hidden).' : 'is live in the Store.'}`);
      close();
    } catch (reason) {
      setFileError(reason?.message || 'Could not save that cape.');
    } finally {
      setSaving(false);
    }
  };

  const patch = async (item, changes, message) => {
    setBusy(item.id);
    try {
      const result = await window.native.admin.storeUpdate(item.id, changes);
      if (!result?.ok) throw new Error(result?.error || 'Could not update that cape.');
      if (result.items) setItems(result.items); else await load();
      if (message) onNotify?.('Store', message);
    } catch (reason) { onError?.(reason?.message || 'Could not update that cape.'); }
    finally { setBusy(''); }
  };

  const remove = async (item) => {
    if (confirmDelete !== item.id) { setConfirmDelete(item.id); setTimeout(() => setConfirmDelete((id) => (id === item.id ? '' : id)), 4000); return; }
    setBusy(item.id);
    setConfirmDelete('');
    try {
      const result = await window.native.admin.storeDelete(item.id);
      if (!result?.ok) throw new Error(result?.error || 'Could not delete that cape.');
      if (result.items) setItems(result.items); else await load();
      if (editing === item.id) close();
      onNotify?.('Cape deleted', `${item.name} was removed from the Store and from every locker.`);
    } catch (reason) { onError?.(reason?.message || 'Could not delete that cape.'); }
    finally { setBusy(''); }
  };

  const editingItem = editing && editing !== 'new' ? (items || []).find((item) => item.id === editing) : null;
  const preview = draft.texture
    ? { src: draft.texture.animated ? draft.texture.strip : draft.texture.still, frames: draft.texture.animated ? draft.frames : 1 }
    : editingItem ? { src: strips[editingItem.id] || editingItem.stillUrl, frames: strips[editingItem.id] ? editingItem.frames : 1 } : null;
  const previewAnimated = draft.texture ? draft.texture.animated : Boolean(editingItem?.animated);

  return (
    <div className="admin-store">
      <div className="admin-toolbar">
        <label className="admin-search"><Search size={14}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search capes, ids or tags"/></label>
        <div className="admin-filters">
          {[['all', 'All'], ['animated', 'Animated'], ['paid', 'Paid'], ['exclusive', 'Event'], ['hidden', 'Hidden']].map(([id, label]) => (
            <button key={id} type="button" className={filter === id ? 'active' : ''} onClick={() => setFilter(id)}>{label}</button>
          ))}
        </div>
        <span className="admin-result-count">{totals.capes} capes · {totals.animated} animated · {totals.featured}/{MAX_FEATURED} featured · {totals.owners} in lockers</span>
        <button type="button" className="admin-store-new" onClick={openNew}><Plus size={14}/>New cape</button>
      </div>

      <div className="admin-store-body">
        <div className="admin-store-list" aria-busy={!items}>
          {!items ? (
            <div className="admin-loading"><LoaderCircle size={18} className="is-spinning"/><span>Loading the store…</span></div>
          ) : visible.length ? visible.map((item) => (
            <article key={item.id} className={`admin-store-row${editing === item.id ? ' is-editing' : ''}${item.hidden ? ' is-hidden' : ''}`}>
              <CapeThumb src={strips[item.id] || item.stillUrl} frames={strips[item.id] ? item.frames : 1} fps={item.fps}/>
              <div className="admin-store-main">
                <div className="admin-user-name">
                  <strong>{item.name}</strong>
                  {item.animated && <em className="admin-tag is-anim">Animated · {item.frames}f · {item.fps}fps</em>}
                  {!item.animated && <em className="admin-tag">Static</em>}
                  {item.exclusive && <em className="admin-tag is-exclusive">Event</em>}
                  {item.paid && <em className="admin-tag is-price">${Number(item.price).toFixed(2)}</em>}
                  {!item.paid && !item.exclusive && <em className="admin-tag">Free</em>}
                  {item.featured && <em className="admin-tag is-featured">Featured</em>}
                  {item.hidden && <em className="admin-tag is-hidden">Hidden</em>}
                  {item.isNew && <em className="admin-tag">New</em>}
                </div>
                <small><code>{item.id}</code> · by {item.author || 'Native'} · {item.owners || 0} in lockers · order {item.order ?? 0}</small>
                {item.description && <small className="admin-user-meta">{item.description}</small>}
              </div>
              <div className="admin-store-actions">
                <button type="button" title={item.featured ? 'Unfeature' : featuredFull ? `Up to ${MAX_FEATURED} capes can be featured` : 'Feature in the Store hero'} className={item.featured ? 'is-on' : ''} disabled={busy === item.id || (!item.featured && featuredFull)} onClick={() => patch(item, { featured: !item.featured }, `${item.name} ${item.featured ? 'is no longer featured' : 'is now featured'}.`)}><Star size={14}/></button>
                <button type="button" title={item.hidden ? 'Show in Store' : 'Hide from Store'} disabled={busy === item.id} onClick={() => patch(item, { hidden: !item.hidden }, `${item.name} is now ${item.hidden ? 'visible' : 'hidden'}.`)}>{item.hidden ? <EyeOff size={14}/> : <Eye size={14}/>}</button>
                <button type="button" title="Edit" disabled={busy === item.id} onClick={() => openEdit(item)}><Pencil size={14}/></button>
                <button type="button" title={confirmDelete === item.id ? 'Click again to delete' : 'Delete'} className={confirmDelete === item.id ? 'is-danger' : ''} disabled={busy === item.id} onClick={() => remove(item)}>{busy === item.id ? <LoaderCircle size={14} className="is-spinning"/> : <Trash2 size={14}/>}{confirmDelete === item.id && <span>Delete?</span>}</button>
              </div>
            </article>
          )) : <div className="admin-loading"><span>{items.length ? 'No cloaks match this view.' : 'No capes yet — add the first one.'}</span></div>}
        </div>

        {editing && (
          <aside className="admin-store-editor" aria-label={editing === 'new' ? 'New cape' : 'Edit cape'}>
            <header>
              <h2>{editing === 'new' ? 'New cape' : `Edit ${editingItem?.name || ''}`}</h2>
              <button type="button" className="admin-icon-btn" onClick={close} aria-label="Close"><X size={15}/></button>
            </header>

            <div className="admin-store-preview">
              {preview?.src ? <CapeThumb key={`${preview.src.length}:${preview.frames}`} src={preview.src} frames={preview.frames} fps={Number(draft.fps) || 12} width={80} height={128}/> : <span className="admin-store-empty">No texture</span>}
              <div>
                <button type="button" className="admin-store-upload" onClick={() => fileRef.current?.click()}><Upload size={14}/>{draft.texture || editing !== 'new' ? 'Replace PNG' : 'Choose PNG'}</button>
                <input ref={fileRef} type="file" accept="image/png" hidden onChange={(event) => { pickTexture(event.target.files?.[0]); event.target.value = ''; }}/>
                <p className="admin-note">
                  {draft.texture
                    ? `${draft.texture.fileName} · ${draft.texture.width}×${draft.texture.height} · ${draft.texture.animated ? `animated, ${draft.frames} frames` : 'static'}`
                    : 'Static: a 2:1 cape PNG (64×32, 128×64 …). Animated: frames stacked vertically in one PNG.'}
                </p>
              </div>
            </div>

            <div className="admin-store-form">
              <label><span>Name</span><input value={draft.name} maxLength={40} onChange={set('name')} placeholder="Aurora"/></label>
              <label><span>ID</span><input value={draft.id} disabled={editing !== 'new'} onChange={set('id')} placeholder="auto from name"/></label>
              <label className="is-wide"><span>Description</span><textarea rows={2} value={draft.description} maxLength={200} onChange={set('description')} placeholder="What makes this cape special?"/></label>
              <label><span>Tags</span><input value={draft.tags} onChange={set('tags')} placeholder="space, glow"/></label>
              <label><span>Author</span><input value={draft.author} maxLength={40} onChange={set('author')}/></label>
              {previewAnimated && <label><span>Frames</span><input type="number" min={2} max={MAX_FRAMES} value={draft.frames} disabled={!draft.texture} onChange={set('frames')}/></label>}
              {previewAnimated && <label><span>Speed (fps)</span><input type="number" min={1} max={MAX_FPS} value={draft.fps} onChange={set('fps')}/></label>}
              <label><span>Price (USD)</span><input type="number" min={0} max={99.99} step={0.01} value={draft.exclusive ? '' : draft.price} disabled={draft.exclusive} onChange={set('price')} placeholder="0 = free"/></label>
              <label><span>Order</span><input type="number" value={draft.order} onChange={set('order')} placeholder="0 = first"/></label>
              <label className="admin-check" title={featuredFull && !draft.featured ? `Up to ${MAX_FEATURED} capes can be featured` : undefined}><input type="checkbox" checked={draft.featured} disabled={!draft.featured && featuredFull && !(editing !== 'new' && items?.find((item) => item.id === editing)?.featured)} onChange={set('featured')}/><span>Featured ({totals.featured}/{MAX_FEATURED})</span></label>
              <label className="admin-check"><input type="checkbox" checked={draft.hidden} onChange={set('hidden')}/><span>Hidden (draft)</span></label>
              <label className="admin-check is-wide"><input type="checkbox" checked={draft.exclusive} onChange={set('exclusive')}/><span>Event cloak: never sold. Give it out by hand or with redeem codes</span></label>
            </div>

            {editingItem && <CapeOwners item={editingItem} onNotify={onNotify} onChanged={(next) => next && setItems(next)}/>}

            <p className="admin-note">{draft.exclusive ? 'Event cloak: players can’t buy or claim it. Give it to people below, or make a redeem code in Sales.' : Number(draft.price) > 0 ? `Sold for $${Number(draft.price).toFixed(2)}. Native+ members get it included.` : 'Free: anyone can add it to their locker.'}</p>
            {fileError && <div className="admin-error" role="alert"><span>{fileError}</span></div>}

            <footer>
              <button type="button" className="instances-ghost-btn" onClick={close}>Cancel</button>
              <button type="button" className="admin-store-save" disabled={saving} onClick={save}>{saving && <LoaderCircle size={14} className="is-spinning"/>}{editing === 'new' ? 'Add to Store' : 'Save changes'}</button>
            </footer>
          </aside>
        )}
      </div>
    </div>
  );
}
