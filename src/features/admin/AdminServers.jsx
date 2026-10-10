import React, { useState } from 'react';
import { Globe, LoaderCircle, Pause, Play, Plus, Server, Trash2 } from 'lucide-react';
import { AdminSwitch, adminCall, formatDate, fromLocalInput, toLocalInput, useAdminAction, useConfirm } from './adminShared.jsx';

const blank = () => ({ name: '', address: '', description: '', tag: '', iconUrl: '', website: '', order: 0, startsAt: null, endsAt: null, enabled: true });

const stateOf = (server, now) => (!server.enabled ? 'Paused' : server.startsAt && server.startsAt > now ? 'Scheduled' : server.endsAt && server.endsAt <= now ? 'Ended' : 'Live');
const validAddress = (value) => /^[a-z0-9.\-_]+(:\d{1,5})?$/.test(String(value || '').trim().toLowerCase());

/** Promoted servers: partner servers pinned to the top of the launcher's server browser. */
export default function AdminServers({ doc, setDoc, onNotify, onAccessRevoked }) {
  const { busy, error, run } = useAdminAction(onNotify, 'Servers');
  const { armed, ask } = useConfirm();
  const [draft, setDraft] = useState(blank);
  const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const servers = doc?.settings?.servers || [];
  const now = Date.now();
  const ready = draft.name.trim().length >= 2 && validAddress(draft.address);

  const create = () => run('create', async () => {
    setDoc(await adminCall('POST', '/site/servers', draft, onAccessRevoked));
    setDraft(blank());
  }, 'Server promoted.');
  const patch = (id, body, ok) => run(id, async () => setDoc(await adminCall('PATCH', `/site/servers/${encodeURIComponent(id)}`, body, onAccessRevoked)), ok);
  const remove = (id) => ask(`del:${id}`) && run(`del:${id}`, async () => setDoc(await adminCall('DELETE', `/site/servers/${encodeURIComponent(id)}`, undefined, onAccessRevoked)), 'Server removed.');

  return (
    <div className="admin-scroll">
      {error && <div className="admin-error" role="alert"><span>{error}</span></div>}
      <div className="admin-overview-grid admin-site-grid">
        <section className="admin-card is-wide">
          <div className="admin-card-head">
            <h3><Plus size={14} />Promote a server</h3>
            <span>Pinned to the top of the launcher’s Servers page</span>
            <span className="admin-head-spacer" />
            <button type="button" className="admin-btn primary" disabled={!ready || Boolean(busy)} onClick={create}>
              {busy === 'create' ? <LoaderCircle size={13} className="is-spinning" /> : <Plus size={13} />}Add server
            </button>
          </div>
          <div className="admin-form-grid">
            <label className="admin-field"><span>Name</span><input maxLength={48} placeholder="Hypixel" value={draft.name} onChange={(event) => set('name', event.target.value)} /></label>
            <label className="admin-field"><span>Address</span><input maxLength={120} placeholder="mc.hypixel.net" value={draft.address} onChange={(event) => set('address', event.target.value)} /></label>
            <label className="admin-field"><span>Badge (optional)</span><input maxLength={24} placeholder="Partner" value={draft.tag} onChange={(event) => set('tag', event.target.value)} /></label>
            <label className="admin-field"><span>Order</span><input type="number" min={0} max={999} value={draft.order} onChange={(event) => set('order', Number(event.target.value))} /></label>
            <label className="admin-field is-wide"><span>Description (optional)</span><input maxLength={160} value={draft.description} onChange={(event) => set('description', event.target.value)} /></label>
            <label className="admin-field"><span>Icon URL (optional, https)</span><input maxLength={300} placeholder="https://…/icon.png" value={draft.iconUrl} onChange={(event) => set('iconUrl', event.target.value)} /></label>
            <label className="admin-field"><span>Website (optional, https)</span><input maxLength={300} placeholder="https://…" value={draft.website} onChange={(event) => set('website', event.target.value)} /></label>
            <label className="admin-field"><span>Starts (optional)</span><input type="datetime-local" value={toLocalInput(draft.startsAt)} onChange={(event) => set('startsAt', fromLocalInput(event.target.value))} /></label>
            <label className="admin-field"><span>Ends (optional)</span><input type="datetime-local" value={toLocalInput(draft.endsAt)} onChange={(event) => set('endsAt', fromLocalInput(event.target.value))} /></label>
            <AdminSwitch on={draft.enabled} onChange={(v) => set('enabled', v)} label="Enabled" hint="Paused servers never show." />
          </div>
          {draft.address && !validAddress(draft.address) && <p className="admin-note">That address doesn’t look valid. Use <code>host</code> or <code>host:port</code>.</p>}
        </section>

        <section className="admin-card is-wide">
          <div className="admin-card-head"><h3><Server size={14} />Promoted servers</h3><span>{servers.length ? `${servers.length} total` : ''}</span></div>
          {!doc ? <p className="admin-note"><LoaderCircle size={12} className="is-spinning" /> Loading…</p> : !servers.length ? <p className="admin-note">No promoted servers yet. Add one above.</p> : (
            <div className="admin-code-list is-tall">
              {[...servers].sort((a, b) => (a.order || 0) - (b.order || 0)).map((server) => {
                const state = stateOf(server, now);
                return (
                  <div key={server.id} className={`admin-code-row${state === 'Ended' ? ' is-done' : ''}`}>
                    <span className="admin-offer-pct">#{server.order || 0}</span>
                    <div className="admin-code-main">
                      <strong className="is-plain">{server.name} <span className={`admin-chip ${state === 'Live' ? 'is-live' : 'is-test'} is-inline`}>{state}</span></strong>
                      <small>
                        {server.address}
                        {server.tag ? ` · ${server.tag}` : ''}
                        {' · '}{server.startsAt ? `from ${formatDate(server.startsAt)}` : 'now'} → {server.endsAt ? formatDate(server.endsAt) : 'no end'}
                      </small>
                    </div>
                    {server.website && (
                      <a className="admin-icon-btn" href={server.website} target="_blank" rel="noreferrer" title="Open website" aria-label="Open website"><Globe size={13} /></a>
                    )}
                    <button type="button" className="admin-btn ghost" disabled={Boolean(busy)} onClick={() => patch(server.id, { enabled: !server.enabled }, server.enabled ? 'Server paused.' : 'Server enabled.')}>
                      {busy === server.id ? <LoaderCircle size={13} className="is-spinning" /> : server.enabled ? <Pause size={13} /> : <Play size={13} />}{server.enabled ? 'Pause' : 'Enable'}
                    </button>
                    <button type="button" className={`admin-icon-btn${armed === `del:${server.id}` ? ' is-danger' : ''}`} title={armed === `del:${server.id}` ? 'Click again to delete' : 'Remove server'} aria-label="Remove server" onClick={() => remove(server.id)}>
                      {busy === `del:${server.id}` ? <LoaderCircle size={13} className="is-spinning" /> : <Trash2 size={13} />}
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
