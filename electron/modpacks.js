const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { downloadFile, fetchJson, writeFileAtomic } = require('./download');
const { enrichFolder } = require('./modMetadata');

/**
 * Modpack installation (Modrinth .mrpack format).
 *
 * A .mrpack is a zip containing modrinth.index.json — a list of files
 * (mods, resource packs, …) with download URLs — plus an overrides/
 * folder of configs. Installing one creates a brand-new instance:
 *   1. fetch project + latest version, download the .mrpack
 *   2. parse the index: MC version + mod loader come from `dependencies`
 *   3. download every client-side file into the new instance dir
 *   4. copy overrides/ (and client-overrides/) on top
 */

let deps = null; // { app, getWin }

const rootDir = () => path.join(deps.app.getPath('userData'), 'minecraft');
const instanceDir = (id) => path.join(rootDir(), 'instances', id);

function progress(projectId, percent, detail, meta = {}) {
  const win = deps.getWin?.();
  if (win && !win.isDestroyed()) {
    win.webContents.send('modpack:progress', { projectId, percent, detail, ...meta });
  }
}

function loaderFromDependencies(dependencies) {
  if (dependencies['fabric-loader']) {
    return { loader: 'Fabric', loaderVersion: dependencies['fabric-loader'] };
  }
  if (dependencies.forge) {
    return { loader: 'Forge', loaderVersion: dependencies.forge };
  }
  if (dependencies.neoforge) {
    return { loader: 'NeoForge', loaderVersion: dependencies.neoforge };
  }
  if (dependencies['quilt-loader']) {
    return { loader: 'Quilt', loaderVersion: dependencies['quilt-loader'] };
  }
  return { loader: 'Vanilla', loaderVersion: null };
}

// Hosts the .mrpack format allows for file downloads (Modrinth spec).
const ALLOWED_DOWNLOAD_HOSTS = new Set(['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com']);
const MODRINTH_ID = /^[A-Za-z0-9_-]{1,64}$/;

function allowedDownloads(urls) {
  return (Array.isArray(urls) ? urls : [urls]).filter((value) => {
    try {
      const url = new URL(String(value));
      return url.protocol === 'https:' && ALLOWED_DOWNLOAD_HOSTS.has(url.hostname.toLowerCase());
    } catch {
      return false;
    }
  });
}

function requireHashes(hashes, label) {
  const sha512 = String(hashes?.sha512 || '');
  const sha1 = String(hashes?.sha1 || '');
  if (!/^[a-f0-9]{128}$/i.test(sha512) && !/^[a-f0-9]{40}$/i.test(sha1)) {
    throw new Error(`Modpack file ${label} has no checksum, refusing to install it.`);
  }
  return { ...(sha512 ? { sha512 } : {}), ...(sha1 ? { sha1 } : {}) };
}

function resolveInside(base, relativePath) {
  const root = path.resolve(base);
  const target = path.resolve(root, String(relativePath ?? ''));
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error(`Unsafe modpack path: ${relativePath}`);
  }
  return target;
}

