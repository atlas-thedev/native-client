// Rebuilds binary assets (e.g. the animated home background) from base64 text packs in
// ./asset-packs. The packs exist because some changes reach this repo through a text-only API.
// Called from vite.config.js, so `vite`, `vite build` and CI all restore them; safe to re-run.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function restoreAssetPacks(root = process.cwd()) {
  const dir = join(root, 'asset-packs');
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const meta = JSON.parse(readFileSync(join(dir, name), 'utf8')); // { target, sha256, parts: [...] }
    const out = join(root, meta.target);
    if (existsSync(out) && createHash('sha256').update(readFileSync(out)).digest('hex') === meta.sha256) continue;
    const b64 = meta.parts.map((p) => readFileSync(join(dir, p), 'utf8').replace(/\s+/g, '')).join('');
    const buf = Buffer.from(b64, 'base64');
    const got = createHash('sha256').update(buf).digest('hex');
    if (got !== meta.sha256) throw new Error(`asset pack ${name}: checksum mismatch`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, buf);
    console.log(`[asset-packs] restored ${meta.target} (${(buf.length / 1048576).toFixed(1)} MB)`);
  }
}
