import React, { useEffect, useState } from 'react';
import { Globe, LoaderCircle, Megaphone, Rocket, RotateCcw, Save, Timer, Wrench } from 'lucide-react';
import AdminPicker from './AdminPicker.jsx';
import { AdminDateTime, AdminSegmented, AdminSwitch, adminCall, useAdminAction, useConfirm } from './adminShared.jsx';

const isCosmetic = (item) => item?.kind === 'cosmetic';
const zone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'local time'; } })();

function Countdown({ at }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const left = Math.max(0, (Number(at) || 0) - now);
  const parts = [[Math.floor(left / 86_400_000), 'days'], [Math.floor(left / 3_600_000) % 24, 'hours'], [Math.floor(left / 60_000) % 60, 'min'], [Math.floor(left / 1000) % 60, 'sec']];
  return (
    <div className="admin-countdown" aria-label="Time until launch">
      {parts.map(([value, label]) => <span key={label}><strong>{String(value).padStart(2, '0')}</strong><small>{label}</small></span>)}
    </div>
  );
}

/** Website controls: launch, countdown and locks, founder gifts, maintenance screen and the announcement bar. */
export default function AdminWebsite({ doc, setDoc, items, strips, onNotify, onAccessRevoked }) {
  const { busy, error, run } = useAdminAction(onNotify, 'Website');
  const [giftKind, setGiftKind] = useState('all');
  const { armed, ask } = useConfirm();
  const [launch, setLaunch] = useState(doc?.settings?.launch || null);
  const [maintenance, setMaintenance] = useState(doc?.settings?.maintenance || null);
  const [banner, setBanner] = useState(doc?.settings?.announcement || null);
  useEffect(() => {
    setLaunch(doc?.settings?.launch || null);
    setMaintenance(doc?.settings?.maintenance || null);
    setBanner(doc?.settings?.announcement || null);
  }, [doc]);

  if (!doc || !launch || !maintenance || !banner) {
    return <div className="admin-scroll">{error && <div className="admin-error" role="alert"><span>{error}</span></div>}<div className="admin-loading"><LoaderCircle size={18} className="is-spinning" /><span>Loading website settings…</span></div></div>;
  }

  const post = (body, key, ok) => run(key, async () => setDoc(await adminCall('POST', '/site', body, onAccessRevoked)), ok);
  const live = doc.config?.launch || {};
  const launchDirty = JSON.stringify(launch) !== JSON.stringify(doc.settings.launch);
  const maintenanceDirty = JSON.stringify(maintenance) !== JSON.stringify(doc.settings.maintenance);
  const bannerDirty = JSON.stringify(banner) !== JSON.stringify(doc.settings.announcement);
  const setL = (key, value) => setLaunch((current) => ({ ...current, [key]: value }));
  // Founder gift: any visible Store item — a cloak or a cosmetic. Picked ones always stay listed.
  const picked = launch.founderCapes || [];
  const giftable = (items || []).filter((item) => (!item.hidden || picked.includes(item.id))
    && (giftKind === 'all' || (giftKind === 'cosmetic' ? isCosmetic(item) : !isCosmetic(item))));
  const giftCounts = { all: 0, cape: 0, cosmetic: 0 };
  for (const id of picked) { const it = (items || []).find((entry) => entry.id === id); if (it) giftCounts[isCosmetic(it) ? 'cosmetic' : 'cape'] += 1; }
  const saveBtn = (dirty, key, onClick, label = 'Save changes') => (
    <button type="button" className="admin-btn primary" disabled={!dirty || Boolean(busy)} onClick={onClick}>
      {busy === key ? <LoaderCircle size={13} className="is-spinning" /> : <Save size={13} />}{label}
    </button>
  );

  return (
    <div className="admin-scroll">
      {error && <div className="admin-error" role="alert"><span>{error}</span></div>}

      <section className={`admin-card admin-launch-hero${live.prelaunch ? ' is-pre' : ' is-live'}`}>
        <div className="admin-card-head">
          <h3><Rocket size={14} />Launch status</h3>
          <span className={`admin-chip ${live.prelaunch ? 'is-test' : 'is-live'}`}>{live.prelaunch ? 'Pre-launch' : 'Live'}</span>
        </div>
        <p className="admin-note">{live.prelaunch ? 'The website is in pre-launch mode: countdown hero, sign-ups and founder gifts.' : 'Native is live. The countdown is gone and the store and downloads are open.'}</p>
        {live.prelaunch && live.at ? <Countdown at={live.at} /> : null}
        <div className="admin-row-actions">
          {live.prelaunch ? (
            <button type="button" className={`admin-btn primary${armed === 'launch' ? ' is-confirm' : ''}`} disabled={Boolean(busy)} onClick={() => ask('launch') && post({ launch: { prelaunch: false } }, 'now', 'Native is launched! 🚀')}>
              {busy === 'now' ? <LoaderCircle size={13} className="is-spinning" /> : <Rocket size={13} />}{armed === 'launch' ? 'Click again to launch for everyone' : 'Launch now'}
            </button>
          ) : (
            <button type="button" className={`admin-btn ghost${armed === 'back' ? ' is-confirm' : ''}`} disabled={Boolean(busy)} onClick={() => ask('back') && post({ launch: { prelaunch: true } }, 'back', 'Back in pre-launch mode.')}>
              {busy === 'back' ? <LoaderCircle size={13} className="is-spinning" /> : <RotateCcw size={13} />}{armed === 'back' ? 'Click again to confirm' : 'Back to pre-launch'}
            </button>
          )}
        </div>
      </section>

      <div className="admin-overview-grid admin-site-grid">
        <section className="admin-card">
          <div className="admin-card-head"><h3><Timer size={14} />Countdown & locks</h3>{saveBtn(launchDirty, 'launch', () => post({ launch }, 'launch', 'Launch settings saved.'))}</div>
          <div className="admin-field"><span>Launch date & time</span><AdminDateTime value={launch.at} onChange={(value) => setL('at', value ?? launch.at)} placeholder="Pick a date" /></div>
          <p className="admin-note">Your time zone ({zone}). The countdown ends here and everything unlocks automatically.</p>
          <div className="admin-beta-switches">
            <AdminSwitch on={launch.prelaunch} onChange={(v) => setL('prelaunch', v)} label="Pre-launch mode" hint="Countdown hero and launch messaging." />
            <AdminSwitch on={launch.lockStore} onChange={(v) => setL('lockStore', v)} label="Lock the store until launch" hint="No buying or claiming capes or Native+ (admins can still test)." />
            <AdminSwitch on={launch.lockDownloads} onChange={(v) => setL('lockDownloads', v)} label="Lock downloads until launch" hint="Download buttons turn into sign-up buttons." />
          </div>
          <label className="admin-field"><span>Hero headline</span><input maxLength={80} value={launch.headline || ''} onChange={(event) => setL('headline', event.target.value)} /></label>
          <label className="admin-field"><span>Hero sub-line</span><textarea maxLength={200} rows={3} value={launch.subline || ''} onChange={(event) => setL('subline', event.target.value)} /></label>
        </section>

        <section className="admin-card">
          <div className="admin-card-head"><h3><Wrench size={14} />Maintenance mode</h3>{saveBtn(maintenanceDirty, 'maintenance', () => post({ maintenance }, 'maintenance', maintenance.enabled ? 'Maintenance is ON.' : 'Maintenance settings saved.'), 'Save')}</div>
          <p className="admin-note">Covers the whole website with a maintenance screen. Admins can still browse, and the sign-in page stays open.</p>
          <AdminSwitch on={maintenance.enabled} onChange={(v) => setMaintenance((current) => ({ ...current, enabled: v }))} label="Maintenance mode" hint={maintenance.enabled ? 'Visitors see the maintenance screen.' : 'The site is open.'} />
          <div className="admin-field"><span>Back by (optional)</span><AdminDateTime value={maintenance.until} onChange={(value) => setMaintenance((current) => ({ ...current, until: value }))} placeholder="No time given" /></div>
          <label className="admin-field"><span>Message</span><textarea maxLength={280} rows={3} value={maintenance.message || ''} onChange={(event) => setMaintenance((current) => ({ ...current, message: event.target.value }))} /></label>
          {doc.settings.maintenance.enabled && (
            <button type="button" className="admin-btn danger" disabled={Boolean(busy)} onClick={() => post({ maintenance: { enabled: false } }, 'off', 'Maintenance is OFF. The site is open.')}>
              {busy === 'off' ? <LoaderCircle size={13} className="is-spinning" /> : <Globe size={13} />}Turn off now
            </button>
          )}
        </section>

        <section className="admin-card">
          <div className="admin-card-head"><h3><Megaphone size={14} />Announcement bar</h3>{saveBtn(bannerDirty, 'banner', () => post({ announcement: banner }, 'banner', 'Announcement saved.'), 'Save')}</div>
          <p className="admin-note">The thin bar above the website navigation. When it’s off, the bar shows a live offer, the launch countdown or the latest version.</p>
          <AdminSwitch on={banner.enabled} onChange={(v) => setBanner((current) => ({ ...current, enabled: v }))} label="Show my announcement" />
          <label className="admin-field"><span>Text</span><input maxLength={160} placeholder="Server event this Saturday at 8pm!" value={banner.text || ''} onChange={(event) => setBanner((current) => ({ ...current, text: event.target.value }))} /></label>
          <div className="admin-field-row">
            <label className="admin-field"><span>Button label</span><input maxLength={30} placeholder="Learn more" value={banner.cta || ''} onChange={(event) => setBanner((current) => ({ ...current, cta: event.target.value }))} /></label>
            <label className="admin-field"><span>Button link</span><input maxLength={300} placeholder="/vote or https://…" value={banner.href || ''} onChange={(event) => setBanner((current) => ({ ...current, href: event.target.value }))} /></label>
          </div>
          {banner.text && (
            <div className="admin-banner-preview">
              <span>{banner.text}</span>{banner.href && <em>{banner.cta || 'Learn more'} →</em>}
            </div>
          )}
        </section>

        <section className="admin-card is-wide">
          <div className="admin-card-head">
            <h3><Rocket size={14} />Founder gift</h3>
            <span>{picked.length}/6 picked{picked.length ? ` · ${giftCounts.cape} cloak${giftCounts.cape === 1 ? '' : 's'}, ${giftCounts.cosmetic} cosmetic${giftCounts.cosmetic === 1 ? '' : 's'}` : ''}</span>
            <span className="admin-head-spacer" />
            {saveBtn(launchDirty, 'founder', () => post({ launch }, 'founder', 'Founder gifts saved.'))}
          </div>
          <p className="admin-note">Accounts created before launch pick ONE of these for free (up to 6) — cloaks or cosmetics. Change them any time; players who already picked keep theirs.</p>
          <AdminSwitch on={launch.founderPick} onChange={(v) => setL('founderPick', v)} label="Free founder gift for pre-launch accounts" />
          <AdminSegmented value={giftKind} onChange={setGiftKind} options={[['all', 'All'], ['cape', 'Cloaks'], ['cosmetic', 'Cosmetics']]} ariaLabel="Gift type" />
          <AdminPicker items={giftable} strips={strips} value={picked} onChange={(v) => setL('founderCapes', v)} max={6} empty={giftKind === 'cosmetic' ? 'No cosmetics in the Store yet.' : 'No Store items yet.'} />
        </section>
      </div>
    </div>
  );
}
