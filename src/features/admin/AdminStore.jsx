import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, DollarSign, Eye, EyeOff, FileJson, Gift, ImageIcon, LoaderCircle, Palette, PackagePlus, Pencil, Plus, Search, Star, Trash2, Upload, X } from 'lucide-react';
import { drawCapeFront, firstFrameDataUrl, guessFrames, isNativeCapeRatio, MAX_FPS, MAX_FRAMES } from '../../lib/animatedCape.js';
import { WornShot, wornShot } from '../../lib/wornShot.jsx';
import SkinViewer3D, { prepareSkinSource } from '../../components/ui/SkinViewer3D.jsx';
import { PixelTabs } from '../../components/ui/PixelControls.jsx';
import steveSkin from '../../assets/steve.png';
import { ImportPackModal, PricingModal } from './AdminStoreTools.jsx';

/** Store sections, in the same order as the Store. */
export const SECTIONS = [
  { id: 'capes', label: 'Cloaks', noun: 'cloak' },
  { id: 'hats', label: 'Headwear', noun: 'hat' },
  { id: 'glasses', label: 'Glasses', noun: 'glasses' },
  { id: 'back', label: 'Wings & Backpacks', noun: 'back item' },
  { id: 'shoes', label: 'Shoes', noun: 'shoes' },
  { id: 'hand', label: 'In hand', noun: 'hand item' }
];
const sectionOf = (item) => (item?.kind === 'cosmetic' ? item.slot : 'capes');
const isCosmetic = (item) => item?.kind === 'cosmetic';
const MAX_DYES = 5;
const MAX_MODEL_KB = 1024;
const MAX_TEXTURE_MB = 2;
const PREVIEW_ACCOUNT = { id: 'admin-preview', type: 'offline', name: 'Steve', skinUrl: steveSkin, model: 'default', hasCape: false, capeUrl: null };

function readText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsText(file);
  });
}

