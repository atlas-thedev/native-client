import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Globe, Handshake, LoaderCircle, Pause, Play, Plus, RotateCcw, Save, Trash2, X } from 'lucide-react';
import PartnerCard, { PARTNER_ANIMATIONS, artSrc } from '../partners/PartnerCard.jsx';
import { AdminColor, AdminDateTime, AdminSegmented, AdminSlider, AdminSwitch, adminCall, formatDate, useAdminAction, useConfirm } from './adminShared.jsx';
import './AdminPartners.css';

const BUNDLED = '/v1/site/partners/media/';
const blank = () => ({
  name: '', tagline: '', description: '', website: '', cta: 'Visit',
  logo: '', background: '', art: '',
  accent: '#8b5cf6', accent2: '#c07eff',
  animation: 'aurora', speed: 1, intensity: 70,
  perks: [], code: '', tier: 'partner', order: 0,
  startsAt: null, endsAt: null, enabled: true
});
const FIELDS = Object.keys(blank());
const pick = (pt) => Object.fromEntries(FIELDS.map((key) => [key, pt?.[key] ?? blank()[key]]));

/* Colour pairs that look good on the dark launcher. */
const PALETTES = [
  ['#8b5cf6', '#c07eff'], ['#3d8bff', '#22d3ee'], ['#22c55e', '#a3e635'], ['#f97316', '#facc15'],
  ['#ef4444', '#f472b6'], ['#ec4899', '#a855f7'], ['#14b8a6', '#60a5fa'], ['#ffffff', '#a1a1aa']
];

const stateOf = (pt, now) => (!pt.enabled ? 'Paused' : pt.startsAt && pt.startsAt > now ? 'Scheduled' : pt.endsAt && pt.endsAt <= now ? 'Ended' : 'Live');
const httpsOrBundled = (value) => !value || /^https:\/\//.test(value) || value.startsWith(BUNDLED);

function ImageField({ label, value, onChange, placeholder, required }) {
  const bad = value && !httpsOrBundled(value);
  return (
    <label className={`admin-field${bad ? ' has-error' : ''}`}>
      <span>{label}{required ? '' : ' (optional)'}</span>
      <div className="apt-image-input">
        <i style={value && !bad ? { backgroundImage: `url("${artSrc(value)}")` } : undefined} />
        <input value={value} maxLength={500} placeholder={placeholder} spellCheck={false} onChange={(event) => onChange(event.target.value.trim())} />
        {value && <button type="button" aria-label={`Clear ${label}`} onClick={() => onChange('')}><X size={12} /></button>}
      </div>
    </label>
  );
}

function PerksInput({ value, onChange }) {
  const [text, setText] = useState('');
  const add = () => {
    const perk = text.trim().slice(0, 40);
    if (perk && !value.includes(perk) && value.length < 6) onChange([...value, perk]);
    setText('');
  };
  return (
    <div className="apt-perks">
      {value.map((perk) => (
        <span key={perk} className="apt-perk">{perk}<button type="button" aria-label={`Remove ${perk}`} onClick={() => onChange(value.filter((item) => item !== perk))}><X size={11} /></button></span>
      ))}
      {value.length < 6 && (
        <input
          value={text}
          maxLength={40}
          placeholder={value.length ? 'Add another…' : 'Type a perk, press Enter'}
          onChange={(event) => setText(event.target.value)}
          onBlur={add}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); add(); }
            else if (event.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
          }}
        />
      )}
    </div>
  );
}

