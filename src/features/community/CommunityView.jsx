import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Crown, Loader2, Lock, RefreshCw, ShieldCheck, ShoppingBag, Sparkles, Trophy, Vote } from 'lucide-react';
import { CapeThumb } from '../admin/AdminStore.jsx';
import { WornShot } from '../../lib/wornShot.jsx';
import { prepareSkinSource } from '../../components/ui/SkinViewer3D.jsx';
import steveSkin from '../../assets/steve.png';
import './CommunityView.css';

const pct = (n, total) => (n == null || !total ? 0 : Math.round((n / total) * 100));
const plural = (n, one, many) => `${Number(n || 0).toLocaleString()} ${n === 1 ? one : many}`;
const KIND = { cosmetic: 'Cosmetic', cape: 'Cloak', feature: 'Feature', other: 'Community' };

/* ── art ─────────────────────────────────────────────────────────── */

const assetJobs = new Map();
function useCosmetic(item) {
  const key = item?.kind === 'cosmetic' && item.modelUrl && item.textureUrl ? `${item.modelUrl}|${item.textureUrl}` : null;
  const [asset, setAsset] = useState(null);
  useEffect(() => {
    if (!key) { setAsset(null); return undefined; }
    let alive = true;
    if (!assetJobs.has(key)) {
      const job = (window.native?.community?.cosmetic?.({ id: item.id, slot: item.slot, modelUrl: item.modelUrl, textureUrl: item.textureUrl, stillUrl: item.stillUrl }) || Promise.resolve(null))
        .then((r) => (r?.ok ? r : null)).catch(() => null);
      job.then((v) => { if (!v) assetJobs.delete(key); });
      assetJobs.set(key, job);
    }
    assetJobs.get(key).then((v) => { if (alive) setAsset(v); });
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return asset;
}

/** What an option looks like: the real cosmetic worn on Steve, a cloak front, an uploaded concept, or a letter. */
function OptionArt({ option, size = 'md' }) {
  const item = option.item;
  const asset = useCosmetic(item);
  const dims = size === 'lg' ? [84, 134] : size === 'sm' ? [34, 54] : [60, 96];
  if (item?.kind === 'cosmetic') {
    return asset
      ? <WornShot item={item} asset={asset} skinUrl={steveSkin} model="default" prepare={prepareSkinSource} fallback={asset.thumb} className={`cv-art-img is-${size}`} />
      : <span className={`cv-art-wait is-${size}`}><Loader2 size={16} className="is-spinning" /></span>;
  }
  if (option.image && !(item && item.kind === 'cape')) return <img className={`cv-art-img is-${size}`} src={option.image} alt="" draggable={false} />;
  if (item?.kind === 'cape') return <CapeThumb src={item.animated && item.stripUrl ? item.stripUrl : item.stillUrl} frames={item.animated ? item.frames : 1} fps={item.fps} width={dims[0]} height={dims[1]} />;
  return <span className={`cv-art-letter is-${size}`}>{String(option.label || '?').slice(0, 1)}</span>;
}

function useNow(active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}
function Countdown({ at }) {
  const now = useNow(true);
  const left = Math.max(0, Number(at) - now);
  const parts = [[Math.floor(left / 86_400_000), 'd'], [Math.floor(left / 3_600_000) % 24, 'h'], [Math.floor(left / 60_000) % 60, 'm'], [Math.floor(left / 1000) % 60, 's']];
  return <span className="cv-countdown">{parts.map(([v, l]) => <b key={l}>{String(v).padStart(2, '0')}<small>{l}</small></b>)}</span>;
}

/* ── live vote ───────────────────────────────────────────────────── */

function LiveVote({ poll, signedIn, busy, onVote, onSignIn }) {
  const top = poll.showResults ? Math.max(0, ...poll.options.map((o) => o.votes ?? 0)) : -1;
  const note = !signedIn ? 'One Native account gets one vote.'
    : !poll.showResults ? (poll.results === 'after_close' ? 'Results show up when voting closes.' : 'Vote and the results show up right away.')
      : poll.myVote ? 'Changed your mind? Pick another one any time before it closes.' : null;
  return (
    <article className="cv-card">
      <header className="cv-card-head">
        <div>
          <p className="cv-eyebrow"><i className="cv-dot is-live" />Voting open · {KIND[poll.kind] || 'Community'}{poll.total != null && <> · {plural(poll.total, 'vote', 'votes')}</>}</p>
          <h2>{poll.title}</h2>
          {poll.description && <p className="cv-desc">{poll.description}</p>}
        </div>
        {poll.endsAt && <div className="cv-closes"><small>Closes in</small><Countdown at={poll.endsAt} /></div>}
      </header>
      <ul className={`cv-options is-${Math.min(poll.options.length, 4)}`}>
        {poll.options.map((o) => {
          const mine = poll.myVote === o.id;
          const leading = poll.showResults && top > 0 && (o.votes ?? 0) === top;
          const p = pct(o.votes, poll.total);
          return (
            <li key={o.id}>
              <button type="button" className={`cv-option${mine ? ' is-mine' : ''}`} disabled={Boolean(busy) || mine} aria-pressed={mine}
                onClick={() => (signedIn ? onVote(poll, o) : onSignIn?.())}>
                <span className="cv-option-art">
                  <OptionArt option={o} />
                  <span className="cv-option-flags">
                    {leading ? <em className="cv-flag is-lead"><Trophy size={11} />Leading</em> : <span />}
                    {mine && <em className="cv-flag"><Check size={11} strokeWidth={3} />Your pick</em>}
                  </span>
                </span>
                <span className="cv-option-body">
                  <strong>{o.label}</strong>
                  {o.description && <small>{o.description}</small>}
                  {poll.showResults && (
                    <span className="cv-result">
                      <span><b>{p}%</b><small>{plural(o.votes ?? 0, 'vote', 'votes')}</small></span>
                      <span className="cv-bar"><i style={{ width: `${p}%` }} className={mine || leading ? 'is-strong' : ''} /></span>
                    </span>
                  )}
                  <span className={`cv-vote-btn${mine ? ' is-done' : ''}`}>
                    {busy === o.id ? <Loader2 size={14} className="is-spinning" /> : mine ? <Check size={14} /> : <Vote size={14} />}
                    {mine ? 'You voted for this' : !signedIn ? 'Sign in to vote' : poll.myVote ? 'Switch my vote' : 'Vote for this'}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {note && <p className="cv-note">{!poll.showResults && <Lock size={12} />}{note}</p>}
    </article>
  );
}

/* ── past campaigns ──────────────────────────────────────────────── */

function PastCampaign({ poll, onOpenStore }) {
  const winner = poll.options.find((o) => o.id === poll.winnerId) || null;
  const rest = poll.options.filter((o) => o.id !== poll.winnerId).sort((a, b) => (b.votes ?? 0) - (a.votes ?? 0));
  const released = winner?.item && !winner.item.hidden;
  return (
    <article className={`cv-past${winner ? '' : ' is-nowinner'}`}>
      <div className="cv-past-art">
        {winner ? <OptionArt option={winner} size="lg" /> : <Trophy size={28} />}
        {winner && <em className="cv-flag is-win"><Crown size={11} />Winner</em>}
      </div>
      <div className="cv-past-body">
        <p className="cv-eyebrow">{KIND[poll.kind] || 'Community'} vote · {plural(poll.total ?? 0, 'vote', 'votes')}</p>
        <h3>{winner ? winner.label : 'No winner yet'}</h3>
        <p className="cv-desc">{poll.title}{winner && poll.total ? ` · won with ${pct(winner.votes, poll.total)}%` : ''}</p>
        {winner?.description && <p className="cv-desc is-soft">{winner.description}</p>}
        <div className="cv-past-foot">
          {released
            ? <button type="button" className="cv-pill" onClick={() => onOpenStore?.()}><ShoppingBag size={13} />Out now in the Store</button>
            : winner ? <span className="cv-pill is-ghost"><Sparkles size={13} />Being made</span> : null}
          {rest.length > 0 && (
            <span className="cv-runners">
              {rest.slice(0, 4).map((o) => (
                <span key={o.id} className="cv-runner" title={`${o.label} · ${pct(o.votes, poll.total)}%`}>
                  <span className="cv-runner-art"><OptionArt option={o} size="sm" /></span>
                  <small>{pct(o.votes, poll.total)}%</small>
                </span>
              ))}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

/** Community: vote on the next cosmetics and cloaks; past winners collect at the bottom. */
export default function CommunityView({ account, isAdmin, onNotify, onOpenStore, onOpenAccountSwitcher, onOpenAdmin }) {
  const [polls, setPolls] = useState(null);
  const [signedIn, setSignedIn] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await window.native?.community?.polls?.(account);
      if (!r?.ok) throw new Error(r?.error || 'Couldn’t load the community votes.');
      setPolls(r.polls || []);
      setSignedIn(Boolean(r.signedIn));
      setError('');
    } catch (e) { setError(e.message); setPolls((p) => p || []); } finally { setLoading(false); }
  }, [account]);
  useEffect(() => { load(); }, [load]);

  const live = useMemo(() => (polls || []).filter((p) => p.status === 'open'), [polls]);
  const past = useMemo(() => (polls || []).filter((p) => p.status !== 'open'), [polls]);
  useEffect(() => {
    if (!live.length) return undefined;
    const t = setInterval(() => { if (!document.hidden) load(); }, 20_000);
    return () => clearInterval(t);
  }, [live.length, load]);

  const vote = async (poll, option) => {
    setBusy(option.id);
    setError('');
    const before = polls;
    setPolls((all) => all.map((p) => (p.id === poll.id ? { ...p, myVote: option.id } : p)));
    try {
      const r = await window.native?.community?.vote?.(account, poll.id, option.id);
      if (!r?.ok) throw new Error(r?.error || 'That vote didn’t go through.');
      if (r.poll) setPolls((all) => all.map((p) => (p.id === r.poll.id ? r.poll : p)));
      onNotify?.('Community', `You voted for ${option.label}.`);
    } catch (e) { setPolls(before); setError(e.message); } finally { setBusy(null); }
  };

  const cast = live.reduce((n, p) => n + (p.total ?? 0), 0);
  return (
    <main className="cv-view">
      <header className="cv-head">
        <div>
          <h1 className="page-title">Community</h1>
          <p className="cv-sub">You pick what’s next. New cosmetics and cloaks go to a vote — whatever wins is what we make.</p>
        </div>
        <div className="cv-head-actions">
          <span className="cv-chip"><i className={`cv-dot${live.length ? ' is-live' : ''}`} />{live.length ? `${plural(live.length, 'vote', 'votes')} open` : 'Nothing open right now'}{cast > 0 && ` · ${plural(cast, 'vote', 'votes')} cast`}</span>
          {isAdmin && <button type="button" className="cv-btn" onClick={onOpenAdmin}><ShieldCheck size={14} />Manage votes</button>}
          <button type="button" className="cv-btn is-icon" onClick={load} disabled={loading} aria-label="Refresh" title="Refresh"><RefreshCw size={14} className={loading ? 'is-spinning' : ''} /></button>
        </div>
      </header>

      {error && <div className="cv-error" role="alert">{error}</div>}

      {!polls ? (
        <div className="cv-empty"><Loader2 size={20} className="is-spinning" /><p>Loading community votes…</p></div>
      ) : (
        <>
          {live.length > 0 ? (
            <section className="cv-live">
              {live.map((p) => <LiveVote key={p.id} poll={p} signedIn={signedIn} busy={busy} onVote={vote} onSignIn={onOpenAccountSwitcher} />)}
            </section>
          ) : (
            <section className="cv-empty">
              <span className="cv-empty-icon"><Trophy size={22} /></span>
              <h2>{past.length ? 'No vote is open right now.' : 'The first vote is on its way.'}</h2>
              <p>New votes show up here and in the Discord the moment they open.</p>
            </section>
          )}

          {past.length > 0 && (
            <section className="cv-past-wrap">
              <div className="cv-section-head">
                <h2><Crown size={16} />Past campaigns</h2>
                <p>What the community picked before.</p>
              </div>
              <div className="cv-past-grid">
                {past.map((p) => <PastCampaign key={p.id} poll={p} onOpenStore={onOpenStore} />)}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
