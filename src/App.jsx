import { useEffect, useMemo, useRef, useState } from 'react';
import Shell from './features/shell/Shell.jsx';
import UpdateCenter from './features/updater/UpdateCenter.jsx';
import useUpdater from './features/updater/useUpdater.js';
import useNetwork from './features/network/useNetwork.js';
import OnboardingFlow from './features/onboarding/OnboardingFlow.jsx';
import AccountSwitcherModal from './features/auth/AccountSwitcherModal.jsx';
import { setApplicationLocale } from './i18n/I18nProvider.jsx';

const GUEST = { id: 'guest', name: 'Guest', uuid: null, type: 'guest', isMicrosoft: false };

// Startup must never wait on the network: anything optional gets a deadline.
const withDeadline = (promise, ms, fallback = null) => Promise.race([
  Promise.resolve(promise).catch(() => fallback),
  new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
]);

export default function App() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [startup, setStartup] = useState({ ready: false, onboarding: false, settings: null });
  const [updateOpen, setUpdateOpen] = useState(false);
  const [wardrobe, setWardrobe] = useState(null);
  const autoShownVersion = useRef(null);
  const updater = useUpdater();
  const network = useNetwork();

  const activeAccount = accounts.find(a => a.id === activeId) ?? (accounts.length > 0 ? accounts[0] : null);
  // Cosmetics decorate the account; they must never overwrite its identity
  // (`active.skinId` is a skin id, not an account id).
  // Microsoft accounts use their official Mojang skin, never a Native wardrobe one.
  const cosmetics = (activeAccount && activeAccount.type !== 'microsoft' && wardrobe && wardrobe.accountId === activeAccount.id) ? wardrobe.active : null;
  const account = useMemo(() => {
    if (!activeAccount) return GUEST;
    return {
      ...activeAccount,
      ...cosmetics,
      id: activeAccount.id,
      isMicrosoft: activeAccount.type === 'microsoft'
    };
  }, [activeAccount, cosmetics]);

  // Back online after being offline: publish locker changes made offline and tell
  // Relay / Locker to refresh, all in the background. Nothing blocks the UI.
  const netState = network.status?.state;
  const prevNetState = useRef(netState);
  const activeAccountRef = useRef(null);
  activeAccountRef.current = activeAccount;
  useEffect(() => {
    const previous = prevNetState.current;
    prevNetState.current = netState;
    if (netState !== 'online' || !previous || previous === 'online') return;
    const current = activeAccountRef.current;
    window.dispatchEvent(new CustomEvent('native:reconnected'));
    if (current && current.type === 'native' && window.native?.wardrobe?.sync) {
      window.native.wardrobe.sync(current).then((res) => {
        if (res?.state) setWardrobe({ ...res.state, accountId: current.id });
      }).catch(() => {});
    }
  }, [netState]);

  // Live: when the website, another PC, or a store equip changes this account's locker, the server
  // sends `wardrobe:changed` and the cloud copy is pulled right away (no restart, no manual sync).
  useEffect(() => {
    const social = window.native?.social;
    if (!social?.onSocialEvent || !window.native?.wardrobe?.refresh) return undefined;
    let busy = false;
    let again = false;
    const run = async () => {
      const current = activeAccountRef.current;
      if (!current || current.type !== 'native') return;
      if (busy) { again = true; return; }
      busy = true;
      try {
        const res = await window.native.wardrobe.refresh(current);
        if (res?.pulled && res.state && activeAccountRef.current?.id === current.id) {
          setWardrobe({ ...res.state, accountId: current.id });
          window.dispatchEvent(new CustomEvent('native:wardrobe-refreshed'));
        }
      } catch { /* the next event or sync retries */ }
      busy = false;
      if (again) { again = false; run(); }
    };
    return social.onSocialEvent((event) => {
      if (event?.type === 'wardrobe:changed') run();
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!activeAccount || !window.native?.wardrobe?.get) {
      setWardrobe(null);
      return undefined;
    }
    window.native.wardrobe.get(activeAccount).then((value) => {
      if (!cancelled) setWardrobe({ ...value, accountId: activeAccount.id });
    }).catch(() => { if (!cancelled) setWardrobe(null); });
    return () => { cancelled = true; };
  }, [activeAccount?.id]);

  useEffect(() => {
    window.native?.onMaximizedChange(setIsMaximized);

    const loadStartup = async () => {
      if (window.native) {
        const [accountData, settings, instanceData] = await Promise.all([
          window.native.accounts?.list(),
          window.native.settings?.load(),
          window.native.instances?.load()
        ]);

        const accs = accountData?.accounts ?? [];
        let actId = accountData?.activeId ?? null;
        if (accs.length > 0 && (!actId || !accs.some(a => a.id === actId))) {
          actId = accs[0].id;
          window.native?.accounts?.setActive?.(actId).catch(() => {});
        }
        setAccounts(accs);
        setActiveId(actId);

        const initialAccount = accs.find(a => a.id === actId) ?? null;
        if (initialAccount && window.native.wardrobe?.get) {
          try {
            // Skins are optional; offline, don't hold the first screen for them.
            const initialWardrobe = await withDeadline(window.native.wardrobe.get(initialAccount), 3000);
            if (initialWardrobe) {
              setWardrobe({ ...initialWardrobe, accountId: initialAccount.id });
            }
          } catch (e) {
            console.warn('Could not load initial wardrobe:', e);
          }
        }

        const completion = settings?.onboarding?.completed;
        const hasExistingData = Boolean(
          accountData?.accounts?.length || instanceData?.instances?.length
        );
        const onboarding = completion === true ? false : completion === false ? true : !hasExistingData;
        setApplicationLocale(settings?.onboarding?.language || 'en');

        // Transparently mark pre-onboarding installs as complete.
        let migratedSettings = settings;
        if (completion == null && hasExistingData) {
          migratedSettings = {
            ...settings,
            onboarding: { language: settings?.onboarding?.language || 'en', completed: true }
          };
          await window.native.settings?.save(migratedSettings);
        }

        setStartup({ ready: true, onboarding, settings: migratedSettings, instances: instanceData });

        // Background sync so any remote cloud updates are pulled seamlessly
        if (initialAccount && window.native.wardrobe?.sync) {
          window.native.wardrobe.sync(initialAccount).then((res) => {
            if (res?.pulled && res?.state) {
              setWardrobe({ ...res.state, accountId: initialAccount.id });
            } else if (res?.ok) {
              window.native.wardrobe.get(initialAccount).then((w) => {
                if (w) setWardrobe({ ...w, accountId: initialAccount.id });
              }).catch(() => {});
            }
          }).catch(() => {});
        }
        return;
      }

      const savedAccounts = [];
      const rawSettings = localStorage.getItem('native.settings');
      const rawInstances = localStorage.getItem('native.instances');
      let settings = rawSettings ? JSON.parse(rawSettings) : {};
      if (!settings.appearance || settings.appearance.theme !== 'black') {
        settings = { ...settings, appearance: { ...(settings.appearance || {}), theme: 'black' } };
        try {
          localStorage.setItem('native.settings', JSON.stringify(settings));
        } catch {}
      }
      const instanceData = rawInstances ? JSON.parse(rawInstances) : null;
      const completion = settings?.onboarding?.completed;
      const hasExistingData = Boolean(instanceData?.instances?.length);
      const onboarding = completion === true ? false : completion === false ? true : !hasExistingData;
      setApplicationLocale(settings?.onboarding?.language || 'en');

      setAccounts(savedAccounts);
      setStartup({ ready: true, onboarding, settings, instances: instanceData });
    };

    loadStartup().catch((error) => {
      console.error('Could not load startup state:', error);
      setStartup({ ready: true, onboarding: true, settings: {}, instances: null });
    });
  }, []);

  useEffect(() => {
    const { type, version } = updater.status;
    if (type === 'available' && version && autoShownVersion.current !== version) {
      autoShownVersion.current = version;
      setUpdateOpen(true);
    }
    if (type === 'downloaded') setUpdateOpen(true);
  }, [updater.status]);

  const refreshAccounts = async () => {
    const res = await window.native?.accounts?.list();
    if (res) {
      const accs = res.accounts ?? [];
      let actId = res.activeId ?? null;
      if (accs.length > 0 && (!actId || !accs.some(a => a.id === actId))) {
        actId = accs[0].id;
        window.native?.accounts?.setActive?.(actId).catch(() => {});
      }
      setAccounts(accs);
      setActiveId(actId);
    }
  };

  const handleAddMicrosoft = async () => {
    const res = await window.native?.accounts?.addMicrosoft();
    if (res?.ok) await refreshAccounts();
    return res;
  };

  const handleAddOffline = async (name) => {
    const res = await window.native?.accounts?.addOffline(name);
    if (res?.ok) {
      await refreshAccounts();
      if (res.account?.id) setActiveId(res.account.id);
    }
    return res;
  };

  const handleAddNative = async (payload) => {
    const bridge = window.native;
    const res = await bridge?.accounts?.addNative?.(payload)
      || await bridge?.accounts?.addNative?.(payload)
      || await bridge?.accounts?.addOffline?.(typeof payload === 'string' ? payload : payload?.name);
    if (res?.ok) {
      await refreshAccounts();
      if (res.account?.id) setActiveId(res.account.id);
    }
    return res;
  };


  const handleNativeSendCode = async (payload) => {
    return await window.native?.accounts?.nativeSendCode?.(payload);
  };

  const handleNativeResendCode = async (payload) => {
    return await window.native?.accounts?.nativeResendCode?.(payload);
  };

  const handleNativeVerifyRegister = async (payload) => {
    const res = await window.native?.accounts?.nativeVerifyRegister?.(payload);
    if (res?.ok) {
      await refreshAccounts();
      if (res.account?.id) setActiveId(res.account.id);
    }
    return res;
  };

  const handleNativeLogin = async (payload) => {
    const res = await window.native?.accounts?.nativeLogin?.(payload);
    if (res?.ok) {
      await refreshAccounts();
      if (res.account?.id) setActiveId(res.account.id);
    }
    return res;
  };

  const handleSwitchAccount = async (id) => {
    await window.native?.accounts?.setActive(id);
    setActiveId(id);
    const target = accounts.find(a => a.id === id);
    if (target && window.native?.wardrobe?.get) {
      try {
        const w = await window.native.wardrobe.get(target);
        if (w) setWardrobe({ ...w, accountId: id });
      } catch {}
    }
  };

  // Premium ↔ Native: connect, disconnect, and keep a connected premium
  // account signed into its Native account in the background.
  const handleConnectNative = async (payload) => {
    const res = await window.native?.accounts?.connectNative?.(payload);
    await refreshAccounts();
    return res || { ok: false, error: 'Connecting accounts is not available in this build.' };
  };

  const handleDisconnectNative = async (microsoftAccountId) => {
    const res = await window.native?.accounts?.disconnectNative?.(microsoftAccountId);
    await refreshAccounts();
    return res || { ok: false, error: 'Disconnecting accounts is not available in this build.' };
  };

  // Native names can change elsewhere (a premium owner claiming theirs).
  useEffect(() => {
    window.native?.accounts?.refreshNames?.().then((res) => { if (res?.changed) refreshAccounts(); }).catch(() => {});
  }, []);

  const handleClaimName = async (microsoftAccountId) => {
    const res = await window.native?.accounts?.claimName?.(microsoftAccountId);
    await refreshAccounts();
    return res || { ok: false, error: 'Not available in this build.' };
  };

  const ensuredPremiumRef = useRef(null);
  useEffect(() => {
    if (!activeAccount || activeAccount.type !== 'microsoft' || !window.native?.accounts?.ensureNative) return undefined;
    if (ensuredPremiumRef.current === activeAccount.id) return undefined;
    ensuredPremiumRef.current = activeAccount.id;
    let cancelled = false;
    const before = activeAccount.nativeLink?.userId || null;
    window.native.accounts.ensureNative(activeAccount.id).then((res) => {
      const after = res?.ok ? res.link?.userId || null : null;
      if (!cancelled && after !== before) refreshAccounts();
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [activeAccount?.id, activeAccount?.type]);

  const handleRemoveAccount = async (id) => {
    await window.native?.accounts?.remove(id);
    await refreshAccounts();
  };

  const handleOnboardingComplete = async ({ language, instance }) => {
    const instanceData = { instances: [instance], selectedId: instance.id };
    const nextSettings = {
      ...(startup.settings ?? {}),
      onboarding: { completed: true, language }
    };

    // Save the instance first. The completion marker is written last so a
    // failed write never strands the user outside setup without an instance.
    if (window.native) {
      await window.native.instances.save(instanceData);
      const savedSettings = await window.native.settings.save(nextSettings);
      setStartup({ ready: true, onboarding: false, settings: savedSettings ?? nextSettings, instances: instanceData });
    } else {
      localStorage.setItem('native.instances', JSON.stringify(instanceData));
      localStorage.setItem('native.settings', JSON.stringify(nextSettings));
      setStartup({ ready: true, onboarding: false, settings: nextSettings, instances: instanceData });
    }
  };

  // Fade out the boot splash (index.html) once the first real screen has
  // painted: two frames after commit guarantees layout and paint happened.
  useEffect(() => {
    if (!startup.ready) return undefined;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => window.__nativeBootDone?.());
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [startup.ready]);

  if (!startup.ready) {
    return <div className="window-frame" aria-label="Loading Native Client" />;
  }

  return (
    <div className={`window-frame${isMaximized ? ' maximized' : ''}`}>
      <UpdateCenter
        open={updateOpen}
        onClose={() => setUpdateOpen(false)}
        status={updater.status}
        onCheck={updater.check}
        onDownload={updater.download}
        onCancel={updater.cancel}
        onInstall={updater.install}
      />
      <Shell
        isMaximized={isMaximized}
        account={account}
        accounts={accounts}
        activeId={activeId}
        initialInstances={startup.instances}
        onAddMicrosoft={handleAddMicrosoft}
        onAddOffline={handleAddOffline}
        onAddNative={handleAddNative}
        onNativeSendCode={handleNativeSendCode}
        onNativeResendCode={handleNativeResendCode}
        onNativeVerifyRegister={handleNativeVerifyRegister}
        onNativeLogin={handleNativeLogin}
        onSwitchAccount={handleSwitchAccount}
        onRemoveAccount={handleRemoveAccount}
        onConnectNative={handleConnectNative}
        onDisconnectNative={handleDisconnectNative}
        onClaimName={handleClaimName}
        onWardrobeChanged={(value) => setWardrobe({ ...value, accountId: activeAccount?.id })}
        updateStatus={updater.status}
        networkStatus={network.status}
        onOpenUpdater={() => setUpdateOpen(true)}
      />
    </div>
  );
}
