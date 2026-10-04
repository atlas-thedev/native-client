#!/usr/bin/env node
//
// Create the GitHub release for the current package.json version *before*
// electron-builder runs, so every artifact lands in one release.
//
// electron-builder's publisher cache has a check-then-await-then-set race
// (app-builder-lib PublishManager.getOrCreatePublisher): each finished artifact
// builds its own publisher, and each publisher creates its own draft. The
// result is two half-filled drafts for one tag. When the release already
// exists, both publishers find and reuse it instead of creating one.
//
//   node scripts/ensure-release.js           # create if missing (idempotent)
//   node scripts/ensure-release.js --list    # show releases for this tag
//   node scripts/ensure-release.js --clean   # delete duplicate drafts, keep 1
//   node scripts/ensure-release.js --publish # flip the draft live (checks assets)
//
// Reads GH_TOKEN from the environment, falling back to electron-builder.env.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const owner = pkg.build?.publish?.owner || 'atlas-thedev';
const primaryRepo = pkg.build?.publish?.repo || 'native-client';
const targetRepos = [primaryRepo];
const tag = `v${pkg.version}`;

function readToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const env = fs.readFileSync(path.join(root, 'electron-builder.env'), 'utf8');
    const match = /^\s*GH_TOKEN\s*=\s*(.+?)\s*$/m.exec(env);
    if (match) return match[1].replace(/^["']|["']$/g, '');
  } catch {
    /* no env file */
  }
  return null;
}

const token = readToken();
if (!token) {
  console.error('error: GH_TOKEN not set and not found in electron-builder.env');
  process.exit(1);
}

async function gh(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'native-release-script',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (data && data.message) || res.statusText;
    throw new Error(`${method} ${url} -> ${res.status} ${message}`);
  }
  return data;
}

// Paginated so a long release history still finds the tag.
async function releasesForTag(repoName) {
  const api = `https://api.github.com/repos/${owner}/${repoName}`;
  const found = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await gh('GET', `${api}/releases?per_page=100&page=${page}`);
    if (!batch.length) break;
    found.push(...batch.filter(r => r.tag_name === tag));
    if (batch.length < 100) break;
  }
  return found;
}

function describe(r) {
  const state = r.draft ? 'draft' : r.prerelease ? 'pre-release' : 'published';
  const assets = r.assets.length ? r.assets.map(a => a.name).join(', ') : 'no assets';
  return `  #${r.id}  ${state}  [${assets}]`;
}

async function handleRepo(repoName, mode) {
  const api = `https://api.github.com/repos/${owner}/${repoName}`;
  const existing = await releasesForTag(repoName);

  if (mode === '--list') {
    console.log(`${existing.length} release(s) for ${tag} in ${owner}/${repoName}`);
    existing.forEach(r => console.log(describe(r)));
    return;
  }

  if (mode === '--publish') {
    const draft = existing.find(r => r.draft);
    if (!draft) {
      console.log(`no draft for ${tag} in ${owner}/${repoName} to publish`);
      return;
    }
    const names = draft.assets.map(a => a.name);
    const required = ['latest.yml'];
    const missing = required.filter(n => !names.includes(n));
    if (missing.length) {
      console.error(`error: draft ${tag} in ${repoName} is missing ${missing.join(' and ')}`);
      console.error(`  has: ${names.join(', ') || '(no assets)'}`);
      console.error('publishing now would ship a release the updater cannot use');
      return;
    }
    await gh('PATCH', `${api}/releases/${draft.id}`, { draft: false });
    console.log(`published ${tag} (#${draft.id}) in ${owner}/${repoName}`);
    return;
  }

  if (mode === '--clean') {
    const drafts = existing.filter(r => r.draft);
    if (drafts.length < 2) {
      console.log(`nothing to clean in ${repoName}: ${drafts.length} draft(s) for ${tag}`);
      return;
    }
    drafts.sort((a, b) => b.assets.length - a.assets.length);
    const [keep, ...remove] = drafts;
    for (const r of remove) {
      await gh('DELETE', `${api}/releases/${r.id}`);
      console.log(`deleted duplicate draft #${r.id} in ${repoName}`);
    }
    console.log(`kept draft #${keep.id} for ${tag} in ${repoName}`);
    return;
  }

  if (existing.length > 1) {
    console.error(`error: ${existing.length} releases already exist for ${tag} in ${owner}/${repoName}:`);
    existing.forEach(r => console.error(describe(r)));
    console.error('run "npm run release:clean" to remove the duplicates first');
    return;
  }

  if (existing.length === 1) {
    const r = existing[0];
    if (!r.draft) {
      console.log(`release ${tag} already published in ${owner}/${repoName} (#${r.id})`);
    } else {
      console.log(`reusing existing draft in ${owner}/${repoName} ${tag} (#${r.id})`);
    }
    return;
  }

  const created = await gh('POST', `${api}/releases`, {
    tag_name: tag,
    name: tag,
    draft: true,
    prerelease: false,
  });
  console.log(`created draft release ${tag} (#${created.id}) in ${owner}/${repoName}`);
}

async function main() {
  const mode = process.argv[2];
  for (const repoName of targetRepos) {
    await handleRepo(repoName, mode);
  }
}

main().catch(err => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
