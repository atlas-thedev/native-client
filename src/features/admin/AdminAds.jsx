import React, { useRef, useState } from 'react';
import { ExternalLink, ImagePlus, LoaderCircle, Megaphone, Pause, Pencil, Play, Plus, Save, Trash2, X } from 'lucide-react';
import { AdminSwitch, adminCall, formatDate, fromLocalInput, toLocalInput, useAdminAction, useConfirm } from './adminShared.jsx';

const noButton = () => ({ label: '', action: 'url', value: '' });
const blank = () => ({ title: '', body: '', image: '', buttons: [{ label: 'Open', action: 'url', value: '' }, noButton()], tag: '', player: false, order: 0, startsAt: null, endsAt: null, enabled: true });
const SERVER = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{2,5})?$/i;
const buttonsOfAd = (ad) => (Array.isArray(ad.buttons) && ad.buttons.length ? ad.buttons : ad.cta ? [{ label: ad.cta, action: 'url', value: ad.url }] : []);
const filled = (b) => b.label.trim() || b.value.trim();
const validButton = (b) => b.label.trim() && (b.action === 'server' ? SERVER.test(b.value.trim()) : /^https:\/\//.test(b.value.trim()));
const describe = (b) => `${b.label}: ${b.action === 'server' ? `join ${b.value}` : b.value}`;

const stateOf = (ad, now) => (!ad.enabled ? 'Paused' : ad.startsAt && ad.startsAt > now ? 'Scheduled' : ad.endsAt && ad.endsAt <= now ? 'Ended' : 'Live');
const isHttps = (value) => /^https:\/\//.test(String(value || '').trim());
const validImage = (value) => isHttps(value) || /^\/v1\/site\/ads\/media\/[a-z0-9._-]+$/.test(String(value || ''));
const API = 'https://api.playnative.fun';
const preview = (image) => (String(image || '').startsWith('/') ? `${API}${image}` : image);

const readFile = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});

