const path = require('path');
const fs = require('fs');

/*
 * Live game console.
 *
 * The launcher feeds every chunk the game writes (stdout + stderr) and its own
 * debug lines into a per-instance ring buffer. Each line is tagged with a
 * level (info / warn / severe / debug), its source (game or launcher) and an
 * optional mark when it looks like the cause of a crash, so the renderer can
 * colour, filter and highlight it without re-parsing.
 *
 * Lines are pushed to the window in small batches (`console:lines`) and the
 * full buffer can be fetched at any time (`console:get`). When there is no
 * live session for an instance, the console falls back to its logs/latest.log.
 */

const MAX_LINES = 20000;
const MAX_LINE_CHARS = 4000;
const MAX_SESSIONS = 6;
const FLUSH_MS = 120;
const HEADERS = { 'User-Agent': 'NoctraClient (https://github.com/atlas-thedev/noctra-client)' };

let deps = null;
const sessions = new Map(); // instanceId -> session
let activeId = null;
let pending = new Map(); // instanceId -> lines[]
let flushTimer = null;

/* ---------------------------------------------------------------- parsing */

const LEVELS = {
  TRACE: 'debug', DEBUG: 'debug', FINE: 'debug', FINER: 'debug', FINEST: 'debug', CONFIG: 'debug',
  INFO: 'info',
  WARN: 'warn', WARNING: 'warn',
  ERROR: 'severe', FATAL: 'severe', SEVERE: 'severe'
};

// [12:34:56] [Render thread/INFO]: …   |  [12:34:56] [main/WARN] [mixin/]: …
// [12:34:56.789] [main/INFO] (FabricLoader) …
const HEADER = /^\[(\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?)\]\s*\[([^\]]*?)\/(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|SEVERE)\]/i;
// [12:34:56 INFO]: …  (Paper style / some older forks)
const HEADER_SHORT = /^\[(\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?)\s+(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|SEVERE)\]/i;
// 2013-05-01 12:00:00 [INFO] …  (pre-1.7 legacy logger)
const HEADER_LEGACY = /^(?:\d{4}-\d{2}-\d{2}\s+)?(\d{1,2}:\d{2}:\d{2})\s+\[(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|SEVERE|FINE|FINER|FINEST|CONFIG)\]/i;
// [main/INFO]: …  (no timestamp)
const HEADER_BARE = /^\[([^\]]{1,60}?)\/(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|SEVERE)\]/i;
const LAUNCHER_LINE = /^\[(MCLC|Noctra)\]/i;

// Stack trace continuation: "\tat x.y(Z.java:1)", "Caused by: …", "\t... 12 more", "Suppressed: …"
const CONTINUATION = /^(?:\s+at\s|\s*at\s+[\w$.<>/]+\(|\s*Caused by:|\s*Suppressed:|\s*\.\.\.\s*\d+\s+more|\s+\S)/;
const EXCEPTION_START = /^(?:Exception in thread|[a-z][\w$]*(?:\.[\w$]+)+(?:Exception|Error|Throwable)\b)/;

const CRASH_MARK = [
  /^----\s*Minecraft Crash Report\s*----/,
  /^#\s*A fatal error has been detected by the Java Runtime Environment/,
  /Reported exception thrown!|Unreported exception thrown!/,
  /Preparing crash report with UUID|This crash report has been saved to:|Crash report saved to/i,
  /^Exception in thread "/,
  /^\s*Caused by:/,
  /Mixin apply(?: for mod [\w-]+)? failed|InvalidMixinException|MixinApplyError|MixinTransformerError/,
  /^java\.lang\.(?:OutOfMemoryError|StackOverflowError|NoClassDefFoundError|ClassNotFoundException|NoSuchMethodError|NoSuchFieldError|UnsupportedClassVersionError)/
];
const DEP_MARK = [
  /which is missing!?/i,
  /requires (?:any version|version|mod) .* of ['"]?[\w-]+/i,
  /Missing or unsupported mandatory dependencies/i,
  /Mod resolution (?:failed|encountered an incompatible mod set)/i,
  /Incompatible mods? (?:set|found)/i,
  /Unmet dependency listing|Missing mods?:/i,
  /\bmissing (?:mandatory )?dependenc/i,
  /is incompatible with/i,
  /Duplicate mods? found|Found duplicate mods?/i,
  /- Install [\w .'-]+, any version/i
];

function classifyMark(text, level) {
  if (DEP_MARK.some((re) => re.test(text))) return 'dep';
  if (CRASH_MARK.some((re) => re.test(text))) return 'crash';
  if (level === 'severe' && EXCEPTION_START.test(text.replace(/^\[[^\]]*\]\s*\[[^\]]*\](?:\s*\[[^\]]*\])?:?\s*/, ''))) return 'crash';
  return null;
}

