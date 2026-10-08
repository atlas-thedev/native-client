const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

// The data directory is resolved when the module is loaded, so point it at a
// scratch folder before requiring the server.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'native-skin-api-'));
process.env.NATIVE_SKIN_DATA = DATA_DIR;
delete process.env.NATIVE_SKIN_PUBLIC_URL;

const { pngBuffer, usernameOf, listen, customSkinProfile } = require('../server/server');

/* ---------- tiny PNG helper ---------- */

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc ^ -1;
}

function makePng(fill = 0) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const size = 64;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(size * (1 + size * 4), fill);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- pure helpers ---------- */

test('skin API accepts valid Minecraft usernames only', () => {
  assert.equal(usernameOf('Player_123'), 'Player_123');
  assert.throws(() => usernameOf('../player'));
  assert.throws(() => usernameOf('ab'));
});

test('skin API rejects non-PNG uploads', () => {
  assert.equal(pngBuffer(null), null);
  assert.throws(() => pngBuffer(Buffer.from('not a png').toString('base64')));
});

/* ---------- profile document shape ---------- */

const VANILLA_HASH = 'f9a76537647989f9a0b6d001e320dac591c359e9e61a31f4ce11c88f207f0ad4';
const VANILLA_PNG = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'assets', 'capes', 'vanilla.png'));

test('CustomSkinAPI documents use absolute texture URLs and follow the model', () => {
  const origin = 'https://api.example.test';
  const classic = customSkinProfile(
    { username: 'Notch', model: 'default', skin: 'a'.repeat(64), cape: VANILLA_HASH },
    origin
  );
  assert.equal(classic.skins.default, `${origin}/csl/textures/${'a'.repeat(64)}`);
  assert.equal(classic.skins.slim, undefined);
  assert.equal(classic.capes.default, `${origin}/csl/textures/${VANILLA_HASH}`);
  // Capes players made themselves are never served.
  assert.deepEqual(customSkinProfile({ username: 'Notch', model: 'default', cape: 'b'.repeat(64) }, origin).capes, {});

  const slim = customSkinProfile({ username: 'Notch', model: 'slim', skin: 'c'.repeat(64), cape: null }, origin);
  assert.equal(slim.skins.slim, `${origin}/csl/textures/${'c'.repeat(64)}`);
  assert.equal(slim.skins.default, undefined);
  assert.deepEqual(slim.capes, {});

  const empty = customSkinProfile({ username: 'Notch', model: 'default' }, origin);
  assert.deepEqual(empty.skins, {});
  assert.deepEqual(empty.capes, {});
});

/* ---------- HTTP round trip ---------- */