async function install({ projectId, versionId = null, name = null, title = null, iconUrl = null }) {
  let packTitle = title || name || 'Modpack Installation';
  let packIcon = iconUrl || null;

  const emit = (percent, detail, extra = {}) => {
    progress(projectId, percent, detail, {
      title: packTitle,
      iconUrl: packIcon,
      ...extra
    });
  };

  if (!MODRINTH_ID.test(String(projectId || ''))) throw new Error('Invalid modpack id.');
  if (versionId != null && !MODRINTH_ID.test(String(versionId))) throw new Error('Invalid modpack version id.');

  emit(0, 'Fetching modpack info…');
  let project;
  try {
    project = await fetchJson(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}`);
    if (project?.title) packTitle = project.title;
    if (project?.icon_url) packIcon = project.icon_url;
  } catch (e) {
    // If info fetch fails, proceed or throw
  }

  const versions = await fetchJson(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version`);
  if (!Array.isArray(versions) || !versions.length) throw new Error('This modpack has no versions.');
  const version = (versionId && versions.find((v) => v.id === versionId)) ?? versions[0];
  const file =
    version.files.find((f) => f.primary && f.filename.endsWith('.mrpack')) ??
    version.files.find((f) => f.filename.endsWith('.mrpack'));
  if (!file) throw new Error('No .mrpack file found in the latest version.');
  if (!allowedDownloads(file.url).length) throw new Error('The modpack download is not hosted on Modrinth.');

  emit(3, `Downloading ${packTitle}…`);
  const packPath = path.join(rootDir(), '.downloads', `${crypto.randomUUID()}.mrpack`);
  await downloadFile(allowedDownloads(file.url), packPath, {
    retries: 3,
    expectedHashes: file.hashes,
    onProgress: ({ percent, retrying, attempt }) => {
      const pct = percent === null ? 3 : Math.max(1, Math.round(percent * 0.03));
      const detail = retrying ? `Retrying pack download (${attempt})…` : `Downloading ${packTitle}…`;
      emit(pct, detail);
    }
  });

  let zip;
  try {
    zip = new AdmZip(packPath);
  } finally {
    fs.rmSync(packPath, { force: true });
  }

  const indexEntry = zip.getEntry('modrinth.index.json');
  if (!indexEntry) throw new Error('Invalid modpack: missing modrinth.index.json');
  const index = JSON.parse(indexEntry.getData().toString('utf8'));

  const mcVersion = index.dependencies?.minecraft;
  if (!mcVersion) throw new Error('Modpack does not declare a Minecraft version.');
  const { loader, loaderVersion } = loaderFromDependencies(index.dependencies);

  const id = crypto.randomUUID();
  const dir = instanceDir(id);
  fs.mkdirSync(dir, { recursive: true });

  try {
    // --- pack files (mods, resource packs, shaders, …) ---
    const files = (index.files ?? []).filter((f) => f.env?.client !== 'unsupported');
    // Validate the whole index before downloading anything.
    const plan = files.map((f) => {
      const downloads = allowedDownloads(f.downloads);
      if (!downloads.length) throw new Error(`Modpack file ${f.path} is not hosted on an allowed site.`);
      return { file: f, target: resolveInside(dir, f.path), downloads, hashes: requireHashes(f.hashes, f.path) };
    });
    const totalWeight = files.reduce((sum, f) => sum + (f.fileSize || 1), 0) || 1;
    let doneWeight = 0;
    let doneCount = 0;

    const CONCURRENCY = 8;
    const queue = [...plan];
    // One failure stops every worker, and we wait for in-flight downloads to
    // settle before cleaning up, so nothing writes into a deleted folder.
    let failure = null;
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length && !failure) {
        const { file: f, target, downloads, hashes } = queue.shift();
        try {
          await downloadFile(downloads, target, { retries: 3, expectedHashes: hashes });
        } catch (error) {
          failure = failure || error;
          return;
        }
        if (failure) return;
        doneWeight += f.fileSize || 1;
        doneCount += 1;
        const pct = 5 + Math.round((doneWeight / totalWeight) * 85);
        emit(pct, `Downloading content — ${doneCount}/${files.length}`);
      }
    });
    await Promise.allSettled(workers);
    if (failure) throw failure;

    // --- overrides (configs, options, …) ---
    emit(92, 'Applying pack configs…');
    for (const prefix of ['overrides/', 'client-overrides/']) {
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory || !entry.entryName.startsWith(prefix)) continue;
        const rel = entry.entryName.slice(prefix.length);
        const target = resolveInside(dir, rel);
        writeFileAtomic(target, entry.getData());
      }
    }

    // --- titles + icons for every downloaded mod (best effort, never fatal) ---
    emit(96, 'Fetching mod details…');
    for (const folder of ['mods', 'resourcepacks', 'shaderpacks']) {
      try {
        await enrichFolder(path.join(dir, folder));
      } catch {
        /* metadata is cosmetic; the UI retries when the instance is opened */
      }
    }

    emit(100, 'Installed');
    return {
      id,
      name: name?.trim() || project?.title || packTitle,
      version: mcVersion,
      loader,
      loaderVersion,
      color: '#ff4133',
      icon: project?.icon_url ?? packIcon ?? null,
      created: Date.now(),
      lastPlayed: null,
      pack: {
        projectId: project?.id || projectId,
        versionId: version.id,
        versionNumber: version.version_number
      }
    };
  } catch (err) {
    emit(100, 'Failed', { error: true });
    // don't leave a half-installed instance dir behind
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

function init(dependencies, ipcMain) {
  deps = dependencies;
  ipcMain.handle('modpack:install', (_event, payload) =>
    install(typeof payload === 'string' ? { projectId: payload } : payload)
  );
}

module.exports = { init, install, loaderFromDependencies, allowedDownloads, requireHashes };
