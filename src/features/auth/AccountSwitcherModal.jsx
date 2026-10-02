import React, { useEffect, useState, useRef } from 'react';
import { ArrowLeft, Check, Eye, EyeOff, Link2, Minus, Square, Unlink, X } from 'lucide-react';
import Logo from '../../components/ui/Logo.jsx';
import NativeIcon from '../../components/ui/NativeIcon.jsx';
import BrandIcon from '../../components/ui/BrandIcon.jsx';
import PlayerAvatar from '../../components/ui/PlayerAvatar.jsx';
import { preloadAccountAvatars } from '../../lib/skins.js';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import packageInfo from '../../../package.json';
import loginSide from '../../assets/noctra-login-side.png';
import './AccountSwitcherModal.css';

const OFFLINE_NAME = /^[A-Za-z0-9_]{3,16}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const COMMUNITY = {
  discord: 'https://discord.gg/noctra',
  x: 'https://x.com/noctraclient',
  instagram: 'https://instagram.com/noctraclient',
  youtube: 'https://youtube.com/@noctraclient',
  patreon: 'https://patreon.com/noctraclient'
};

const LEGAL = 'https://noctra.client';

export default function AccountSwitcherModal({
  open,
  firstRun = false,
  onClose,
  accounts = [],
  activeId,
  onSwitchAccount,
  onAddMicrosoft,
  onAddOffline,
  onAddNoctra,
  onAddNative,
  onNoctraSendCode,
  onNoctraResendCode,
  onNoctraVerifyRegister,
  onNoctraLogin,
  onRemoveAccount,
  onConnectNoctra,
  onDisconnectNoctra,
  connectRequest = null
}) {
  const { t } = useI18n();

  // Navigation view: main or a Noctra authentication step.
  const [view, setView] = useState('main');
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

  // Premium ↔ Noctra connection
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
    setView('noctra-connect');
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
    if ((view !== 'noctra-verify' && view !== 'noctra-reset') || countdown <= 0) return undefined;
    const timer = setInterval(() => {
      setCountdown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [view, countdown]);

  if (!open) return null;

  const openExternal = (url) => window.native?.openExternal?.(url);

  const connectTarget = accounts.find((acc) => acc.id === connectTargetId && acc.type === 'microsoft') || null;
  const savedNoctraAccounts = accounts.filter((acc) => acc.type === 'noctra' || acc.type === 'native');

  const openConnect = (microsoftAccountId) => {
    setConnectTargetId(microsoftAccountId);
    setConnectDone(false);
    setError('');
    setLoginInput('');
    setPasswordInput('');
    setView('noctra-connect');
  };

  const runConnect = async (payload) => {
    if (!connectTarget || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await onConnectNoctra?.({ microsoftAccountId: connectTarget.id, ...payload });
      if (!result?.ok) throw new Error(result?.error || 'Could not connect the accounts.');
      setPasswordInput('');
      setConnectDone(true);
    } catch (err) {
      setError(err?.message || 'Could not connect the accounts.');
    } finally {
      setBusy(false);
    }
  };

  const handleConnectSubmit = (event) => {
    event.preventDefault();
    if (!loginInput.trim() || !passwordInput) return;
    runConnect({ login: loginInput.trim(), password: passwordInput });
  };

  const handleDisconnect = async () => {
    if (!connectTarget || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await onDisconnectNoctra?.(connectTarget.id);
      if (!result?.ok) throw new Error(result?.error || 'Could not disconnect.');
      setConnectDone(false);
    } catch (err) {
      setError(err?.message || 'Could not disconnect.');
    } finally {
      setBusy(false);
    }
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

  // Offline accounts need no internet and no Microsoft/Noctra sign-in:
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
      const res = await onNoctraLogin?.({ login, password });
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
      const res = await onNoctraSendCode?.({ email, username });
      if (res && !res.ok) {
        throw new Error(res.error || 'Failed to send verification code.');
      }
      setCountdown(60);
      setOtpDigits(['', '', '', '', '', '']);
      setView('noctra-verify');
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
      const res = await onNoctraResendCode?.({
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
      const res = await onNoctraVerifyRegister?.({
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
    setView('noctra-forgot');
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
      const res = await window.native?.accounts?.noctraForgotPassword?.({ email });
      if (!res) throw new Error('Password reset is not available in this build.');
      if (!res.ok) throw new Error(res.error || 'Could not send a reset code.');
      setResetEmail(email);
      setResetPassword('');
      setResetConfirm('');
      setCountdown(60);
      setOtpDigits(['', '', '', '', '', '']);
      setView('noctra-reset');
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
      const res = await window.native?.accounts?.noctraForgotPassword?.({ email: resetEmail.trim().toLowerCase() });
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
      const res = await window.native?.accounts?.noctraResetPassword?.({ email, code, password: resetPassword });
      if (!res) throw new Error('Password reset is not available in this build.');
      if (!res.ok) throw new Error(res.error || 'Could not reset the password.');
      // Sign straight in with the new password.
      const login = await onNoctraLogin?.({ login: email, password: resetPassword });
      if (login && !login.ok) {
        setPasswordInput('');
        setLoginInput(email);
        setView('noctra-login');
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
          <span>Noctra Client</span>
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
                <Logo height={80} variant="mark" className="account-login-logo" />
                <h1 className="account-login-title">
                  Noctra <strong>Client</strong>
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
                    className="account-login-noctra account-login-native"
                    onClick={() => {
                      setView('noctra-login');
                      setError('');
                    }}
                  >
                    <span className="account-login-btn-lead">{t('account.logInWith')}</span>
                    <span className="account-login-noctra-mark account-login-native-mark" aria-hidden="true">
                      <Logo height={32} variant="mark" />
                    </span>
                    <strong className="account-login-btn-brand">{t('account.noctra') || t('account.native')}</strong>
                  </button>

                  {onAddOffline && (
                    <button
                      type="button"
                      className="account-login-offline-link"
                      style={{
                        alignSelf: 'center',
                        background: 'none',
                        border: 0,
                        padding: '4px 6px',
                        marginTop: 2,
                        font: 'inherit',
                        fontSize: 12.5,
                        color: 'var(--fg-muted, #9aa0a6)',
                        textDecoration: 'underline',
                        textUnderlineOffset: 3,
                        cursor: 'pointer'
                      }}
                      onClick={() => {
                        setView('offline');
                        setError('');
                      }}
                    >
                      Play offline
                    </button>
                  )}

                  {/* Saved accounts */}
                  {accounts.length > 0 && (
                    <div className="account-login-saved">
                      <div className="account-login-saved-head">
                        <span>Saved accounts</span>
                        <small>{accounts.length}</small>
                      </div>
                      <div className="account-login-list">
                        {accounts.map((acc) => {
                          const active = acc.id === activeId;
                          const choose = () => {
                            onSwitchAccount?.(acc.id);
                            if (firstRun) onClose?.();
                          };
                          return (
                            <div
                              key={acc.id}
                              className={`account-login-item ${active ? 'active' : ''}`}
                              role="button"
                              tabIndex={0}
                              onClick={choose}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') choose();
                              }}
                            >
                              <PlayerAvatar account={acc} kind="avatar" size={30} />
                              <div className="account-login-item-text">
                                <strong>{acc.name}</strong>
                                <small className={acc.type === 'microsoft' ? 'is-ms' : 'is-noctra is-native'}>
                                  {acc.type === 'microsoft' ? t('account.microsoft') : acc.type === 'offline' ? 'Offline' : (t('account.noctra') || t('account.native'))}
                                  {acc.type === 'microsoft' && acc.noctraLink?.connected && (
                                    <span className="account-login-item-link" title={`Signs into Noctra as ${acc.noctraLink.name}`}>
                                      <Link2 size={10} strokeWidth={2.4} aria-hidden="true" /> {acc.noctraLink.name}
                                    </span>
                                  )}
                                </small>
                              </div>
                              {acc.type === 'microsoft' && onConnectNoctra && (
                                <button
                                  type="button"
                                  className={`account-login-item-connect${acc.noctraLink?.connected ? ' is-connected' : ''}`}
                                  title={acc.noctraLink?.connected ? 'Noctra connection' : 'Connect a Noctra account'}
                                  aria-label={acc.noctraLink?.connected ? `Noctra connection for ${acc.name}` : `Connect a Noctra account to ${acc.name}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openConnect(acc.id);
                                  }}
                                >
                                  <Link2 size={12} strokeWidth={2.2} aria-hidden="true" />
                                  {!acc.noctraLink?.connected && <span>Connect</span>}
                                </button>
                              )}
                              {active && <span className="account-login-item-active">Active</span>}
                              <button
                                type="button"
                                className="account-login-item-remove"
                                title={t('account.remove')}
                                aria-label={t('account.remove')}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onRemoveAccount?.(acc.id);
                                }}
                              >
                                <NativeIcon name="trash" size={13} />
                              </button>
                            </div>
                          );
                        })}
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
                  {['Discord', 'X', 'Instagram', 'YouTube', 'Patreon'].map((brand) => (
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
            ) : view === 'noctra-connect' ? (
              <div className="noctra-auth-container noctra-connect">
                <div className="noctra-auth-top">
                  <button
                    type="button"
                    className="noctra-auth-back-btn"
                    onClick={() => { setView('main'); setError(''); setConnectDone(false); }}
                    aria-label={t('common.back')}
                  >
                    <ArrowLeft size={15} />
                    <span>{t('common.back')}</span>
                  </button>
                </div>

                {!connectTarget ? (
                  <div className="noctra-auth-header">
                    <h2 className="noctra-auth-title">Connect Noctra</h2>
                    <p className="noctra-auth-sub">Sign in with Microsoft first, then connect your Noctra account to it.</p>
                  </div>
                ) : (
                  <>
                    <div className={`noctra-connect-hero${connectTarget.noctraLink?.connected ? ' is-linked' : ''}${connectDone ? ' is-done' : ''}`} aria-hidden="true">
                      <span className="noctra-connect-node">
                        <PlayerAvatar account={connectTarget} kind="avatar" size={44} />
                      </span>
                      <span className="noctra-connect-wire">
                        <i /><i /><i />
                        <b className="noctra-connect-badge">
                          {connectTarget.noctraLink?.connected ? <Check size={13} strokeWidth={3} /> : <Link2 size={13} strokeWidth={2.4} />}
                        </b>
                      </span>
                      <span className="noctra-connect-node is-noctra">
                        <Logo height={26} variant="mark" />
                      </span>
                    </div>

                    {connectTarget.noctraLink?.connected ? (
                      <div className="noctra-connect-body">
                        <div className="noctra-auth-header">
                          <h2 className="noctra-auth-title">{connectDone ? 'Connected' : 'Noctra is connected'}</h2>
                          <p className="noctra-auth-sub">
                            <strong>{connectTarget.name}</strong> signs into Noctra as <strong>{connectTarget.noctraLink.name}</strong> automatically,
                            on this PC and any other where you use this premium account. Relay, friends and chat just work.
                          </p>
                        </div>
                        {error && <div className="account-login-error" role="alert">{error}</div>}
                        <div className="noctra-connect-actions">
                          <button type="button" className="noctra-auth-primary-btn" onClick={() => { setView('main'); setConnectDone(false); }}>
                            Done
                          </button>
                          <button type="button" className="noctra-connect-disconnect" onClick={handleDisconnect} disabled={busy}>
                            <Unlink size={13} aria-hidden="true" />
                            <span>{busy ? 'Disconnecting…' : 'Disconnect'}</span>
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="noctra-connect-body">
                        <div className="noctra-auth-header">
                          <h2 className="noctra-auth-title">Connect Noctra to {connectTarget.name}</h2>
                          <p className="noctra-auth-sub">
                            Do it once. Every time you sign in with this premium account, Noctra signs you in too.
                          </p>
                        </div>

                        {savedNoctraAccounts.length > 0 && (
                          <div className="noctra-connect-saved">
                            <span className="noctra-form-label">Use a signed-in Noctra account</span>
                            {savedNoctraAccounts.map((acc) => (
                              <button
                                key={acc.id}
                                type="button"
                                className="account-login-item noctra-connect-choice"
                                disabled={busy}
                                onClick={() => runConnect({ noctraAccountId: acc.id })}
                              >
                                <PlayerAvatar account={acc} kind="avatar" size={26} />
                                <span className="account-login-item-text">
                                  <strong>{acc.name}</strong>
                                  <small className="is-noctra">Noctra</small>
                                </span>
                                <span className="noctra-connect-choice-cta">Connect</span>
                              </button>
                            ))}
                            <span className="noctra-connect-or"><i />or sign in<i /></span>
                          </div>
                        )}

                        <form className="noctra-auth-form" onSubmit={handleConnectSubmit}>
                          <div className="noctra-form-group">
                            <label className="noctra-form-label" htmlFor="noctra-connect-login">{t('account.loginOrEmail')}</label>
                            <input
                              id="noctra-connect-login"
                              type="text"
                              className="noctra-form-input"
                              placeholder={t('account.loginOrEmail')}
                              value={loginInput}
                              autoComplete="username"
                              autoFocus={savedNoctraAccounts.length === 0}
                              onChange={(e) => { setLoginInput(e.target.value); setError(''); }}
                            />
                          </div>
                          <div className="noctra-form-group">
                            <label className="noctra-form-label" htmlFor="noctra-connect-password">{t('account.password')}</label>
                            <div className="noctra-input-wrap">
                              <input
                                id="noctra-connect-password"
                                type={showPassword ? 'text' : 'password'}
                                className="noctra-form-input has-toggle"
                                placeholder="••••••••"
                                value={passwordInput}
                                autoComplete="current-password"
                                onChange={(e) => { setPasswordInput(e.target.value); setError(''); }}
                              />
                              <button
                                type="button"
                                className="noctra-input-toggle"
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
                            className="noctra-auth-primary-btn"
                            disabled={busy || !loginInput.trim() || !passwordInput}
                          >
                            {busy ? (
                              <span className="noctra-btn-spinner">
                                <NativeIcon name="refresh" size={16} className="is-spinning" />
                                <span>Connecting…</span>
                              </span>
                            ) : (
                              'Connect accounts'
                            )}
                          </button>
                          <p className="noctra-connect-fine">
                            Noctra checks with Microsoft that you own this Minecraft account. Your Microsoft password never reaches Noctra.
                          </p>
                        </form>
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : view === 'offline' ? (
              <div className="noctra-auth-container">
                <div className="noctra-auth-top">
                  <button
                    type="button"
                    className="noctra-auth-back-btn"
                    onClick={() => { setView('main'); setError(''); }}
                    aria-label={t('common.back')}
                  >
                    <ArrowLeft size={15} />
                    <span>{t('common.back')}</span>
                  </button>
                </div>

                <div className="noctra-auth-header">
                  <Logo height={48} variant="mark" className="noctra-auth-clean-logo" />
                  <h2 className="noctra-auth-title">Play offline</h2>
                  <p className="noctra-auth-sub">
                    No internet or sign-in needed. Works in singleplayer, on LAN and on offline-mode servers.
                  </p>
                </div>

                <form className="noctra-auth-form" onSubmit={handleOfflineSubmit}>
                  <div className="noctra-form-group">
                    <label className="noctra-form-label">Username</label>
                    <input
                      type="text"
                      className="noctra-form-input"
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
                    className="noctra-auth-primary-btn"
                    disabled={busy || !OFFLINE_NAME.test(offlineName.trim())}
                  >
                    {busy ? (
                      <span className="noctra-btn-spinner">
                        <NativeIcon name="refresh" size={16} className="is-spinning" />
                      </span>
                    ) : (
                      'Play offline'
                    )}
                  </button>
                </form>
              </div>
            ) : view === 'noctra-login' ? (
              <div className="noctra-auth-container">
                <div className="noctra-auth-top">
                  <button
                    type="button"
                    className="noctra-auth-back-btn"
                    onClick={() => { setView('main'); setError(''); }}
                    aria-label={t('common.back')}
                  >
                    <ArrowLeft size={15} />
                    <span>{t('common.back')}</span>
                  </button>
                </div>

                <div className="noctra-auth-header">
                  <Logo height={48} variant="mark" className="noctra-auth-clean-logo" />
                  <h2 className="noctra-auth-title">{t('account.noctraLogin')}</h2>
                  <p className="noctra-auth-sub">{t('account.nativeSubtitle')}</p>
                </div>

                <form className="noctra-auth-form" onSubmit={handleLoginSubmit}>
                  <div className="noctra-form-group">
                    <label className="noctra-form-label">{t('account.loginOrEmail')}</label>
                    <input
                      type="text"
                      className="noctra-form-input"
                      placeholder={t('account.loginOrEmail')}
                      value={loginInput}
                      autoFocus
                      onChange={(e) => { setLoginInput(e.target.value); setError(''); }}
                    />
                  </div>

                  <div className="noctra-form-group">
                    <label className="noctra-form-label">{t('account.password')}</label>
                    <div className="noctra-input-wrap">
                      <input
                        type={showPassword ? 'text' : 'password'}
                        className="noctra-form-input has-toggle"
                        placeholder="••••••••"
                        value={passwordInput}
                        onChange={(e) => { setPasswordInput(e.target.value); setError(''); }}
                      />
                      <button
                        type="button"
                        className="noctra-input-toggle"
                        onClick={() => setShowPassword((v) => !v)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        aria-pressed={showPassword}
                      >
                        {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                  </div>

                  <div className="noctra-resend-row" style={{ justifyContent: 'flex-end' }}>
                    <button type="button" className="noctra-link-btn" onClick={startPasswordReset}>
                      Forgot password?
                    </button>
                  </div>

                  {error && <div className="account-login-error" role="alert">{error}</div>}

                  <button
                    type="submit"
                    className="noctra-auth-primary-btn"
                    disabled={busy || !loginInput.trim() || !passwordInput}
                  >
                    {busy ? (
                      <span className="noctra-btn-spinner">
                        <NativeIcon name="refresh" size={16} className="is-spinning" />
                        <span>{t('account.securing')}</span>
                      </span>
                    ) : (
                      t('account.logInWithNoctra')
                    )}
                  </button>

                  <div className="noctra-auth-switch-link">
                    <span>{t('account.dontHaveAccount')}</span>
                    <button
                      type="button"
                      className="noctra-link-btn"
                      onClick={() => { setView('noctra-register'); setError(''); }}
                    >
                      {t('account.createNoctraLink')}
                    </button>
                  </div>
                </form>
              </div>
            ) : view === 'noctra-register' ? (
              <div className="noctra-auth-container">
                <div className="noctra-auth-top">
                  <button
                    type="button"
                    className="noctra-auth-back-btn"
                    onClick={() => { setView('main'); setError(''); }}
                    aria-label={t('common.back')}
                  >
                    <ArrowLeft size={15} />
                    <span>{t('common.back')}</span>
                  </button>
                </div>

                <div className="noctra-auth-header">
                  <div className="noctra-avatar-preview-wrap">
                    <PlayerAvatar
                      name={regUsername.trim() || 'Steve'}
                      kind="avatar"
                      size={50}
                      radius={12}
                    />
                  </div>
                  <span className="noctra-auth-step">Step 1 of 2</span>
                  <h2 className="noctra-auth-title">{t('account.createNoctra')}</h2>
                  <p className="noctra-auth-sub">{t('account.nativeSubtitle')}</p>
                </div>

                <form className="noctra-auth-form" onSubmit={handleRegisterSendCode}>
                  <div className="noctra-form-group">
                    <label className="noctra-form-label">{t('onboarding.username')}</label>
                    <input
                      type="text"
                      className="noctra-form-input"
                      maxLength={16}
                      placeholder="e.g. Steve"
                      value={regUsername}
                      autoFocus
                      onChange={(e) => { setRegUsername(e.target.value); setError(''); }}
                    />
                  </div>

                  <div className="noctra-form-group">
                    <label className="noctra-form-label">{t('account.email')}</label>
                    <input
                      type="email"
                      className="noctra-form-input"
                      placeholder="name@example.com"
                      value={regEmail}
                      onChange={(e) => { setRegEmail(e.target.value); setError(''); }}
                    />
                  </div>

                  <div className="noctra-form-group">
                    <label className="noctra-form-label">{t('account.password')}</label>
                    <div className="noctra-input-wrap">
                      <input
                        type={showPassword ? 'text' : 'password'}
                        className="noctra-form-input has-toggle"
                        placeholder="At least 6 characters"
                        value={regPassword}
                        onChange={(e) => { setRegPassword(e.target.value); setError(''); }}
                      />
                      <button
                        type="button"
                        className="noctra-input-toggle"
                        onClick={() => setShowPassword((v) => !v)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        aria-pressed={showPassword}
                      >
                        {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                  </div>

                  <div className="noctra-form-group">
                    <label className="noctra-form-label">{t('account.model')}</label>
                    <div className="noctra-model-pills" role="radiogroup">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={regModel === 'classic'}
                        className={`noctra-model-pill ${regModel === 'classic' ? 'active' : ''}`}
                        onClick={() => setRegModel('classic')}
                      >
                        {t('account.modelClassic')}
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={regModel === 'slim'}
                        className={`noctra-model-pill ${regModel === 'slim' ? 'active' : ''}`}
                        onClick={() => setRegModel('slim')}
                      >
                        {t('account.modelSlim')}
                      </button>
                    </div>
                  </div>

                  {error && <div className="account-login-error" role="alert">{error}</div>}

                  <button
                    type="submit"
                    className="noctra-auth-primary-btn"
                    disabled={busy || !regUsername.trim() || !regEmail.trim() || !regPassword}
                  >
                    {busy ? (
                      <span className="noctra-btn-spinner">
                        <NativeIcon name="refresh" size={16} className="is-spinning" />
                        <span>{t('account.securing')}</span>
                      </span>
                    ) : (
                      t('account.sendCode')
                    )}
                  </button>

                  <div className="noctra-auth-switch-link">
                    <span>{t('account.alreadyHaveAccount')}</span>
                    <button
                      type="button"
                      className="noctra-link-btn"
                      onClick={() => { setView('noctra-login'); setError(''); }}
                    >
                      {t('account.logInLink')}
                    </button>
                  </div>
                </form>
              </div>
            ) : view === 'noctra-verify' ? (
              <div className="noctra-auth-container">
                <div className="noctra-auth-top">
                  <button
                    type="button"
                    className="noctra-auth-back-btn"
                    onClick={() => { setView('noctra-register'); setError(''); }}
                    aria-label={t('account.changeEmail')}
                  >
                    <ArrowLeft size={15} />
                    <span>{t('account.changeEmail')}</span>
                  </button>
                </div>

                <div className="noctra-auth-header">
                  <Logo height={48} variant="mark" className="noctra-auth-clean-logo" />
                  <span className="noctra-auth-step">Step 2 of 2</span>
                  <h2 className="noctra-auth-title">{t('account.verifyCodeTitle')}</h2>
                  <p className="noctra-auth-sub">
                    {t('account.verifyCodeSubtitle', { email: regEmail })}
                  </p>
                </div>

                <form className="noctra-auth-form" onSubmit={handleVerifySubmit}>
                  <div className="noctra-otp-container">
                    {otpDigits.map((digit, idx) => (
                      <input
                        key={idx}
                        ref={(el) => (otpRefs.current[idx] = el)}
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={1}
                        className={`noctra-otp-box ${digit ? 'filled' : ''}`}
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
                    className="noctra-auth-primary-btn"
                    disabled={busy || otpDigits.join('').length < 6}
                  >
                    {busy ? (
                      <span className="noctra-btn-spinner">
                        <NativeIcon name="refresh" size={16} className="is-spinning" />
                        <span>{t('account.securing')}</span>
                      </span>
                    ) : (
                      t('account.verifyAndPlay')
                    )}
                  </button>

                  <div className="noctra-resend-row">
                    {countdown > 0 ? (
                      <span className="noctra-countdown-text">
                        {t('account.resendIn').replace('{seconds}', countdown)}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="noctra-link-btn"
                        disabled={busy}
                        onClick={handleResendCode}
                      >
                        {t('account.resendCode')}
                      </button>
                    )}
                  </div>
                </form>
              </div>
            ) : view === 'noctra-forgot' ? (
              <div className="noctra-auth-container">
                <div className="noctra-auth-top">
                  <button
                    type="button"
                    className="noctra-auth-back-btn"
                    onClick={() => { setView('noctra-login'); setError(''); }}
                    aria-label={t('common.back')}
                  >
                    <ArrowLeft size={15} />
                    <span>{t('common.back')}</span>
                  </button>
                </div>

                <div className="noctra-auth-header">
                  <Logo height={48} variant="mark" className="noctra-auth-clean-logo" />
                  <h2 className="noctra-auth-title">Reset your password</h2>
                  <p className="noctra-auth-sub">Enter the email for your Noctra account and we'll send you a 6-digit code.</p>
                </div>

                <form className="noctra-auth-form" onSubmit={handleForgotSubmit}>
                  <div className="noctra-form-group">
                    <label className="noctra-form-label">Email</label>
                    <input
                      type="email"
                      className="noctra-form-input"
                      placeholder="you@example.com"
                      value={resetEmail}
                      autoFocus
                      onChange={(e) => { setResetEmail(e.target.value); setError(''); }}
                    />
                  </div>

                  {error && <div className="account-login-error" role="alert">{error}</div>}

                  <button
                    type="submit"
                    className="noctra-auth-primary-btn"
                    disabled={busy || !resetEmail.trim()}
                  >
                    {busy ? (
                      <span className="noctra-btn-spinner">
                        <NativeIcon name="refresh" size={16} className="is-spinning" />
                        <span>{t('account.securing')}</span>
                      </span>
                    ) : (
                      'Send reset code'
                    )}
                  </button>
                </form>
              </div>
            ) : view === 'noctra-reset' ? (
              <div className="noctra-auth-container">
                <div className="noctra-auth-top">
                  <button
                    type="button"
                    className="noctra-auth-back-btn"
                    onClick={() => { setView('noctra-forgot'); setError(''); }}
                    aria-label={t('account.changeEmail')}
                  >
                    <ArrowLeft size={15} />
                    <span>{t('account.changeEmail')}</span>
                  </button>
                </div>

                <div className="noctra-auth-header">
                  <Logo height={48} variant="mark" className="noctra-auth-clean-logo" />
                  <h2 className="noctra-auth-title">Choose a new password</h2>
                  <p className="noctra-auth-sub">
                    If an account exists for {resetEmail}, we sent it a 6-digit code. Enter it below with your new password.
                  </p>
                </div>

                <form className="noctra-auth-form" onSubmit={handleResetSubmit}>
                  <div className="noctra-otp-container">
                    {otpDigits.map((digit, idx) => (
                      <input
                        key={idx}
                        ref={(el) => (otpRefs.current[idx] = el)}
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={1}
                        className={`noctra-otp-box ${digit ? 'filled' : ''}`}
                        value={digit}
                        onChange={(e) => handleOtpChange(idx, e.target.value)}
                        onKeyDown={(e) => handleOtpKeyDown(idx, e)}
                        onPaste={handleOtpPaste}
                        autoFocus={idx === 0}
                      />
                    ))}
                  </div>

                  <div className="noctra-form-group">
                    <label className="noctra-form-label">New password</label>
                    <div className="noctra-input-wrap">
                      <input
                        type={showPassword ? 'text' : 'password'}
                        className="noctra-form-input has-toggle"
                        placeholder="••••••••"
                        autoComplete="new-password"
                        value={resetPassword}
                        onChange={(e) => { setResetPassword(e.target.value); setError(''); }}
                      />
                      <button
                        type="button"
                        className="noctra-input-toggle"
                        onClick={() => setShowPassword((v) => !v)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        aria-pressed={showPassword}
                      >
                        {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                  </div>

                  <div className="noctra-form-group">
                    <label className="noctra-form-label">Confirm new password</label>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      className="noctra-form-input"
                      placeholder="••••••••"
                      autoComplete="new-password"
                      value={resetConfirm}
                      onChange={(e) => { setResetConfirm(e.target.value); setError(''); }}
                    />
                  </div>

                  {error && <div className="account-login-error" role="alert">{error}</div>}

                  <button
                    type="submit"
                    className="noctra-auth-primary-btn"
                    disabled={busy || otpDigits.join('').length < 6 || !resetPassword || !resetConfirm}
                  >
                    {busy ? (
                      <span className="noctra-btn-spinner">
                        <NativeIcon name="refresh" size={16} className="is-spinning" />
                        <span>{t('account.securing')}</span>
                      </span>
                    ) : (
                      'Reset password'
                    )}
                  </button>

                  <div className="noctra-resend-row">
                    {countdown > 0 ? (
                      <span className="noctra-countdown-text">
                        {t('account.resendIn').replace('{seconds}', countdown)}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="noctra-link-btn"
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
            <img src={loginSide} alt="A purple-lit Minecraft cavern with the Noctra mark" />
          </aside>
        </div>
      </div>
    </div>
  );
}
