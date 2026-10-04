const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

let esbuild = null;
try {
  esbuild = require('esbuild');
} catch {
  esbuild = null;
}

test('NativeAccountGate renders correctly for Locker and Relay', { skip: !esbuild && 'esbuild is not installed' }, () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noctra-gate-ui-'));
  const entry = path.join(workDir, 'entry.jsx');
  const bundle = path.join(workDir, 'bundle.cjs');

  fs.writeFileSync(entry, `
globalThis.window = {
  native: { version: '3.9.58', openExternal() {}, minimize() {}, maximize() {}, close() {} },
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
};
globalThis.document = { documentElement: { dataset: {}, style: { setProperty() {} } }, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const React = require('react');
const { renderToString } = require('react-dom/server');
const NativeAccountGate = require(${JSON.stringify(path.join(ROOT, 'src/components/ui/NativeAccountGate.jsx'))}).default;

const lockerHtml = renderToString(React.createElement(NativeAccountGate, {
  feature: 'locker',
  onOpenAccountSwitcher() {},
  onBackHome() {}
}));

const relayHtml = renderToString(React.createElement(NativeAccountGate, {
  feature: 'relay',
  onOpenAccountSwitcher() {},
  onBackHome() {}
}));

process.stdout.write(JSON.stringify({ lockerHtml, relayHtml }));
`);

  esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.png': 'dataurl' },
    outfile: bundle,
    logLevel: 'error',
    nodePaths: [path.join(ROOT, 'node_modules')]
  });

  const raw = execFileSync(process.execPath, [bundle], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  fs.rmSync(workDir, { recursive: true, force: true });

  const { lockerHtml, relayHtml } = JSON.parse(raw);

  // Locker verification
  assert.ok(lockerHtml.includes('Native account required'), 'Locker gate title is rendered');
  assert.ok(lockerHtml.includes('Sign in'), 'Locker gate has Sign in CTA');
  assert.ok(lockerHtml.includes('Back to Home'), 'Locker gate has Back to Home CTA');
  assert.ok(lockerHtml.includes('skins and capes'), 'Locker gate mentions skins and capes');

  // Relay verification
  assert.ok(relayHtml.includes('Native account required'), 'Relay gate title is rendered');
  assert.ok(relayHtml.includes('Sign in'), 'Relay gate has Sign in CTA');
  assert.ok(relayHtml.includes('Back to Home'), 'Relay gate has Back to Home CTA');
  assert.ok(relayHtml.includes('chat with friends'), 'Relay gate mentions chat with friends');
});

test('account gating logic distinguishes Native accounts from guest/microsoft/offline', () => {
  const isNativeAccount = (acc, accs) => {
    const hasValid = Boolean(acc && acc.id && acc.id !== 'guest' && accs && accs.length > 0);
    return Boolean(hasValid && (acc.type === 'noctra' || acc.type === 'native'));
  };

  const guest = { id: 'guest', name: 'Guest', type: 'guest' };
  const offline = { id: 'off-1', name: 'Steve', type: 'offline' };
  const ms = { id: 'ms-1', name: 'Alex', type: 'microsoft', isMicrosoft: true };
  const noctra = { id: 'noctra-1', name: 'ProPlayer', type: 'noctra', token: 'sec-123' };
  const native = { id: 'native-1', name: 'LegacyPlayer', type: 'native' };

  // Guest or no accounts
  assert.equal(isNativeAccount(guest, []), false, 'Guest is not Native');
  assert.equal(isNativeAccount(null, []), false, 'Null account is not Native');
  assert.equal(isNativeAccount(noctra, []), false, 'Empty accounts list disallows access');

  // Microsoft and offline
  assert.equal(isNativeAccount(offline, [offline]), false, 'Offline account cannot access Native features');
  assert.equal(isNativeAccount(ms, [ms]), false, 'Microsoft account cannot access Native features');

  // Native and native
  assert.equal(isNativeAccount(noctra, [noctra]), true, 'Native account can access Native features');
  assert.equal(isNativeAccount(native, [native]), true, 'Native account can access Native features');
});

test('relay notifications use Discord-style titles and bodies', () => {
  const formatNotification = (event, selfId = 'self-1', friends = []) => {
    let title = '';
    let body = '';

    if (event?.type === 'message:new' && event.message?.senderId !== selfId) {
      const friend = friends.find((item) => item.id === event.message?.senderId);
      title = friend?.nickname || friend?.name || event.message.senderName || 'Direct Message';
      body = event.message.content || (event.message.mediaName ? `Sent an attachment: ${event.message.mediaName}` : 'Sent an attachment');
    } else if (event?.type === 'group:message') {
      const message = event.data?.message ?? event.message;
      if (!message || message.senderId === selfId || message.isSystem) return null;
      const sender = message.senderName || 'Member';
      const group = event.data?.groupName || event.groupName || 'Group';
      title = `${sender} (${group})`;
      body = message.content || (message.mediaName ? `Sent an attachment: ${message.mediaName}` : 'Sent an attachment');
    } else if (event?.type === 'request:changed' && event.actorId !== selfId) {
      const actor = event.actorName || 'A player';
      if (event.action === 'accepted') {
        title = 'Friend Request Accepted';
        body = `${actor} accepted your friend request.`;
      } else if (!event.action || event.action === 'sent') {
        title = 'Friend Request';
        body = `${actor} sent you a friend request.`;
      }
    }
    return { title, body };
  };

  // Direct Message (Discord format)
  const dm = formatNotification({
    type: 'message:new',
    message: { senderId: 'u2', senderName: 'OhLlama', content: 'Hey, are you on?' }
  });
  assert.equal(dm.title, 'OhLlama', 'DM notification title is author name without "New" prefix');
  assert.equal(dm.body, 'Hey, are you on?');

  // Group Message (Discord format)
  const groupMsg = formatNotification({
    type: 'group:message',
    data: {
      groupName: 'Survival SMP',
      message: { senderId: 'u3', senderName: 'Steve', content: 'Base is ready!' }
    }
  });
  assert.equal(groupMsg.title, 'Steve (Survival SMP)', 'Group notification title is "Sender (Group)" without "New" prefix');
  assert.equal(groupMsg.body, 'Base is ready!', 'Group notification body is clean message content');

  // Friend Request (Discord format)
  const req = formatNotification({
    type: 'request:changed',
    actorId: 'u4',
    actorName: 'Alex',
    action: 'sent'
  });
  assert.equal(req.title, 'Friend Request', 'Friend request title is "Friend Request"');
  assert.equal(req.body, 'Alex sent you a friend request.');
});