// Never let tokens reach the console, a saved file or a paste service.
function redact(text) {
  return text
    .replace(/(--accessToken[\s=]+)\S+/gi, '$1••••••••')
    .replace(/(--(?:xuid|clientId)[\s=]+)\S+/gi, '$1••••••••')
    .replace(/(Session ID is )(?:token:)?[^\s)]+/gi, '$1••••••••')
    .replace(/(\btoken:)[A-Za-z0-9._-]{20,}/g, '$1••••••••')
    .replace(/(\beyJ[A-Za-z0-9_-]{10,}\.)[A-Za-z0-9._-]+/g, '$1••••••••');
}

function stripXml(text) {
  return text.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/**
 * Stateful line classifier. Feed it whole lines; it remembers the previous
 * level so stack traces stay red, and buffers log4j XML events (used when a
 * launcher passes Mojang's client.xml logging config).
 */
function createParser() {
  let prevLevel = 'info';
  let inTrace = false; // inside an exception / crash report block
  let xml = null; // { level, thread, logger, ts, parts }

  const parseLine = (raw, stream = 'stdout') => {
    const text = raw.replace(/\r$/, '');
    if (xml) {
      if (/<\/log4j:Event>/.test(text)) {
        const done = xml;
        xml = null;
        const body = stripXml(done.parts.join('\n').replace(/<\/?log4j:(?:Message|Throwable)>/g, '')).trim();
        prevLevel = done.level;
        const time = done.ts ? new Date(done.ts).toTimeString().slice(0, 8) : '';
        const line = `[${time}] [${done.thread}/${done.levelName}]: ${body}`;
        return { level: done.level, thread: done.thread, text: line };
      }
      xml.parts.push(text.replace(/^\s+/, ''));
      return undefined;
    }
    const event = /<log4j:Event\b([^>]*)>/.exec(text);
    if (event) {
      const attr = (name) => (new RegExp(`${name}="([^"]*)"`).exec(event[1]) || [])[1] || '';
      const levelName = attr('level').toUpperCase() || 'INFO';
      xml = { level: LEVELS[levelName] || 'info', levelName, thread: attr('thread'), logger: attr('logger'), ts: Number(attr('timestamp')) || 0, parts: [] };
      const rest = text.slice(event.index + event[0].length);
      if (rest.trim()) return parseLine(rest, stream);
      return undefined;
    }

    if (LAUNCHER_LINE.test(text)) {
      const level = /\b(?:error|failed|couldn't|could not)\b/i.test(text) ? 'warn' : 'info';
      return { level, source: 'launcher', text };
    }

    let m = HEADER.exec(text);
    if (m) {
      inTrace = false;
      prevLevel = LEVELS[m[3].toUpperCase()] || 'info';
      return { level: prevLevel, thread: m[2], text };
    }
    m = HEADER_SHORT.exec(text) || HEADER_LEGACY.exec(text);
    if (m) {
      inTrace = false;
      prevLevel = LEVELS[m[2].toUpperCase()] || 'info';
      return { level: prevLevel, text };
    }
    m = HEADER_BARE.exec(text);
    if (m) {
      inTrace = false;
      prevLevel = LEVELS[m[2].toUpperCase()] || 'info';
      return { level: prevLevel, thread: m[1], text };
    }
    if (text.trim() && CONTINUATION.test(text) && !/^\s*$/.test(text)) {
      // Stack frames belong to whatever started them; an exception that
      // surfaced on stderr is severe even if the header said INFO.
      if (/^\s*Caused by:/.test(text) && prevLevel !== 'severe' && stream === 'stderr') prevLevel = 'severe';
      if (/^\s*(?:at\s|Caused by:)/.test(text)) inTrace = true;
      return { level: prevLevel, text, cont: true };
    }
    if (EXCEPTION_START.test(text)) {
      prevLevel = 'severe';
      inTrace = true;
      return { level: 'severe', text };
    }
    if (/^----\s*Minecraft Crash Report\s*----|^#\s*A fatal error has been detected/.test(text)) {
      prevLevel = 'severe';
      inTrace = true;
      return { level: 'severe', text };
    }
    if (stream === 'stderr') {
      prevLevel = /\b(?:error|exception|fatal|failed)\b/i.test(text) ? 'severe' : 'warn';
      return { level: prevLevel, text };
    }
    // Plain stdout text: a crash report printed to stdout stays red, a mod's
    // System.out println after an error line does not.
    return { level: inTrace && prevLevel === 'severe' ? 'severe' : 'info', text };
  };

  return { parseLine };
}

/** Parse a whole log text into console lines (used for latest.log fallback and tests). */
function parseText(text, { source = 'game', startAt = 0 } = {}) {
  const parser = createParser();
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const parsed = parser.parseLine(raw, 'stdout');
    if (!parsed) continue;
    out.push(makeLine(out.length + 1, startAt, parsed, source));
  }
  return out;
}

function makeLine(n, t, parsed, source) {
  const text = redact(parsed.text.length > MAX_LINE_CHARS ? `${parsed.text.slice(0, MAX_LINE_CHARS)}…` : parsed.text);
  const line = { n, t, lv: parsed.level, src: parsed.source || source, text };
  if (parsed.thread) line.th = parsed.thread;
  const mark = classifyMark(text, parsed.level);
  if (mark) line.mk = mark;
  return line;
}

/* --------------------------------------------------------------- sessions */

function summary(instance) {
  if (!instance) return null;
  return {
    id: instance.id,
    name: instance.name || instance.version || instance.id,
    version: instance.version || instance.mcVersion || null,
    loader: instance.loader || instance.mc_loader || 'vanilla',
    loaderVersion: instance.loaderVersion || null
  };
}

function begin(instance) {
  if (!instance?.id) return;
  const session = {
    instance: summary(instance),
    startedAt: Date.now(),
    endedAt: null,
    running: true,
    exit: null,
    lines: [],
    seq: 0,
    dropped: 0,
    partial: { stdout: '', stderr: '' },
    parser: createParser(),
    counts: { info: 0, warn: 0, severe: 0, debug: 0, launcher: 0 },
    shareUrls: {}
  };
  sessions.delete(instance.id);
  sessions.set(instance.id, session);
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  activeId = instance.id;
  pending.delete(instance.id);
  send('console:session', publicSession(session, false));
}

function addLine(session, parsed, source) {
  session.seq += 1;
  const line = makeLine(session.seq, Date.now(), parsed, source);
  session.lines.push(line);
  if (line.src === 'launcher') session.counts.launcher += 1;
  else session.counts[line.lv] = (session.counts[line.lv] || 0) + 1;
  if (session.lines.length > MAX_LINES) {
    const removed = session.lines.splice(0, session.lines.length - MAX_LINES);
    session.dropped += removed.length;
    for (const old of removed) {
      if (old.src === 'launcher') session.counts.launcher -= 1;
      else session.counts[old.lv] -= 1;
    }
  }
  const id = session.instance.id;
  if (!pending.has(id)) pending.set(id, []);
  pending.get(id).push(line);
  scheduleFlush();
}

/** Game output chunk from the child process. */
function pushGame(chunk, stream = 'stdout', instanceId = activeId) {
  const session = sessions.get(instanceId);
  if (!session) return;
  const key = stream === 'stderr' ? 'stderr' : 'stdout';
  const text = session.partial[key] + String(chunk);
  const parts = text.split('\n');
  session.partial[key] = parts.pop();
  // A runaway line without newline must not grow forever.
  if (session.partial[key].length > MAX_LINE_CHARS * 4) {
    parts.push(session.partial[key]);
    session.partial[key] = '';
  }
  for (const raw of parts) {
    const parsed = session.parser.parseLine(raw, key);
    if (parsed && (parsed.text.trim() || parsed.cont)) addLine(session, parsed, 'game');
  }
}

/** A launcher status line (MCLC debug output, Noctra messages). */
function pushLauncher(text, instanceId = activeId) {
  const session = sessions.get(instanceId);
  if (!session) return;
  for (const raw of String(text).split('\n')) {
    if (!raw.trim()) continue;
    const tagged = LAUNCHER_LINE.test(raw) ? raw : `[Noctra] ${raw}`;
    const level = /\b(?:error|failed|couldn't|could not)\b/i.test(raw) ? 'warn' : 'info';
    addLine(session, { level, source: 'launcher', text: tagged }, 'launcher');
  }
}

function end(instanceId = activeId, { code = null, signal = null, killed = false, note = null } = {}) {
  const session = sessions.get(instanceId);
  if (!session) return;
  for (const key of ['stdout', 'stderr']) {
    if (session.partial[key].trim()) {
      const parsed = session.parser.parseLine(session.partial[key], key);
      if (parsed) addLine(session, parsed, 'game');
    }
    session.partial[key] = '';
  }
  if (note) {
    addLine(session, { level: 'warn', source: 'launcher', text: `[Noctra] ${note}` }, 'launcher');
  } else {
    const how = killed ? 'was stopped from the launcher' : signal ? `was stopped (${signal})` : `exited with code ${code}`;
    addLine(session, { level: code && code !== 0 && !killed ? 'warn' : 'info', source: 'launcher', text: `[Noctra] Minecraft ${how}` }, 'launcher');
  }
  session.running = false;
  session.endedAt = Date.now();
  session.exit = { code, signal, killed };
  flush();
  send('console:session', publicSession(session, false));
  if (activeId === instanceId) activeId = null;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_MS);
}

function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  const batches = pending;
  pending = new Map();
  for (const [instanceId, lines] of batches) {
    if (lines.length) send('console:lines', { instanceId, lines });
  }
}

