import React, { useCallback, useEffect, useRef, useState } from 'react';
import AppNavbar from './AppNavbar.jsx';
import HomeView from '../home/HomeView.jsx';
import InstancesView from '../instances/InstancesView.jsx';
import ClustersView from '../clusters/ClustersView.jsx';
import BrowseView from '../browser/BrowseView.jsx';

import ClusterDetailView from '../cluster/ClusterDetailView.jsx';
import LockerView from '../skins/LockerView.jsx';
import RelayPage from '../social/RelayPage.jsx';
import NotificationDrawer from '../notifications/NotificationDrawer.jsx';
import FriendContextMenu from '../social/FriendContextMenu.jsx';
import NicknameModal from '../social/NicknameModal.jsx';
import useSocial from '../social/useSocial.js';
import SettingsView from '../settings/SettingsView.jsx';
import SettingsModal from '../settings/SettingsModal.jsx';
import AccountSwitcherModal from '../auth/AccountSwitcherModal.jsx';
import CreateInstanceModal from '../instances/CreateInstanceModal.jsx';
import useLauncher from '../launcher/useLauncher.js';
import useInstances from '../instances/useInstances.js';
import usePlaytimeTracker from '../instances/usePlaytimeTracker.js';
import CrashReportModal from '../crash/CrashReportModal.jsx';
import useCrashReports from '../crash/useCrashReports.js';
import NoctraAccountGate from '../../components/ui/NoctraAccountGate.jsx';
import AdminView from '../admin/AdminView.jsx';
import WelcomeTour from './WelcomeTour.jsx';
import { DownloadManagerProvider } from './DownloadManagerContext.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import './Shell.css';

const WELCOME_TOUR_KEY = 'noctra.welcome-tour.v1';

const playRelayChime = () => {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.24);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
    osc.onended = () => ctx.close().catch(() => {});
  } catch {}
};