/** Model + texture of a listed cosmetic (hidden ones too), loaded once per model/texture. */
const assetCache = new Map();
function loadAsset(item) {
  const key = `${item.modelUrl}|${item.textureUrl}`;
  if (!assetCache.has(key)) {
    const job = (window.native?.admin?.cosmeticAsset?.({ id: item.id, slot: item.slot, modelUrl: item.modelUrl, textureUrl: item.textureUrl, stillUrl: item.stillUrl }) || Promise.resolve(null))
      .then((res) => (res?.ok ? res : null))
      .catch(() => null);
    job.then((value) => { if (!value) assetCache.delete(key); });
    assetCache.set(key, job);
  }
  return assetCache.get(key);
}
function useCosmeticAsset(item) {
  const [asset, setAsset] = useState(null);
  const key = item && isCosmetic(item) ? `${item.modelUrl}|${item.textureUrl}` : null;
  useEffect(() => {
    if (!key) { setAsset(null); return undefined; }
    let alive = true;
    setAsset(null);
    loadAsset(item).then((value) => { if (alive) setAsset(value); });
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return asset;
}

/** The real 3D piece worn on Steve (drawn once and cached), like the Store cards. */
export function CosmeticThumb({ item, asset: given = null, width = 64, height = 64 }) {
  const loaded = useCosmeticAsset(given ? null : item);
  const asset = given || loaded;
  const box = { width, height };
  if (!asset) return <span className="admin-cos-thumb is-loading" style={box} />;
  return <span className="admin-cos-thumb" style={box}><WornShot item={item} asset={asset} skinUrl={steveSkin} model="default" prepare={prepareSkinSource} fallback={asset.thumb} className="admin-cos-thumb-img" /></span>;
}

/** Any store item's thumbnail: cloaks show their front (animated), cosmetics the worn 3D piece. */
export function ItemThumb({ item, strips = {}, width = 40, height = 64 }) {
  if (isCosmetic(item)) return <CosmeticThumb item={item} width={Math.max(width, height)} height={Math.max(width, height)} />;
  return <CapeThumb key={`${item.id}:${strips[item.id] ? 1 : 0}`} src={strips[item.id] || item.stillUrl} frames={strips[item.id] ? item.frames : 1} fps={item.fps} width={width} height={height} />;
}

/** Up to 5 colours players may dye an item, besides its default. */
function DyeColors({ value, onChange }) {
  return (
    <div className="admin-dye-colors" role="group" aria-label="Dye colours">
      {Array.from({ length: MAX_DYES }, (_, index) => {
        const hex = value[index];
        if (!hex) {
          return index === value.length
            ? <button key={index} type="button" className="admin-dye-add" title="Add a colour" onClick={() => onChange([...value, '#ffffff'])}><Plus size={13}/></button>
            : <span key={index} className="admin-dye-slot" aria-hidden="true"/>;
        }
        return (
          <span key={index} className="admin-dye-color">
            <input type="color" value={hex} aria-label={`Colour ${index + 1}`} title={hex} onChange={(event) => onChange(value.map((entry, j) => (j === index ? event.target.value.toLowerCase() : entry)))}/>
            <button type="button" aria-label={`Remove colour ${index + 1}`} onClick={() => onChange(value.filter((_, j) => j !== index))}><X size={9} strokeWidth={3}/></button>
          </span>
        );
      })}
      <small>{value.length}/{MAX_DYES}</small>
    </div>
  );
}

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
      <h3>Give this {isCosmetic(item) ? 'item' : 'cape'} <small>{owners ? `${owners.length} ${owners.length === 1 ? 'owner' : 'owners'}` : ''}</small></h3>
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

/** Matches the server: each Store section's hero rotates through at most 5 featured items. */
const MAX_FEATURED = 5;
const emptyDraft = () => ({ name: '', id: '', description: '', tags: '', author: 'Native', order: '', featured: false, hidden: false, exclusive: false, price: '', fps: 12, frames: 1, texture: null, model: null, cosTexture: null, thumb: null, dyeable: false, dyeDefault: '#ffffff', dyeColors: [], dyeMask: null, dropMask: false });

const draftFrom = (item) => ({
  ...emptyDraft(),
  name: item.name, id: item.id, description: item.description || '', tags: (item.tags || []).join(', '), author: item.author || 'Native',
  order: String(item.order ?? ''), featured: Boolean(item.featured), hidden: Boolean(item.hidden), exclusive: Boolean(item.exclusive),
  price: item.price > 0 ? String(item.price) : '', fps: item.fps || 12, frames: item.frames || 1,
  dyeable: Boolean(item.dyeable), dyeDefault: item.dyeDefault || '#ffffff', dyeColors: item.dyeColors || []
});

/** Admin -> Store: add, edit, hide, feature and delete cloaks and every kind of cosmetic. */
export default function AdminStore({ onNotify, onError, onAccessRevoked, onItemsChanged }) {
  const [items, setItems] = useState(null);
  const [tool, setTool] = useState(null); // null | 'pricing' | 'import'
  const [section, setSection] = useState('capes');
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
  const modelRef = useRef(null);
  const cosTexRef = useRef(null);
  const thumbRef = useRef(null);
  const maskRef = useRef(null);
  const cosmeticSection = section !== 'capes';
  const meta = SECTIONS.find((entry) => entry.id === section) || SECTIONS[0];

  const load = useCallback(async () => {
    const result = await window.native?.admin?.storeItems?.();
    if (!result?.ok) { onError?.(result?.error || 'Could not load the store.'); setItems((current) => current || []); return; }
    setItems(result.items || []);
  }, [onError]);

  useEffect(() => { load(); }, [load]);

  // Animated thumbnails for public animated cloaks (hidden ones show their first frame).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const item of items || []) {
        if (isCosmetic(item) || !item.animated || item.hidden || strips[item.id]) continue;
        const res = await window.native?.store?.strip?.(item.id).catch(() => null);
        if (cancelled) return;
        if (res?.ok) setStrips((current) => ({ ...current, [item.id]: res.url }));
      }
    })();
    return () => { cancelled = true; };
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    const out = {};
    for (const item of items || []) out[sectionOf(item)] = (out[sectionOf(item)] || 0) + 1;
    return out;
  }, [items]);

  const inSection = useMemo(() => (items || []).filter((item) => sectionOf(item) === section), [items, section]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return inSection.filter((item) => {
      if (filter === 'animated' && !(item.animated || item.motion)) return false;
      if (filter === 'paid' && !item.paid) return false;
      if (filter === 'hidden' && !item.hidden) return false;
      if (filter === 'exclusive' && !item.exclusive) return false;
      if (filter === 'dyeable' && !item.dyeable) return false;
      if (!needle) return true;
      return [item.name, item.id, item.author, ...(item.tags || [])].some((value) => String(value || '').toLowerCase().includes(needle));
    });
  }, [inSection, query, filter]);

  const totals = useMemo(() => ({
    count: inSection.length,
    animated: inSection.filter((item) => item.animated || item.motion).length,
    owners: inSection.reduce((sum, item) => sum + (item.owners || 0), 0),
    featured: inSection.filter((item) => item.featured).length
  }), [inSection]);
  const featuredFull = totals.featured >= MAX_FEATURED;

  const switchSection = (id) => { setSection(id); setEditing(null); setDraft(emptyDraft()); setFileError(''); if (id === 'capes' && filter === 'dyeable') setFilter('all'); };
  const openNew = () => { setDraft(emptyDraft()); setFileError(''); setEditing('new'); };
  const openEdit = (item) => { setDraft(draftFrom(item)); setFileError(''); setEditing(item.id); };
  const close = () => { setEditing(null); setDraft(emptyDraft()); setFileError(''); };
  const set = (key) => (event) => { const value = event?.target ? (event.target.type === 'checkbox' ? event.target.checked : event.target.value) : event; setDraft((current) => ({ ...current, [key]: value })); };
  const nameFrom = (file) => file.name.replace(/\.(png|json)$/i, '').replace(/[-_]+/g, ' ').slice(0, 40);

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
      setDraft((current) => ({ ...current, name: current.name || nameFrom(file) }));
    } catch (reason) {
      setFileError(reason?.message || 'Could not use that file.');
    }
  };

  // cosmetics: a Blockbench-style model (.json), its texture PNG, an optional thumbnail and dye mask
  const pickModel = async (file) => {
    setFileError('');
    if (!file) return;
    try {
      if (file.size > MAX_MODEL_KB * 1024) throw new Error(`The model must be smaller than ${MAX_MODEL_KB} KB.`);
      const text = await readText(file);
      let json;
      try { json = JSON.parse(text); } catch { throw new Error('That model isn’t valid JSON.'); }
      setDraft((current) => ({ ...current, model: { text, json, fileName: file.name }, name: current.name || nameFrom(file) }));
    } catch (reason) { setFileError(reason?.message || 'Could not use that model.'); }
  };
  const pickPng = (key, limitMb) => async (file) => {
    setFileError('');
    if (!file) return;
    try {
      if (file.type && file.type !== 'image/png') throw new Error('Choose a PNG file.');
      if (file.size > limitMb * 1024 * 1024) throw new Error(`Choose a PNG smaller than ${limitMb} MB.`);
      const dataUrl = await readFile(file);
      const image = await loadImage(dataUrl);
      setDraft((current) => ({ ...current, [key]: { dataUrl, width: image.naturalWidth, height: image.naturalHeight, fileName: file.name }, ...(key === 'dyeMask' ? { dropMask: false } : {}) }));
    } catch (reason) { setFileError(reason?.message || 'Could not use that file.'); }
  };

  const editingItem = editing && editing !== 'new' ? (items || []).find((item) => item.id === editing) : null;
  const savedAsset = useCosmeticAsset(cosmeticSection && editingItem ? editingItem : null);
  // what the 3D preview wears: the files picked in the editor, falling back to the saved item
  const previewAsset = useMemo(() => {
    if (!cosmeticSection || !editing) return null;
    const model = draft.model?.json || savedAsset?.model;
    const texture = draft.cosTexture?.dataUrl || savedAsset?.texture;
    if (!model || !texture) return null;
    return { id: editingItem?.id || 'draft', slot: section, model, texture, ...(section === 'hand' ? { side: 'right' } : {}) };
  }, [cosmeticSection, editing, draft.model, draft.cosTexture, savedAsset, editingItem, section]);
  const [dyedPreview, setDyedPreview] = useState(null);
  // dyeable items preview in their default colour (the server bakes the same way)
  useEffect(() => {
    let alive = true;
    setDyedPreview(null);
    if (!previewAsset || !draft.dyeable || !draft.cosTexture || !draft.dyeDefault) return undefined;
    bakeDye(previewAsset.texture, draft.dyeMask?.dataUrl || null, draft.dyeDefault).then((url) => { if (alive && url) setDyedPreview({ ...previewAsset, texture: url }); }).catch(() => {});
    return () => { alive = false; };
  }, [previewAsset, draft.dyeable, draft.dyeDefault, draft.dyeMask, draft.cosTexture]);
  const shownAsset = dyedPreview || previewAsset;

  const save = async () => {
    if (saving) return;
    const creating = editing === 'new';
    const noun = cosmeticSection ? meta.noun : 'cape';
    if (draft.name.trim().length < 2) { setFileError(`Give the ${noun} a name.`); return; }
    if (creating && !cosmeticSection && !draft.texture) { setFileError('Choose the cape PNG first.'); return; }
    if (creating && cosmeticSection && (!draft.model || !draft.cosTexture)) { setFileError('Choose the model (.json) and its texture PNG first.'); return; }
    const fps = Math.max(1, Math.min(MAX_FPS, Math.round(Number(draft.fps) || 12)));
    const body = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      tags: draft.tags,
      author: draft.author.trim() || 'Native',
      featured: draft.featured,
      hidden: draft.hidden,
      exclusive: draft.exclusive,
      price: draft.exclusive ? 0 : Math.max(0, Number(draft.price) || 0), // 0 = the server picks the automatic price
      ...(draft.order !== '' && Number.isFinite(Number(draft.order)) ? { order: Number(draft.order) } : {})
    };
    if (creating && draft.id.trim()) body.id = draft.id.trim();
    if (cosmeticSection) {
      if (creating) { body.kind = 'cosmetic'; body.slot = section; }
      if (draft.model) body.model = draft.model.text;
      if (draft.cosTexture) body.texture = draft.cosTexture.dataUrl;
      if (draft.thumb) body.thumb = draft.thumb.dataUrl;
      else if (draft.model || draft.cosTexture) {
        // no thumbnail picked: draw the piece worn on Steve, like the Store does
        const asset = shownAsset;
        const shot = asset ? await wornShot({ item: { id: `admin-${Date.now()}`, slot: section }, asset, skinUrl: steveSkin, model: 'default', prepare: prepareSkinSource }).catch(() => null) : null;
        if (shot && /^data:image\/png/.test(shot)) body.thumb = shot;
      }
      const wasDyeable = Boolean(editingItem?.dyeable);
      if (draft.dyeable || wasDyeable) {
        body.dyeable = draft.dyeable;
        if (draft.dyeable) {
          body.dyeDefault = draft.dyeDefault;
          body.dyeColors = draft.dyeColors;
          if (draft.dyeMask) body.dyeMask = draft.dyeMask.dataUrl;
          else if (draft.dropMask) body.dyeMask = '';
        }
      }
    } else {
      body.fps = fps;
      if (draft.texture) {
        body.animated = draft.texture.animated;
        body.still = draft.texture.still;
        if (draft.texture.animated) { body.strip = draft.texture.strip; body.frames = draft.frames; }
      }
    }
    setSaving(true);
    setFileError('');
    try {
      const result = creating ? await window.native.admin.storeCreate(body) : await window.native.admin.storeUpdate(editing, body);
      if (!result?.ok) throw new Error(result?.error || `Could not save that ${noun}.`);
      if (result.items) setItems(result.items); else await load();
      setStrips((current) => { const next = { ...current }; delete next[result.item?.id || editing]; return next; });
      onNotify?.(creating ? 'Added to the Store' : 'Saved', `${body.name} ${body.hidden ? 'is saved (hidden).' : 'is live in the Store.'}`);
      close();
    } catch (reason) {
      setFileError(reason?.message || `Could not save that ${noun}.`);
    } finally {
      setSaving(false);
    }
  };

  const patch = async (item, changes, message) => {
    setBusy(item.id);
    try {
      const result = await window.native.admin.storeUpdate(item.id, changes);
      if (!result?.ok) throw new Error(result?.error || 'Could not update that item.');
      if (result.items) setItems(result.items); else await load();
      if (message) onNotify?.('Store', message);
    } catch (reason) { onError?.(reason?.message || 'Could not update that item.'); }
    finally { setBusy(''); }
  };

  const remove = async (item) => {
    if (confirmDelete !== item.id) { setConfirmDelete(item.id); setTimeout(() => setConfirmDelete((id) => (id === item.id ? '' : id)), 4000); return; }
    setBusy(item.id);
    setConfirmDelete('');
    try {
      const result = await window.native.admin.storeDelete(item.id);
      if (!result?.ok) throw new Error(result?.error || 'Could not delete that item.');
      if (result.items) setItems(result.items); else await load();
      if (editing === item.id) close();
      onNotify?.('Deleted', `${item.name} was removed from the Store and from every locker.`);
    } catch (reason) { onError?.(reason?.message || 'Could not delete that item.'); }
    finally { setBusy(''); }
  };

  const preview = draft.texture
    ? { src: draft.texture.animated ? draft.texture.strip : draft.texture.still, frames: draft.texture.animated ? draft.frames : 1 }
    : editingItem && !isCosmetic(editingItem) ? { src: strips[editingItem.id] || editingItem.stillUrl, frames: strips[editingItem.id] ? editingItem.frames : 1 } : null;
  const previewAnimated = draft.texture ? draft.texture.animated : Boolean(editingItem?.animated);
  const filters = [['all', 'All'], ['animated', cosmeticSection ? 'Moving' : 'Animated'], ['paid', 'Paid'], ['exclusive', 'Event'], ...(cosmeticSection ? [['dyeable', 'Dyeable']] : []), ['hidden', 'Hidden']];
  const tabs = SECTIONS.map((entry) => ({ id: entry.id, label: entry.label, count: items ? counts[entry.id] || 0 : null }));
  const fileLabel = (file, fallback) => (file ? `${file.fileName}${file.width ? ` · ${file.width}×${file.height}` : ''}` : fallback);

  return (
    <div className="admin-store">
      <div className="admin-store-sections">
        <PixelTabs size="sm" fill items={tabs} value={section} onChange={switchSection} label="Store sections"/>
      </div>
      <div className="admin-toolbar">
        <label className="admin-search"><Search size={14}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${meta.label.toLowerCase()}, ids or tags`}/></label>
        <div className="admin-filters">
          {filters.map(([id, label]) => (
            <button key={id} type="button" className={filter === id ? 'active' : ''} onClick={() => setFilter(id)}>{label}</button>
          ))}
        </div>
        <span className="admin-result-count">{totals.count} items · {totals.animated} {cosmeticSection ? 'moving' : 'animated'} · {totals.featured}/{MAX_FEATURED} featured · {totals.owners} in lockers</span>
        <button type="button" className="admin-btn ghost" onClick={() => setTool('pricing')} title="Set every price at once"><DollarSign size={13}/>Pricing</button>
        <button type="button" className="admin-btn ghost" onClick={() => setTool('import')} title="Import cosmetics from an ItemsAdder, Nexo, Oraxen, ModelEngine or HMCCosmetics pack"><PackagePlus size={13}/>Import pack</button>
        <button type="button" className="admin-store-new" onClick={openNew}><Plus size={14}/>New {meta.noun}</button>
      </div>
      {tool === 'pricing' && <PricingModal onClose={() => setTool(null)} onDone={async () => { await load(); onItemsChanged?.(); }} onNotify={onNotify} onAccessRevoked={onAccessRevoked}/>}
      {tool === 'import' && <ImportPackModal onClose={() => setTool(null)} onImported={async (next) => { if (next) setItems(next); else await load(); onItemsChanged?.(); }} onNotify={onNotify}/>}

      <div className="admin-store-body">
        <div className="admin-store-list" aria-busy={!items}>
          {!items ? (
            <div className="admin-loading"><LoaderCircle size={18} className="is-spinning"/><span>Loading the store…</span></div>
          ) : visible.length ? visible.map((item) => (
            <article key={item.id} className={`admin-store-row${editing === item.id ? ' is-editing' : ''}${item.hidden ? ' is-hidden' : ''}`}>
              <ItemThumb item={item} strips={strips} width={40} height={64}/>
              <div className="admin-store-main">
                <div className="admin-user-name">
                  <strong>{item.name}</strong>
                  {isCosmetic(item)
                    ? <em className="admin-tag"><Box size={10}/>3D{item.motion ? ' · moves' : ''}</em>
                    : item.animated ? <em className="admin-tag is-anim">Animated · {item.frames}f · {item.fps}fps</em> : <em className="admin-tag">Static</em>}
                  {item.dyeable && <em className="admin-tag is-dye"><Palette size={10}/>Dyeable{item.dyeColors?.length ? ` · ${item.dyeColors.length + 1} colours` : ' · no colours yet'}</em>}
                  {item.exclusive && <em className="admin-tag is-exclusive">Event</em>}
                  {item.paid && <em className="admin-tag is-price">${Number(item.price).toFixed(2)}</em>}
                  {item.featured && <em className="admin-tag is-featured">Featured</em>}
                  {item.hidden && <em className="admin-tag is-hidden">Hidden</em>}
                  {item.isNew && <em className="admin-tag">New</em>}
                </div>
                <small><code>{item.id}</code> · by {item.author || 'Native'} · {item.owners || 0} in lockers · order {item.order ?? 0}</small>
                {item.description && <small className="admin-user-meta">{item.description}</small>}
              </div>
              <div className="admin-store-actions">
                <button type="button" title={item.featured ? 'Unfeature' : featuredFull ? `Up to ${MAX_FEATURED} items per section can be featured` : 'Feature in the Store hero'} className={item.featured ? 'is-on' : ''} disabled={busy === item.id || (!item.featured && featuredFull)} onClick={() => patch(item, { featured: !item.featured }, `${item.name} ${item.featured ? 'is no longer featured' : 'is now featured'}.`)}><Star size={14}/></button>
                <button type="button" title={item.hidden ? 'Show in Store' : 'Hide from Store'} disabled={busy === item.id} onClick={() => patch(item, { hidden: !item.hidden }, `${item.name} is now ${item.hidden ? 'visible' : 'hidden'}.`)}>{item.hidden ? <EyeOff size={14}/> : <Eye size={14}/>}</button>
                <button type="button" title="Edit" disabled={busy === item.id} onClick={() => openEdit(item)}><Pencil size={14}/></button>
                <button type="button" title={confirmDelete === item.id ? 'Click again to delete' : 'Delete'} className={confirmDelete === item.id ? 'is-danger' : ''} disabled={busy === item.id} onClick={() => remove(item)}>{busy === item.id ? <LoaderCircle size={14} className="is-spinning"/> : <Trash2 size={14}/>}{confirmDelete === item.id && <span>Delete?</span>}</button>
              </div>
            </article>
          )) : <div className="admin-loading"><span>{inSection.length ? 'Nothing matches this view.' : `No ${meta.label.toLowerCase()} yet — add the first one.`}</span></div>}
        </div>

        {editing && (
          <aside className="admin-store-editor" aria-label={editing === 'new' ? `New ${meta.noun}` : 'Edit item'}>
            <header>
              <h2>{editing === 'new' ? `New ${meta.noun}` : `Edit ${editingItem?.name || ''}`}</h2>
              <button type="button" className="admin-icon-btn" onClick={close} aria-label="Close"><X size={15}/></button>
            </header>

            {cosmeticSection ? (
              <>
                <div className="admin-cos-stage">
                  {shownAsset
                    ? <SkinViewer3D key={`${shownAsset.id}:${String(shownAsset.texture).length}:${draft.model?.fileName || ''}`} account={PREVIEW_ACCOUNT} cosmetics={[shownAsset]} zoom={0.74} width={260} height={300} animation="walk" autoRotate/>
                    : <span className="admin-store-empty is-stage">{editingItem && !savedAsset && !draft.model ? <><LoaderCircle size={16} className="is-spinning"/>Loading model…</> : 'Pick a model and a texture to preview it in 3D'}</span>}
                </div>
                <div className="admin-cos-files">
                  <button type="button" className="admin-store-upload" onClick={() => modelRef.current?.click()}><FileJson size={14}/>{draft.model || editingItem ? 'Replace model' : 'Model (.json)'}</button>
                  <button type="button" className="admin-store-upload" onClick={() => cosTexRef.current?.click()}><Upload size={14}/>{draft.cosTexture || editingItem ? 'Replace texture' : 'Texture PNG'}</button>
                  <button type="button" className="admin-store-upload" onClick={() => thumbRef.current?.click()}><ImageIcon size={14}/>{draft.thumb ? 'Change thumbnail' : 'Thumbnail (optional)'}</button>
                  <input ref={modelRef} type="file" accept=".json,application/json" hidden onChange={(event) => { pickModel(event.target.files?.[0]); event.target.value = ''; }}/>
                  <input ref={cosTexRef} type="file" accept="image/png" hidden onChange={(event) => { pickPng('cosTexture', MAX_TEXTURE_MB)(event.target.files?.[0]); event.target.value = ''; }}/>
                  <input ref={thumbRef} type="file" accept="image/png" hidden onChange={(event) => { pickPng('thumb', 5)(event.target.files?.[0]); event.target.value = ''; }}/>
                </div>
                <p className="admin-note">
                  {[draft.model && `Model: ${draft.model.fileName}`, draft.cosTexture && `Texture: ${fileLabel(draft.cosTexture)}`, draft.thumb && `Thumbnail: ${fileLabel(draft.thumb)}`].filter(Boolean).join(' · ') || 'A Blockbench model (.json) and its texture. Without a thumbnail, one is drawn from the 3D model.'}
                </p>
              </>
            ) : (
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
            )}

            <div className="admin-store-form">
              <label><span>Name</span><input value={draft.name} maxLength={40} onChange={set('name')} placeholder={cosmeticSection ? 'Witch Hat' : 'Aurora'}/></label>
              <label><span>ID</span><input value={draft.id} disabled={editing !== 'new'} onChange={set('id')} placeholder="auto from name"/></label>
              <label className="is-wide"><span>Description</span><textarea rows={2} value={draft.description} maxLength={200} onChange={set('description')} placeholder={`What makes this ${meta.noun} special?`}/></label>
              <label><span>Tags</span><input value={draft.tags} onChange={set('tags')} placeholder="space, glow"/></label>
              <label><span>Author</span><input value={draft.author} maxLength={40} onChange={set('author')}/></label>
              {!cosmeticSection && previewAnimated && <label><span>Frames</span><input type="number" min={2} max={MAX_FRAMES} value={draft.frames} disabled={!draft.texture} onChange={set('frames')}/></label>}
              {!cosmeticSection && previewAnimated && <label><span>Speed (fps)</span><input type="number" min={1} max={MAX_FPS} value={draft.fps} onChange={set('fps')}/></label>}
              <label><span>Price (USD)</span><input type="number" min={1.99} max={99.99} step={0.01} value={draft.exclusive ? '' : draft.price} disabled={draft.exclusive} onChange={set('price')} placeholder="Automatic"/></label>
              <label><span>Order</span><input type="number" value={draft.order} onChange={set('order')} placeholder="0 = first"/></label>
              <label className="admin-check" title={featuredFull && !draft.featured ? `Up to ${MAX_FEATURED} items per section can be featured` : undefined}><input type="checkbox" checked={draft.featured} disabled={!draft.featured && featuredFull && !editingItem?.featured} onChange={set('featured')}/><span>Featured ({totals.featured}/{MAX_FEATURED})</span></label>
              <label className="admin-check"><input type="checkbox" checked={draft.hidden} onChange={set('hidden')}/><span>Hidden (draft)</span></label>
              <label className="admin-check is-wide"><input type="checkbox" checked={draft.exclusive} onChange={set('exclusive')}/><span>Event item: never sold. Give it out by hand or with redeem codes</span></label>
            </div>

            {cosmeticSection && (
              <section className="admin-dye">
                <label className="admin-check"><input type="checkbox" checked={draft.dyeable} onChange={set('dyeable')}/><span><Palette size={13}/> Dyeable: players pick its colour in the Locker</span></label>
                {draft.dyeable && <>
                  <p className="admin-note">The texture is the undyed base (white/grey where the colour goes); the colour is multiplied in, keeping the shading.</p>
                  <div className="admin-dye-row"><span>Default</span><input type="color" value={draft.dyeDefault} onChange={(event) => set('dyeDefault')(event.target.value.toLowerCase())}/><code>{draft.dyeDefault}</code></div>
                  <div className="admin-dye-row"><span>Colours</span><DyeColors value={draft.dyeColors} onChange={(value) => set('dyeColors')(value)}/></div>
                  <div className="admin-dye-row">
                    <span>Mask</span>
                    <button type="button" className="admin-store-upload" onClick={() => maskRef.current?.click()}><Upload size={13}/>{draft.dyeMask ? draft.dyeMask.fileName : editingItem?.dyeable ? 'Replace mask PNG' : 'Mask PNG (optional)'}</button>
                    <input ref={maskRef} type="file" accept="image/png" hidden onChange={(event) => { pickPng('dyeMask', 2)(event.target.files?.[0]); event.target.value = ''; }}/>
                    {editingItem?.dyeable && !draft.dyeMask && <label className="admin-check"><input type="checkbox" checked={draft.dropMask} onChange={set('dropMask')}/><span>No mask (dye everything)</span></label>}
                  </div>
                  {!draft.dyeColors.length && <p className="admin-note">Add at least one colour, or players won’t see a dye picker.</p>}
                </>}
              </section>
            )}

            {editingItem && <CapeOwners item={editingItem} onNotify={onNotify} onChanged={(next) => next && setItems(next)}/>}

            <p className="admin-note">{draft.exclusive ? 'Event item: players can’t buy or claim it. Give it to people below, or make a redeem code in Sales.' : Number(draft.price) > 0 ? `Sold for $${Number(draft.price).toFixed(2)}. Native+ members get it included.` : 'Automatic price (1.99 and up). Native+ members get it included.'}</p>
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

/** Bakes a dye colour into a texture (colour × brightness where the mask is opaque), like the server. */
async function bakeDye(textureUrl, maskUrl, hex) {
  const [texture, mask] = await Promise.all([loadImage(textureUrl), maskUrl ? loadImage(maskUrl) : null]);
  const canvas = document.createElement('canvas');
  canvas.width = texture.naturalWidth;
  canvas.height = texture.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(texture, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let maskData = null;
  if (mask) {
    const m = document.createElement('canvas');
    m.width = canvas.width; m.height = canvas.height;
    const mctx = m.getContext('2d');
    mctx.imageSmoothingEnabled = false;
    mctx.drawImage(mask, 0, 0, canvas.width, canvas.height);
    maskData = mctx.getImageData(0, 0, canvas.width, canvas.height).data;
  }
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const d = pixels.data;
  for (let i = 0; i < d.length; i += 4) {
    if (maskData && !maskData[i + 3]) continue;
    d[i] = Math.floor((d[i] * r) / 255); d[i + 1] = Math.floor((d[i + 1] * g) / 255); d[i + 2] = Math.floor((d[i + 2] * b) / 255);
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas.toDataURL('image/png');
}
