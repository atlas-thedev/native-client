import { useEffect, useState } from 'react';

/** Fired by the Store (and anything else that learns the Noctra+ state) so the shell updates at once. */
export const PLUS_EVENT = 'noctra:plus-changed';
export const announcePlus = (active) => {
  try { window.dispatchEvent(new CustomEvent(PLUS_EVENT, { detail: { active: Boolean(active) } })); } catch {}
};

const cacheKey = (account) => `noctra.plus.${account?.id || account?.uuid || 'none'}`;

/**
 * Whether the signed-in account has Noctra+. Cached per account so the N+ logo shows instantly,
 * refreshed on focus (at most once a minute) and whenever the Store reports a change.
 */
export default function usePlus(account, enabled = true) {
  const key = cacheKey(account);
  const [active, setActive] = useState(() => {
    try { return enabled && localStorage.getItem(key) === '1'; } catch { return false; }
  });

  useEffect(() => {
    if (!enabled || !account) { setActive(false); return undefined; }
    let dead = false;
    let last = 0;
    try { setActive(localStorage.getItem(key) === '1'); } catch {}
    const save = (on) => {
      if (dead) return;
      setActive(on);
      try { localStorage.setItem(key, on ? '1' : '0'); } catch {}
    };
    const refresh = async (force = false) => {
      if (!force && Date.now() - last < 60_000) return;
      last = Date.now();
      const res = await window.native?.billing?.me?.(account).catch(() => null);
      if (res?.ok && res.plus) save(Boolean(res.plus.active));
    };
    refresh(true);
    const onFocus = () => refresh(false);
    const onChange = (event) => save(Boolean(event.detail?.active));
    window.addEventListener('focus', onFocus);
    window.addEventListener(PLUS_EVENT, onChange);
    const timer = setInterval(() => refresh(true), 10 * 60_000);
    return () => { dead = true; window.removeEventListener('focus', onFocus); window.removeEventListener(PLUS_EVENT, onChange); clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  useEffect(() => { window.native?.setPlusIcon?.(active); }, [active]);
  return active;
}
