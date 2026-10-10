import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, Crown, Gift, LoaderCircle, LogOut, Search, Shirt, ShieldCheck, ShieldOff, Sparkles, X } from 'lucide-react';
import { BADGE_DEFS } from '../social/Badges.jsx';
import NativePlusIcon from '../../components/ui/NativePlusIcon.jsx';
import { ItemThumb } from './AdminStore.jsx';
import { AdminSegmented, InitialAvatar, Presence, adminError, formatAgo, formatDate, formatNumber } from './adminShared.jsx';

function Stat({ label, value, title }) {
  return <div className="admin-stat" title={title}><dt>{label}</dt><dd>{value}</dd></div>;
}

/**
 * Everything about one Native account: who they are, their capes (attach, wear,
 * take off, take back), badges, admin role and sessions.
 */
export default function AdminUserPanel({ userId, summary, items, strips, onNotify, onUserChanged, onAccessRevoked, onClose }) {
  const [user, setUser] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerKind, setPickerKind] = useState('all');
  const [confirm, setConfirm] = useState('');
  const [copied, setCopied] = useState(false);
  const [plusGift, setPlusGift] = useState(undefined); // this player's given Native+ (null = none), undefined while loading

  const load = useCallback(async () => {
    setError('');
    const result = await window.native?.admin?.getUser?.(userId);
    if (!result?.ok) throw adminError(result, 'Could not load this player.', onAccessRevoked);
    setUser(result.user);
    return result.user;
  }, [userId, onAccessRevoked]);

  const loadPlus = useCallback(async () => {
    const result = await window.native?.admin?.plusGifts?.();
    if (!result?.ok) { setPlusGift(null); return; }
    setPlusGift((result.gifts || []).find((row) => String(row.userId) === String(userId)) || null);
  }, [userId]);
  useEffect(() => { setPlusGift(undefined); loadPlus().catch(() => setPlusGift(null)); }, [loadPlus]);

  useEffect(() => {
    setUser(null);
    setConfirm('');
    setPickerQuery('');
    load().catch((reason) => setError(reason?.message || 'Could not load this player.'));
  }, [load]);

  const view = user || (summary ? { ...summary, owned: null, equipped: null } : null);
  const itemById = useMemo(() => new Map((items || []).map((item) => [item.id, item])), [items]);
  const ownedIds = useMemo(() => new Set((user?.owned || []).map((entry) => entry.id)), [user]);
  const owned = (user?.owned || []).map((entry) => ({ ...entry, item: itemById.get(entry.id) })).filter((entry) => entry.item);
  const wearing = user?.equipped ? itemById.get(user.equipped) : null;
  const attachable = (items || []).filter((item) => !ownedIds.has(item.id)).filter((item) => {
    if (pickerKind !== 'all' && (item.kind === 'cosmetic') !== (pickerKind === 'cosmetic')) return false;
    const q = pickerQuery.trim().toLowerCase();
    return !q || `${item.name} ${item.id} ${(item.tags || []).join(' ')}`.toLowerCase().includes(q);
  });

  const run = async (key, fn) => {
    setBusy(key);
    setError('');
    try { await fn(); } catch (reason) { setError(reason?.message || 'Something went wrong.'); } finally { setBusy(''); }
  };

  const givePlus = (days, label) => run(`plus:${days}`, async () => {
    const result = await window.native?.admin?.givePlus?.({ username: view?.username, days, note: 'From the user panel' });
    if (!result?.ok) throw adminError(result, 'Could not give Native+.', onAccessRevoked);
    setPlusGift((result.gifts || []).find((row) => String(row.userId) === String(userId)) || { userId, expiresAt: result.expiresAt });
    onNotify?.('Native+', `${result.username} has Native+ ${result.expiresAt ? `until ${formatDate(result.expiresAt)}` : 'forever'} (${label}).`);
    onUserChanged?.();
  });
  const removePlus = () => {
    if (confirm !== 'plus') { setConfirm('plus'); setTimeout(() => setConfirm((current) => (current === 'plus' ? '' : current)), 2600); return; }
    setConfirm('');
    run('plus:off', async () => {
      const result = await window.native?.admin?.removePlus?.(userId);
      if (!result?.ok) throw adminError(result, 'Could not take Native+ away.', onAccessRevoked);
      setPlusGift(null);
      onNotify?.('Native+', `Took Native+ away from ${view?.username || 'this player'}.`);
      onUserChanged?.();
    });
  };
  const cape = (item, action) => run(`${action}:${item?.id || 'off'}`, async () => {
    const result = await window.native?.admin?.userCape?.(userId, item?.id ?? null, action);
    if (!result?.ok) throw adminError(result, 'Could not update capes.', onAccessRevoked);
    if (result.user) setUser((current) => ({ ...current, ...result.user }));
    else await load();
    const name = view?.username || 'player';
    const copy = {
      grant: `${item?.name} was added to ${name}’s locker.`,
      equip: `${name} is now wearing ${item?.name}.`,
      unequip: `${item?.name || 'That item'} was taken off ${name}.`,
      revoke: `${item?.name} was taken back from ${name}.`
    }[action];
    onNotify?.('Locker', copy);
    onUserChanged?.();
  });

  const toggleBadge = (badgeId, granted) => run(`badge:${badgeId}`, async () => {
    const result = await window.native?.admin?.setBadge?.(userId, badgeId, granted);
    if (!result?.ok) throw adminError(result, 'Could not update badge.', onAccessRevoked);
    setUser((current) => ({ ...(current || view), badges: result.user?.badges || [] }));
    onUserChanged?.({ id: userId, badges: result.user?.badges || [] });
    onNotify?.(granted ? 'Badge granted' : 'Badge revoked', `${BADGE_DEFS[badgeId]?.name} · ${view?.username}`);
  });

  const toggleAdmin = () => {
    const next = !view?.isAdmin;
    if (confirm !== 'admin') { setConfirm('admin'); return; }
    setConfirm('');
    run('admin', async () => {
      const result = await window.native?.admin?.setAdmin?.(userId, next);
      if (!result?.ok) throw adminError(result, 'Could not change admin access.', onAccessRevoked);
      setUser((current) => ({ ...(current || view), isAdmin: next }));
      onUserChanged?.({ id: userId, isAdmin: next });
      onNotify?.('Admin access', next ? `${view?.username} is now an admin.` : `${view?.username} is no longer an admin.`);
    });
  };

  const signOutEverywhere = () => {
    if (confirm !== 'sessions') { setConfirm('sessions'); return; }
    setConfirm('');
    run('sessions', async () => {
      const result = await window.native?.admin?.revokeSessions?.(userId);
      if (!result?.ok) throw adminError(result, 'Could not sign this player out.', onAccessRevoked);
      setUser((current) => ({ ...(current || view), sessionCount: 0 }));
      onNotify?.('Signed out', `${view?.username} was signed out of ${formatNumber(result.revoked)} session${result.revoked === 1 ? '' : 's'}.`);
    });
  };

  const copyId = () => {
    navigator.clipboard?.writeText(userId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  if (!view) {
    return <aside className="admin-panel admin-user-panel"><div className="admin-loading"><LoaderCircle size={18} className="is-spinning" /><span>Loading player…</span></div></aside>;
  }

  const thumb = (item, width = 40, height = 64) => (
    <ItemThumb item={item} strips={strips} width={width} height={height} />
  );

  return (
    <aside className="admin-panel admin-user-panel" aria-label={`${view.username} details`}>
      <header className="admin-user-hero">
        <InitialAvatar name={view.username} size="lg" />
        <div className="admin-user-hero-main">
          <div className="admin-user-hero-name">
            <h2>{view.username}</h2>
            {view.isAdmin && <span className="admin-chip is-admin"><Crown size={11} />Admin</span>}
            <Presence status={view.status} />
          </div>
          <span className="admin-user-email">{view.email}</span>
          <button type="button" className="admin-copy-id" onClick={copyId} title="Copy user ID">
            <code>{userId}</code>{copied ? <Check size={11} /> : <Copy size={11} />}
          </button>
        </div>
        {onClose && <button type="button" className="admin-icon-btn" onClick={onClose} aria-label="Close"><X size={15} /></button>}
      </header>

      {error && <div className="admin-error" role="alert"><span>{error}</span></div>}

      <dl className="admin-stats">
        <Stat label="Joined" value={formatAgo(view.createdAt)} title={formatDate(view.createdAt)} />
        <Stat label="Last seen" value={view.status && view.status !== 'offline' ? 'Online now' : formatAgo(view.lastSeen)} title={formatDate(view.lastSeen)} />
        <Stat label="Sessions" value={user ? formatNumber(user.sessionCount ?? user.sessions ?? 0) : '…'} />
        <Stat label="Friends" value={formatNumber(view.friendCount)} />
        <Stat label="Groups" value={formatNumber(view.groupCount)} />
        <Stat label="Messages" value={formatNumber(view.messageCount)} />
      </dl>

      <section className="admin-block">
        <div className="admin-block-head">
          <h3>Capes</h3>
          <span>{user ? `${owned.length} in locker` : 'Loading…'}</span>
        </div>

        <div className={`admin-wearing${wearing ? '' : ' is-empty'}`}>
          <div className="admin-wearing-art">{wearing ? thumb(wearing, 50, 80) : <Shirt size={18} />}</div>
          <div className="admin-wearing-copy">
            <small>Wearing now</small>
            <strong>{wearing ? wearing.name : user?.hasCustomCape ? 'Their own uploaded cape' : 'No Store cloak'}</strong>
            <span>{wearing ? 'Shows in the launcher, on the website and in game.' : 'Pick one below and press Wear to put it on them.'}</span>
          </div>
          {wearing && (
            <button type="button" className="admin-btn ghost" disabled={Boolean(busy)} onClick={() => cape(null, 'unequip')}>
              {busy === 'unequip:off' ? <LoaderCircle size={13} className="is-spinning" /> : <X size={13} />}Take off
            </button>
          )}
        </div>

        {owned.length > 0 && (
          <div className="admin-cape-grid">
            {owned.map(({ item, acquiredAt, source }) => {
              const worn = user?.equipped === item.id;
              return (
                <div key={item.id} className={`admin-cape-tile${worn ? ' is-worn' : ''}`}>
                  <div className="admin-cape-tile-art">{thumb(item)}{worn && <span className="admin-cape-tile-flag">Wearing</span>}</div>
                  <strong title={item.name}>{item.name}</strong>
                  <small title={formatDate(acquiredAt)}>{source === 'admin' ? 'Given' : 'Claimed'} {formatAgo(acquiredAt)}</small>
                  <div className="admin-cape-tile-actions">
                    {!worn && <button type="button" disabled={Boolean(busy)} onClick={() => cape(item, 'equip')} title={`Put ${item.name} on`}>{busy === `equip:${item.id}` ? <LoaderCircle size={12} className="is-spinning" /> : <Shirt size={12} />}Wear</button>}
                    <button type="button" className="is-danger" disabled={Boolean(busy)} onClick={() => cape(item, 'revoke')} title={`Take ${item.name} back`} aria-label={`Take ${item.name} back`}>{busy === `revoke:${item.id}` ? <LoaderCircle size={12} className="is-spinning" /> : <X size={12} />}</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="admin-attach">
          <div className="admin-attach-head">
            <span><Gift size={13} />Give an item</span>
            <AdminSegmented value={pickerKind} onChange={setPickerKind} options={[['all', 'All'], ['cape', 'Cloaks'], ['cosmetic', 'Cosmetics']]} ariaLabel="Item kind" />
            <label className="admin-search is-small"><Search size={12} /><input value={pickerQuery} onChange={(event) => setPickerQuery(event.target.value)} placeholder="Find a cloak or cosmetic" aria-label="Find an item to give" /></label>
          </div>
          {!items ? <p className="admin-note"><LoaderCircle size={12} className="is-spinning" /> Loading Store cloaks…</p>
            : !attachable.length ? <p className="admin-note">{(items || []).length && !pickerQuery && pickerKind === 'all' ? 'They already have every Store item.' : 'Nothing matches.'}</p>
              : (
                <div className="admin-attach-grid">
                  {attachable.map((item) => (
                    <div key={item.id} className="admin-attach-tile">
                      <div className="admin-attach-art">{thumb(item, 30, 48)}</div>
                      <div className="admin-attach-copy">
                        <strong title={item.name}>{item.name}</strong>
                        <small>{item.kind === 'cosmetic' ? 'Cosmetic' : 'Cloak'} · {item.exclusive ? 'Exclusive' : item.hidden ? 'Hidden' : item.animated ? 'Animated' : 'Static'}</small>
                      </div>
                      <div className="admin-attach-actions">
                        <button type="button" disabled={Boolean(busy) || !user} onClick={() => cape(item, 'grant')} title={`Give ${item.name}`}>{busy === `grant:${item.id}` ? <LoaderCircle size={12} className="is-spinning" /> : <Gift size={12} />}Give</button>
                        <button type="button" className="is-primary" disabled={Boolean(busy) || !user} onClick={() => cape(item, 'equip')} title={`Give ${item.name} and put it on`}>{busy === `equip:${item.id}` ? <LoaderCircle size={12} className="is-spinning" /> : <Sparkles size={12} />}Give &amp; wear</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
        </div>
      </section>

      <section className="admin-block">
        <div className="admin-block-head"><h3>Native+</h3><span>{plusGift === undefined ? 'Loading…' : plusGift ? (plusGift.expiresAt ? `Given · ends ${formatDate(plusGift.expiresAt)}` : 'Given · forever') : 'Not given'}</span></div>
        <div className="admin-plus-user">
          <span className="admin-plus-chip"><NativePlusIcon size={18} /></span>
          <div className="admin-plus-user-text">
            <strong>{plusGift ? 'Has Native+' : 'Give Native+'}</strong>
            <span>{plusGift ? `${plusGift.expiresAt ? `${Math.max(1, Math.ceil((plusGift.expiresAt - Date.now()) / 86_400_000))} days left` : 'Never ends'}. More time adds to what's left.` : 'Every paid cloak and cosmetic plus the Native+ badge, free. No payment.'}</span>
          </div>
        </div>
        <div className="admin-plus-actions">
          {[['30', '1 month'], ['90', '3 months'], ['365', '1 year'], ['0', 'Forever']].map(([days, label]) => (
            <button key={days} type="button" className="admin-btn ghost" disabled={Boolean(busy) || !view.username} onClick={() => givePlus(Number(days), label)}>
              {busy === `plus:${days}` ? <LoaderCircle size={13} className="is-spinning" /> : <Gift size={13} />}{plusGift ? `+${label}` : label}
            </button>
          ))}
          {plusGift && <button type="button" className={`admin-btn danger${confirm === 'plus' ? ' is-confirm' : ''}`} disabled={Boolean(busy)} onClick={removePlus}>
            {busy === 'plus:off' ? <LoaderCircle size={13} className="is-spinning" /> : <X size={13} />}{confirm === 'plus' ? 'Click to confirm' : 'Take away'}
          </button>}
        </div>
      </section>

      <section className="admin-block">
        <div className="admin-block-head"><h3>Badges</h3><span>{(view.badges || []).length} of {Object.keys(BADGE_DEFS).length}</span></div>
        <div className="admin-badge-grid">
          {Object.entries(BADGE_DEFS).map(([badgeId, badge]) => {
            const active = (view.badges || []).includes(badgeId);
            return (
              <button key={badgeId} type="button" className={`admin-badge-toggle${active ? ' is-active' : ''}`} disabled={Boolean(busy)} aria-pressed={active} onClick={() => toggleBadge(badgeId, !active)} title={`${active ? 'Revoke' : 'Grant'} ${badge.name}`}>
                {badge.icon}<span>{badge.name}</span>{busy === `badge:${badgeId}` ? <LoaderCircle size={11} className="is-spinning" /> : active ? <Check size={11} /> : null}
              </button>
            );
          })}
        </div>
      </section>

      <section className="admin-block">
        <div className="admin-block-head"><h3>Access</h3></div>
        <div className="admin-access-row">
          <div>
            <strong>{view.isAdmin ? 'Administrator' : 'Player'}</strong>
            <span>{view.isAdmin ? 'Can open this page and manage every account and cape.' : 'Normal account. Make them an admin to give them this page.'}</span>
          </div>
          <button type="button" className={`admin-btn ${view.isAdmin ? 'danger' : 'ghost'}${confirm === 'admin' ? ' is-confirm' : ''}`} disabled={Boolean(busy)} onClick={toggleAdmin}>
            {busy === 'admin' ? <LoaderCircle size={13} className="is-spinning" /> : view.isAdmin ? <ShieldOff size={13} /> : <ShieldCheck size={13} />}
            {confirm === 'admin' ? 'Click to confirm' : view.isAdmin ? 'Remove admin' : 'Make admin'}
          </button>
        </div>
        <div className="admin-access-row">
          <div>
            <strong>Sessions</strong>
            <span>Sign them out of the launcher and website on every device.</span>
          </div>
          <button type="button" className={`admin-btn danger${confirm === 'sessions' ? ' is-confirm' : ''}`} disabled={Boolean(busy)} onClick={signOutEverywhere}>
            {busy === 'sessions' ? <LoaderCircle size={13} className="is-spinning" /> : <LogOut size={13} />}
            {confirm === 'sessions' ? 'Click to confirm' : 'Sign out everywhere'}
          </button>
        </div>
      </section>
    </aside>
  );
}