function publicSession(session, withLines = true) {
  return {
    instanceId: session.instance.id,
    instance: session.instance,
    source: session.source || 'live',
    running: session.running,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    exit: session.exit,
    dropped: session.dropped,
    counts: { ...session.counts },
    ...(withLines ? { lines: session.lines } : {})
  };
}

/* ---------------------------------------------------------------- history */

const instanceDir = (id) => path.join(deps.app.getPath('userData'), 'minecraft', 'instances', id);

function readTail(file, maxBytes) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return { text, mtime: stat.mtimeMs };
  } finally {
    fs.closeSync(fd);
  }
}

function fromLatestLog(instanceId) {
  if (!instanceId || /[\\/]|\.\./.test(instanceId)) return null;
  const file = path.join(instanceDir(instanceId), 'logs', 'latest.log');
  if (!fs.existsSync(file)) return null;
  const { text, mtime } = readTail(file, 3_000_000);
  const lines = parseText(text, { startAt: mtime }).slice(-MAX_LINES);
  const counts = { info: 0, warn: 0, severe: 0, debug: 0, launcher: 0 };
  for (const line of lines) counts[line.lv] = (counts[line.lv] || 0) + 1;
  return {
    instanceId,
    instance: { id: instanceId },
    source: 'file',
    running: false,
    startedAt: null,
    endedAt: mtime,
    exit: null,
    dropped: 0,
    counts,
    lines
  };
}