export default function Shell({
  isMaximized,
  account,
  accounts = [],
  activeId,
  initialInstances = null,
  onAddMicrosoft,
  onAddOffline,
  onAddNoctra,
  onAddNative,
  onNoctraSendCode,
  onNoctraResendCode,
  onNoctraVerifyRegister,
  onNoctraLogin,
  onSwitchAccount,
  onRemoveAccount,
  onWardrobeChanged,
  onOpenUpdater,
  updateStatus,
  networkStatus
}) {
  const { locale, t } = useI18n();
  // Instance management is an overlay; opening it never replaces this page.
  const [currentTab, setCurrentTab] = useState('home');
  const [previousTab, setPreviousTab] = useState('home');
  const [settingsInitialTab, setSettingsInitialTab] = useState('launcher');
  const [clusterDetailTab, setClusterDetailTab] = useState('overview');
  const [browseReturnTab, setBrowseReturnTab] = useState('instances');

  const [instanceManagerOpen, setInstanceManagerOpen] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [accountSwitcherOpen, setAccountSwitcherOpen] = useState(false);
  const [browseIntent, setBrowseIntent] = useState(null);
  /* Set when Discover was opened from a specific instance (e.g. the instance
     manager's add-content banner). Locks installs to that instance and gives
     the header a back button. */
  const [browseTargetId, setBrowseTargetId] = useState(null);
  const [browseBack, setBrowseBack] = useState(null);
  const [createInstanceOpen, setCreateInstanceOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);

  const [notifications, setNotifications] = useState([]);
  const [relayActiveThreadId, setRelayActiveThreadId] = useState(null);
  const relayNotificationRef = useRef({});

  const openUpdater = useCallback(() => {
    setSettingsOpen(false);
    setNotificationsOpen(false);
    onOpenUpdater?.();
  }, [onOpenUpdater]);

  const hasValidAccount = Boolean(
    account &&
    account.id &&
    account.id !== 'guest' &&
    accounts.length > 0
  );

  const isNoctra = Boolean(
    hasValidAccount &&
    (account.type === 'noctra' || account.type === 'native')
  );

  const instancesManager = useInstances(initialInstances);
  const launcher = useLauncher();
  const [gameSince, setGameSince] = useState(null);
  useEffect(() => {
    setGameSince((current) => (launcher.status === 'running' ? current || Date.now() : null));
  }, [launcher.status]);
  const runningInstance = launcher.status === 'running'
    ? instancesManager.instances.find((item) => item.id === launcher.instanceId)
    : null;
  const runningGame = launcher.status === 'running'
    ? {
        name: runningInstance?.name || 'Minecraft',
        version: runningInstance?.mc_version || runningInstance?.version || '',
        loader: runningInstance?.mc_loader || runningInstance?.loader || '',
        since: gameSince || Date.now(),
        instance: runningInstance || null
      }
    : null;
  usePlaytimeTracker(instancesManager.recordSession, { launcherState: launcher });
  const social = useSocial(isNoctra ? account : null);
  const crash = useCrashReports();
  const instancesRef = useRef(instancesManager.instances);
  instancesRef.current = instancesManager.instances;

  useEffect(() => {
    if (!hasValidAccount || accountSwitcherOpen || settingsOpen || notificationsOpen || createInstanceOpen || instanceManagerOpen) return undefined;
    let completed = false;
    try {
      completed = localStorage.getItem(WELCOME_TOUR_KEY) === 'complete';
    } catch {}
    if (completed) return undefined;
    const timer = window.setTimeout(() => setTourOpen(true), 850);
    return () => window.clearTimeout(timer);
  }, [accountSwitcherOpen, createInstanceOpen, hasValidAccount, instanceManagerOpen, notificationsOpen, settingsOpen]);

  const openTutorial = useCallback(() => {
    setSettingsOpen(false);
    setNotificationsOpen(false);
    setAccountSwitcherOpen(false);
    setCreateInstanceOpen(false);
    setInstanceManagerOpen(false);
    setTourOpen(true);
  }, []);

  const closeTutorial = useCallback(() => {
    setTourOpen(false);
    try {
      localStorage.setItem(WELCOME_TOUR_KEY, 'complete');
    } catch {}
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!isNoctra) {
      setIsAdmin(false);
      return undefined;
    }
    window.native?.admin?.status?.()
      .then((result) => { if (!cancelled) setIsAdmin(Boolean(result?.ok && result?.isAdmin)); })
      .catch(() => { if (!cancelled) setIsAdmin(false); });
    return () => { cancelled = true; };
  }, [account?.id, isNoctra]);

  useEffect(() => {
    if (currentTab === 'admin' && !isAdmin) setCurrentTab('home');
    window.native?.discord?.setTab?.(currentTab);
  }, [currentTab, isAdmin]);

  const notify = useCallback((title, body) => {
    setNotifications((prev) =>
      [
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          title,
          body,
          time: new Date().toLocaleTimeString(locale)
        },
        ...prev
      ].slice(0, 60)
    );
  }, [locale]);

  const revokeAdminView = useCallback(() => {
    setIsAdmin(false);
    setCurrentTab('home');
    notify('Admin session ended', 'Your account no longer has access to the control room.');
  }, [notify]);

  /* Relay emits `{ type, message }` payloads; the drawer wants title + body. */
  const notifyRelay = useCallback((payload, body) => {
    if (typeof payload === 'string') {
      notify(payload, body);
      return;
    }
    if (!payload?.message) return;
    const title = payload.type === 'error'
      ? 'Relay error'
      : 'Relay';
    notify(title, payload.message);
  }, [notify]);

  relayNotificationRef.current = {
    selfId: social.selfId,
    friends: social.friends,
    currentTab,
    activeThreadId: relayActiveThreadId
  };

  useEffect(() => {
    if (!isNoctra) return undefined;
    return social.subscribe((event) => {
      const state = relayNotificationRef.current;
      let title = '';
      let body = '';
      let threadId = null;

      if (event?.type === 'message:new' && event.message?.senderId !== state.selfId) {
        threadId = event.message.senderId;
        const friend = state.friends.find((item) => item.id === threadId);
        title = friend?.nickname || friend?.name || event.message.senderName || 'Direct Message';
        body = event.message.content || (event.message.mediaName ? `Sent an attachment: ${event.message.mediaName}` : 'Sent an attachment');
      } else if (event?.type === 'group:message') {
        const message = event.data?.message ?? event.message;
        threadId = event.data?.groupId ?? event.groupId;
        if (!message || message.senderId === state.selfId || message.isSystem) return;
        const sender = message.senderName || 'Member';
        const group = event.data?.groupName || event.groupName || 'Group';
        title = `${sender} (${group})`;
        body = message.content || (message.mediaName ? `Sent an attachment: ${message.mediaName}` : 'Sent an attachment');
      } else if (event?.type === 'request:changed' && event.actorId !== state.selfId) {
        const actor = event.actorName || 'A player';
        if (event.action === 'accepted') {
          title = 'Friend Request Accepted';
          body = `${actor} accepted your friend request.`;
        } else if (!event.action || event.action === 'sent') {
          title = 'Friend Request';
          body = `${actor} sent you a friend request.`;
        }
      }

      if (!title) return;
      if (threadId) {
        let mutedIds = {};
        try {
          mutedIds = JSON.parse(localStorage.getItem('noctra_relay_store_v5') || '{}').mutedIds || {};
        } catch {}
        const friend = state.friends.find((item) => item.id === threadId);
        if (mutedIds[threadId] ?? friend?.muted) return;
      }
      const viewingThread = threadId && state.currentTab === 'relay' &&
        state.activeThreadId === threadId && document.hasFocus();
      if (viewingThread) return;

      notify(title, body);
      playRelayChime();
      window.native?.showNotification?.(title, body);
    });
  }, [isNoctra, notify, social.subscribe]);

  const handleLaunch = (cluster, options = {}) => {
    if (!cluster) return;
    if (!account || account.id === 'guest' || accounts.length === 0) {
      setAccountSwitcherOpen(true);
      return;
    }
    launcher.launch(cluster, account, options);
    notify(
      t('notify.launching'),
      options?.quickJoinServer
        ? `Connecting to ${options.quickJoinServer} with ${cluster.name || cluster.mc_version || cluster.version}\u2026`
        : options?.quickJoinWorld
          ? `Opening ${options.quickJoinWorld} in ${cluster.name || cluster.mc_version || cluster.version}\u2026`
          : t('notify.starting', {
            name: cluster.name || cluster.mc_version || cluster.version,
            version: `${cluster.mc_version || cluster.version} ${cluster.mc_loader || cluster.loader}`
          })
    );
  };

  /* Crash-report fixes that change the instance itself (memory, Java, JVM args, loader). */
  const applyCrashInstanceFix = async (record, fix) => {
    const target = instancesRef.current.find((item) => item.id === record?.instance?.id);
    if (!target) return { ok: false, message: 'That instance no longer exists.' };
    const ov = target.overrides || {};
    const save = async (patch) => {
      await instancesManager.saveOverrides(target.id, { overrides: { ...ov, ...patch } });
    };
    switch (fix.kind) {
      case 'memory': {
        const max = Number(fix.maxGb);
        const min = Math.min(Number(ov.memory?.min) || 1, max);
        await save({ memory: { ...(ov.memory || {}), enabled: true, min, max } });
        return { ok: true, message: `This instance now gets ${max} GB` };
      }
      case 'java-auto':
        await save({ java: { enabled: false, path: '' } });
        return { ok: true, message: 'Noctra picks the right Java on the next launch' };
      case 'jvm-reset':
        await save({ jvmArgs: '' });
        return { ok: true, message: 'Custom JVM arguments removed' };
      case 'jvm-add': {
        const current = String(ov.jvmArgs || '').trim();
        const next = current.split(/\s+/).includes(fix.args) ? current : `${current} ${fix.args}`.trim();
        await save({ jvmArgs: next, jvmEnabled: true });
        return { ok: true, message: `Added ${fix.args}` };
      }
      case 'loader-latest':
        instancesManager.update(target.id, { loaderVersion: '', mc_loader_version: '' });
        return { ok: true, message: `The newest ${target.loader || 'loader'} version is used on the next launch` };
      case 'patch':
        await save({ ...fix.patch, jvmEnabled: fix.patch?.java?.enabled ? true : ov.jvmEnabled });
        return { ok: true };
      default:
        return { ok: false, message: 'Unknown fix' };
    }
  };

  const relaunchAfterCrash = (record) => {
    crash.close();
    // Let the override save settle so the launch reads the fixed instance.
    window.setTimeout(() => {
      const target = instancesRef.current.find((item) => item.id === record?.instance?.id);
      if (target) handleLaunch(target);
    }, 60);
  };

  /* Accepts a friend object or a raw server address. */
  const handleJoinServer = (target) => {
    const serverAddress = typeof target === 'string' ? target : target?.serverAddress;
    if (!serverAddress) return;
    const cluster = instancesManager.activeCluster || instancesManager.clusters?.[0] || instancesManager.instances?.[0];
    if (!cluster) {
      notify('No instance found', 'Please install or create a Minecraft instance first to join.');
      return;
    }
    handleLaunch(cluster, { quickJoinServer: serverAddress });
  };

  const handleOpenCluster = (cluster, tab = 'overview') => {
    if (!cluster?.id) return;
    instancesManager.select(cluster.id);
    setClusterDetailTab(tab);

    setInstanceManagerOpen(true);
  };

  const BROWSE_MANAGER_TABS = { mod: 'mods', shader: 'shaders', resourcepack: 'textures' };

  const handleNavigateBrowse = (cluster, contentType) => {
    if (cluster?.id) instancesManager.select(cluster.id);
    const returnTab = currentTab === 'discover' ? browseReturnTab : currentTab;
    setBrowseReturnTab(returnTab);
    setBrowseTargetId(cluster?.id || null);
    setBrowseBack({
      tab: returnTab,
      managerTab: instanceManagerOpen ? BROWSE_MANAGER_TABS[contentType] || 'overview' : null
    });
    if (contentType) setBrowseIntent({ contentType, nonce: Date.now() });
    setInstanceManagerOpen(false);
    setCurrentTab('discover');
  };

  const handleBrowseBack = () => {
    const back = browseBack;
    const target = instancesManager.instances.find((item) => item.id === browseTargetId);
    setBrowseTargetId(null);
    setBrowseBack(null);
    setCurrentTab(back?.tab || 'instances');
    if (back?.managerTab && target) handleOpenCluster(target, back.managerTab);
  };

  const handleCreateInstance = (values) => {
    const created = instancesManager.create(values);
    notify(t('notify.created'), `${created.name} \u2014 ${created.version} ${created.loader}`);
    setInstanceManagerOpen(false);
    setCurrentTab('home');
    return created;
  };

  const handleAddInstance = (instance) => {
    if (!instance?.id) return;
    instancesManager.add(instance);
    notify(t('notify.modpackInstalled'), t('notify.ready', { name: instance.name }));
  };

  const handleDuplicate = (id) => {
    const copy = instancesManager.duplicate(id);
    if (copy) notify(t('notify.duplicated'), copy.name);
    return copy;
  };

  const handleRemoveInstance = (id) => {
    const target = instancesManager.instances.find((item) => item.id === id);
    instancesManager.remove(id);
    if (target) notify(t('instances.removed'), target.name);
    setInstanceManagerOpen(false);
  };

  const handleMinimize = () => window.native?.minimize();
  const handleMaximize = () => window.native?.maximize();
  const handleClose = () => window.native?.close();

  const handleSelectTab = (tab) => {
    if (tab === 'relay' && currentTab !== 'relay') social?.setActiveChatFriend?.(null);
    if (tab !== 'settings') {
      setPreviousTab(currentTab === 'settings' ? 'home' : currentTab);
    }
    if (tab !== 'discover') {
      setBrowseTargetId(null);
      setBrowseBack(null);
    }
    setCurrentTab(tab);
  };

  const handleOpenSettings = (initialTab = 'launcher') => {
    if (currentTab !== 'settings') {
      setPreviousTab(currentTab);
    }
    setSettingsInitialTab(initialTab);
    setCurrentTab('settings');
  };

  return (
    <DownloadManagerProvider>
      <div className="app-shell">
        <AppNavbar
          currentTab={currentTab}
          onSelectTab={handleSelectTab}
          onOpenSettings={() => handleOpenSettings('launcher')}
          onOpenAccountSwitcher={() => setAccountSwitcherOpen(true)}
          isAccountOpen={!hasValidAccount || accountSwitcherOpen}
          account={account}
          isNoctra={isNoctra}
          notifications={notifications.length}
          onOpenNotifications={() => setNotificationsOpen(true)}
          isMaximized={isMaximized}
          onMinimize={handleMinimize}
          onMaximize={handleMaximize}
          onClose={handleClose}
          updateStatus={updateStatus}
          networkStatus={networkStatus}
          onOpenUpdater={openUpdater}
          onOpenTutorial={openTutorial}
          isTutorialOpen={tourOpen}
          friendsBadge={isNoctra ? social.badgeTotal : 0}
          liveUserCount={social.liveUserCount}
          isAdmin={isAdmin}
          runningGame={runningGame}
          onStopGame={launcher.kill}
          onOpenRunningGame={runningGame?.instance ? () => handleOpenCluster(runningGame.instance) : undefined}
        />

        <div className="shell-content-layer">
          {currentTab === 'home' && (
            <HomeView
              instances={instancesManager.instances}
              selectedCluster={instancesManager.selected}
              onSelectCluster={instancesManager.select}
              onOpenCluster={handleOpenCluster}
              onOpenInstances={() => setCurrentTab('instances')}
              onOpenVersions={() => setCurrentTab('versions')}
              onCreateInstance={() => setCreateInstanceOpen(true)}
              account={account}
              launcherState={launcher}
              onLaunch={handleLaunch}
              onKill={launcher.kill}
            />
          )}

        {currentTab === 'skins' && (
          isNoctra ? (
            <LockerView
              account={account}
              onWardrobeChanged={onWardrobeChanged}
              onNotify={notify}
            />
          ) : (
            <NoctraAccountGate
              feature="locker"
              onOpenAccountSwitcher={() => setAccountSwitcherOpen(true)}
              onBackHome={() => setCurrentTab('home')}
            />
          )
        )}

        {currentTab === 'relay' && (
          isNoctra ? (
            <RelayPage
              account={account}
              social={social}
              onJoinServer={handleJoinServer}
              onNotify={notifyRelay}
              onActiveThreadChange={setRelayActiveThreadId}
            />
          ) : (
            <NoctraAccountGate
              feature="relay"
              onOpenAccountSwitcher={() => setAccountSwitcherOpen(true)}
              onBackHome={() => setCurrentTab('home')}
            />
          )
        )}


        {currentTab === 'instances' && (
          <InstancesView
            instances={instancesManager.instances}
            selectedId={instancesManager.selectedId}
            onSelect={instancesManager.select}
            onOpenCluster={handleOpenCluster}
            onLaunch={handleLaunch}
            onKill={launcher.kill}
            launcherState={launcher}
            onOpenCreateModal={() => setCreateInstanceOpen(true)}
            onUpdate={instancesManager.update}
            onDuplicate={handleDuplicate}
            onRemove={handleRemoveInstance}
            onNavigateBrowse={handleNavigateBrowse}
            onNotify={notify}
          />
        )}

        {currentTab === 'versions' && (
          <ClustersView
            instances={instancesManager.instances}
            selectedCluster={instancesManager.selected}
            onSelectCluster={instancesManager.select}
            onOpenCluster={handleOpenCluster}
            onLaunch={handleLaunch}
            onKill={launcher.kill}
            onOpenNewInstanceModal={() => setCreateInstanceOpen(true)}
            onCreateInstance={handleCreateInstance}
            onNotify={notify}
            launcherState={launcher}
          />
        )}

        {currentTab === 'discover' && (
          <BrowseView
            initialIntent={browseIntent}
            instances={instancesManager.instances}
            selectedCluster={
              instancesManager.instances.find((item) => item.id === browseTargetId) || undefined
            }
            onBack={browseTargetId ? handleBrowseBack : undefined}
            onSelectCluster={instancesManager.select}
            onAddInstance={handleAddInstance}
            onOpenCluster={handleOpenCluster}
            onNotify={notify}
            pageTitle="Discover"
          />
        )}

        {currentTab === 'admin' && isAdmin && (
          <AdminView onNotify={notify} onAccessRevoked={revokeAdminView} />
        )}

        {currentTab === 'settings' && (
          <SettingsView
            initialTab={settingsInitialTab}
            instances={instancesManager.instances}
            onOpenUpdater={openUpdater}
            onBack={() => setCurrentTab(previousTab || 'home')}
          />
        )}


        {instanceManagerOpen && instancesManager.selected && (
          <ClusterDetailView
            key={instancesManager.selected.id}
            cluster={instancesManager.selected}
            instances={instancesManager.instances}
            onSelectCluster={instancesManager.select}
            initialTab={clusterDetailTab}
            onBack={() => setInstanceManagerOpen(false)}
            onLaunch={handleLaunch}
            onKill={launcher.kill}
            launcherState={launcher}
            onUpdateCluster={instancesManager.saveOverrides}
            onAnalyzeCrash={crash.analyzeInstance}
            onNavigateBrowse={handleNavigateBrowse}
            social={social}
            account={account}
          />
        )}
      </div>

      <NotificationDrawer
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
        notifications={notifications}
        onClear={() => setNotifications([])}
      />

      <CrashReportModal
        open={crash.open}
        analyzing={crash.analyzing}
        record={crash.record}
        error={crash.error}
        onClose={crash.close}
        onOpenReport={crash.openReport}
        onApplyInstanceFix={applyCrashInstanceFix}
        onRelaunch={relaunchAfterCrash}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        instances={instancesManager.instances}
        onOpenUpdater={openUpdater}
      />

      <AccountSwitcherModal
        open={!hasValidAccount || accountSwitcherOpen}
        firstRun={!hasValidAccount}
        onClose={() => {
          if (hasValidAccount) {
            setAccountSwitcherOpen(false);
          }
        }}
        accounts={accounts}
        activeId={activeId}
        onSwitchAccount={onSwitchAccount}
        onAddMicrosoft={onAddMicrosoft}
        onAddOffline={onAddOffline}
        onAddNoctra={onAddNoctra || onAddNative}
        onAddNative={onAddNoctra || onAddNative}
        onNoctraSendCode={onNoctraSendCode}
        onNoctraResendCode={onNoctraResendCode}
        onNoctraVerifyRegister={onNoctraVerifyRegister}
        onNoctraLogin={onNoctraLogin}
        onRemoveAccount={onRemoveAccount}
      />

      <CreateInstanceModal
        open={createInstanceOpen}
        instances={instancesManager.instances}
        onClose={() => setCreateInstanceOpen(false)}
        onCreate={(values) => handleCreateInstance(values)}
      />



      {isNoctra && social.contextMenu && (
        <FriendContextMenu
          context={social.contextMenu}
          onClose={() => social.setContextMenu(null)}
          onJoinServer={handleJoinServer}
          onOpenChat={(friend) => {
            social.setActiveChatFriend(friend);
            setCurrentTab('relay');
          }}
          onToggleBestFriend={(friend) =>
            social.updateFriend(friend.id, { isBestFriend: !friend.isBestFriend })
          }
          onSetNickname={(friend) => social.setNicknameModalFriend(friend)}
          onUnfriend={(friend) => social.unfriend(friend.id)}
          onBlock={(friend) => social.block(friend.id)}
        />
      )}

      {isNoctra && social.nicknameModalFriend && (
        <NicknameModal
          friend={social.nicknameModalFriend}
          onClose={() => social.setNicknameModalFriend(null)}
          onSave={(friendId, nickname) => social.updateFriend(friendId, { nickname })}
        />
      )}

      <WelcomeTour open={tourOpen} onClose={closeTutorial} />
    </div>
    </DownloadManagerProvider>
  );
}