test('publishing an outfit serves a CustomSkinLoader profile and texture', async (t) => {
  const server = await listen(0, '127.0.0.1');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const authDb = require('../server/db');
  const owner = authDb.createUser({ email: 'notch@example.com', username: 'Notch', password: 'password123' });
  const key = authDb.createSession(owner.id).token;
  const skin = makePng(0x11);
  const cape = VANILLA_PNG;

  const publish = await fetch(`${base}/v1/wardrobe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ username: 'Notch', model: 'slim', skin: skin.toString('base64'), skinName: 'Night Walker', cape: cape.toString('base64') })
  });
  assert.equal(publish.status, 200);

  const profileRes = await fetch(`${base}/csl/Notch.json`);
  assert.equal(profileRes.status, 200);
  assert.equal(profileRes.headers.get('access-control-allow-origin'), '*');
  const profile = await profileRes.json();
  assert.equal(profile.username, 'Notch');
  assert.equal(profile.model, 'slim');
  assert.equal(profile.skinName, 'Night Walker'); // the locker name travels with the skin
  assert.match(profile.skins.slim, new RegExp(`^${base}/csl/textures/[a-f0-9]{64}$`));
  assert.match(profile.capes.default, new RegExp(`^${base}/csl/textures/[a-f0-9]{64}$`));

  // The advertised URLs really serve the uploaded bytes.
  const textureRes = await fetch(profile.skins.slim);
  assert.equal(textureRes.status, 200);
  assert.equal(textureRes.headers.get('content-type'), 'image/png');
  const served = Buffer.from(await textureRes.arrayBuffer());
  assert.equal(served.length, skin.length);
  assert.ok(served.equals(skin));

  // The local proxy's X-Forwarded-Proto is honoured; X-Forwarded-Host never is.
  const proxied = await fetch(`${base}/csl/Notch`, { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example' } });
  const proxiedProfile = await proxied.json();
  assert.match(proxiedProfile.skins.slim, /^https:\/\/127\.0\.0\.1:\d+\/csl\/textures\//);

  // A spoofed Host header falls back to the public API origin.
  const spoofed = await new Promise((resolve, reject) => {
    const { port } = new URL(base);
    const req = require('http').request({ host: '127.0.0.1', port, path: '/csl/Notch', headers: { Host: 'evil.example' } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.end();
  });
  assert.match(spoofed.skins.slim, /^https:\/\/api\.playnative\.fun\/csl\/textures\//);

  // Without a session nobody can publish; another account can't touch this name.
  const anonymous = await fetch(`${base}/v1/wardrobe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${crypto.randomBytes(32).toString('hex')}` },
    body: JSON.stringify({ username: 'Notch', skin: skin.toString('base64') })
  });
  assert.equal(anonymous.status, 401);
  const other = authDb.createUser({ email: 'jeb@example.com', username: 'Jeb_', password: 'password123' });
  const conflict = await fetch(`${base}/v1/wardrobe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authDb.createSession(other.id).token}` },
    body: JSON.stringify({ username: 'Notch', skin: skin.toString('base64') })
  });
  assert.equal(conflict.status, 403);

  // Unknown players are a clean 404.
  assert.equal((await fetch(`${base}/csl/Herobrine.json`)).status, 404);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('multi-device sync succeeds with a Native session token', async (t) => {
  const authDb = require('../server/db');
  const server = await listen(0, '127.0.0.1');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const testUser = authDb.createUser({ email: 'steve@example.com', username: 'SteveTest', password: 'password123', model: 'classic' });
  const sessionDevice1 = authDb.createSession(testUser.id);
  const sessionDevice2 = authDb.createSession(testUser.id);
  const skinA = makePng(0x33);
  const skinB = makePng(0x44);

  const upload = (token, skin, key = crypto.randomBytes(24).toString('hex')) => fetch(`${base}/v1/wardrobe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Native-Token': token } : {}), Authorization: `Bearer ${key}` },
    body: JSON.stringify({ username: 'SteveTest', skin: skin.toString('base64') })
  });

  assert.equal((await upload(sessionDevice1.token, skinA)).status, 200);
  assert.equal((await upload(sessionDevice2.token, skinB)).status, 200);

  // A registered name can't be changed without that account's session.
  assert.equal((await upload(null, skinA)).status, 401);

  const profile = await (await fetch(`${base}/csl/SteveTest.json`)).json();
  const served = Buffer.from(await (await fetch(profile.skins.default)).arrayBuffer());
  assert.ok(served.equals(skinB));
});

test('offline names are never published and premium accounts publish only their cloak', async (t) => {
  const authDb = require('../server/db');
  const server = await listen(0, '127.0.0.1');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (key, body) => fetch(`${base}/v1/wardrobe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body)
  });
  // An offline player (no Native session) can't claim a name any more.
  assert.equal((await post(crypto.randomBytes(24).toString('hex'), { username: 'AlexOffline', skin: makePng(0x55).toString('base64') })).status, 401);
  assert.equal((await fetch(`${base}/csl/AlexOffline.json`)).status, 404);

  const premium = authDb.createPremiumUser({ uuid: '853c80ef3c3749fdaa49938b674adae6', name: 'jeb' });
  const token = authDb.createSession(premium.id, 'premium').token;
  assert.equal((await post(token, { skin: makePng(0x66).toString('base64'), cape: VANILLA_PNG.toString('base64') })).status, 200);
  const profile = await (await fetch(`${base}/csl/jeb.json`)).json();
  assert.deepEqual(profile.skins, {}, 'the Mojang skin stays');
  assert.match(profile.capes.default, /\/csl\/textures\/[a-f0-9]{64}$/);
});
