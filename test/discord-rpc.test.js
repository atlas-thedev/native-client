const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const discordRpc = require('../electron/discordRpc');

test('discord-rpc: exports correct client ID and opcodes', () => {
  assert.equal(discordRpc.CLIENT_ID, '1465139441457827972');
  assert.equal(discordRpc.OPCODES.HANDSHAKE, 0);
  assert.equal(discordRpc.OPCODES.FRAME, 1);
  assert.equal(discordRpc.OPCODES.CLOSE, 2);
  assert.equal(discordRpc.OPCODES.PING, 3);
  assert.equal(discordRpc.OPCODES.PONG, 4);
});

test('discord-rpc: builds professional launcher and in-game activities', () => {
  discordRpc.setTab('skins');
  const wardrobeActivity = discordRpc.buildCurrentActivity();
  assert.equal(wardrobeActivity.details, 'In Launcher');
  assert.equal(wardrobeActivity.state, 'Customizing Wardrobe');
  assert.equal(wardrobeActivity.assets.large_image, 'logo');
  assert.equal(wardrobeActivity.assets.large_text, 'Native Client');
  assert.equal(wardrobeActivity.buttons[0].label, 'Get Native Client');

  discordRpc.setGameActivity({
    instance: { name: 'Tricky Trials', version: '1.21.1', loader: 'Fabric' },
    status: 'launching'
  });
  const launchingActivity = discordRpc.buildCurrentActivity();
  assert.equal(launchingActivity.details, 'Starting Minecraft');
  assert.equal(launchingActivity.state, 'Tricky Trials (1.21.1)');
  assert.equal(launchingActivity.assets.small_image, 'fabric');
  assert.equal(launchingActivity.assets.small_text, 'Fabric 1.21.1');

  discordRpc.setGameActivity({
    instance: { name: 'Tricky Trials', version: '1.21.1', loader: 'Fabric' },
    status: 'multiplayer',
    server: 'Hypixel',
    serverAddress: 'mc.hypixel.net:25565'
  });
  const mpActivity = discordRpc.buildCurrentActivity();
  assert.equal(mpActivity.details, 'Playing Multiplayer');
  assert.equal(mpActivity.state, 'Server: Hypixel');
  assert.equal(mpActivity.assets.small_image, 'fabric');

  discordRpc.setGameActivity({
    instance: { name: 'Tricky Trials', version: '1.21.1', loader: 'Vanilla' },
    status: 'singleplayer'
  });
  const spActivity = discordRpc.buildCurrentActivity();
  assert.equal(spActivity.details, 'Playing Singleplayer');
  assert.equal(spActivity.state, 'Tricky Trials');
  assert.equal(spActivity.assets.small_image, 'vanilla');

  discordRpc.clearGameActivity();
  const backInLauncher = discordRpc.buildCurrentActivity();
  assert.equal(backInLauncher.details, 'In Launcher');
});

test('discord-rpc: performs complete handshake and set_activity exchange with mock Discord IPC server', async () => {
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\test-discord-ipc-${Date.now()}-${Math.random().toString(36).slice(2)}`
    : path.join(os.tmpdir(), `test-discord-ipc-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
  if (process.platform !== 'win32' && fs.existsSync(socketPath)) fs.unlinkSync(socketPath);

  const receivedPackets = [];
  let serverClientSocket = null;

  const server = net.createServer((c) => {
    serverClientSocket = c;
    let buf = Buffer.alloc(0);

    c.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const opcode = buf.readInt32LE(0);
        const len = buf.readInt32LE(4);
        if (buf.length < 8 + len) break;
        const payload = JSON.parse(buf.subarray(8, 8 + len).toString('utf8'));
        buf = buf.subarray(8 + len);
        receivedPackets.push({ opcode, payload });

        if (opcode === 0) { // HANDSHAKE
          const readyMsg = Buffer.from(JSON.stringify({
            cmd: 'DISPATCH',
            evt: 'READY',
            data: { v: 1, user: { id: '999', username: 'TestPlayer' } }
          }), 'utf8');
          const hdr = Buffer.alloc(8);
          hdr.writeInt32LE(1, 0); // FRAME
          hdr.writeInt32LE(readyMsg.length, 4);
          c.write(Buffer.concat([hdr, readyMsg]));
        }
      }
    });
  });

  await new Promise((resolve) => server.listen(socketPath, resolve));

  try {
    discordRpc.setTestSocketPath(socketPath);
    discordRpc.init({
      app: {},
      getSettings: () => ({ behavior: { discordRpc: true } })
    });

    // Wait for handshake and activity flush
    await new Promise((resolve) => setTimeout(resolve, 600));

    assert.ok(receivedPackets.length >= 2, 'Expected handshake and initial activity frame');
    assert.equal(receivedPackets[0].opcode, 0, 'First packet is handshake');
    assert.equal(receivedPackets[0].payload.client_id, '1465139441457827972');

    const activityFrame = receivedPackets.find((p) => p.payload.cmd === 'SET_ACTIVITY');
    assert.ok(activityFrame, 'Should have sent SET_ACTIVITY command');
    assert.equal(activityFrame.payload.args.activity.details, 'In Launcher');
    assert.equal(activityFrame.payload.args.activity.assets.large_image, 'logo');

    // Test disabling via settings
    discordRpc.onSettingsChanged({ behavior: { discordRpc: false } });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const status = discordRpc.getStatus();
    assert.equal(status.enabled, false);
    assert.equal(status.connected, false);
  } finally {
    discordRpc.destroy();
    discordRpc.setTestSocketPath(null);
    if (serverClientSocket) serverClientSocket.destroy();
    server.close();
    try { fs.unlinkSync(socketPath); } catch {}
  }
});
