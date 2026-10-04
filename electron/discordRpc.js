const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

/**
 * Native Discord Rich Presence (RPC) implementation for Native Client.
 *
 * Communicates directly with the local Discord desktop client via the
 * standard Discord IPC socket / named pipe protocol.
 *
 * Zero external dependencies: works out of the box on Windows, macOS,
 * Linux (including Flatpak and Snap Discord installs), auto-reconnects,
 * gracefully handles Discord starting/closing, and cleanly maps launcher
 * and in-game Minecraft states.
 */

const CLIENT_ID = '1465139441457827972';
const DOWNLOAD_URL = 'https://nativelaunch.xyz';
const DISCORD_URL = 'https://discord.gg/m9QpHFP8e';

const OPCODES = {
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4
};

const TAB_DESCRIPTIONS = {
  home: 'Browsing Instances',
  instances: 'Managing Instances',
  skins: 'Customizing Wardrobe',
  relay: 'Chatting on Relay',
  versions: 'Browsing Versions',
  browse: 'Browsing Content',
  modpacks: 'Exploring Modpacks',
  admin: 'Admin Console'
};

let deps = null;
let socket = null;
let isConnected = false;
let isReady = false;
let connecting = false;
let reconnectTimer = null;
let updateThrottleTimer = null;

let launcherStartTime = Date.now();
let gameStartTime = null;
let currentTab = 'home';
let currentGameState = null; // { instance, status, server, serverAddress }
let lastPayloadSent = null;

// Allow overriding socket path for testing or custom socket locations
let testSocketPath = null;

function setTestSocketPath(p) {
  testSocketPath = p;
}

function getCandidatePaths() {
  if (testSocketPath) return [testSocketPath];

  if (process.platform === 'win32') {
    const pipes = [];
    for (let i = 0; i < 10; i += 1) {
      pipes.push(`\\\\?\\pipe\\discord-ipc-${i}`);
      pipes.push(`\\\\.\\pipe\\discord-ipc-${i}`);
    }
    return pipes;
  }

  const baseDirs = [
    process.env.XDG_RUNTIME_DIR,
    process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, 'app', 'com.discordapp.Discord') : null,
    process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, 'snap.discord') : null,
    process.env.TMPDIR,
    process.env.TMP,
    process.env.TEMP,
    '/tmp'
  ].filter(Boolean);

  const candidates = [];
  for (const dir of baseDirs) {
    for (let i = 0; i < 10; i += 1) {
      candidates.push(path.join(dir, `discord-ipc-${i}`));
    }
  }
  return candidates;
}

let settingsOverride = null;

function isRpcEnabled() {
  if (settingsOverride && typeof settingsOverride.discordRpc === 'boolean') {
    return settingsOverride.discordRpc;
  }
  try {
    const settings = deps?.getSettings?.();
    if (settings?.behavior && typeof settings.behavior.discordRpc === 'boolean') {
      return settings.behavior.discordRpc;
    }
  } catch {
    /* fallback to default enabled */
  }
  return true;
}

function sendPacket(opcode, payload) {
  if (!socket || socket.destroyed) return false;
  try {
    const jsonStr = JSON.stringify(payload);
    const dataBuf = Buffer.from(jsonStr, 'utf8');
    const headerBuf = Buffer.alloc(8);
    headerBuf.writeInt32LE(opcode, 0);
    headerBuf.writeInt32LE(dataBuf.length, 4);
    socket.write(Buffer.concat([headerBuf, dataBuf]));
    return true;
  } catch {
    return false;
  }
}

function handleIncomingMessage(opcode, payloadBuf) {
  if (opcode === OPCODES.PING) {
    sendPacket(OPCODES.PONG, {});
    return;
  }

  if (opcode === OPCODES.FRAME) {
    try {
      const msg = JSON.parse(payloadBuf.toString('utf8'));
      if (msg.cmd === 'DISPATCH' && msg.evt === 'READY') {
        isReady = true;
        flushPresence();
      }
    } catch {
      /* ignore invalid json frames */
    }
  }
}

function tryConnectNext(paths, index = 0) {
  if (index >= paths.length) {
    connecting = false;
    scheduleReconnect();
    return;
  }

  const targetPath = paths[index];
  const client = net.createConnection(targetPath);
  let resolved = false;

  const onConnect = () => {
    resolved = true;
    connecting = false;
    socket = client;
    isConnected = true;
    isReady = false;

    let buffer = Buffer.alloc(0);
    client.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8) {
        const opcode = buffer.readInt32LE(0);
        const length = buffer.readInt32LE(4);
        if (buffer.length < 8 + length) break;
        const payload = buffer.subarray(8, 8 + length);
        buffer = buffer.subarray(8 + length);
        handleIncomingMessage(opcode, payload);
      }
    });

    client.on('error', () => {
      cleanupSocket();
      scheduleReconnect();
    });

    client.on('close', () => {
      cleanupSocket();
      scheduleReconnect();
    });

    // Handshake
    sendPacket(OPCODES.HANDSHAKE, {
      v: 1,
      client_id: CLIENT_ID
    });
  };

  const onError = () => {
    if (!resolved) {
      resolved = true;
      try { client.destroy(); } catch {}
      tryConnectNext(paths, index + 1);
    }
  };

  client.once('connect', onConnect);
  client.once('error', onError);
}

function connect() {
  if (connecting || isConnected) return;
  if (!isRpcEnabled()) return;

  clearTimeout(reconnectTimer);
  connecting = true;
  const paths = getCandidatePaths();
  tryConnectNext(paths, 0);
}

