// Renders the store thumbnails of the bundled cosmetics (transparent PNG, the same three.js geometry as the
// launcher/site previews) into server/store/assets/<id>.thumb.png.b64.
//   node scripts/cosmetics/thumbs.mjs [id,id,...]      needs playwright (or playwright-core) + Chromium
//   CHROMIUM=/path/to/chromium to pick the browser.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ASSETS = path.join(ROOT, 'server', 'store', 'assets');
const items = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'cosmetics', 'items.json'), 'utf8'));
const only = process.argv[2] ? process.argv[2].split(',') : null;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let pw;
try { pw = await import('playwright'); } catch { pw = await import('playwright-core'); }
const browser = await pw.chromium.launch({
  ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
});
const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
page.on('pageerror', (e) => console.error('page error:', e.message));
for (const it of items.filter((x) => !only || only.includes(x.id))) {
  await page.goto(`${base}/scripts/cosmetics/preview.html?mode=thumb&ids=${it.id}&section=${it.section}&size=256`);
  await page.waitForSelector('body[data-ready="1"]', { timeout: 60_000 });
  const png = JSON.parse(await page.textContent('#out'))[it.id].split(',')[1];
  fs.writeFileSync(path.join(ASSETS, `${it.id}.thumb.png.b64`), `${png}\n`);
  console.log('thumbnail', it.id);
}
await browser.close();
server.close();
process.exit(0);
