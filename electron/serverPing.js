const net = require('net');
const dns = require('dns');

/**
 * Native Minecraft Server List Ping (SLP) — main process.
 *
 * Speaks the post-1.7 JSON status protocol over a raw TCP socket, so it works
 * for any public server without an external API or key:
 *   handshake (state 1) -> status request -> status response (JSON) .
 *
 * Returns MOTD, player counts, version, favicon (data URI) and latency.
 */

const DEFAULT_PORT = 25565;
const TIMEOUT_MS = 6000;

/* ── VarInt helpers ─────────────────────────────────────────── */

function encodeVarInt(value) {
  const bytes = [];
  let v = value;
  do {
    let temp = v & 0b01111111;
    v >>>= 7; // unsigned shift so negatives (e.g. protocol -1) encode correctly
    if (v !== 0) temp |= 0b10000000;
    bytes.push(temp);
  } while (v !== 0);
  return Buffer.from(bytes);
}

/** Read a VarInt from buffer at offset. Returns { value, size } or null if incomplete. */
function readVarInt(buffer, offset) {
  let value = 0;
  let size = 0;
  let byte;
  do {
    if (offset + size >= buffer.length) return null; // need more bytes
    byte = buffer[offset + size];
    value |= (byte & 0b01111111) << (7 * size);
    size += 1;
    if (size > 5) throw new Error('VarInt too big');
  } while (byte & 0b10000000);
  return { value, size };
}

function makePacket(id, ...chunks) {
  const body = Buffer.concat([encodeVarInt(id), ...chunks]);
  return Buffer.concat([encodeVarInt(body.length), body]);
}

function writeString(str) {
  const buf = Buffer.from(str, 'utf8');
  return Buffer.concat([encodeVarInt(buf.length), buf]);
}

/* ── MOTD flattening ────────────────────────────────────────── */

function flattenMotd(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(flattenMotd).join('');
  let out = typeof node.text === 'string' ? node.text : '';
  if (Array.isArray(node.extra)) out += node.extra.map(flattenMotd).join('');
  return out;
}

function cleanMotd(raw) {
  return flattenMotd(raw)
    .replace(/\u00a7[0-9a-fk-or]/gi, '') // strip § formatting codes
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/* ── address parsing + SRV ──────────────────────────────────── */

function parseAddress(address) {
  const value = String(address || '').trim();
  const match = value.match(/^([^:\s]+)(?::(\d{1,5}))?$/);
  if (!match) return null;
  return { host: match[1], port: match[2] ? Number(match[2]) : null };
}

function resolveSrv(host) {
  return new Promise((resolve) => {
    dns.resolveSrv(`_minecraft._tcp.${host}`, (err, records) => {
      if (err || !records || records.length === 0) return resolve(null);
      const best = records.sort((a, b) => a.priority - b.priority)[0];
      resolve({ host: best.name, port: best.port });
    });
  });
}

/* ── the ping itself ────────────────────────────────────────── */

function pingOnce(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let chunks = Buffer.alloc(0);
    let started = 0;
    let settled = false;

    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(TIMEOUT_MS);
    socket.on('timeout', () => done({ online: false }));
    socket.on('error', () => done({ online: false }));

    socket.on('connect', () => {
      started = Date.now();
      const handshake = makePacket(
        0x00,
        encodeVarInt(-1),          // protocol version (-1 = "just pinging")
        writeString(host),
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        encodeVarInt(1)            // next state: status
      );
      socket.write(Buffer.concat([handshake, makePacket(0x00)]));
    });

    socket.on('data', (data) => {
      chunks = Buffer.concat([chunks, data]);
      try {
        const lengthPrefix = readVarInt(chunks, 0);
        if (!lengthPrefix) return; // need more
        const total = lengthPrefix.size + lengthPrefix.value;
        if (chunks.length < total) return; // packet not complete yet

        let cursor = lengthPrefix.size;
        const packetId = readVarInt(chunks, cursor);
        cursor += packetId.size;
        const strLen = readVarInt(chunks, cursor);
        cursor += strLen.size;
        const json = chunks.slice(cursor, cursor + strLen.value).toString('utf8');
        const parsed = JSON.parse(json);
        const latency = Date.now() - started;

        done({
          online: true,
          latency,
          motd: cleanMotd(parsed.description),
          rawDescription: parsed.description,
          players: {
            online: parsed.players?.online ?? 0,
            max: parsed.players?.max ?? 0
          },
          version: parsed.version?.name ?? '',
          favicon:
            typeof parsed.favicon === 'string' && parsed.favicon.startsWith('data:image')
              ? parsed.favicon
              : null
        });
      } catch {
        done({ online: false });
      }
    });
  });
}

async function ping(address) {
  const parsed = parseAddress(address);
  if (!parsed) return { online: false };

  let { host, port } = parsed;
  if (port == null) {
    const srv = await resolveSrv(host);
    if (srv) { host = srv.host; port = srv.port; }
    else port = DEFAULT_PORT;
  }

  try {
    return await pingOnce(host, port);
  } catch {
    return { online: false };
  }
}

/* ── promoted servers ───────────────────────────────────────── *
 * Partner servers the backend pins to the top of the server browser.
 * Cached briefly so switching tabs doesn't re-hit the API. */

const PROMOTED_API = String(process.env.NATIVE_WARDROBE_API || 'https://api.playnative.fun').replace(/\/+$/, '');
const PROMOTED_TTL = 5 * 60_000;
let promotedCache = { at: 0, servers: [] };

async function promoted(force = false) {
  const now = Date.now();
  if (!force && promotedCache.at && now - promotedCache.at < PROMOTED_TTL) {
    return { ok: true, servers: promotedCache.servers, cached: true };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`${PROMOTED_API}/v1/site/config`, { signal: controller.signal });
    clearTimeout(timer);
    const body = await res.json();
    const servers = Array.isArray(body?.servers) ? body.servers : [];
    promotedCache = { at: now, servers };
    return { ok: true, servers };
  } catch (error) {
    // Offline or the API is down: keep showing whatever we fetched last.
    return { ok: false, servers: promotedCache.servers, error: String(error?.message || error) };
  }
}

function init(_deps, ipcMain) {
  ipcMain.handle('server:ping', (_e, address) => ping(address));
  ipcMain.handle('server:promoted', (_e, options) => promoted(Boolean(options?.force)));
}

module.exports = { init, ping, promoted, cleanMotd, parseAddress };
