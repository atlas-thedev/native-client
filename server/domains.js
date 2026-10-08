'use strict';

/**
 * Domain autopilot (admin only). Buy a domain anywhere, add it in the launcher admin (Domains) and this:
 *   1. finds or creates its Cloudflare zone (you then point the registrar's nameservers at Cloudflare once),
 *   2. website: proxied A @ → the server, CNAME www → @, SSL "Full", Always HTTPS,
 *      and (optional) a Cloudflare redirect rule that sends the whole domain to the main website,
 *   3. email: adds the domain to Resend, writes Resend's SPF/DKIM records + DMARC into Cloudflare, asks Resend to verify,
 *   4. lets you make it the main website (checkout links, emails) or the email sender — no redeploy.
 *
 * The backend itself always stays on api.nativelaunch.xyz; nothing here touches the api record.
 *
 *   GET    /v1/admin/domains                    settings + domains
 *   POST   /v1/admin/domains/settings           { cloudflareToken?, accountId?, serverIp? , clear?: [] }
 *   POST   /v1/admin/domains                    { domain, website: true, email: true, mode: 'main'|'redirect' }  → set up
 *   POST   /v1/admin/domains/:domain/check      re-check zone, DNS, Resend and HTTPS
 *   POST   /v1/admin/domains/:domain/primary    { use: 'site'|'email' }
 *   DELETE /v1/admin/domains/:domain            forget it (DNS is left alone)
 *
 * Env fallbacks: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, NATIVE_SERVER_IP, NATIVE_SITE_URL, NATIVE_SECURITY_EMAIL.
 */
const db = require('./db');

const CF = 'https://api.cloudflare.com/client/v4';
const RESEND = 'https://api.resend.com';
const DEFAULT_IP = '158.178.247.161';
const env = (name) => String(process.env[name] || '').trim();

let ready = null;
function sql() {
  const handle = db.getDb();
  if (ready !== handle) {
    handle.exec(`
      CREATE TABLE IF NOT EXISTS domain_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS domains (
        name TEXT PRIMARY KEY,
        zone_id TEXT,
        website INTEGER NOT NULL DEFAULT 1,
        email INTEGER NOT NULL DEFAULT 1,
        mode TEXT NOT NULL DEFAULT 'main',
        resend_id TEXT,
        status TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    ready = handle;
  }
  return handle;
}

function saved() {
  try { return Object.fromEntries(sql().prepare('SELECT key, value FROM domain_settings').all().map((r) => [r.key, r.value])); } catch { return {}; }
}
function save(key, value) {
  if (value == null || value === '') sql().prepare('DELETE FROM domain_settings WHERE key = ?').run(key);
  else sql().prepare('INSERT INTO domain_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, String(value), Date.now());
}
function config() {
  const s = saved();
  return {
    token: s['cloudflare.token'] || env('CLOUDFLARE_API_TOKEN'),
    accountId: s['cloudflare.accountId'] || env('CLOUDFLARE_ACCOUNT_ID'),
    serverIp: s['server.ip'] || env('NATIVE_SERVER_IP') || DEFAULT_IP,
    primarySite: s['primary.site'] || '',
    emailFrom: s['primary.emailFrom'] || ''
  };
}

/* ── used by the rest of the server ─────────────────────────────── */

/** Main website origin (https://…): admin choice → env → default. */
function siteUrl(fallback = 'https://playnative.fun') {
  let chosen = '';
  try { chosen = config().primarySite; } catch { /* db not ready */ }
  return (chosen || env('NATIVE_SITE_URL') || env('PUBLIC_SITE_URL') || fallback).replace(/\/$/, '');
}
/** Sender address for system email: admin choice → env → default. */
function senderEmail(fallback = 'noreply@playnative.fun') {
  let chosen = '';
  try { chosen = config().emailFrom; } catch { /* db not ready */ }
  return chosen || env('NATIVE_SECURITY_EMAIL') || fallback;
}

/* ── providers ───────────────────────────────────────────────────── */

async function cf(method, pathname, body, token = config().token) {
  if (!token) { const e = new Error('Add a Cloudflare API token first.'); e.status = 400; throw e; }
  const res = await fetch(`${CF}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000)
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok || data.success === false) {
    const msg = (data.errors || []).map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    const e = new Error(`Cloudflare: ${msg}`); e.status = res.status; throw e;
  }
  return data;
}

