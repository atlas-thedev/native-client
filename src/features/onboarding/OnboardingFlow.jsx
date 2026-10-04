import { useEffect, useMemo, useState } from 'react';
import Logo from '../../components/ui/Logo.jsx';
import NativeIcon from '../../components/ui/NativeIcon.jsx';
import PlayerAvatar from '../../components/ui/PlayerAvatar.jsx';
import { getClusterArt } from '../../data/versionsData.js';
import {
  getFabricGameVersions,
  getVersionManifest,
  loaderAvailability
} from '../../lib/mojang.js';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import './OnboardingFlow.css';

const LANGUAGES = [
  { code: 'en', name: 'English', region: 'United States' },
  { code: 'es', name: 'Español', region: 'España' },
  { code: 'de', name: 'Deutsch', region: 'Deutschland' },
  { code: 'fr', name: 'Français', region: 'France' },
  { code: 'pt-BR', name: 'Português', region: 'Brasil' },
  { code: 'tr', name: 'Türkçe', region: 'Türkiye' }
];

const SUPPORTED_LOADERS = ['Vanilla', 'Fabric', 'Forge'];
const OFFLINE_NAME = /^[A-Za-z0-9_]{3,16}$/;

function suggestedLanguage() {
  const browserLanguage = navigator.language || 'en';
  return LANGUAGES.find((item) => browserLanguage.toLowerCase().startsWith(item.code.toLowerCase()))?.code || 'en';
}

