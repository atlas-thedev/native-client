import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DollarSign, FolderUp, LoaderCircle, PackagePlus, Sparkles, X } from 'lucide-react';
import Dropdown from '../../components/ui/Dropdown.jsx';
import SkinViewer3D, { prepareSkinSource } from '../../components/ui/SkinViewer3D.jsx';
import { wornShot } from '../../lib/wornShot.jsx';
import steveSkin from '../../assets/steve.png';
import { AdminSwitch, adminCall, usd } from './adminShared.jsx';

const PREVIEW_ACCOUNT = { id: 'admin-import-preview', type: 'offline', name: 'Steve', skinUrl: steveSkin, model: 'default', hasCape: false, capeUrl: null };
const SLOTS = [
  { value: 'hats', label: 'Headwear' },
  { value: 'glasses', label: 'Glasses' },
  { value: 'back', label: 'Wings & Backpacks' },
  { value: 'shoes', label: 'Shoes' },
  { value: 'hand', label: 'In hand' }
];
const SIDES = [{ value: 'right', label: 'Right hand' }, { value: 'left', label: 'Left hand' }];

const toDataUrl = (bytes, type = 'image/png') => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(new Error('Could not read that file.'));
  reader.readAsDataURL(new Blob([bytes], { type }));
});

function Modal({ title, icon, onClose, children, wide = false }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="admin-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`admin-modal${wide ? ' is-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="admin-modal-head"><h2>{icon}{title}</h2><button type="button" className="admin-icon-btn" aria-label="Close" onClick={onClose}><X size={14} /></button></header>
        <div className="admin-modal-body">{children}</div>
      </div>
    </div>
  );
}

/** Set every buyable item to one price, or back to automatic prices. */
export function PricingModal({ onClose, onDone, onNotify, onAccessRevoked }) {
  const [price, setPrice] = useState('1.99');
  const [busy, setBusy] = useState('');
  const [armed, setArmed] = useState('');
  const [error, setError] = useState('');
  const apply = async (key, value, ok) => {
    if (armed !== key) { setArmed(key); return; }
    setArmed('');
    setBusy(key);
    setError('');
    try {
      const result = await adminCall('POST', '/site/prices', { price: value }, onAccessRevoked);
      onNotify?.('Store', `${ok}${result.changed != null ? ` (${result.changed} changed)` : ''}`);
      await onDone?.();
      onClose();
    } catch (reason) { setError(reason.message); }
    finally { setBusy(''); }
  };
  const value = Number(price);
  const valid = Number.isFinite(value) && value >= 1.99 && value <= 99.99;
  return (
    <Modal title="Pricing" icon={<DollarSign size={15} />} onClose={onClose}>
      <p className="admin-note">Nothing is free: event-only items are given, never sold. New uploads get an automatic price and offers discount on top.</p>
      {error && <div className="admin-error" role="alert"><span>{error}</span></div>}
      <label className="admin-field"><span>Price (USD)</span><input type="number" min={1.99} max={99.99} step={0.01} value={price} onChange={(event) => setPrice(event.target.value)} /></label>
      <div className="admin-row-actions">
        <button type="button" className={`admin-btn primary${armed === 'set' ? ' is-confirm' : ''}`} disabled={!valid || Boolean(busy)} onClick={() => apply('set', value, `Prices updated to ${usd(value)}.`)}>
          {busy === 'set' ? <LoaderCircle size={13} className="is-spinning" /> : <DollarSign size={13} />}{armed === 'set' ? 'Click again to confirm' : `Set everything to ${usd(value)}`}
        </button>
        <button type="button" className={`admin-btn ghost${armed === 'auto' ? ' is-confirm' : ''}`} disabled={Boolean(busy)} onClick={() => apply('auto', 0, 'Every item now has its automatic price.')}>
          {busy === 'auto' ? <LoaderCircle size={13} className="is-spinning" /> : <Sparkles size={13} />}{armed === 'auto' ? 'Click again to confirm' : 'Automatic prices'}
        </button>
      </div>
      <p className="admin-note">Automatic: cloaks 1.99 static, up to 2.99 animated. Cosmetics 1.99 and up with motion, size and detail.</p>
    </Modal>
  );
}

