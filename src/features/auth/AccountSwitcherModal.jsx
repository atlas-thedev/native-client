import React, { useEffect, useState, useRef } from 'react';
import { ArrowLeft, Check, ChevronRight, Eye, EyeOff, Globe, GitMerge, Minus, Square, Trash2, WifiOff, X } from 'lucide-react';
import Logo from '../../components/ui/Logo.jsx';
import NativeIcon from '../../components/ui/NativeIcon.jsx';
import ProviderLogo from '../../components/ui/ProviderLogo.jsx';
import BrandIcon from '../../components/ui/BrandIcon.jsx';
import PlayerAvatar from '../../components/ui/PlayerAvatar.jsx';
import { preloadAccountAvatars } from '../../lib/skins.js';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import packageInfo from '../../../package.json';
import loginSide from '../../assets/native-login-side.png';
import './AccountSwitcherModal.css';

const OFFLINE_NAME = /^[A-Za-z0-9_]{3,16}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const COMMUNITY = {
  discord: 'https://discord.gg/m9QpHFP8e',
  youtube: 'https://www.youtube.com/@native-client'
};

const LEGAL = 'https://nativelaunch.xyz';

/** "just now", "5 min ago", "3 days ago", "Mar 4" */
function lastUsedLabel(ms) {
  const at = Number(ms);
  if (!at) return '';
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 2) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** The little provider mark on the corner of a saved account's face. */
function ProviderBadge({ type }) {
  if (type === 'microsoft') return <span className="acc-card-badge is-ms" title="Microsoft"><i /><i /><i /><i /></span>;
  if (type === 'offline') return <span className="acc-card-badge is-offline" title="Offline"><WifiOff size={9} strokeWidth={2.6} /></span>;
  return <span className="acc-card-badge is-native" title="Native"><Logo height={9} variant="mark" /></span>;
}

/**
 * A saved account on the login screen: face with its provider mark, name, how it signs in and when it was last
 * used. Click anywhere to continue as that player; the tools (website, merge, remove) show on hover.
 */
function AccountCard({ account, active, confirming, onChoose, onMerge, onWebsite, onRemove, t }) {
  const type = account.type === 'microsoft' ? 'microsoft' : account.type === 'offline' ? 'offline' : 'native';
  const merged = type === 'microsoft' && account.nativeLink?.type === 'merged';
  const provider = type === 'microsoft' ? (t('account.microsoft') || 'Microsoft') : type === 'offline' ? 'Offline' : 'Native';
  const detail = type === 'native' && account.email ? account.email : type === 'offline' ? 'This PC only' : '';
  const when = active ? '' : lastUsedLabel(account.lastUsedAt);
  const stop = (fn) => (event) => { event.stopPropagation(); fn(); };
  return (
    <div
      role="listitem"
      className={`acc-card is-${type}${active ? ' is-active' : ''}${confirming ? ' is-confirming' : ''}`}
      tabIndex={0}
      onClick={onChoose}
      onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onChoose(); } }}
      aria-label={`${active ? 'Signed in as' : 'Continue as'} ${account.name}, ${provider}`}
      aria-current={active ? 'true' : undefined}
    >
      <span className="acc-card-face">
        <PlayerAvatar account={account} kind="avatar" size={38} radius={9} />
        <ProviderBadge type={type} />
      </span>
      <span className="acc-card-text">
        <strong>{account.name}</strong>
        <small>
          <b className="acc-card-provider">{provider}</b>
          {merged && <span className="acc-card-chip" title={`Merged with ${account.nativeLink.email || 'your Native account'}`}><GitMerge size={9} strokeWidth={2.6} aria-hidden="true" />Merged</span>}
          {detail && <span className="acc-card-detail">{detail}</span>}
          {when && <span className="acc-card-when">{when}</span>}
        </small>
      </span>
      <span className="acc-card-end">
      <span className="acc-card-tools">
        {onWebsite && (
          <button type="button" className="acc-card-tool" title="Open nativelaunch.xyz signed in" aria-label={`Open the Native website as ${account.name}`} onClick={stop(onWebsite)}>
            <Globe size={13} strokeWidth={2.2} />
          </button>
        )}
        {onMerge && (
          <button type="button" className="acc-card-tool" title="Merge with an email Native account" aria-label={`Merge ${account.name} with a Native account`} onClick={stop(onMerge)}>
            <GitMerge size={13} strokeWidth={2.2} />
          </button>
        )}
        <button type="button" className={`acc-card-tool is-danger${confirming ? ' is-armed' : ''}`} title={confirming ? 'Click again to remove' : (t('account.remove') || 'Remove')} aria-label={confirming ? `Confirm removing ${account.name}` : `Remove ${account.name}`} onClick={stop(onRemove)}>
          <Trash2 size={13} strokeWidth={2.2} />
          {confirming && <span>Remove?</span>}
        </button>
      </span>
      {active
        ? <span className="acc-card-state"><i aria-hidden="true" />Signed in</span>
        : <span className="acc-card-go" aria-hidden="true"><ChevronRight size={15} strokeWidth={2.4} /></span>}
      </span>
    </div>
  );
}