/** Launcher ads: the small sponsored cards on Home. Banners are 1200×500 (12:5). */
export default function AdminAds({ doc, setDoc, onNotify, onAccessRevoked }) {
  const { busy, error, run } = useAdminAction(onNotify, 'Ads');
  const { armed, ask } = useConfirm();
  const [draft, setDraft] = useState(blank);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);
  const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const ads = doc?.settings?.ads || [];
  const now = Date.now();
  const [editing, setEditing] = useState(null);
  const setButton = (i, key, value) => setDraft((current) => ({ ...current, buttons: current.buttons.map((b, j) => (j === i ? { ...b, [key]: value } : b)) }));
  const buttons = draft.buttons.filter(filled);
  const ready = draft.title.trim().length >= 2 && validImage(draft.image) && buttons.length > 0 && buttons.every(validButton);
  const payload = () => {
    const { buttons: _all, ...rest } = draft;
    return { ...rest, buttons: buttons.map((b) => ({ label: b.label.trim(), action: b.action, value: b.value.trim() })) };
  };
  const edit = (ad) => {
    const list = buttonsOfAd(ad).map((b) => ({ ...b }));
    while (list.length < 2) list.push(noButton());
    setDraft({ ...blank(), ...ad, body: ad.body || '', tag: ad.tag || '', buttons: list });
    setEditing(ad.id);
  };
  const cancel = () => { setEditing(null); setDraft(blank()); };

  const upload = async (file) => {
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) { onNotify?.({ type: 'error', title: 'Ads', message: 'Banners must be under 4 MB.' }); return; }
    setUploading(true);
    try {
      const result = await window.native?.social?.uploadMedia?.(await readFile(file), file.name);
      const link = result?.url || result?.attachment?.url;
      if (!link) throw new Error(result?.error || 'Upload failed.');
      set('image', link);
    } catch (uploadError) {
      onNotify?.({ type: 'error', title: 'Ads', message: uploadError.message || 'Upload failed.' });
    } finally {
      setUploading(false);
    }
  };

  const create = () => run('create', async () => {
    if (editing) setDoc(await adminCall('PATCH', `/site/ads/${encodeURIComponent(editing)}`, payload(), onAccessRevoked));
    else setDoc(await adminCall('POST', '/site/ads', payload(), onAccessRevoked));
    cancel();
  }, editing ? 'Ad saved.' : 'Ad added. Launchers and the in-game menu pick it up within 10 minutes.');
  const patch = (id, body, ok) => run(id, async () => setDoc(await adminCall('PATCH', `/site/ads/${encodeURIComponent(id)}`, body, onAccessRevoked)), ok);
  const remove = (id) => ask(`del:${id}`) && run(`del:${id}`, async () => setDoc(await adminCall('DELETE', `/site/ads/${encodeURIComponent(id)}`, undefined, onAccessRevoked)), 'Ad removed.');

  return (
    <div className="admin-scroll">
      {error && <div className="admin-error" role="alert"><span>{error}</span></div>}
      <div className="admin-overview-grid admin-site-grid">
        <section className="admin-card is-wide">
          <div className="admin-card-head">
            <h3>{editing ? <Pencil size={14} /> : <Plus size={14} />}{editing ? 'Edit ad' : 'New ad'}</h3>
            <span>Shown on the launcher’s Home and the in-game title screen</span>
            <span className="admin-head-spacer" />
            {editing && <button type="button" className="admin-btn ghost" onClick={cancel}><X size={13} />Cancel</button>}
            <button type="button" className="admin-btn primary" disabled={!ready || Boolean(busy)} onClick={create}>
              {busy === 'create' ? <LoaderCircle size={13} className="is-spinning" /> : editing ? <Save size={13} /> : <Plus size={13} />}{editing ? 'Save ad' : 'Add ad'}
            </button>
          </div>
          <div className="admin-form-grid">
            <label className="admin-field"><span>Title</span><input maxLength={60} placeholder="Join the Native Discord" value={draft.title} onChange={(event) => set('title', event.target.value)} /></label>
            <label className="admin-field"><span>Label (optional)</span><input maxLength={20} placeholder="Partner" value={draft.tag} onChange={(event) => set('tag', event.target.value)} /></label>
            <label className="admin-field is-wide"><span>Text (optional)</span><input maxLength={140} placeholder="Events, giveaways and support." value={draft.body} onChange={(event) => set('body', event.target.value)} /></label>
            <label className="admin-field is-wide">
              <span>Banner image (https, 1200×500)</span>
              <span style={{ display: 'flex', gap: 8 }}>
                <input style={{ flex: 1 }} maxLength={500} placeholder="https://…/banner.png" value={draft.image} onChange={(event) => set('image', event.target.value)} />
                <button type="button" className="admin-btn ghost" disabled={uploading} onClick={() => fileRef.current?.click()}>
                  {uploading ? <LoaderCircle size={13} className="is-spinning" /> : <ImagePlus size={13} />}Upload
                </button>
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(event) => { upload(event.target.files?.[0]); event.target.value = ''; }} />
              </span>
            </label>
            {draft.buttons.map((b, i) => (
              <label key={i} className="admin-field is-wide">
                <span>{i === 0 ? 'Main button (also used when the banner is clicked)' : 'Second button (optional)'}</span>
                <span style={{ display: 'flex', gap: 8 }}>
                  <input style={{ width: 130 }} maxLength={20} placeholder={i === 0 ? 'Join' : 'Website'} value={b.label} onChange={(event) => setButton(i, 'label', event.target.value)} />
                  <select style={{ width: 150 }} value={b.action} onChange={(event) => setButton(i, 'action', event.target.value)}>
                    <option value="url">Open a link</option>
                    <option value="server">Join a server</option>
                  </select>
                  <input style={{ flex: 1 }} maxLength={500} placeholder={b.action === 'server' ? 'play.example.net' : 'https://discord.gg/playnative'} value={b.value} onChange={(event) => setButton(i, 'value', event.target.value)} />
                </span>
              </label>
            ))}
            <label className="admin-field"><span>Order</span><input type="number" min={0} max={999} value={draft.order} onChange={(event) => set('order', Number(event.target.value))} /></label>
            <label className="admin-field"><span>Starts (optional)</span><input type="datetime-local" value={toLocalInput(draft.startsAt)} onChange={(event) => set('startsAt', fromLocalInput(event.target.value))} /></label>
            <label className="admin-field"><span>Ends (optional)</span><input type="datetime-local" value={toLocalInput(draft.endsAt)} onChange={(event) => set('endsAt', fromLocalInput(event.target.value))} /></label>
            <AdminSwitch on={draft.enabled} onChange={(v) => set('enabled', v)} label="Enabled" hint="Paused ads never show." />
            <AdminSwitch on={draft.player} onChange={(v) => set('player', v)} label="Show the player’s skin" hint="Draws each user’s own skin, waving, on the right of the banner. Leave that side of the art empty." />
          </div>
          {validImage(draft.image) && (
            <img src={preview(draft.image)} alt="" style={{ marginTop: 12, width: 360, aspectRatio: '12 / 5', objectFit: 'cover', borderRadius: 14, display: 'block' }} />
          )}
        </section>

        <section className="admin-card is-wide">
          <div className="admin-card-head"><h3><Megaphone size={14} />Ads</h3><span>{ads.length ? `${ads.length} total` : ''}</span></div>
          {!doc ? <p className="admin-note"><LoaderCircle size={12} className="is-spinning" /> Loading…</p> : !ads.length ? <p className="admin-note">No ads. Add one above.</p> : (
            <div className="admin-code-list is-tall">
              {[...ads].sort((a, b) => (a.order || 0) - (b.order || 0)).map((ad) => {
                const state = stateOf(ad, now);
                return (
                  <div key={ad.id} className={`admin-code-row${state === 'Ended' ? ' is-done' : ''}`}>
                    <img src={preview(ad.image)} alt="" style={{ width: 96, aspectRatio: '12 / 5', objectFit: 'cover', borderRadius: 8, flex: 'none' }} />
                    <div className="admin-code-main">
                      <strong className="is-plain">{ad.title} <span className={`admin-chip ${state === 'Live' ? 'is-live' : 'is-test'} is-inline`}>{state}</span></strong>
                      <small>
                        #{ad.order || 0}{ad.tag ? ` · ${ad.tag}` : ''}{ad.player ? ' · player skin' : ''} · {buttonsOfAd(ad).map(describe).join(' · ') || ad.url}
                        {' · '}{ad.startsAt ? `from ${formatDate(ad.startsAt)}` : 'now'} → {ad.endsAt ? formatDate(ad.endsAt) : 'no end'}
                      </small>
                    </div>
                    <button type="button" className="admin-icon-btn" title="Edit ad" aria-label="Edit ad" onClick={() => edit(ad)}><Pencil size={13} /></button>
                    <a className="admin-icon-btn" href={ad.url} target="_blank" rel="noreferrer" title="Open link" aria-label="Open link"><ExternalLink size={13} /></a>
                    <button type="button" className="admin-btn ghost" disabled={Boolean(busy)} onClick={() => patch(ad.id, { enabled: !ad.enabled }, ad.enabled ? 'Ad paused.' : 'Ad enabled.')}>
                      {busy === ad.id ? <LoaderCircle size={13} className="is-spinning" /> : ad.enabled ? <Pause size={13} /> : <Play size={13} />}{ad.enabled ? 'Pause' : 'Enable'}
                    </button>
                    <button type="button" className={`admin-icon-btn${armed === `del:${ad.id}` ? ' is-danger' : ''}`} title={armed === `del:${ad.id}` ? 'Click again to delete' : 'Remove ad'} aria-label="Remove ad" onClick={() => remove(ad.id)}>
                      {busy === `del:${ad.id}` ? <LoaderCircle size={13} className="is-spinning" /> : <Trash2 size={13} />}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