function resendKey() {
  try { return require('./mailer').resolveResendKey?.() || ''; } catch { return env('RESEND_API_KEY'); }
}
async function resend(method, pathname, body) {
  const key = resendKey();
  if (!key) { const e = new Error('Resend isn’t set up on the server (RESEND_API_KEY).'); e.status = 400; throw e; }
  const res = await fetch(`${RESEND}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000)
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) { const e = new Error(`Resend: ${data.message || data.error || `HTTP ${res.status}`}`); e.status = res.status; throw e; }
  return data;
}

/* ── setup steps ─────────────────────────────────────────────────── */

const DOMAIN = /^(?=.{3,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;
const cleanDomain = (value) => String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').replace(/\.$/, '');
const fqdn = (name, domain) => (!name || name === '@' ? domain : name === domain || name.endsWith(`.${domain}`) ? name : `${name}.${domain}`);

async function findOrCreateZone(domain, steps) {
  const found = await cf('GET', `/zones?name=${encodeURIComponent(domain)}`);
  let zone = found.result?.[0];
  if (!zone) {
    const { accountId } = config();
    if (!accountId) { const e = new Error(`${domain} isn’t in Cloudflare yet. Add your Cloudflare account ID so it can be created, or add the site in Cloudflare first.`); e.status = 400; throw e; }
    zone = (await cf('POST', '/zones', { name: domain, account: { id: accountId }, type: 'full' })).result;
    steps.push(`Created ${domain} in Cloudflare`);
  } else {
    steps.push(`Found ${domain} in Cloudflare`);
  }
  if (zone.status !== 'active') steps.push(`Waiting for nameservers: set ${(zone.name_servers || []).join(' and ')} at your domain registrar`);
  return zone;
}

/** Creates or updates one DNS record (matched by type + name [+ content for TXT/MX]). */
async function upsertRecord(zoneId, record, steps, label) {
  const name = record.name;
  const list = (await cf('GET', `/zones/${zoneId}/dns_records?type=${record.type}&name=${encodeURIComponent(name)}`)).result || [];
  const multi = record.type === 'TXT' || record.type === 'MX';
  const match = multi ? list.find((r) => r.content === record.content || (record.matchPrefix && String(r.content).startsWith(record.matchPrefix))) : list[0];
  const body = { type: record.type, name, content: record.content, ttl: 1, proxied: Boolean(record.proxied), ...(record.priority != null ? { priority: record.priority } : {}), comment: 'Managed by Native admin' };
  if (match) {
    const same = match.content === body.content && Boolean(match.proxied) === body.proxied && (record.priority == null || match.priority === record.priority);
    if (!same) { await cf('PUT', `/zones/${zoneId}/dns_records/${match.id}`, body); steps.push(`Updated ${label}`); } else steps.push(`${label} already set`);
  } else {
    // A/AAAA/CNAME on the same name conflict; clear them first for website records.
    if (record.replaceConflicts) {
      const others = ((await cf('GET', `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`)).result || []).filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type));
      for (const r of others) await cf('DELETE', `/zones/${zoneId}/dns_records/${r.id}`);
    }
    await cf('POST', `/zones/${zoneId}/dns_records`, body);
    steps.push(`Added ${label}`);
  }
}

async function setupWebsite(domain, zoneId, mode, steps) {
  const { serverIp } = config();
  await upsertRecord(zoneId, { type: 'A', name: domain, content: serverIp, proxied: true, replaceConflicts: true }, steps, `A ${domain} → ${serverIp}`);
  await upsertRecord(zoneId, { type: 'CNAME', name: `www.${domain}`, content: domain, proxied: true, replaceConflicts: true }, steps, `CNAME www → ${domain}`);
  try { await cf('PATCH', `/zones/${zoneId}/settings/ssl`, { value: 'full' }); steps.push('SSL set to Full'); } catch (e) { steps.push(`SSL mode not changed (${e.message})`); }
  try { await cf('PATCH', `/zones/${zoneId}/settings/always_use_https`, { value: 'on' }); steps.push('Always HTTPS on'); } catch (e) { steps.push(`Always HTTPS not changed (${e.message})`); }

  const target = siteUrl();
  const targetHost = new URL(target).hostname;
  const redirect = mode === 'redirect' && targetHost !== domain && targetHost !== `www.${domain}`;
  const rules = redirect ? [{
    description: `Native: ${domain} → ${targetHost}`,
    expression: `(http.host eq "${domain}" or http.host eq "www.${domain}")`,
    action: 'redirect',
    action_parameters: { from_value: { status_code: 301, preserve_query_string: true, target_url: { expression: `concat("${target}", http.request.uri.path)` } } },
    enabled: true
  }] : [];
  try {
    await cf('PUT', `/zones/${zoneId}/rulesets/phases/http_request_dynamic_redirect/entrypoint`, { rules });
    steps.push(redirect ? `Redirects ${domain} to ${target}` : 'Serves the website directly');
  } catch (e) {
    steps.push(redirect ? `Redirect rule failed (${e.message}) — give the token “Single Redirect: Edit”` : 'No redirect rule');
  }
}

async function setupEmail(domain, zoneId, row, steps) {
  let id = row?.resend_id || null;
  if (!id) {
    const list = await resend('GET', '/domains');
    id = (list.data || []).find((d) => d.name === domain)?.id || null;
  }
  if (!id) {
    id = (await resend('POST', '/domains', { name: domain })).id;
    steps.push(`Added ${domain} to Resend`);
  } else steps.push(`${domain} already in Resend`);
  const info = await resend('GET', `/domains/${id}`);
  for (const r of info.records || []) {
    const name = fqdn(r.name, domain);
    const type = String(r.type || '').toUpperCase();
    if (!['TXT', 'MX', 'CNAME'].includes(type)) continue;
    await upsertRecord(zoneId, { type, name, content: r.value, priority: type === 'MX' ? Number(r.priority ?? 10) : null, matchPrefix: type === 'TXT' && /^v=spf1/i.test(r.value) ? 'v=spf1' : null }, steps, `${r.record || type} ${name}`);
  }
  await upsertRecord(zoneId, { type: 'TXT', name: `_dmarc.${domain}`, content: 'v=DMARC1; p=none;', matchPrefix: 'v=DMARC1' }, steps, `DMARC _dmarc.${domain}`);
  try { await resend('POST', `/domains/${id}/verify`); steps.push('Asked Resend to verify (takes a few minutes)'); } catch (e) { steps.push(`Resend verify: ${e.message}`); }
  return id;
}

async function probe(domain) {
  try {
    const res = await fetch(`https://${domain}/`, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(8000) });
    return { ok: res.status < 500, status: res.status, location: res.headers.get('location') || null };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function check(domain) {
  const row = sql().prepare('SELECT * FROM domains WHERE name = ?').get(domain);
  if (!row) return null;
  const status = { checkedAt: Date.now() };
  try {
    const zone = (await cf('GET', `/zones?name=${encodeURIComponent(domain)}`)).result?.[0];
    status.zone = zone ? zone.status : 'missing';
    status.nameServers = zone?.name_servers || [];
    if (zone && row.zone_id !== zone.id) sql().prepare('UPDATE domains SET zone_id = ? WHERE name = ?').run(zone.id, domain);
    if (zone && row.website) {
      const a = (await cf('GET', `/zones/${zone.id}/dns_records?type=A&name=${encodeURIComponent(domain)}`)).result || [];
      status.dns = a.some((r) => r.content === config().serverIp) ? 'ok' : 'missing';
    }
  } catch (e) { status.cloudflareError = e.message; }
  if (row.email && row.resend_id) {
    try { status.email = (await resend('GET', `/domains/${row.resend_id}`)).status || 'unknown'; } catch (e) { status.emailError = e.message; }
  }
  if (row.website) status.https = await probe(domain);
  sql().prepare('UPDATE domains SET status = ?, updated_at = ? WHERE name = ?').run(JSON.stringify(status), Date.now(), domain);
  return status;
}

/* ── http ────────────────────────────────────────────────────────── */

const hint = (v) => (v ? `…${String(v).slice(-4)}` : null);
function view() {
  const c = config();
  const s = saved();
  return {
    settings: {
      cloudflareToken: hint(c.token),
      tokenFromEnv: !s['cloudflare.token'] && Boolean(env('CLOUDFLARE_API_TOKEN')),
      accountId: c.accountId || null,
      serverIp: c.serverIp,
      resend: Boolean(resendKey()),
      primarySite: siteUrl(),
      emailFrom: senderEmail(),
      backend: 'https://api.nativelaunch.xyz'
    },
    domains: sql().prepare('SELECT * FROM domains ORDER BY created_at DESC').all().map((r) => {
      let status = null;
      try { status = r.status ? JSON.parse(r.status) : null; } catch {}
      return { name: r.name, website: Boolean(r.website), email: Boolean(r.email), mode: r.mode, status, primarySite: siteUrl() === `https://${r.name}`, emailSender: senderEmail().endsWith(`@${r.name}`), createdAt: r.created_at, updatedAt: r.updated_at };
    })
  };
}

const bearerOf = (req) => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

/**
 * The website bakes its own address in at build time, so after the main domain changes we
 * rebuild it with the server's site deploy script (NATIVE_SITE_DEPLOY, e.g. ~/deploy-site.sh).
 * That script reads the new address from GET /v1/domains/primary.
 */
function rebuildSite(domain) {
  const script = env('NATIVE_SITE_DEPLOY');
  if (!script) return false;
  try {
    const fs = require('node:fs');
    if (!fs.existsSync(script)) return false;
    const log = fs.openSync(require('node:path').join(require('node:os').tmpdir(), 'native-site-redeploy.log'), 'a');
    require('node:child_process').spawn('bash', [script], { detached: true, stdio: ['ignore', log, log] }).unref();
    console.log(`[Native Domains] rebuilding the website for ${domain}`);
    return true;
  } catch (e) { console.error('[Native Domains] site rebuild failed to start:', e.message); return false; }
}

async function handleDomainRoutes(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/v1/domains/primary') {
    ctx.send(res, 200, { ok: true, site: siteUrl(), email: senderEmail(), api: 'https://api.nativelaunch.xyz' }, { 'Cache-Control': 'no-store' });
    return true;
  }
  if (!url.pathname.startsWith('/v1/admin/domains')) return false;
  const { send, readJson } = ctx;
  const noStore = { 'Cache-Control': 'no-store' };
  const token = bearerOf(req);
  const user = token ? db.getUserBySession(token) : null;
  if (!user) { send(res, 401, { ok: false, error: 'Native account session required.' }); return true; }
  if (!user.is_admin) { send(res, 403, { ok: false, error: 'Administrator access required.' }); return true; }
  const fail = (e) => send(res, e.status && e.status < 500 ? 400 : 502, { ok: false, error: e.message || 'Domain setup failed.' });
  const parts = url.pathname.replace(/^\/v1\/admin\/domains\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);

  try {
    if (req.method === 'GET' && !parts.length) { send(res, 200, { ok: true, ...view() }, noStore); return true; }

    if (req.method === 'POST' && parts[0] === 'settings' && parts.length === 1) {
      const body = await readJson(req);
      const tokenText = String(body.cloudflareToken || '').trim();
      if (tokenText) {
        if (!/^[A-Za-z0-9_-]{30,200}$/.test(tokenText)) { send(res, 400, { ok: false, error: 'That doesn’t look like a Cloudflare API token.' }); return true; }
        const verify = await cf('GET', '/user/tokens/verify', null, tokenText).catch((e) => ({ error: e }));
        if (verify.error) { send(res, 400, { ok: false, error: `Cloudflare rejected that token: ${verify.error.message}` }); return true; }
        save('cloudflare.token', tokenText);
      }
      const account = String(body.accountId || '').trim();
      if (account) { if (!/^[a-f0-9]{32}$/i.test(account)) { send(res, 400, { ok: false, error: 'The account ID is 32 letters and numbers (Cloudflare → Overview, right side).' }); return true; } save('cloudflare.accountId', account); }
      const ip = String(body.serverIp || '').trim();
      if (ip) { if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) { send(res, 400, { ok: false, error: 'Use the server’s IPv4 address.' }); return true; } save('server.ip', ip); }
      for (const k of Array.isArray(body.clear) ? body.clear : []) if (k === 'cloudflareToken') save('cloudflare.token', null);
      console.log(`[Native Domains] ${user.username} updated the domain settings`);
      send(res, 200, { ok: true, ...view() }, noStore);
      return true;
    }

    if (req.method === 'POST' && !parts.length) {
      const body = await readJson(req);
      const domain = cleanDomain(body.domain);
      if (!DOMAIN.test(domain)) { send(res, 400, { ok: false, error: 'Type the domain like playnative.fun.' }); return true; }
      if (domain === 'nativelaunch.xyz' || domain.endsWith('.nativelaunch.xyz')) { send(res, 400, { ok: false, error: 'nativelaunch.xyz holds the backend (api.nativelaunch.xyz); manage it by hand.' }); return true; }
      const website = body.website !== false;
      const email = body.email !== false;
      const mode = body.mode === 'redirect' ? 'redirect' : 'main';
      const steps = [];
      const zone = await findOrCreateZone(domain, steps);
      const now = Date.now();
      sql().prepare(`INSERT INTO domains (name, zone_id, website, email, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET zone_id = excluded.zone_id, website = excluded.website, email = excluded.email, mode = excluded.mode, updated_at = excluded.updated_at`)
        .run(domain, zone.id, website ? 1 : 0, email ? 1 : 0, mode, now, now);
      const row = sql().prepare('SELECT * FROM domains WHERE name = ?').get(domain);
      if (website) await setupWebsite(domain, zone.id, mode, steps);
      if (email) {
        try {
          const id = await setupEmail(domain, zone.id, row, steps);
          sql().prepare('UPDATE domains SET resend_id = ? WHERE name = ?').run(id, domain);
        } catch (e) { steps.push(`Email not set up: ${e.message}`); }
      }
      await check(domain);
      console.log(`[Native Domains] ${user.username} set up ${domain}`);
      send(res, 200, { ok: true, steps, ...view() }, noStore);
      return true;
    }

    const domain = cleanDomain(parts[0]);
    const row = domain ? sql().prepare('SELECT * FROM domains WHERE name = ?').get(domain) : null;
    if (!row) { send(res, 404, { ok: false, error: 'That domain isn’t in the list.' }); return true; }

    if (req.method === 'POST' && parts[1] === 'check') { await check(domain); send(res, 200, { ok: true, ...view() }, noStore); return true; }

    if (req.method === 'POST' && parts[1] === 'primary') {
      const body = await readJson(req);
      const st = (() => { try { return JSON.parse(row.status || '{}'); } catch { return {}; } })();
      if (body.use === 'site') {
        if (!row.website) { send(res, 400, { ok: false, error: 'Set this domain up for the website first.' }); return true; }
        if (!st.https?.ok && body.force !== true) { send(res, 400, { ok: false, error: `https://${domain} isn’t answering yet. Check again once Cloudflare shows it active.` }); return true; }
        save('primary.site', `https://${domain}`);
        if (row.mode === 'redirect') sql().prepare("UPDATE domains SET mode = 'main' WHERE name = ?").run(domain);
        rebuildSite(domain);
      } else if (body.use === 'email') {
        if (!row.email) { send(res, 400, { ok: false, error: 'Set this domain up for email first.' }); return true; }
        if (st.email !== 'verified' && body.force !== true) { send(res, 400, { ok: false, error: 'Resend hasn’t verified this domain yet. Check again in a few minutes.' }); return true; }
        save('primary.emailFrom', `noreply@${domain}`);
      } else { send(res, 400, { ok: false, error: 'Pick site or email.' }); return true; }
      console.log(`[Native Domains] ${user.username} made ${domain} the ${body.use === 'site' ? 'main website' : 'email sender'}`);
      send(res, 200, { ok: true, ...view() }, noStore);
      return true;
    }

    if (req.method === 'DELETE' && parts.length === 1) {
      sql().prepare('DELETE FROM domains WHERE name = ?').run(domain);
      if (config().primarySite === `https://${domain}`) save('primary.site', null);
      if (config().emailFrom.endsWith(`@${domain}`)) save('primary.emailFrom', null);
      send(res, 200, { ok: true, ...view() }, noStore);
      return true;
    }
  } catch (e) {
    console.error('[Native Domains]', e.message);
    fail(e);
    return true;
  }
  send(res, 404, { ok: false, error: 'Domain endpoint not found.' });
  return true;
}

module.exports = { handleDomainRoutes, siteUrl, senderEmail, cleanDomain };