/** Drop an ItemsAdder / Nexo / Oraxen / ModelEngine / HMCCosmetics pack: preview its cosmetics in 3D and import the ones you pick. */
export function ImportPackModal({ onClose, onImported, onNotify }) {
  const lib = useRef(null);
  const files = useRef(null);
  const [found, setFound] = useState([]);
  const [opts, setOpts] = useState({});
  const [notes, setNotes] = useState([]);
  const [selected, setSelected] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState('');
  const [publish, setPublish] = useState(false);
  const setOpt = (id, patch) => setOpts((current) => ({ ...current, [id]: { ...current[id], ...patch } }));

  const read = async (file) => {
    if (!file || busy) return;
    setBusy('read'); setError(''); setFound([]); setPreview(null); setSelected(null); setNotes([]);
    try {
      lib.current ||= await import('../../lib/ncmImport.js');
      files.current = await lib.current.readZip(await file.arrayBuffer());
      const result = lib.current.discover(files.current);
      setFound(result.entries || []);
      setNotes(result.notes || []);
      setOpts(Object.fromEntries((result.entries || []).map((entry) => [entry.id, { on: true, name: entry.name, slot: entry.slot, side: entry.side || 'right', scale: '1', ox: '0', oy: '0', oz: '0', dye: entry.color || '#ffffff' }])));
      if (!result.entries?.length) throw new Error('No cosmetics found in that pack.');
      setSelected(result.entries[0].id);
    } catch (reason) { setError(reason?.message || 'Could not read that pack.'); }
    finally { setBusy(''); }
  };

  const optionsFor = (id) => {
    const o = opts[id];
    return { slot: o.slot, side: o.side, scale: Number(o.scale) || 1, offset: [Number(o.ox) || 0, Number(o.oy) || 0, Number(o.oz) || 0] };
  };
  const convert = (id) => lib.current.convert(files.current, found.find((entry) => entry.id === id), optionsFor(id));

  const o = selected ? opts[selected] : null;
  const key = selected && o ? `${selected}|${o.slot}|${o.side}|${o.scale}|${o.ox}|${o.oy}|${o.oz}|${o.dye}` : '';
  useEffect(() => {
    if (!selected || !files.current || !lib.current) return undefined;
    let dead = false;
    const timer = setTimeout(async () => {
      try {
        const result = await convert(selected);
        const shown = result.mask ? await lib.current.bakeDye(result.png, result.mask, opts[selected]?.dye || '#ffffff') : result.png;
        const texture = await toDataUrl(shown);
        if (dead) return;
        setError('');
        setPreview({ model: result.model, texture, dyeable: Boolean(result.mask), info: `${result.info.parts} parts · ${result.info.cubes} cubes · ${result.info.size[0]}×${result.info.size[1]} texture${result.mask ? ' · dyeable' : ''}` });
      } catch (reason) { if (!dead) { setPreview(null); setError(reason?.message || String(reason)); } }
    }, 250);
    return () => { dead = true; clearTimeout(timer); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const worn = useMemo(() => (preview && selected && o ? [{ id: `import:${selected}`, slot: o.slot, model: preview.model, texture: preview.texture, ...(o.slot === 'hand' ? { side: o.side } : {}) }] : []), [preview, selected, o]);

  const importAll = async () => {
    const chosen = found.filter((entry) => opts[entry.id]?.on);
    if (!chosen.length) { setError('Tick at least one cosmetic.'); return; }
    setBusy('import'); setError('');
    let last = null;
    try {
      for (const [index, entry] of chosen.entries()) {
        setProgress(`${index + 1}/${chosen.length} · ${opts[entry.id].name || entry.name}`);
        const result = await convert(entry.id);
        const dyeHex = opts[entry.id].dye || '#ffffff';
        const shown = result.mask ? await lib.current.bakeDye(result.png, result.mask, dyeHex) : result.png;
        const shownUrl = await toDataUrl(shown);
        const slot = opts[entry.id].slot;
        const asset = { id: `import:${entry.id}`, slot, model: result.model, texture: shownUrl, ...(slot === 'hand' ? { side: opts[entry.id].side } : {}) };
        const thumb = await wornShot({ item: { id: `import-${entry.id}-${Date.now()}`, slot }, asset, skinUrl: steveSkin, model: 'default', prepare: prepareSkinSource }).catch(() => null);
        const response = await window.native?.admin?.storeCreate?.({
          kind: 'cosmetic', slot, name: (opts[entry.id].name || entry.name).trim().slice(0, 40), description: '', tags: '',
          featured: false, hidden: !publish, exclusive: false,
          model: JSON.stringify(result.model), texture: await toDataUrl(result.png),
          ...(thumb && /^data:image\/png/.test(thumb) ? { thumb } : {}),
          ...(result.mask ? { dyeable: true, dyeMask: await toDataUrl(result.mask), dyeDefault: dyeHex } : {})
        });
        if (!response?.ok) throw new Error(`${entry.name}: ${response?.error || 'could not be imported.'}`);
        last = response.items || last;
      }
      onNotify?.('Store', `Imported ${chosen.length} cosmetic${chosen.length === 1 ? '' : 's'}. ${publish ? 'They’re live in the Store.' : 'They’re hidden drafts: unhide them when ready.'}`);
      await onImported?.(last);
      onClose();
    } catch (reason) { setError(reason?.message || 'Import failed.'); await onImported?.(last); }
    finally { setBusy(''); setProgress(''); }
  };

  const chosenCount = found.filter((entry) => opts[entry.id]?.on).length;
  return (
    <Modal title="Import a plugin pack" icon={<PackagePlus size={15} />} onClose={() => { if (busy !== 'import') onClose(); }} wide>
      <p className="admin-note">Drop an ItemsAdder, Nexo, Oraxen, ModelEngine or HMCCosmetics pack (.zip). Native finds the cosmetics, converts their models and textures and shows them here before anything is added.</p>
      <label className={`admin-import-drop${busy === 'read' ? ' is-busy' : ''}`}>
        {busy === 'read' ? <LoaderCircle size={15} className="is-spinning" /> : <FolderUp size={15} />}
        <span>{busy === 'read' ? 'Reading the pack…' : found.length ? `${found.length} cosmetics found. Pick another pack to replace` : 'Choose a pack .zip'}</span>
        <input type="file" accept=".zip,application/zip" onChange={(event) => { read(event.target.files?.[0] || null); event.target.value = ''; }} />
      </label>
      {notes.length > 0 && <ul className="admin-import-notes">{notes.map((note) => <li key={note}>{note}</li>)}</ul>}
      {error && <div className="admin-error" role="alert"><span>{error}</span></div>}
      {found.length > 0 && (
        <div className="admin-import-body">
          <div className="admin-import-list">
            {found.map((entry) => {
              const v = opts[entry.id];
              if (!v) return null;
              return (
                <div key={entry.id} className={`admin-import-row${selected === entry.id ? ' is-selected' : ''}`} onClick={() => setSelected(entry.id)}>
                  <input type="checkbox" checked={v.on} onChange={(event) => setOpt(entry.id, { on: event.target.checked })} onClick={(event) => event.stopPropagation()} aria-label={`Import ${v.name}`} />
                  <input className="admin-import-name" value={v.name} maxLength={40} onChange={(event) => setOpt(entry.id, { name: event.target.value })} onClick={(event) => event.stopPropagation()} />
                  <div onClick={(event) => event.stopPropagation()}><Dropdown className="admin-dropdown" value={v.slot} onChange={(slot) => setOpt(entry.id, { slot })} options={SLOTS} /></div>
                </div>
              );
            })}
          </div>
          <div className="admin-import-preview">
            <div className="admin-cos-stage">
              {worn.length ? <SkinViewer3D key={key} account={PREVIEW_ACCOUNT} cosmetics={worn} zoom={0.74} width={300} height={300} animation="idle" autoRotate /> : <div className="admin-loading"><LoaderCircle size={16} className="is-spinning" /><span>Converting…</span></div>}
            </div>
            <p className="admin-note">{preview?.info || ''}</p>
            {selected && o && (
              <div className="admin-field-row is-four">
                <label className="admin-field"><span>Scale</span><input type="number" step={0.05} min={0.1} value={o.scale} onChange={(event) => setOpt(selected, { scale: event.target.value })} /></label>
                <label className="admin-field"><span>Offset X</span><input type="number" step={0.5} value={o.ox} onChange={(event) => setOpt(selected, { ox: event.target.value })} /></label>
                <label className="admin-field"><span>Offset Y</span><input type="number" step={0.5} value={o.oy} onChange={(event) => setOpt(selected, { oy: event.target.value })} /></label>
                <label className="admin-field"><span>Offset Z</span><input type="number" step={0.5} value={o.oz} onChange={(event) => setOpt(selected, { oz: event.target.value })} /></label>
                {preview?.dyeable && <label className="admin-field"><span>Default dye</span><input type="color" className="admin-color" value={o.dye} onChange={(event) => setOpt(selected, { dye: event.target.value })} /></label>}
                {o.slot === 'hand' && <label className="admin-field"><span>Side</span><Dropdown className="admin-dropdown" value={o.side} onChange={(side) => setOpt(selected, { side })} options={SIDES} /></label>}
              </div>
            )}
          </div>
        </div>
      )}
      <div className="admin-modal-foot">
        <AdminSwitch on={publish} onChange={setPublish} label="Publish immediately" hint="Otherwise they’re imported as hidden drafts." />
        <button type="button" className="admin-btn primary" disabled={!chosenCount || Boolean(busy)} onClick={importAll}>
          {busy === 'import' ? <LoaderCircle size={13} className="is-spinning" /> : <PackagePlus size={13} />}{busy === 'import' ? `Importing ${progress}` : `Import ${chosenCount || ''} selected`}
        </button>
      </div>
    </Modal>
  );
}
