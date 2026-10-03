const { contextBridge, ipcRenderer } = require('electron');

// Set by main.js via webPreferences.additionalArguments.
const versionArg = process.argv.find((arg) => arg.startsWith('--app-version='));

const api = {
  version: versionArg ? versionArg.slice('--app-version='.length) : null,
  apiUrl: 'https://api.nativelaunch.xyz',
  wardrobeApi: 'https://api.nativelaunch.xyz',
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  showNotification: (title, body) => ipcRenderer.invoke('app:showNotification', { title, body }),
  onMaximizedChange: (callback) =>
    ipcRenderer.on('window:maximized', (_event, isMaximized) => callback(isMaximized)),
  instances: {
    load: () => ipcRenderer.invoke('instances:load'),
    loadSync: () => ipcRenderer.sendSync('instances:loadSync'),
    save: (data) => ipcRenderer.invoke('instances:save', data)
  },
  auth: {
    login: () => ipcRenderer.invoke('auth:login'),
    restore: () => ipcRenderer.invoke('auth:restore'),
    logout: () => ipcRenderer.invoke('auth:logout')
  },
  accounts: {
    list:                 ()        => ipcRenderer.invoke('accounts:list'),
    addOffline:           (name)    => ipcRenderer.invoke('accounts:addOffline', name),
    addNoctra:            (payload) => ipcRenderer.invoke('accounts:addNoctra', payload),
    addNative:            (payload) => ipcRenderer.invoke('accounts:addNoctra', payload),
    addMicrosoft:         ()        => ipcRenderer.invoke('accounts:addMicrosoft'),
    noctraSendCode:       (payload) => ipcRenderer.invoke('accounts:noctraSendCode', payload),
    noctraResendCode:     (payload) => ipcRenderer.invoke('accounts:noctraResendCode', payload),
    noctraVerifyRegister: (payload) => ipcRenderer.invoke('accounts:noctraVerifyRegister', payload),
    noctraLogin:          (payload) => ipcRenderer.invoke('accounts:noctraLogin', payload),
    noctraForgotPassword: (payload) => ipcRenderer.invoke('accounts:noctraForgotPassword', payload),
    noctraResetPassword:  (payload) => ipcRenderer.invoke('accounts:noctraResetPassword', payload),
    getPremiumLink:       (id)      => ipcRenderer.invoke('accounts:getPremiumLink', id),
    linkPremium:          (payload) => ipcRenderer.invoke('accounts:linkPremium', payload),
    unlinkPremium:        (id)      => ipcRenderer.invoke('accounts:unlinkPremium', id),
    // Premium ↔ Noctra: a connected Microsoft account signs into Noctra on its own.
    premiumStatus:        (id)      => ipcRenderer.invoke('accounts:premiumStatus', id),
    ensureNoctra:         (id, options) => ipcRenderer.invoke('accounts:ensureNoctra', id, options || {}),
    connectNoctra:        (payload) => ipcRenderer.invoke('accounts:connectNoctra', payload),
    disconnectNoctra:     (id)      => ipcRenderer.invoke('accounts:disconnectNoctra', id),
    setActive:            (id)      => ipcRenderer.invoke('accounts:setActive', id),
    remove:               (id)      => ipcRenderer.invoke('accounts:remove', id),
    getAvatar:            (uuid)    => ipcRenderer.invoke('accounts:getAvatar', uuid)
  },
  wardrobe: {
    get: (account) => ipcRenderer.invoke('wardrobe:get', account),
    // Resolves { skinUrl, capeUrl, model } for avatar UIs; self-heals local skins.
    avatar: (account) => ipcRenderer.invoke('wardrobe:avatar', account),
    // `dataUrl` accepts a raw base64 string or a data: URL from a dropped file.
    upload: (account, kind, dataUrl, options = {}) =>
      ipcRenderer.invoke('wardrobe:upload', { account, kind, dataUrl, ...options }),
    choose: (payload) => ipcRenderer.invoke('wardrobe:choose', payload),
    apply: (account, id) => ipcRenderer.invoke('wardrobe:apply', { account, id }),
    clearActive: (account, kind) => ipcRenderer.invoke('wardrobe:clearActive', { account, kind }),
    favorite: (account, id, favorite) => ipcRenderer.invoke('wardrobe:favorite', { account, id, favorite }),
    rename: (account, id, name) => ipcRenderer.invoke('wardrobe:rename', { account, id, name }),
    remove: (account, id) => ipcRenderer.invoke('wardrobe:remove', { account, id }),
    setModel: (account, model) => ipcRenderer.invoke('wardrobe:setModel', { account, model }),
    export: (account, id) => ipcRenderer.invoke('wardrobe:export', { account, id }),
    sync: (account) => ipcRenderer.invoke('wardrobe:sync', account),
    // Pull the account's cloud locker (another device / the website changed it).
    pull: (account) => ipcRenderer.invoke('wardrobe:pull', account),
    // Live refresh after a `wardrobe:changed` event: pulls only when the cloud copy is newer.
    refresh: (account) => ipcRenderer.invoke('wardrobe:refresh', account),
    officialProfile: (account) => ipcRenderer.invoke('wardrobe:officialProfile', account),
    reauthOfficialProfile: (account) => ipcRenderer.invoke('wardrobe:reauthOfficialProfile', account),
    applyOfficialSkin: (account, id) => ipcRenderer.invoke('wardrobe:applyOfficialSkin', { account, id }),
    activateOfficialCape: (account, capeId) => ipcRenderer.invoke('wardrobe:activateOfficialCape', { account, capeId })
  },
  store: {
    catalog: (options) => ipcRenderer.invoke('store:catalog', options),
    strip: (itemId) => ipcRenderer.invoke('store:strip', itemId),
    equip: (account, itemId) => ipcRenderer.invoke('store:equip', { account, itemId }),
    me: (account) => ipcRenderer.invoke('store:me', account),
    claim: (account, itemId) => ipcRenderer.invoke('store:claim', { account, itemId }),
    unclaim: (account, itemId) => ipcRenderer.invoke('store:unclaim', { account, itemId })
  },
  settings: {
    load: () => ipcRenderer.invoke('settings:load'),
    systemMemory: () => ipcRenderer.invoke('settings:systemMemory'),
    save: (settings) => ipcRenderer.invoke('settings:save', settings),
    detectJava: () => ipcRenderer.invoke('settings:detectJava'),
    dataDir: () => ipcRenderer.invoke('settings:dataDir'),
    openDataDir: () => ipcRenderer.invoke('settings:openDataDir'),
    storageInfo: () => ipcRenderer.invoke('settings:storageInfo')
  },
  java: {
    test: (javaPath) => ipcRenderer.invoke('java:test', javaPath),
    detectFor: (major) => ipcRenderer.invoke('java:detectFor', major),
    install: (major) => ipcRenderer.invoke('java:install', major),
    browse: () => ipcRenderer.invoke('java:browse'),
    scan: (options) => ipcRenderer.invoke('java:scan', options || {}),
    probe: (javaPath) => ipcRenderer.invoke('java:probe', javaPath),
    host: () => ipcRenderer.invoke('java:host'),
    presets: () => ipcRenderer.invoke('java:presets'),
    slots: () => ipcRenderer.invoke('java:slots'),
    setSlot: (slot, javaPath) => ipcRenderer.invoke('java:setSlot', slot, javaPath),
    // { requiredMajor, slot, path, source, runtime, flags, status, issues }
    check: (payload) => ipcRenderer.invoke('java:check', payload),
    onProgress: (callback) => subscribe('java:progress', callback)
  },
  loaders: {
    // { kind, loader, mcVersion, versions: [{ version, stable, recommended, latest }], recommended, latest, unavailable }
    versions: (loader, mcVersion) => ipcRenderer.invoke('loaders:versions', { loader, mcVersion }),
    available: (mcVersion) => ipcRenderer.invoke('loaders:available', { mcVersion }),
    install: (payload) => ipcRenderer.invoke('loaders:install', payload),
    // { target, compatible, incompatible: [{ file, name, loader }], unknown }
    check: (payload) => ipcRenderer.invoke('loaders:check', payload),
    disableMods: (payload) => ipcRenderer.invoke('loaders:disableMods', payload),
    onProgress: (callback) => subscribe('loaders:progress', callback)
  },
  mods: {
    installed: (instanceId) => ipcRenderer.invoke('mods:installed', instanceId),
    toggle: (payload) => ipcRenderer.invoke('mods:toggle', payload),
    install: (payload) => ipcRenderer.invoke('mods:install', payload),
    remove: (payload) => ipcRenderer.invoke('mods:remove', payload),
    removeFile: (payload) => ipcRenderer.invoke('mods:removeFile', payload),
    enrich: (instanceId, folder) => ipcRenderer.invoke('mods:enrich', instanceId, folder),
    // { checked, known, updates: [{ file, title, from, to, versionId, url, filename, sha1, ... }], dependencies, unknown }
    checkUpdates: (payload) => ipcRenderer.invoke('mods:checkUpdates', payload),
    // { updated, installed, failed }
    applyUpdates: (payload) => ipcRenderer.invoke('mods:applyUpdates', payload),
    // { problems: [{ id, kind, severity, title, detail, files, fix }], checked, offline }
    problems: (payload) => ipcRenderer.invoke('mods:problems', payload),
    onProgress: (callback) => subscribe('mods:progress', callback)
  },
  modpacks: {
    install: (payload) => ipcRenderer.invoke('modpack:install', payload),
    onProgress: (callback) => subscribe('modpack:progress', callback)
  },
  launcher: {
    launch: (instance, account, options = {}) =>
      ipcRenderer.send('launcher:launch', { instance, account, ...options }),
    kill: (options) => ipcRenderer.send('launcher:kill', options || {}),
    // Resolves { ok, forced } — `force` skips the graceful close request.
    stop: (options) => ipcRenderer.invoke('launcher:stop', options || {}),
    onState: (callback) => subscribe('launcher:state', callback),
    onProgress: (callback) => subscribe('launcher:progress', callback),
    onLog: (callback) => subscribe('launcher:log', callback)
  },

  console: {
    get: (instanceId) => ipcRenderer.invoke('console:get', instanceId),
    clear: (instanceId) => ipcRenderer.invoke('console:clear', instanceId),
    upload: (instanceId, service) => ipcRenderer.invoke('console:upload', instanceId, service),
    save: (instanceId) => ipcRenderer.invoke('console:save', instanceId),
    onLines: (callback) => subscribe('console:lines', callback),
    onSession: (callback) => subscribe('console:session', callback)
  },
  crash: {
    list: (instanceId) => ipcRenderer.invoke('crash:list', instanceId),
    get: (id) => ipcRenderer.invoke('crash:get', id),
    log: (id) => ipcRenderer.invoke('crash:log', id),
    applyFix: (id, fix) => ipcRenderer.invoke('crash:applyFix', id, fix),
    share: (id) => ipcRenderer.invoke('crash:share', id),
    text: (id) => ipcRenderer.invoke('crash:text', id),
    open: (id, target) => ipcRenderer.invoke('crash:open', id, target),
    remove: (id) => ipcRenderer.invoke('crash:delete', id),
    analyzeInstance: (instance) => ipcRenderer.invoke('crash:analyzeInstance', instance),
    onAnalyzing: (callback) => subscribe('crash:analyzing', callback),
    onDetected: (callback) => subscribe('crash:detected', callback)
  },
  updater: {
    status: () => ipcRenderer.invoke('updater:status'),
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    cancel: () => ipcRenderer.invoke('updater:cancel'),
    install: () => ipcRenderer.invoke('updater:install'),
    onStatus: (callback) => subscribe('updater:status', callback)
  },
  instance: {
    listDir:     (id, sub)  => ipcRenderer.invoke('instance:listDir', id, sub),
    openFolder:  (id, sub)  => ipcRenderer.invoke('instance:openFolder', id, sub),
    worldList:   (id)       => ipcRenderer.invoke('instance:worldList', id),
    deleteWorld: (id, name) => ipcRenderer.invoke('instance:deleteWorld', id, name),
    screenshotList: (id) => ipcRenderer.invoke('instance:screenshotList', id),
    screenshotData: (id, name, options) => ipcRenderer.invoke('instance:screenshotData', id, name, options),
    revealScreenshot: (id, name) => ipcRenderer.invoke('instance:revealScreenshot', id, name),
    deleteScreenshot: (id, name) => ipcRenderer.invoke('instance:deleteScreenshot', id, name),
    toggleFile:  (id, sub, filename, enabled) => ipcRenderer.invoke('instance:toggleFile', id, sub, filename, enabled),
    getLogFile:  (id)       => ipcRenderer.invoke('instance:getLogFile', id),
    isInstalled: (version, loader) => ipcRenderer.invoke('instance:isInstalled', version, loader),
    verifyInstallation: (version, loader) => ipcRenderer.invoke('instance:verifyInstallation', version, loader),
    installedVersions: ()       => ipcRenderer.invoke('instance:installedVersions'),
    recentServers: ()       => ipcRenderer.invoke('instance:recentServers'),
    recentWorlds: ()        => ipcRenderer.invoke('instance:recentWorlds')
  },
  news: {
    list: (options) => ipcRenderer.invoke('news:list', options)
  },
  server: {
    ping: (address) => ipcRenderer.invoke('server:ping', address)
  },
  social: {
    getFriends: () => ipcRenderer.invoke('social:getFriends'),
    getStats: () => ipcRenderer.invoke('social:getStats'),
    getRequests: () => ipcRenderer.invoke('social:getRequests'),
    // Preloads the tail of every conversation in one call.
    getConversations: (perFriend = 40) => ipcRenderer.invoke('social:getConversations', { perFriend }),
    getUpdates: (since = 0) => ipcRenderer.invoke('social:getUpdates', { since }),
    sendRequest: (targetUsername) => ipcRenderer.invoke('social:sendRequest', targetUsername),
    respondRequest: (requestId, action) => ipcRenderer.invoke('social:respondRequest', { requestId, action }),
    getMessages: (friendId, limit, options = {}) =>
      ipcRenderer.invoke('social:getMessages', { friendId, limit, ...options }),
    sendMessage: (friendId, content, mediaOptions = {}) => ipcRenderer.invoke('social:sendMessage', { friendId, content, ...mediaOptions }),
    uploadMedia: (dataUrl, filename) => ipcRenderer.invoke('social:uploadMedia', { dataUrl, filename }),
    setMessageReaction: (messageId, reaction) => ipcRenderer.invoke('social:setMessageReaction', { messageId, reaction }),
    markRead: (friendId) => ipcRenderer.invoke('social:markRead', friendId),
    setTyping: (friendId, isTyping) => ipcRenderer.invoke('social:setTyping', { friendId, isTyping }),
    updateFriend: (friendId, data) => ipcRenderer.invoke('social:updateFriend', { friendId, ...data }),
    getMutualFriends: (friendId) => ipcRenderer.invoke('social:getMutualFriends', friendId),
    unfriend: (friendId) => ipcRenderer.invoke('social:unfriend', friendId),
    block: (targetId) => ipcRenderer.invoke('social:block', targetId),
    unblock: (targetId) => ipcRenderer.invoke('social:unblock', targetId),
    getBlocked: () => ipcRenderer.invoke('social:getBlocked'),
    searchUsers: (query) => ipcRenderer.invoke('social:searchUsers', query),
    getPresence: () => ipcRenderer.invoke('social:getPresence'),
    setPresence: (payload) => ipcRenderer.invoke('social:setPresence', payload),
    getStreamStatus: () => ipcRenderer.invoke('social:getStreamStatus'),
    reconnectStream: () => ipcRenderer.invoke('social:reconnectStream'),
    onPresenceUpdated: (callback) => subscribe('social:presenceUpdated', callback),
    // Realtime fan-out: message:new, message:reaction, message:read, typing,
    // presence, request:changed, friends:changed, blocks:changed, skin:updated.
    onSocialEvent: (callback) => subscribe('social:event', callback),
    onStreamStatus: (callback) => subscribe('social:streamStatus', callback)
  },
  relay: {
    getGroups: () => ipcRenderer.invoke('relay:getGroups'),
    getGroup: (id) => ipcRenderer.invoke('relay:getGroup', id),
    createGroup: (payload) => ipcRenderer.invoke('relay:createGroup', payload),
    updateGroup: (id, payload) => ipcRenderer.invoke('relay:updateGroup', id, payload),
    deleteGroup: (id) => ipcRenderer.invoke('relay:deleteGroup', id),
    leaveGroup: (id) => ipcRenderer.invoke('relay:leaveGroup', id),
    addMembers: (id, userIds) => ipcRenderer.invoke('relay:addMembers', id, userIds),
    removeMember: (id, userId) => ipcRenderer.invoke('relay:removeMember', id, userId),
    setMemberRole: (id, userId, role) => ipcRenderer.invoke('relay:setMemberRole', id, userId, role),
    setGroupPrefs: (id, prefs) => ipcRenderer.invoke('relay:setGroupPrefs', id, prefs),
    markGroupRead: (id) => ipcRenderer.invoke('relay:markGroupRead', id),
    setGroupTyping: (id, isTyping) => ipcRenderer.invoke('relay:setGroupTyping', id, isTyping),
    getGroupMessages: (id, options) => ipcRenderer.invoke('relay:getGroupMessages', id, options),
    sendGroupMessage: (id, payload) => ipcRenderer.invoke('relay:sendGroupMessage', id, payload),
    reactToGroupMessage: (messageId, reaction) => ipcRenderer.invoke('relay:reactToGroupMessage', messageId, reaction),
    editGroupMessage: (messageId, content) => ipcRenderer.invoke('relay:editGroupMessage', messageId, content),
    deleteGroupMessage: (messageId) => ipcRenderer.invoke('relay:deleteGroupMessage', messageId),
    getDirectMessages: (friendId, options) => ipcRenderer.invoke('relay:getDirectMessages', friendId, options),
    sendDirectMessage: (friendId, payload) => ipcRenderer.invoke('relay:sendDirectMessage', friendId, payload),
    editDirectMessage: (messageId, content) => ipcRenderer.invoke('relay:editDirectMessage', messageId, content),
    deleteDirectMessage: (messageId) => ipcRenderer.invoke('relay:deleteDirectMessage', messageId)
  },
  admin: {
    status: () => ipcRenderer.invoke('admin:status'),
    overview: () => ipcRenderer.invoke('admin:overview'),
    listUsers: (options) => ipcRenderer.invoke('admin:listUsers', options),
    setBadge: (userId, badge, granted) => ipcRenderer.invoke('admin:setBadge', userId, badge, granted),
    storeItems: () => ipcRenderer.invoke('admin:storeItems'),
    storeCreate: (item) => ipcRenderer.invoke('admin:storeCreate', item),
    storeUpdate: (id, patch) => ipcRenderer.invoke('admin:storeUpdate', id, patch),
    storeDelete: (id) => ipcRenderer.invoke('admin:storeDelete', id),
    storeOwners: (id) => ipcRenderer.invoke('admin:storeOwners', id),
    storeGrant: (id, username) => ipcRenderer.invoke('admin:storeGrant', id, username),
    storeRevoke: (id, username) => ipcRenderer.invoke('admin:storeRevoke', id, username)
  },
  discord: {
    setTab: (tab) => ipcRenderer.send('discord:setTab', tab),
    setGameActivity: (state) => ipcRenderer.invoke('discord:setGameActivity', state),
    clearGameActivity: () => ipcRenderer.invoke('discord:clearGameActivity'),
    getStatus: () => ipcRenderer.invoke('discord:getStatus')
  }
};

contextBridge.exposeInMainWorld('noctra', api);
contextBridge.exposeInMainWorld('native', api);

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