function get(instanceId) {
  const session = sessions.get(instanceId);
  if (session) return publicSession(session);
  return fromLatestLog(instanceId) || { instanceId, source: 'empty', running: false, lines: [], counts: { info: 0, warn: 0, severe: 0, debug: 0, launcher: 0 } };
}

function textFor(instanceId, header = true) {
  const data = get(instanceId);
  const body = data.lines.map((line) => line.text).join('\n');
  if (!header) return { data, text: body };
  const inst = sessions.get(instanceId)?.instance;
  const top = [
    '# Noctra Client console',
    inst ? `# Instance: ${inst.name} · Minecraft ${inst.version || '?'} · ${inst.loader}${inst.loaderVersion ? ` ${inst.loaderVersion}` : ''}` : null,
    data.startedAt ? `# Started: ${new Date(data.startedAt).toISOString()}` : data.source === 'file' ? '# Source: logs/latest.log' : null,
    `# Platform: ${process.platform} ${process.arch}`
  ].filter(Boolean).join('\n');
  return { data, text: `${top}\n\n${body}` };
}

/* ----------------------------------------------------------------- upload */

const SERVICES = {
  mclogs: {
    label: 'mclo.gs',
    async upload(text) {
      let lines = text.split('\n');
      // mclo.gs keeps 25k lines / 10 MB: keep the start (boot info) and the end.
      if (lines.length > 24000) lines = [...lines.slice(0, 4000), '... (trimmed by Noctra) ...', ...lines.slice(-19000)];
      const body = new URLSearchParams({ content: lines.join('\n').slice(0, 9_000_000) });
      const response = await fetch('https://api.mclo.gs/1/log', { method: 'POST', body, headers: HEADERS });
      const json = await response.json().catch(() => null);
      if (!response.ok || !json?.success) throw new Error(json?.error || `Upload failed (HTTP ${response.status})`);
      return json.url;
    }
  },
  pastesdev: {
    label: 'pastes.dev',
    async upload(text) {
      const response = await fetch('https://api.pastes.dev/post', {
        method: 'POST',
        body: text.slice(0, 9_000_000),
        headers: { ...HEADERS, 'Content-Type': 'text/log; charset=utf-8' }
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || !json?.key) throw new Error(`Upload failed (HTTP ${response.status})`);
      return `https://pastes.dev/${json.key}`;
    }
  }
};

async function upload(instanceId, service = 'mclogs') {
  const target = SERVICES[service];
  if (!target) throw new Error('Unknown paste service.');
  const { data, text } = textFor(instanceId);
  if (!data.lines.length) throw new Error('There is nothing in the console to upload yet.');
  const session = sessions.get(instanceId);
  const cacheKey = `${service}:${data.lines.length}:${data.lines[data.lines.length - 1]?.n}`;
  if (session?.shareUrls[cacheKey]) return { ok: true, url: session.shareUrls[cacheKey], service: target.label };
  const url = await target.upload(text);
  if (session) session.shareUrls[cacheKey] = url;
  return { ok: true, url, service: target.label };
}

/* -------------------------------------------------------------------- ipc */

function send(channel, payload) {
  const win = deps?.getWin?.();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function init(dependencies, ipcMain) {
  deps = dependencies;
  ipcMain.handle('console:get', (_e, instanceId) => get(instanceId));
  ipcMain.handle('console:clear', (_e, instanceId) => {
    const session = sessions.get(instanceId);
    if (session) {
      session.lines = [];
      session.counts = { info: 0, warn: 0, severe: 0, debug: 0, launcher: 0 };
      session.dropped = 0;
      pending.delete(instanceId);
      send('console:session', publicSession(session, false));
    }
    return { ok: true };
  });
  ipcMain.handle('console:upload', (_e, instanceId, service) => upload(instanceId, service));
  ipcMain.handle('console:save', async (_e, instanceId) => {
    const { dialog } = require('electron');
    const { text } = textFor(instanceId);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const name = (sessions.get(instanceId)?.instance?.name || 'minecraft').replace(/[^\w.-]+/g, '-');
    const result = await dialog.showSaveDialog(deps.getWin(), {
      title: 'Save console log',
      defaultPath: path.join(deps.app.getPath('downloads'), `${name}-${stamp}.log`),
      filters: [{ name: 'Log files', extensions: ['log', 'txt'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, text, 'utf8');
    return { ok: true, path: result.filePath };
  });
}

module.exports = {
  init,
  begin,
  pushGame,
  pushLauncher,
  end,
  get,
  isActive: (instanceId) => activeId === instanceId,
  _internals: { createParser, parseText, classifyMark, redact, sessions, flush, upload, SERVICES }
};