function cleanupSocket() {
  isConnected = false;
  isReady = false;
  connecting = false;
  if (socket) {
    try {
      socket.removeAllListeners();
      socket.destroy();
    } catch {}
    socket = null;
  }
}

function scheduleReconnect() {
  if (!isRpcEnabled()) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (!isConnected && !connecting) connect();
  }, 15000);
  reconnectTimer?.unref?.();
}

function buildCurrentActivity() {
  if (!isRpcEnabled()) return null;

  const defaultButtons = [
    { label: 'Get Native Client', url: DOWNLOAD_URL },
    { label: 'Join Discord', url: DISCORD_URL }
  ];

  if (currentGameState) {
    const { instance, status, server } = currentGameState;
    const loaderName = instance?.loader || 'Vanilla';
    const mcVer = instance?.version || '';
    const instanceName = instance?.name || 'Minecraft';

    const isFabric = String(loaderName).toLowerCase().includes('fabric');
    const smallImage = isFabric ? 'fabric' : 'vanilla';
    const smallText = `${loaderName} ${mcVer}`.trim();

    let details = 'Playing Minecraft';
    let state = `${instanceName} (${mcVer})`;

    if (status === 'launching') {
      details = 'Starting Minecraft';
      state = `${instanceName} (${mcVer})`;
    } else if (status === 'multiplayer') {
      details = 'Playing Multiplayer';
      state = server ? (server.includes('.') ? server : `Server: ${server}`) : 'Multiplayer';
    } else if (status === 'singleplayer') {
      details = 'Playing Singleplayer';
      state = instanceName;
    } else if (status === 'in-menus') {
      details = 'In Menus';
      state = `${instanceName} (${mcVer})`;
    }

    return {
      details,
      state,
      timestamps: {
        start: gameStartTime || launcherStartTime
      },
      assets: {
        large_image: 'logo',
        large_text: 'Native Client',
        small_image: smallImage,
        small_text: smallText
      },
      buttons: defaultButtons
    };
  }

  // In Launcher presence
  const tabLabel = TAB_DESCRIPTIONS[currentTab] || 'Main Menu';
  return {
    details: 'In Launcher',
    state: tabLabel,
    timestamps: {
      start: launcherStartTime
    },
    assets: {
      large_image: 'logo',
      large_text: 'Native Client'
    },
    buttons: [
      { label: 'Get Native Client', url: DOWNLOAD_URL }
    ]
  };
}

function flushPresence() {
  if (!isReady || !isConnected) {
    if (isRpcEnabled() && !connecting) connect();
    return;
  }

  const activity = buildCurrentActivity();
  const serialized = JSON.stringify(activity);
  if (serialized === lastPayloadSent) return;
  lastPayloadSent = serialized;

  const nonce = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
  sendPacket(OPCODES.FRAME, {
    cmd: 'SET_ACTIVITY',
    args: {
      pid: process.pid,
      activity
    },
    nonce
  });
}

function queueUpdate() {
  clearTimeout(updateThrottleTimer);
  updateThrottleTimer = setTimeout(flushPresence, 200);
}

function setGameActivity(gameState) {
  if (gameState) {
    if (!currentGameState) gameStartTime = Date.now();
    currentGameState = {
      instance: gameState.instance || null,
      status: gameState.status || 'running',
      server: gameState.server || null,
      serverAddress: gameState.serverAddress || null
    };
  } else {
    currentGameState = null;
    gameStartTime = null;
  }
  queueUpdate();
}

function clearGameActivity() {
  currentGameState = null;
  gameStartTime = null;
  queueUpdate();
}

function setTab(tab) {
  currentTab = String(tab || 'home');
  queueUpdate();
}

function onSettingsChanged(settings) {
  const enabled = typeof settings?.behavior?.discordRpc === 'boolean'
    ? settings.behavior.discordRpc
    : true;
  settingsOverride = { discordRpc: enabled };

  if (!enabled) {
    if (isReady && isConnected) {
      sendPacket(OPCODES.FRAME, {
        cmd: 'SET_ACTIVITY',
        args: { pid: process.pid, activity: null },
        nonce: String(Date.now())
      });
    }
    cleanupSocket();
    clearTimeout(reconnectTimer);
    lastPayloadSent = null;
  } else if (!isConnected && !connecting) {
    connect();
  }
}

function getStatus() {
  return {
    clientId: CLIENT_ID,
    connected: isConnected,
    ready: isReady,
    enabled: isRpcEnabled(),
    currentTab,
    inGame: Boolean(currentGameState)
  };
}

function init(dependencies, ipcMain) {
  deps = dependencies;
  launcherStartTime = Date.now();

  if (ipcMain) {
    ipcMain.on('discord:setTab', (_event, tab) => setTab(tab));
    ipcMain.handle('discord:setGameActivity', (_event, state) => setGameActivity(state));
    ipcMain.handle('discord:clearGameActivity', () => clearGameActivity());
    ipcMain.handle('discord:getStatus', () => getStatus());
  }

  if (isRpcEnabled()) {
    connect();
  }
}

function destroy() {
  clearTimeout(reconnectTimer);
  clearTimeout(updateThrottleTimer);
  settingsOverride = null;
  if (isReady && isConnected) {
    try {
      sendPacket(OPCODES.FRAME, {
        cmd: 'SET_ACTIVITY',
        args: { pid: process.pid, activity: null },
        nonce: String(Date.now())
      });
    } catch {}
  }
  cleanupSocket();
}

module.exports = {
  CLIENT_ID,
  OPCODES,
  init,
  connect,
  destroy,
  setTab,
  setGameActivity,
  clearGameActivity,
  onSettingsChanged,
  getStatus,
  buildCurrentActivity,
  setTestSocketPath
};