function createInstance({ name, version, loader, memoryMb }) {
  const cleanName = name.trim();
  return {
    id: `native-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: cleanName,
    version,
    mc_version: version,
    loader,
    mc_loader: loader,
    memoryMb,
    art: getClusterArt({ version, mc_version: version }),
    description: `Minecraft ${version}`,
    tags: [loader, 'Custom'],
    group: null,
    icon: null,
    playtimeSecs: 0,
    sessionCount: 0,
    avgSessionSecs: 0,
    activeDays: 0,
    serverJoins: 0,
    created: Date.now(),
    lastPlayed: null
  };
}

function WindowControls({ isMaximized }) {
  const { t } = useI18n();
  return (
    <div className="onboarding-window-controls">
      <button type="button" onClick={() => window.native?.minimize()} aria-label={t('window.minimize')}>
        <NativeIcon name="minimize" size={15} />
      </button>
      <button type="button" onClick={() => window.native?.maximize()} aria-label={t(isMaximized ? 'window.restore' : 'window.maximize')}>
        <NativeIcon name={isMaximized ? 'restore' : 'maximize'} size={14} />
      </button>
      <button type="button" className="onboarding-close" onClick={() => window.native?.close()} aria-label={t('common.close')}>
        <NativeIcon name="close" size={15} />
      </button>
    </div>
  );
}

export default function OnboardingFlow({
  isMaximized,
  accounts = [],
  activeId,
  initialLanguage,
  onAddMicrosoft,
  onAddOffline,
  onSwitchAccount,
  onComplete
}) {
  const { t, setLocale } = useI18n();
  const [step, setStep] = useState(0);
  const [language, setLanguage] = useState(
    LANGUAGES.some((item) => item.code === initialLanguage) ? initialLanguage : suggestedLanguage()
  );
  const [offlineName, setOfflineName] = useState('');
  const [accountError, setAccountError] = useState('');
  const [accountBusy, setAccountBusy] = useState(false);
  const [manifest, setManifest] = useState(null);
  const [fabricSet, setFabricSet] = useState(null);
  const [version, setVersion] = useState('');
  const [loader, setLoader] = useState('Fabric');
  const [instanceName, setInstanceName] = useState(() => t('onboarding.defaultInstance'));
  const [instanceNameTouched, setInstanceNameTouched] = useState(false);
  const [memoryMb, setMemoryMb] = useState(4096);
  const [finishError, setFinishError] = useState('');
  const [finishing, setFinishing] = useState(false);

  const activeAccount = accounts.find((item) => item.id === activeId) || accounts[0] || null;

  useEffect(() => {
    setLocale(language);
    if (!instanceNameTouched) setInstanceName(t('onboarding.defaultInstance'));
  }, [language, instanceNameTouched, setLocale, t]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getVersionManifest(), getFabricGameVersions()]).then(([data, fabric]) => {
      if (cancelled) return;
      setManifest(data);
      setFabricSet(fabric);
      setVersion((current) => current || data.latest?.release || data.versions[0]?.id || '');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!version || loader !== 'Fabric' || !fabricSet) return;
    if (!loaderAvailability('Fabric', version, fabricSet).available) setLoader('Vanilla');
  }, [fabricSet, loader, version]);

  const releases = useMemo(
    () => (manifest?.versions || []).filter((entry) => entry.type === 'release').slice(0, 40),
    [manifest]
  );
  const availability = loaderAvailability(loader, version, fabricSet);
  const canCreate = Boolean(instanceName.trim() && version && availability.available && activeAccount);

  const addMicrosoft = async () => {
    setAccountBusy(true);
    setAccountError('');
    try {
      const result = await onAddMicrosoft?.();
      if (!result?.ok) throw new Error(result?.error || t('error.microsoftLogin'));
    } catch (error) {
      setAccountError(error?.message || t('error.microsoftLogin'));
    } finally {
      setAccountBusy(false);
    }
  };

  const addOffline = async () => {
    const name = offlineName.trim();
    if (!OFFLINE_NAME.test(name)) {
      setAccountError(t('error.offlineName'));
      return;
    }

    setAccountBusy(true);
    setAccountError('');
    try {
      const result = await onAddOffline?.(name);
      if (!result?.ok) throw new Error(result?.error || t('error.offlineAccount'));
      setOfflineName('');
    } catch (error) {
      setAccountError(error?.message || t('error.offlineAccount'));
    } finally {
      setAccountBusy(false);
    }
  };

  const finish = async () => {
    if (!canCreate) return;
    setFinishing(true);
    setFinishError('');
    try {
      await onComplete?.({
        language,
        instance: createInstance({ name: instanceName, version, loader, memoryMb })
      });
    } catch (error) {
      setFinishError(error?.message || t('error.saveSetup'));
      setFinishing(false);
    }
  };

  return (
    <main className="onboarding">
      <header className="onboarding-titlebar">
        <Logo height={28} />
        <WindowControls isMaximized={isMaximized} />
      </header>

      <section className="onboarding-stage">
        <div className="onboarding-heading">
          <h1>{t('onboarding.setup')}</h1>
          <span>{t('onboarding.step', { current: step + 1, total: 3 })}</span>
        </div>
        <nav className="onboarding-progress" aria-label={t('onboarding.setup')}>
          {[t('onboarding.language'), t('onboarding.account'), t('onboarding.instance')].map((label, index) => (
            <div key={label} className={`onboarding-progress-item ${index === step ? 'active' : ''} ${index < step ? 'done' : ''}`}>
              <span>{index < step ? <NativeIcon name="check" size={12} /> : index + 1}</span>
              <strong>{label}</strong>
            </div>
          ))}
        </nav>

        <div className="onboarding-panel" key={step}>
          <div className="onboarding-copy">
            {step === 0 && (
              <>
                <h2>{t('onboarding.languageTitle')}</h2>
                <p>{t('onboarding.languageBody')}</p>
                <div className="onboarding-language-list" role="radiogroup" aria-label={t('onboarding.language')}>
                  {LANGUAGES.map((item) => (
                    <button
                      key={item.code}
                      type="button"
                      role="radio"
                      aria-checked={language === item.code}
                      className={`onboarding-language-option ${language === item.code ? 'selected' : ''}`}
                      onClick={() => setLanguage(item.code)}
                    >
                      <span className="onboarding-language-code">{item.code.split('-')[0].toUpperCase()}</span>
                      <span className="onboarding-language-name">
                        <strong>{item.name}</strong>
                        <small>{item.region}</small>
                      </span>
                      {language === item.code && <NativeIcon name="check-circle" size={18} />}
                    </button>
                  ))}
                </div>
              </>
            )}

            {step === 1 && (
              <>
                <h2>{t('onboarding.accountTitle')}</h2>
                <p>{t('onboarding.accountBody')}</p>

                {activeAccount ? (
                  <div className="onboarding-account-ready">
                    <PlayerAvatar account={activeAccount} kind="avatar" size={50} />
                    <span>
                      <small>{t('onboarding.readyAs')}</small>
                      <strong>{activeAccount.name}</strong>
                    </span>
                    <span className="onboarding-account-type">
                      {activeAccount.type === 'microsoft' ? t('account.microsoft') : t('account.offline')}
                    </span>
                  </div>
                ) : (
                  <>
                    <button type="button" className="onboarding-microsoft" onClick={addMicrosoft} disabled={accountBusy}>
                      <span className="onboarding-ms-mark"><i /><i /><i /><i /></span>
                      <span><strong>{t('onboarding.microsoft')}</strong><small>{t('onboarding.microsoftHint')}</small></span>
                      <NativeIcon name="arrow-right" size={17} />
                    </button>

                    <div className="onboarding-or"><span>{t('onboarding.offlineDivider')}</span></div>
                    <div className="onboarding-offline-row">
                      <label>
                        <span>{t('onboarding.username')}</span>
                        <input
                          value={offlineName}
                          maxLength={16}
                          autoFocus
                          placeholder="Steve"
                          onChange={(event) => {
                            setOfflineName(event.target.value);
                            setAccountError('');
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') addOffline();
                          }}
                        />
                      </label>
                      <button type="button" onClick={addOffline} disabled={accountBusy || !offlineName.trim()}>
                        {t('onboarding.createOffline')}
                      </button>
                    </div>
                  </>
                )}

                {accounts.length > 1 && (
                  <div className="onboarding-existing-accounts">
                    {accounts.map((item) => (
                      <button key={item.id} type="button" className={item.id === activeId ? 'active' : ''} onClick={() => onSwitchAccount?.(item.id)}>
                        {item.name}
                      </button>
                    ))}
                  </div>
                )}
                {accountError && <p className="onboarding-error"><NativeIcon name="alert" size={14} />{accountError}</p>}
              </>
            )}

            {step === 2 && (
              <>
                <h2>{t('onboarding.instanceTitle')}</h2>
                <p>{t('onboarding.instanceBody')}</p>
                <div className="onboarding-instance-form">
                  <label className="onboarding-field onboarding-field-wide">
                    <span>{t('onboarding.instanceName')}</span>
                    <input value={instanceName} maxLength={60} onChange={(event) => { setInstanceName(event.target.value); setInstanceNameTouched(true); }} />
                  </label>
                  <label className="onboarding-field">
                    <span>{t('onboarding.minecraftVersion')}</span>
                    <select value={version} onChange={(event) => setVersion(event.target.value)} disabled={!releases.length}>
                      {!releases.length && <option>{t('onboarding.loadingVersions')}</option>}
                      {releases.map((entry) => <option key={entry.id} value={entry.id}>{entry.id}</option>)}
                    </select>
                  </label>
                  <div className="onboarding-field">
                    <span>{t('onboarding.modLoader')}</span>
                    <div className="onboarding-loader-options">
                      {SUPPORTED_LOADERS.map((item) => {
                        const state = loaderAvailability(item, version, fabricSet);
                        return (
                          <button key={item} type="button" className={loader === item ? 'selected' : ''} disabled={!state.available} title={state.reasonKey ? t(state.reasonKey, state.reasonVars) : item} onClick={() => setLoader(item)}>
                            {item}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <label className="onboarding-field onboarding-field-wide">
                    <span className="onboarding-memory-label"><span>{t('onboarding.memory')}</span><strong>{(memoryMb / 1024).toFixed(1)} GB</strong></span>
                    <input type="range" min="1024" max="16384" step="512" value={memoryMb} onChange={(event) => setMemoryMb(Number(event.target.value))} />
                  </label>
                </div>
                {manifest?.offline && !releases.length && <p className="onboarding-error"><NativeIcon name="alert" size={14} />{t('onboarding.noVersions')}</p>}
                {finishError && <p className="onboarding-error"><NativeIcon name="alert" size={14} />{finishError}</p>}
              </>
            )}
          </div>

        </div>

        <footer className="onboarding-actions">
          <button type="button" className="onboarding-back" onClick={() => setStep((value) => Math.max(0, value - 1))} disabled={step === 0 || finishing}>
            <NativeIcon name="arrow-left" size={16} /> {t('common.back')}
          </button>
          {step < 2 ? (
            <button type="button" className="onboarding-next" onClick={() => setStep((value) => value + 1)} disabled={(step === 1 && !activeAccount) || accountBusy}>
              {t('common.continue')} <NativeIcon name="arrow-right" size={16} />
            </button>
          ) : (
            <button type="button" className="onboarding-next" onClick={finish} disabled={!canCreate || finishing}>
              {finishing ? t('onboarding.finishing') : t('onboarding.finish')}
              <NativeIcon name={finishing ? 'refresh' : 'check'} size={16} className={finishing ? 'is-spinning' : ''} />
            </button>
          )}
        </footer>
      </section>
    </main>
  );
}