/** Partners: brands on the website and the launcher's Partners page, each with its own motion card. */
export default function AdminPartners({ doc, setDoc, onNotify, onAccessRevoked }) {
  const { busy, error, setError, run } = useAdminAction(onNotify, 'Partners');
  const { armed, ask } = useConfirm();
  const partners = useMemo(() => [...(doc?.settings?.partners || [])].sort((a, b) => (a.order || 0) - (b.order || 0) || (a.createdAt || 0) - (b.createdAt || 0)), [doc]);
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(blank);
  const [replay, setReplay] = useState(0);
  const nextNew = useRef(null);
  const selected = partners.find((pt) => pt.id === selectedId) || null;
  const now = Date.now();

  // Pick the first partner once the list arrives; keep the draft in step with the server copy.
  useEffect(() => {
    if (selectedId === null && partners.length) setSelectedId(partners[0].id);
  }, [partners, selectedId]);
  useEffect(() => {
    if (selected) setDraft(pick(selected));
    else if (selectedId === 'new') { setDraft(nextNew.current || blank()); nextNew.current = null; }
  }, [selectedId, selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const dirty = selectedId === 'new' || (selected && JSON.stringify(pick(selected)) !== JSON.stringify(draft));
  const problems = [
    draft.name.trim().length < 2 && 'a name',
    !/^https:\/\//.test(draft.website) && 'an https:// website',
    (!draft.logo || !httpsOrBundled(draft.logo)) && 'a logo link',
    (!httpsOrBundled(draft.background) || !httpsOrBundled(draft.art)) && 'https:// image links'
  ].filter(Boolean);

  const save = () => run('save', async () => {
    if (selectedId === 'new') {
      const result = await adminCall('POST', '/site/partners', draft, onAccessRevoked);
      setDoc(result);
      const added = (result.settings?.partners || []).at(-1);
      if (added) setSelectedId(added.id);
    } else {
      setDoc(await adminCall('PATCH', `/site/partners/${encodeURIComponent(selectedId)}`, draft, onAccessRevoked));
    }
  }, selectedId === 'new' ? 'Partner added.' : 'Partner saved.');
  const patch = (id, body, ok) => run(id, async () => setDoc(await adminCall('PATCH', `/site/partners/${encodeURIComponent(id)}`, body, onAccessRevoked)), ok);
  const remove = (id) => ask(`del:${id}`) && run(`del:${id}`, async () => {
    setDoc(await adminCall('DELETE', `/site/partners/${encodeURIComponent(id)}`, undefined, onAccessRevoked));
    setSelectedId(null);
  }, 'Partner removed.');
  // Swap order with the neighbour (orders are re-numbered so ties never stick).
  const move = (index, delta) => run(`move:${index}`, async () => {
    const list = partners.map((pt, i) => ({ id: pt.id, order: i }));
    const other = index + delta;
    if (other < 0 || other >= list.length) return;
    [list[index].order, list[other].order] = [list[other].order, list[index].order];
    let result = null;
    for (const entry of list) {
      const current = partners.find((pt) => pt.id === entry.id);
      if ((current.order || 0) !== entry.order) result = await adminCall('PATCH', `/site/partners/${encodeURIComponent(entry.id)}`, { order: entry.order }, onAccessRevoked);
    }
    if (result) setDoc(result);
  });
  const startNew = () => { setError(''); setSelectedId('new'); setDraft(blank()); };
  const duplicate = () => { nextNew.current = { ...draft, name: `${draft.name} copy`.slice(0, 48), enabled: false }; setError(''); setSelectedId('new'); };

  return (
    <div className="admin-scroll apt">
      {error && <div className="admin-error" role="alert"><span>{error}</span></div>}

      <div className="apt-layout">
        <aside className="admin-card apt-list">
          <div className="admin-card-head">
            <h3><Handshake size={14} />Partners</h3>
            <span>{partners.filter((pt) => stateOf(pt, now) === 'Live').length} live</span>
            <span className="admin-head-spacer" />
            <button type="button" className="admin-btn primary" onClick={startNew}><Plus size={13} />New</button>
          </div>
          {!doc ? <p className="admin-note"><LoaderCircle size={12} className="is-spinning" /> Loading…</p> : (
            <div className="apt-rows">
              {selectedId === 'new' && (
                <button type="button" className="apt-row is-selected" style={{ '--pt-accent': draft.accent }}>
                  <span className="apt-row-logo"><Plus size={14} /></span>
                  <span className="apt-row-main"><strong>{draft.name || 'New partner'}</strong><small>Not saved yet</small></span>
                </button>
              )}
              {partners.map((pt, index) => {
                const state = stateOf(pt, now);
                const logo = artSrc(pt.logo);
                return (
                  <div key={pt.id} className={`apt-row${pt.id === selectedId ? ' is-selected' : ''}${state === 'Live' ? '' : ' is-muted'}`} style={{ '--pt-accent': pt.accent || '#fff' }}>
                    <button type="button" className="apt-row-hit" onClick={() => { setError(''); setSelectedId(pt.id); }} aria-label={`Edit ${pt.name}`} />
                    <span className="apt-row-logo">{logo ? <img src={logo} alt="" /> : <Handshake size={14} />}</span>
                    <span className="apt-row-main">
                      <strong>{pt.name}</strong>
                      <small><i className={`apt-dot is-${state.toLowerCase()}`} />{state} · {PARTNER_ANIMATIONS.find(([id]) => id === pt.animation)?.[1] || 'Aurora'}{pt.tier === 'featured' ? ' · Featured' : ''}</small>
                    </span>
                    <span className="apt-row-tools">
                      <button type="button" disabled={Boolean(busy) || index === 0} onClick={() => move(index, -1)} aria-label="Move up"><ArrowUp size={12} /></button>
                      <button type="button" disabled={Boolean(busy) || index === partners.length - 1} onClick={() => move(index, 1)} aria-label="Move down"><ArrowDown size={12} /></button>
                    </span>
                  </div>
                );
              })}
              {!partners.length && selectedId !== 'new' && <p className="admin-note">No partners yet. Add the first one.</p>}
            </div>
          )}
          <p className="admin-note">Shown on playnative.net (home page + /partners) and in the launcher’s Partners page. Order here is the order everywhere.</p>
        </aside>

        {selectedId ? (
          <div className="apt-editor">
            <section className="apt-stage">
              <div className="apt-stage-head">
                <span><i className="apt-live-dot" />Live preview</span>
                <AdminSegmented value={draft.tier} onChange={(value) => set('tier', value)} ariaLabel="Card size" options={[['featured', 'Featured'], ['partner', 'Partner'], ['sponsor', 'Sponsor']]} />
                <button type="button" className="admin-btn ghost" onClick={() => setReplay((n) => n + 1)} title="Replay the animation"><RotateCcw size={13} />Replay</button>
              </div>
              <div className={`apt-stage-canvas is-${draft.tier === 'featured' ? 'hero' : 'tile'}`} key={replay}>
                <div className="pt-enter"><PartnerCard partner={draft} size={draft.tier === 'featured' ? 'hero' : 'tile'} preview /></div>
              </div>
            </section>

            <section className="admin-card">
              <div className="admin-card-head"><h3>Motion</h3><span>How the card moves</span></div>
              <div className="apt-motions" role="radiogroup" aria-label="Animation">
                {PARTNER_ANIMATIONS.map(([id, label, hint]) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={draft.animation === id}
                    className={`apt-motion${draft.animation === id ? ' is-on' : ''}`}
                    style={{ '--pt-accent': draft.accent, '--pt-accent2': draft.accent2, '--pt-speed': draft.speed, '--pt-intensity': draft.intensity / 100, '--pt-dur': `calc(1s / ${draft.speed || 1})` }}
                    onClick={() => set('animation', id)}
                    title={hint}
                  >
                    <span className={`apt-motion-swatch pt-card pt-anim-${id}`}>
                      {id !== 'none' && <span className={`pt-motion pt-motion-${id}`}>
                        {id === 'aurora' && <><i /><i /><i /></>}
                        {id === 'orbit' && <><i /><i /><b /><b /><b /></>}
                        {id === 'glitch' && <><i /><i /></>}
                        {id === 'float' && Array.from({ length: 8 }, (_, n) => <i key={n} style={{ '--n': n * 1.7 }} />)}
                        {id === 'shine' && <i />}
                        {id === 'pulse' && <><i /><i /><i /></>}
                        {id === 'grid' && <><i /><b /></>}
                      </span>}
                    </span>
                    <strong>{label}</strong>
                  </button>
                ))}
              </div>
              <div className="admin-form-grid">
                <div className="admin-field"><span>Speed · {Number(draft.speed).toFixed(2)}×</span><AdminSlider min={0.25} max={3} step={0.05} value={draft.speed} onChange={(value) => set('speed', value)} ariaLabel="Animation speed" /></div>
                <div className="admin-field"><span>Intensity · {draft.intensity}%</span><AdminSlider min={0} max={100} value={draft.intensity} onChange={(value) => set('intensity', value)} ariaLabel="Animation intensity" /></div>
              </div>
              <div className="apt-colours">
                <div className="admin-field"><span>Accent</span><AdminColor value={draft.accent} onChange={(value) => set('accent', value)} /></div>
                <div className="admin-field"><span>Glow</span><AdminColor value={draft.accent2} onChange={(value) => set('accent2', value)} /></div>
                <div className="admin-field apt-palettes"><span>Presets</span>
                  <div>
                    {PALETTES.map(([a, b]) => (
                      <button key={a + b} type="button" aria-label={`${a} and ${b}`} className={draft.accent === a && draft.accent2 === b ? 'is-on' : ''} style={{ background: `linear-gradient(135deg, ${a}, ${b})` }} onClick={() => setDraft((current) => ({ ...current, accent: a, accent2: b }))} />
                    ))}
                  </div>
                </div>
              </div>
            </section>

            <section className="admin-card">
              <div className="admin-card-head"><h3>Details</h3><span>Name, copy and link</span></div>
              <div className="admin-form-grid">
                <label className="admin-field"><span>Name</span><input maxLength={48} placeholder="Aurex Hosting" value={draft.name} onChange={(event) => set('name', event.target.value)} /></label>
                <label className="admin-field"><span>Website (https)</span><input maxLength={300} placeholder="https://…" value={draft.website} onChange={(event) => set('website', event.target.value.trim())} /></label>
                <label className="admin-field is-wide"><span>Tagline</span><input maxLength={90} placeholder="One line people remember" value={draft.tagline} onChange={(event) => set('tagline', event.target.value)} /></label>
                <label className="admin-field is-wide"><span>Description (featured cards)</span><textarea rows={3} maxLength={500} value={draft.description} onChange={(event) => set('description', event.target.value)} /></label>
                <label className="admin-field"><span>Button label</span><input maxLength={24} placeholder="Visit" value={draft.cta} onChange={(event) => set('cta', event.target.value)} /></label>
                <label className="admin-field"><span>Discount code (optional)</span><input maxLength={24} placeholder="NATIVE10" value={draft.code} onChange={(event) => set('code', event.target.value.toUpperCase())} /></label>
                <div className="admin-field is-wide"><span>Perks (up to 6)</span><PerksInput value={draft.perks} onChange={(value) => set('perks', value)} /></div>
              </div>
            </section>

            <section className="admin-card">
              <div className="admin-card-head"><h3>Artwork</h3><span>https:// links (PNG, WebP, JPG or GIF)</span></div>
              <div className="admin-form-grid">
                <ImageField label="Logo" required value={draft.logo} onChange={(value) => set('logo', value)} placeholder="https://…/logo.png" />
                <ImageField label="Background" value={draft.background} onChange={(value) => set('background', value)} placeholder="https://…/banner.webp" />
                <ImageField label="Floating art" value={draft.art} onChange={(value) => set('art', value)} placeholder="https://…/render.png" />
              </div>
            </section>

            <section className="admin-card">
              <div className="admin-card-head"><h3>Schedule</h3><span>{selected ? `Added ${formatDate(selected.createdAt, 'with the launch')}` : 'New partner'}</span></div>
              <div className="admin-form-grid">
                <div className="admin-field"><span>Starts</span><AdminDateTime value={draft.startsAt} onChange={(value) => set('startsAt', value)} placeholder="Right away" /></div>
                <div className="admin-field"><span>Ends</span><AdminDateTime value={draft.endsAt} onChange={(value) => set('endsAt', value)} placeholder="No end" /></div>
                <AdminSwitch on={draft.enabled} onChange={(value) => set('enabled', value)} label="Enabled" hint="Paused partners are hidden everywhere." />
              </div>
            </section>

            <div className="apt-savebar">
              <span>{problems.length ? `Needs ${problems.join(', ')}.` : dirty ? 'Unsaved changes' : 'All changes saved'}</span>
              {selected && (
                <>
                  <a className="admin-icon-btn" href={selected.website} target="_blank" rel="noreferrer" title="Open website" aria-label="Open website"><Globe size={13} /></a>
                  <button type="button" className="admin-icon-btn" onClick={duplicate} title="Duplicate" aria-label="Duplicate"><Copy size={13} /></button>
                  <button type="button" className="admin-btn ghost" disabled={Boolean(busy)} onClick={() => patch(selected.id, { enabled: !selected.enabled }, selected.enabled ? 'Partner paused.' : 'Partner enabled.')}>
                    {busy === selected.id ? <LoaderCircle size={13} className="is-spinning" /> : selected.enabled ? <Pause size={13} /> : <Play size={13} />}{selected.enabled ? 'Pause' : 'Enable'}
                  </button>
                  <button type="button" className={`admin-btn ${armed === `del:${selected.id}` ? 'is-confirm' : 'danger'}`} disabled={Boolean(busy)} onClick={() => remove(selected.id)}>
                    {busy === `del:${selected.id}` ? <LoaderCircle size={13} className="is-spinning" /> : <Trash2 size={13} />}{armed === `del:${selected.id}` ? 'Click to confirm' : 'Delete'}
                  </button>
                  <button type="button" className="admin-btn ghost" disabled={!dirty || Boolean(busy)} onClick={() => setDraft(pick(selected))}><RotateCcw size={13} />Revert</button>
                </>
              )}
              {selectedId === 'new' && <button type="button" className="admin-btn ghost" onClick={() => setSelectedId(partners[0]?.id || null)}>Cancel</button>}
              <button type="button" className="admin-btn primary" disabled={!dirty || problems.length > 0 || Boolean(busy)} onClick={save}>
                {busy === 'save' ? <LoaderCircle size={13} className="is-spinning" /> : <Save size={13} />}{selectedId === 'new' ? 'Add partner' : 'Save'}
              </button>
            </div>
          </div>
        ) : (
          <section className="admin-card apt-empty">
            <Handshake size={22} />
            <h3>Pick a partner</h3>
            <p>Or create a new one: choose a motion, colours and art, and watch the live preview as you go.</p>
            <button type="button" className="admin-btn primary" onClick={startNew}><Plus size={13} />New partner</button>
          </section>
        )}
      </div>
    </div>
  );
}