export default function AccountSwitcherModal({
  open,
  firstRun = false,
  onClose,
  accounts = [],
  activeId,
  onSwitchAccount,
  onAddMicrosoft,
  onAddOffline,
  onAddNative,
  onNativeSendCode,
  onNativeResendCode,
  onNativeVerifyRegister,
  onNativeLogin,
  onRemoveAccount,
  onMergeNative,
  onOpenWebsite,
  connectRequest = null
}) {
  const { t } = useI18n();

  // Navigation view: main or a Native authentication step.
  const [view, setView] = useState('main');
  // Removing a saved account takes two clicks: the bin turns into "Remove?" for a few seconds.
  const [confirmRemove, setConfirmRemove] = useState(null);
  useEffect(() => {
    if (!confirmRemove) return undefined;
    const timer = setTimeout(() => setConfirmRemove(null), 3500);
    return () => clearTimeout(timer);
  }, [confirmRemove]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  // Login form state
  const [loginInput, setLoginInput] = useState('');
  const [offlineName, setOfflineName] = useState('');
  const [passwordInput, setPasswordInput] = useState('');

  // Registration form state
  const [regUsername, setRegUsername] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regModel, setRegModel] = useState('classic');
  const [showPassword, setShowPassword] = useState(false);

  // Password reset state
  const [resetEmail, setResetEmail] = useState('');
  const [resetPassword, setResetPassword] = useState('');
  const [resetConfirm, setResetConfirm] = useState('');

  // Merging a premium account into an email Native account
  const [connectTargetId, setConnectTargetId] = useState(null);
  const [connectDone, setConnectDone] = useState(false);

  // OTP 6-digit verification state
  const [otpDigits, setOtpDigits] = useState(['', '', '', '', '', '']);
  const [countdown, setCountdown] = useState(60);
  const otpRefs = useRef([]);

  useEffect(() => {
    if (open) preloadAccountAvatars(accounts, 128);
  }, [open, accounts]);

  useEffect(() => {
    if (!open || !connectRequest?.id) return;
    setConnectTargetId(connectRequest.id);
    setConnectDone(false);
    setError('');
    setView('native-connect');
  }, [open, connectRequest?.nonce]);

  useEffect(() => {
    window.native?.onMaximizedChange?.(setIsMaximized);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        if (view !== 'main') {
          setView('main');
          setError('');
        } else if (!firstRun) {
          onClose?.();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, firstRun, onClose, view]);

  useEffect(() => {
    if (!open) {
      setView('main');
      setError('');
      setLoginInput('');
      setPasswordInput('');
      setRegUsername('');
      setRegEmail('');
      setRegPassword('');
      setRegModel('classic');
      setResetEmail('');
      setResetPassword('');
      setResetConfirm('');
      setOtpDigits(['', '', '', '', '', '']);
    }
  }, [open]);

  useEffect(() => {
    if ((view !== 'native-verify' && view !== 'native-reset') || countdown <= 0) return undefined;
    const timer = setInterval(() => {
      setCountdown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [view, countdown]);

  if (!open) return null;

  const openExternal = (url) => window.native?.openExternal?.(url);

  const connectTarget = accounts.find((acc) => acc.id === connectTargetId && acc.type === 'microsoft') || null;
  const savedNativeAccounts = accounts.filter((acc) => acc.type === 'native');

  const openConnect = (microsoftAccountId) => {
    setConnectTargetId(microsoftAccountId);
    setConnectDone(false);
    setError('');
    setLoginInput('');
    setPasswordInput('');
    setView('native-connect');
  };

  const runConnect = async (payload) => {
    if (!connectTarget || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await onMergeNative?.({ microsoftAccountId: connectTarget.id, ...payload });
      if (!result?.ok) throw new Error(result?.error || 'Could not merge the accounts.');
      setPasswordInput('');
      setConnectDone(true);
    } catch (err) {
      setError(err?.message || 'Could not merge the accounts.');
    } finally {
      setBusy(false);
    }
  };

  const handleConnectSubmit = (event) => {
    event.preventDefault();
    if (!loginInput.trim() || !passwordInput) return;
    runConnect({ login: loginInput.trim(), password: passwordInput });
  };

  const openWebsite = async (accountId) => {
    setError('');
    const result = await onOpenWebsite?.(accountId);
    if (result && result.ok === false) setError(result.error || 'Could not open the website.');
  };

  const handleAddMicrosoft = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await onAddMicrosoft?.();
      if (result && !result.ok) throw new Error(result.error || t('error.microsoftLogin'));
      if (firstRun || accounts.length === 0) {
        onClose?.();
      }
    } catch (err) {
      setError(err?.message || t('error.microsoftLogin'));
    } finally {
      setBusy(false);
    }
  };

  // Offline accounts need no internet and no Microsoft/Native sign-in:
  // singleplayer, LAN and offline-mode (online-mode=false) servers.
  const handleOfflineSubmit = async (e) => {
    e?.preventDefault?.();
    const name = offlineName.trim();
    if (!OFFLINE_NAME.test(name)) {
      setError(t('error.offlineName') || 'Use 3–16 letters, numbers or underscores.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await onAddOffline?.(name);
      if (!res?.ok) throw new Error(res?.error || 'Could not add the offline account.');
      setOfflineName('');
      setView('main');
      onClose?.();
    } catch (err) {
      setError(err?.message || 'Could not add the offline account.');
    } finally {
      setBusy(false);
    }
  };

  const handleLoginSubmit = async (e) => {
    e?.preventDefault?.();
    const login = loginInput.trim();
    const password = passwordInput;
    if (!login || !password) {
      setError(t('account.loginOrEmail') + ' & ' + t('account.password'));
      return;
    }

    setBusy(true);
    setError('');
    try {
      const res = await onNativeLogin?.({ login, password });
      if (res && !res.ok) {
        throw new Error(res.error || t('error.saveSetup'));
      }
      onClose?.();
    } catch (err) {
      setError(err?.message || t('error.saveSetup'));
    } finally {
      setBusy(false);
    }
  };

  const handleRegisterSendCode = async (e) => {
    e?.preventDefault?.();
    const username = regUsername.trim();
    const email = regEmail.trim().toLowerCase();
    const password = regPassword;

    if (!OFFLINE_NAME.test(username)) {
      setError(t('error.offlineName'));
      return;
    }
    if (!EMAIL_REGEX.test(email)) {
      setError('Please enter a valid email address.');
      return;
    }
    if (!password || password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    setBusy(true);
    setError('');
    try {
      const res = await onNativeSendCode?.({ email, username });
      if (res && !res.ok) {
        throw new Error(res.error || 'Failed to send verification code.');
      }
      setCountdown(60);
      setOtpDigits(['', '', '', '', '', '']);
      setView('native-verify');
      setTimeout(() => otpRefs.current[0]?.focus(), 100);
    } catch (err) {
      setError(err?.message || 'Could not send verification code.');
    } finally {
      setBusy(false);
    }
  };

  const handleResendCode = async () => {
    if (countdown > 0 || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await onNativeResendCode?.({
        email: regEmail.trim().toLowerCase(),
        username: regUsername.trim()
      });
      if (res && !res.ok) {
        throw new Error(res.error || 'Failed to resend code.');
      }
      setCountdown(60);
    } catch (err) {
      setError(err?.message || 'Could not resend code.');
    } finally {
      setBusy(false);
    }
  };

  const handleVerifySubmit = async (e) => {
    e?.preventDefault?.();
    const code = otpDigits.join('').trim();
    if (code.length !== 6) {
      setError(t('account.invalidCode'));
      return;
    }

    setBusy(true);
    setError('');
    try {
      const res = await onNativeVerifyRegister?.({
        email: regEmail.trim().toLowerCase(),
        code,
        username: regUsername.trim(),
        password: regPassword,
        model: regModel
      });
      if (res && !res.ok) {
        throw new Error(res.error || 'Verification failed. Please check the code.');
      }
      onClose?.();
    } catch (err) {
      setError(err?.message || 'Verification failed.');
    } finally {
      setBusy(false);
    }
  };

  const startPasswordReset = () => {
    // Carry over an email typed into the sign-in box.
    if (!resetEmail && EMAIL_REGEX.test(loginInput.trim())) setResetEmail(loginInput.trim());
    setPasswordInput('');
    setError('');
    setView('native-forgot');
  };

  const handleForgotSubmit = async (e) => {
    e?.preventDefault?.();
    const email = resetEmail.trim().toLowerCase();
    if (!EMAIL_REGEX.test(email)) {
      setError('Please enter a valid email address.');
      return;
    }

    setBusy(true);
    setError('');
    try {
      const res = await window.native?.accounts?.nativeForgotPassword?.({ email });
      if (!res) throw new Error('Password reset is not available in this build.');
      if (!res.ok) throw new Error(res.error || 'Could not send a reset code.');
      setResetEmail(email);
      setResetPassword('');
      setResetConfirm('');
      setCountdown(60);
      setOtpDigits(['', '', '', '', '', '']);
      setView('native-reset');
      setTimeout(() => otpRefs.current[0]?.focus(), 100);
    } catch (err) {
      setError(err?.message || 'Could not send a reset code.');
    } finally {
      setBusy(false);
    }
  };

  const handleResendResetCode = async () => {
    if (countdown > 0 || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await window.native?.accounts?.nativeForgotPassword?.({ email: resetEmail.trim().toLowerCase() });
      if (res && !res.ok) throw new Error(res.error || 'Could not resend the code.');
      setCountdown(60);
    } catch (err) {
      setError(err?.message || 'Could not resend the code.');
    } finally {
      setBusy(false);
    }
  };

  const handleResetSubmit = async (e) => {
    e?.preventDefault?.();
    const email = resetEmail.trim().toLowerCase();
    const code = otpDigits.join('').trim();
    if (code.length !== 6) {
      setError(t('account.invalidCode'));
      return;
    }
    if (resetPassword.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (resetPassword !== resetConfirm) {
      setError('Passwords do not match.');
      return;
    }

    setBusy(true);
    setError('');
    try {
      const res = await window.native?.accounts?.nativeResetPassword?.({ email, code, password: resetPassword });
      if (!res) throw new Error('Password reset is not available in this build.');
      if (!res.ok) throw new Error(res.error || 'Could not reset the password.');
      // Sign straight in with the new password.
      const login = await onNativeLogin?.({ login: email, password: resetPassword });
      if (login && !login.ok) {
        setPasswordInput('');
        setLoginInput(email);
        setView('native-login');
        setError('Password updated. Please sign in with your new password.');
        return;
      }
      onClose?.();
    } catch (err) {
      setError(err?.message || 'Could not reset the password.');
    } finally {
      setBusy(false);
    }
  };

  const handleOtpChange = (index, value) => {
    const char = value.slice(-1);
    if (char && !/^[0-9]$/.test(char)) return;

    const next = [...otpDigits];
    next[index] = char;
    setOtpDigits(next);
    setError('');

    if (char && index < 5) {
      otpRefs.current[index + 1]?.focus();
    }
  };

  const handleOtpKeyDown = (index, event) => {
    if (event.key === 'Backspace') {
      if (!otpDigits[index] && index > 0) {
        otpRefs.current[index - 1]?.focus();
      }
    }
  };

  const handleOtpPaste = (event) => {
    event.preventDefault();
    const pasted = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (!pasted) return;

    const next = ['', '', '', '', '', ''];
    for (let i = 0; i < pasted.length; i++) {
      next[i] = pasted[i];
    }
    setOtpDigits(next);
    setError('');
    const nextFocus = Math.min(pasted.length, 5);
    otpRefs.current[nextFocus]?.focus();
  };

  return (
    <div className="account-login-screen" role="dialog" aria-modal="true" aria-label={t('account.accounts')}>
      <div className={`account-login-frame${isMaximized ? ' is-maximized' : ''}`}>
        <div className="account-login-drag-bar" />

        {/* Titlebar branding */}
        <div className="account-login-build">
          <Logo height={11} variant="mark" />
          <span>Native Client</span>
          <span className="account-login-dot">·</span>
          <small>Build {window.native?.version || packageInfo.version || '0.9.2'}</small>
        </div>

        {/* Window controls */}
        <div className="account-login-controls">
          <button type="button" onClick={() => window.native?.minimize()} aria-label={t('window.minimize')}>
            <Minus size={13} />
          </button>
          <button type="button" onClick={() => window.native?.maximize()} aria-label={t('window.maximize')}>
            <Square size={11} />
          </button>
          <button type="button" className="close" onClick={() => window.native?.close()} aria-label={t('common.close')}>
            <X size={14} />
          </button>
        </div>

        <div className="account-login-layout">
          {/* Left Hero Column */}
          <section className="account-login-panel">
            {view === 'main' ? (
              <div className="account-login-content">
                <Logo height={56} variant="mark" className="account-login-logo" />
                <h1 className="account-login-title">
                  Native <strong>Client</strong>
                </h1>

                {/* Action buttons stack */}
                <div className="account-login-actions">
                  <button
                    type="button"
                    className="account-login-microsoft"
                    onClick={handleAddMicrosoft}
                    disabled={busy}
                  >
                    {busy ? (
                      <span className="account-login-btn-loading">
                        <NativeIcon name="refresh" size={18} className="is-spinning" />
                        <span>{t('account.securing') || 'Waiting for Microsoft...'}</span>
                      </span>
                    ) : (
                      <>
                        <span className="account-login-btn-lead">{t('account.logInWith')}</span>
                        <span className="account-login-ms-mark" aria-hidden="true">
                          <i /><i /><i /><i />
                        </span>
                        <strong className="account-login-btn-brand">Microsoft</strong>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    className="account-login-native"
                    onClick={() => {
                      setView('native-login');
                      setError('');
                    }}
                  >
                    <span className="account-login-btn-lead">{t('account.logInWith')}</span>
                    <span className="account-login-native-mark" aria-hidden="true">
                      <Logo height={22} variant="mark" />
                    </span>
                    <strong className="account-login-btn-brand">{t('account.native')}</strong>
                  </button>

                  {onAddOffline && (
                    <>
                      <div className="account-login-divider" aria-hidden="true">
                        <i /><span>or</span><i />
                      </div>
                      <button
                        type="button"
                        className="account-login-offline"
                        onClick={() => {
                          setView('offline');
                          setError('');
                        }}
                      >
                        <WifiOff size={16} strokeWidth={2} aria-hidden="true" />
                        <span className="account-login-offline-label">Play offline</span>
                        <small>No account needed</small>
                      </button>
                    </>
                  )}

                  {/* Saved accounts */}
                  {accounts.length > 0 && (
                    <div className="account-login-saved">
                      <div className="account-login-saved-head">
                        <span>{firstRun ? 'Continue as' : 'Saved accounts'}</span>
                        <small>{accounts.length}</small>
                      </div>
                      <div className="account-login-list" role="list">
                        {accounts.map((acc) => (
                          <AccountCard
                            key={acc.id}
                            account={acc}
                            active={acc.id === activeId}
                            confirming={confirmRemove === acc.id}
                            onChoose={() => {
                              onSwitchAccount?.(acc.id);
                              if (firstRun) onClose?.();
                            }}
                            onMerge={acc.type === 'microsoft' && acc.nativeLink?.type !== 'merged' && onMergeNative ? () => openConnect(acc.id) : null}
                            onWebsite={(acc.type === 'native' || (acc.type === 'microsoft' && acc.nativeLink?.connected)) && onOpenWebsite ? () => openWebsite(acc.id) : null}
                            onRemove={() => {
                              if (confirmRemove !== acc.id) { setConfirmRemove(acc.id); return; }
                              setConfirmRemove(null);
                              onRemoveAccount?.(acc.id);
                            }}
                            t={t}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {error && <div role="alert" className="account-login-error">{error}</div>}

                  {accounts.length > 0 && !firstRun && (
                    <button type="button" className="account-login-home" onClick={onClose}>
                      <ArrowLeft size={16} />
                      <span>{t('account.backHome')}</span>
                    </button>
                  )}
                </div>

                {/* Social links row */}
                <div className="account-login-social" role="group" aria-label={t('account.community') || 'Community'}>
                  {['Discord', 'YouTube'].map((brand) => (
                    <button
                      key={brand}
                      type="button"
                      title={brand}
                      aria-label={brand}
                      className="account-login-social-btn"
                      onClick={() => openExternal(COMMUNITY[brand.toLowerCase()])}
                    >
                      <BrandIcon name={brand.toLowerCase()} size={20} />
                    </button>
                  ))}
                </div>

                {/* Legal navigation */}
                <footer>
                  <button type="button" onClick={() => openExternal(`${LEGAL}/privacy`)}>
                    Privacy Policy
                  </button>
                  <span aria-hidden="true">·</span>
                  <button type="button" onClick={() => openExternal(`${LEGAL}/terms`)}>
                    Terms of Service
                  </button>
                  <span aria-hidden="true">·</span>
                  <button type="button" onClick={() => openExternal(`${LEGAL}/support`)}>
                    Support
                  </button>
                </footer>
              </div>
            ) : view === 'native-connect' ? (
              <div className="native-auth-container native-connect">
                <div className="native-auth-top">
                  <button
                    type="button"
                    className="native-auth-back-btn"
                    onClick={() => { setView('main'); setError(''); setConnectDone(false); }}
                    aria-label={t('common.back')}
                  >
                    <ArrowLeft size={15} />
                    <span>{t('common.back')}</span>
                  </button>
                </div>

                {!connectTarget ? (
                  <div className="native-auth-header">
                    <h2 className="native-auth-title">Merge accounts</h2>
                    <p className="native-auth-sub">Sign in with Microsoft first, then merge your Native account into it.</p>
                  </div>
                ) : (
                  <>
                    <div className={`native-connect-hero${connectTarget.nativeLink?.type === 'merged' ? ' is-linked' : ''}${connectDone ? ' is-done' : ''}`} aria-hidden="true">
                      <span className="native-connect-node">
                        <PlayerAvatar account={connectTarget} kind="avatar" size={44} />
                      </span>
                      <span className="native-connect-wire">
                        <i /><i /><i />
                        <b className="native-connect-badge">
                          {connectTarget.nativeLink?.type === 'merged' ? <Check size={13} strokeWidth={3} /> : <GitMerge size={13} strokeWidth={2.4} />}
                        </b>
                      </span>
                      <span className="native-connect-node is-native">
                        <Logo height={26} variant="mark" />
                      </span>
                    </div>

                    {connectTarget.nativeLink?.type === 'merged' ? (
                      <div className="native-connect-body">
                        <div className="native-auth-header">
                          <h2 className="native-auth-title">{connectDone ? 'Merged' : 'Accounts merged'}</h2>
                          <p className="native-auth-sub">
                            Your Native account{connectTarget.nativeLink.email ? <> (<strong>{connectTarget.nativeLink.email}</strong>)</> : null} is now <strong>{connectTarget.nativeLink.name}</strong>.
                            Friends, chats and cloaks came along. Sign in with Microsoft on any PC, or with your email and password on the website.
                          </p>
                        </div>
                        {error && <div className="account-login-error" role="alert">{error}</div>}
                        <div className="native-connect-actions">
                          <button type="button" className="native-auth-primary-btn" onClick={() => { setView('main'); setConnectDone(false); }}>
                            Done
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="native-connect-body">
                        <div className="native-auth-header">
                          <h2 className="native-auth-title">Merge a Native account into {connectTarget.name}</h2>
                          <p className="native-auth-sub">
                            Your Native account takes the name <strong>{connectTarget.name}</strong> and keeps its friends, chats and cloaks.
                            Anything this Microsoft account had on Native moves into it. This can’t be undone.
                          </p>
                        </div>

                        {savedNativeAccounts.length > 0 && (
                          <div className="native-connect-saved">
                            <span className="native-form-label">Your signed-in Native accounts</span>
                            {savedNativeAccounts.map((acc) => (
                              <button
                                key={acc.id}
                                type="button"
                                className="account-login-item native-connect-choice"
                                disabled={busy}
                                onClick={() => { setLoginInput(acc.email || acc.name); setError(''); }}
                              >
                                <PlayerAvatar account={acc} kind="avatar" size={26} />
                                <span className="account-login-item-text">
                                  <strong>{acc.name}</strong>
                                  <small className="is-native">{acc.email || 'Native'}</small>
                                </span>
                                <span className="native-connect-choice-cta">Use</span>
                              </button>
                            ))}
                          </div>
                        )}

                        <form className="native-auth-form" onSubmit={handleConnectSubmit}>
                          <div className="native-form-group">
                            <label className="native-form-label" htmlFor="native-connect-login">{t('account.loginOrEmail')}</label>
                            <input
                              id="native-connect-login"
                              type="text"
                              className="native-form-input"
                              placeholder={t('account.loginOrEmail')}
                              value={loginInput}
                              autoComplete="username"
                              autoFocus={savedNativeAccounts.length === 0}
                              onChange={(e) => { setLoginInput(e.target.value); setError(''); }}
                            />
                          </div>
                          <div className="native-form-group">
                            <label className="native-form-label" htmlFor="native-connect-password">{t('account.password')}</label>
                            <div className="native-input-wrap">
                              <input
                                id="native-connect-password"
                                type={showPassword ? 'text' : 'password'}
                                className="native-form-input has-toggle"
                                placeholder="••••••••"
                                value={passwordInput}
                                autoComplete="current-password"
                                onChange={(e) => { setPasswordInput(e.target.value); setError(''); }}
                              />
                              <button
                                type="button"
                                className="native-input-toggle"
                                onClick={() => setShowPassword((v) => !v)}
                                aria-label={showPassword ? 'Hide password' : 'Show password'}
                                aria-pressed={showPassword}
                              >
                                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                              </button>
                            </div>
                          </div>

                          {error && <div className="account-login-error" role="alert">{error}</div>}

                          <button
                            type="submit"
                            className="native-auth-primary-btn"
                            disabled={busy || !loginInput.trim() || !passwordInput}
                          >
                            {busy ? (
                              <span className="native-btn-spinner">
                                <NativeIcon name="refresh" size={16} className="is-spinning" />
                                <span>Merging…</span>
                              </span>
                            ) : (
                              'Merge accounts'
                            )}
                          </button>
                          <p className="native-connect-fine">
                            Merging is one-way. Your email and password keep working; your Microsoft password never reaches Native.
                          </p>
                        </form>
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : view === 'offline' ? (
              <div className="native-auth-container">
                <div className="native-auth-top">
                  <button
                    type="button"
                    className="native-auth-back-btn"
                    onClick={() => { setView('main'); setError(''); }}
                    aria-label={t('common.back')}
                  >
                    <ArrowLeft size={15} />
                    <span>{t('common.back')}</span>
                  </button>
                </div>

                <div className="native-auth-header">
                  <Logo height={48} variant="mark" className="native-auth-clean-logo" />
                  <h2 className="native-auth-title">Play offline</h2>
                  <p className="native-auth-sub">
                    No internet or sign-in needed. Works in singleplayer, on LAN and on offline-mode servers.
                  </p>
                </div>

                <form className="native-auth-form" onSubmit={handleOfflineSubmit}>
                  <div className="native-form-group">
                    <label className="native-form-label">Username</label>
                    <input
                      type="text"
                      className="native-form-input"
                      placeholder="Steve"
                      value={offlineName}
                      maxLength={16}
                      autoFocus
                      spellCheck={false}
                      onChange={(e) => { setOfflineName(e.target.value.replace(/\s/g, '')); setError(''); }}
                    />
                  </div>

                  {error && <div className="account-login-error" role="alert">{error}</div>}

                  <button
                    type="submit"
                    className="native-auth-primary-btn"
                    disabled={busy || !OFFLINE_NAME.test(offlineName.trim())}
                  >
                    {busy ? (
                      <span className="native-btn-spinner">
                        <NativeIcon name="refresh" size={16} className="is-spinning" />
                      </span>
                    ) : (
                      'Play offline'
                    )}
                  </button>
                </form>
              </div>
            ) : view === 'native-login' ? (
              <div className="native-auth-container">
                <div className="native-auth-top">
                  <button
                    type="button"
                    className="native-auth-back-btn"
                    onClick={() => { setView('main'); setError(''); }}
                    aria-label={t('common.back')}
                  >
                    <ArrowLeft size={15} />
                    <span>{t('common.back')}</span>
                  </button>
                </div>

                <div className="native-auth-header">
                  <Logo height={48} variant="mark" className="native-auth-clean-logo" />
                  <h2 className="native-auth-title">{t('account.nativeLogin')}</h2>
                  <p className="native-auth-sub">{t('account.nativeSubtitle')}</p>
                </div>

                <form className="native-auth-form" onSubmit={handleLoginSubmit}>
                  <div className="native-form-group">
                    <label className="native-form-label">{t('account.loginOrEmail')}</label>
                    <input
                      type="text"
                      className="native-form-input"
                      placeholder={t('account.loginOrEmail')}
                      value={loginInput}
                      autoFocus
                      onChange={(e) => { setLoginInput(e.target.value); setError(''); }}
                    />
                  </div>

                  <div className="native-form-group">
                    <label className="native-form-label">{t('account.password')}</label>
                    <div className="native-input-wrap">
                      <input
                        type={showPassword ? 'text' : 'password'}
                        className="native-form-input has-toggle"
                        placeholder="••••••••"
                        value={passwordInput}
                        onChange={(e) => { setPasswordInput(e.target.value); setError(''); }}
                      />
                      <button
                        type="button"
                        className="native-input-toggle"
                        onClick={() => setShowPassword((v) => !v)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        aria-pressed={showPassword}
                      >
                        {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                  </div>

                  <div className="native-resend-row" style={{ justifyContent: 'flex-end' }}>
                    <button type="button" className="native-link-btn" onClick={startPasswordReset}>
                      Forgot password?
                    </button>
                  </div>

                  {error && <div className="account-login-error" role="alert">{error}</div>}

                  <button
                    type="submit"
                    className="native-auth-primary-btn"
                    disabled={busy || !loginInput.trim() || !passwordInput}
                  >
                    {busy ? (
                      <span className="native-btn-spinner">
                        <NativeIcon name="refresh" size={16} className="is-spinning" />
                        <span>{t('account.securing')}</span>
                      </span>
                    ) : (
                      t('account.logInWithNative')
                    )}
                  </button>

                  <div className="native-auth-switch-link">
                    <span>{t('account.dontHaveAccount')}</span>
                    <button
                      type="button"
                      className="native-link-btn"
                      onClick={() => { setView('native-register'); setError(''); }}
                    >
                      {t('account.createNativeLink')}
                    </button>
                  </div>
                </form>
              </div>
            ) : view === 'native-register' ? (
              <div className="native-auth-container">
                <div className="native-auth-top">
                  <button
                    type="button"
                    className="native-auth-back-btn"
                    onClick={() => { setView('main'); setError(''); }}
                    aria-label={t('common.back')}
                  >
                    <ArrowLeft size={15} />
                    <span>{t('common.back')}</span>
                  </button>
                </div>

                <div className="native-auth-header">
                  <div className="native-avatar-preview-wrap">
                    <PlayerAvatar
                      name={regUsername.trim() || 'Steve'}
                      kind="avatar"
                      size={50}
                      radius={12}
                    />
                  </div>
                  <span className="native-auth-step">Step 1 of 2</span>
                  <h2 className="native-auth-title">{t('account.createNative')}</h2>
                  <p className="native-auth-sub">{t('account.nativeSubtitle')}</p>
                </div>

                <form className="native-auth-form" onSubmit={handleRegisterSendCode}>
                  <div className="native-form-group">
                    <label className="native-form-label">{t('onboarding.username')}</label>
                    <input
                      type="text"
                      className="native-form-input"
                      maxLength={16}
                      placeholder="e.g. Steve"
                      value={regUsername}
                      autoFocus
                      onChange={(e) => { setRegUsername(e.target.value); setError(''); }}
                    />
                  </div>

                  <div className="native-form-group">
                    <label className="native-form-label">{t('account.email')}</label>
                    <input
                      type="email"
                      className="native-form-input"
                      placeholder="name@example.com"
                      value={regEmail}
                      onChange={(e) => { setRegEmail(e.target.value); setError(''); }}
                    />
                  </div>

                  <div className="native-form-group">
                    <label className="native-form-label">{t('account.password')}</label>
                    <div className="native-input-wrap">
                      <input
                        type={showPassword ? 'text' : 'password'}
                        className="native-form-input has-toggle"
                        placeholder="At least 6 characters"
                        value={regPassword}
                        onChange={(e) => { setRegPassword(e.target.value); setError(''); }}
                      />
                      <button
                        type="button"
                        className="native-input-toggle"
                        onClick={() => setShowPassword((v) => !v)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        aria-pressed={showPassword}
                      >
                        {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                  </div>

                  <div className="native-form-group">
                    <label className="native-form-label">{t('account.model')}</label>
                    <div className="native-model-pills" role="radiogroup">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={regModel === 'classic'}
                        className={`native-model-pill ${regModel === 'classic' ? 'active' : ''}`}
                        onClick={() => setRegModel('classic')}
                      >
                        {t('account.modelClassic')}
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={regModel === 'slim'}
                        className={`native-model-pill ${regModel === 'slim' ? 'active' : ''}`}
                        onClick={() => setRegModel('slim')}
                      >
                        {t('account.modelSlim')}
                      </button>
                    </div>
                  </div>

                  {error && <div className="account-login-error" role="alert">{error}</div>}

                  <button
                    type="submit"
                    className="native-auth-primary-btn"
                    disabled={busy || !regUsername.trim() || !regEmail.trim() || !regPassword}
                  >
                    {busy ? (
                      <span className="native-btn-spinner">
                        <NativeIcon name="refresh" size={16} className="is-spinning" />
                        <span>{t('account.securing')}</span>
                      </span>
                    ) : (
                      t('account.sendCode')
                    )}
                  </button>

                  <div className="native-auth-switch-link">
                    <span>{t('account.alreadyHaveAccount')}</span>
                    <button
                      type="button"
                      className="native-link-btn"
                      onClick={() => { setView('native-login'); setError(''); }}
                    >
                      {t('account.logInLink')}
                    </button>
                  </div>
                </form>
              </div>
            ) : view === 'native-verify' ? (
              <div className="native-auth-container">
                <div className="native-auth-top">
                  <button
                    type="button"
                    className="native-auth-back-btn"
                    onClick={() => { setView('native-register'); setError(''); }}
                    aria-label={t('account.changeEmail')}
                  >
                    <ArrowLeft size={15} />
                    <span>{t('account.changeEmail')}</span>
                  </button>
                </div>

                <div className="native-auth-header">
                  <Logo height={48} variant="mark" className="native-auth-clean-logo" />
                  <span className="native-auth-step">Step 2 of 2</span>
                  <h2 className="native-auth-title">{t('account.verifyCodeTitle')}</h2>
                  <p className="native-auth-sub">
                    {t('account.verifyCodeSubtitle', { email: regEmail })}
                  </p>
                </div>

                <form className="native-auth-form" onSubmit={handleVerifySubmit}>
                  <div className="native-otp-container">
                    {otpDigits.map((digit, idx) => (
                      <input
                        key={idx}
                        ref={(el) => (otpRefs.current[idx] = el)}
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={1}
                        className={`native-otp-box ${digit ? 'filled' : ''}`}
                        value={digit}
                        onChange={(e) => handleOtpChange(idx, e.target.value)}
                        onKeyDown={(e) => handleOtpKeyDown(idx, e)}
                        onPaste={handleOtpPaste}
                        autoFocus={idx === 0}
                      />
                    ))}
                  </div>

                  {error && <div className="account-login-error" role="alert">{error}</div>}

                  <button
                    type="submit"
                    className="native-auth-primary-btn"
                    disabled={busy || otpDigits.join('').length < 6}
                  >
                    {busy ? (
                      <span className="native-btn-spinner">
                        <NativeIcon name="refresh" size={16} className="is-spinning" />
                        <span>{t('account.securing')}</span>
                      </span>
                    ) : (
                      t('account.verifyAndPlay')
                    )}
                  </button>

                  <div className="native-resend-row">
                    {countdown > 0 ? (
                      <span className="native-countdown-text">
                        {t('account.resendIn').replace('{seconds}', countdown)}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="native-link-btn"
                        disabled={busy}
                        onClick={handleResendCode}
                      >
                        {t('account.resendCode')}
                      </button>
                    )}
                  </div>
                </form>
              </div>
            ) : view === 'native-forgot' ? (
              <div className="native-auth-container">
                <div className="native-auth-top">
                  <button
                    type="button"
                    className="native-auth-back-btn"
                    onClick={() => { setView('native-login'); setError(''); }}
                    aria-label={t('common.back')}
                  >
                    <ArrowLeft size={15} />
                    <span>{t('common.back')}</span>
                  </button>
                </div>

                <div className="native-auth-header">
                  <Logo height={48} variant="mark" className="native-auth-clean-logo" />
                  <h2 className="native-auth-title">Reset your password</h2>
                  <p className="native-auth-sub">Enter the email for your Native account and we'll send you a 6-digit code.</p>
                </div>

                <form className="native-auth-form" onSubmit={handleForgotSubmit}>
                  <div className="native-form-group">
                    <label className="native-form-label">Email</label>
                    <input
                      type="email"
                      className="native-form-input"
                      placeholder="you@example.com"
                      value={resetEmail}
                      autoFocus
                      onChange={(e) => { setResetEmail(e.target.value); setError(''); }}
                    />
                  </div>

                  {error && <div className="account-login-error" role="alert">{error}</div>}

                  <button
                    type="submit"
                    className="native-auth-primary-btn"
                    disabled={busy || !resetEmail.trim()}
                  >
                    {busy ? (
                      <span className="native-btn-spinner">
                        <NativeIcon name="refresh" size={16} className="is-spinning" />
                        <span>{t('account.securing')}</span>
                      </span>
                    ) : (
                      'Send reset code'
                    )}
                  </button>
                </form>
              </div>
            ) : view === 'native-reset' ? (
              <div className="native-auth-container">
                <div className="native-auth-top">
                  <button
                    type="button"
                    className="native-auth-back-btn"
                    onClick={() => { setView('native-forgot'); setError(''); }}
                    aria-label={t('account.changeEmail')}
                  >
                    <ArrowLeft size={15} />
                    <span>{t('account.changeEmail')}</span>
                  </button>
                </div>

                <div className="native-auth-header">
                  <Logo height={48} variant="mark" className="native-auth-clean-logo" />
                  <h2 className="native-auth-title">Choose a new password</h2>
                  <p className="native-auth-sub">
                    If an account exists for {resetEmail}, we sent it a 6-digit code. Enter it below with your new password.
                  </p>
                </div>

                <form className="native-auth-form" onSubmit={handleResetSubmit}>
                  <div className="native-otp-container">
                    {otpDigits.map((digit, idx) => (
                      <input
                        key={idx}
                        ref={(el) => (otpRefs.current[idx] = el)}
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={1}
                        className={`native-otp-box ${digit ? 'filled' : ''}`}
                        value={digit}
                        onChange={(e) => handleOtpChange(idx, e.target.value)}
                        onKeyDown={(e) => handleOtpKeyDown(idx, e)}
                        onPaste={handleOtpPaste}
                        autoFocus={idx === 0}
                      />
                    ))}
                  </div>

                  <div className="native-form-group">
                    <label className="native-form-label">New password</label>
                    <div className="native-input-wrap">
                      <input
                        type={showPassword ? 'text' : 'password'}
                        className="native-form-input has-toggle"
                        placeholder="••••••••"
                        autoComplete="new-password"
                        value={resetPassword}
                        onChange={(e) => { setResetPassword(e.target.value); setError(''); }}
                      />
                      <button
                        type="button"
                        className="native-input-toggle"
                        onClick={() => setShowPassword((v) => !v)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        aria-pressed={showPassword}
                      >
                        {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                  </div>

                  <div className="native-form-group">
                    <label className="native-form-label">Confirm new password</label>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      className="native-form-input"
                      placeholder="••••••••"
                      autoComplete="new-password"
                      value={resetConfirm}
                      onChange={(e) => { setResetConfirm(e.target.value); setError(''); }}
                    />
                  </div>

                  {error && <div className="account-login-error" role="alert">{error}</div>}

                  <button
                    type="submit"
                    className="native-auth-primary-btn"
                    disabled={busy || otpDigits.join('').length < 6 || !resetPassword || !resetConfirm}
                  >
                    {busy ? (
                      <span className="native-btn-spinner">
                        <NativeIcon name="refresh" size={16} className="is-spinning" />
                        <span>{t('account.securing')}</span>
                      </span>
                    ) : (
                      'Reset password'
                    )}
                  </button>

                  <div className="native-resend-row">
                    {countdown > 0 ? (
                      <span className="native-countdown-text">
                        {t('account.resendIn').replace('{seconds}', countdown)}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="native-link-btn"
                        disabled={busy}
                        onClick={handleResendResetCode}
                      >
                        {t('account.resendCode')}
                      </button>
                    )}
                  </div>
                </form>
              </div>
            ) : null}
          </section>

          {/* Right Artwork Panel */}
          <aside className="account-login-art" aria-hidden="true">
            <img src={loginSide} alt="A purple-lit Minecraft cavern with the Native mark" />
          </aside>
        </div>
      </div>
    </div>
  );
}
