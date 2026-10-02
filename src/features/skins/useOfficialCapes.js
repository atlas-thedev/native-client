import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Wires the renderer to the existing official-cosmetics backend
 * (`wardrobe:officialProfile` / `wardrobe:activateOfficialCape`), which returns
 * the REAL capes a Microsoft account owns. The main process wraps every call in
 * a `{ ok, profile } | { ok:false, error, code, status }` envelope, so this hook
 * normalizes that into `{ capes, activeCapeId, loading, busy, error }` plus
 * `equip`, `reload` and `reauth` actions.
 *
 * Only Microsoft accounts have official cosmetics; for any other account type
 * the hook stays inert (no IPC, empty state) so the Locker can fall back to the
 * bundled cape presets.
 */
export default function useOfficialCapes(account) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // The merged account object gets a fresh identity on most renders, so we key
  // effects off the stable id and read the latest account through a ref to keep
  // the IPC payload current without re-subscribing.
  const accountRef = useRef(account);
  accountRef.current = account;
  const reqRef = useRef(0);

  const accountId = account?.id || null;
  const isMicrosoft = Boolean(account?.isMicrosoft);

  const load = useCallback(async (mode = 'load') => {
    const acc = accountRef.current;
    const wardrobe = window.native?.wardrobe;
    if (!acc?.id || !acc.isMicrosoft || !wardrobe?.officialProfile) {
      setProfile(null);
      setError(null);
      setLoading(false);
      return;
    }
    const reqId = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const call = mode === 'reauth' && wardrobe.reauthOfficialProfile
        ? wardrobe.reauthOfficialProfile
        : wardrobe.officialProfile;
      const res = await call(acc);
      if (reqId !== reqRef.current) return; // a newer request superseded this one
      if (res?.ok) {
        setProfile(res.profile || null);
        setError(null);
      } else {
        setProfile(null);
        setError({ code: res?.code || null, status: res?.status || null, message: res?.error || null });
      }
    } catch (err) {
      if (reqId !== reqRef.current) return;
      setProfile(null);
      setError({ code: null, status: null, message: err?.message || String(err) });
    } finally {
      if (reqId === reqRef.current) setLoading(false);
    }
  }, [accountId, isMicrosoft]);

  useEffect(() => {
    load('load');
  }, [load]);

  // Back online: refresh the real cape list quietly (the saved one stays on screen).
  useEffect(() => {
    const onBack = () => { load('load'); };
    window.addEventListener('noctra:reconnected', onBack);
    return () => window.removeEventListener('noctra:reconnected', onBack);
  }, [load]);

  const equip = useCallback(async (capeId) => {
    const acc = accountRef.current;
    const wardrobe = window.native?.wardrobe;
    if (!acc?.id || !wardrobe?.activateOfficialCape) return;
    setBusy(true);
    // Optimistically flip the active flag so the highlight moves instantly; the
    // authoritative refreshed profile from the backend replaces it below.
    setProfile((prev) => (prev
      ? { ...prev, capes: (prev.capes || []).map((cape) => ({ ...cape, state: cape.id === capeId ? 'ACTIVE' : 'INACTIVE' })) }
      : prev));
    try {
      const res = await wardrobe.activateOfficialCape(acc, capeId || null);
      if (res?.ok) {
        setProfile(res.profile || null);
        setError(null);
      } else {
        setError({ code: res?.code || null, status: res?.status || null, message: res?.error || null });
        await load('load'); // reconcile with the server's real state
      }
    } catch (err) {
      setError({ code: null, status: null, message: err?.message || String(err) });
      await load('load');
    } finally {
      setBusy(false);
    }
  }, [load]);

  const capes = profile?.capes || [];
  const activeCape = capes.find((cape) => cape.state === 'ACTIVE') || null;

  return {
    active: isMicrosoft,
    profile,
    capes,
    activeCape,
    activeCapeId: activeCape?.id || null,
    loading,
    busy,
    error,
    equip,
    reload: () => load('load'),
    reauth: () => load('reauth')
  };
}
