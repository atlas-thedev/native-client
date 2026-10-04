const path = require('path');
const fs = require('fs');
const { downloadFile, writeFileAtomic } = require('./download');
const { enrichFolder } = require('./modMetadata');

/**
 * Mod installation (main process).
 * Mod jars land in the instance's own mods/ folder; a small manifest
 * (.native-mods.json) tracks projectId -> filename so the UI can show
 * installed state and cleanly remove mods later.
 */

let deps = null; // { app, getWin }

const rootDir = () => path.join(deps.app.getPath('userData'), 'minecraft');
const instancesDir = () => path.join(rootDir(), 'instances');
const ALLOWED_FOLDERS = new Set(['mods', 'resourcepacks', 'shaderpacks', 'datapacks']);

/**
 * Push a content-install progress event to the renderer so the shared Download
 * Manager can surface mod / shaderpack / resourcepack / datapack downloads the
 * same way it already surfaces modpacks, Java, and Minecraft dependencies.
 */
function sendProgress(payload) {
  const win = deps?.getWin?.();
  if (win && !win.isDestroyed()) {
    win.webContents.send('mods:progress', payload);
  }
}

function resolveInside(base, ...parts) {
  const root = path.resolve(base);
  const target = path.resolve(root, ...parts.map((part) => String(part ?? '')));
  const relative = path.relative(root, target);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('Invalid path outside the instance directory');
  }
  return target;
}

const instanceDir = (instanceId) => resolveInside(instancesDir(), instanceId);
const modsDir = (instanceId) => resolveInside(instanceDir(instanceId), 'mods');
const manifestPath = (instanceId) => {
  const dir = modsDir(instanceId);
  const primary = path.join(dir, '.native-mods.json');
  const legacy = path.join(dir, '.native-mods.json');
  return fs.existsSync(primary) || !fs.existsSync(legacy) ? primary : legacy;
};

function validateDestination(instanceId, folder, filename) {
  if (!ALLOWED_FOLDERS.has(folder)) throw new Error('Unsupported content folder');
  if (!filename || path.basename(filename) !== filename) throw new Error('Invalid filename');
  const dir = resolveInside(instanceDir(instanceId), folder);
  return { dir, target: resolveInside(dir, filename) };
}

function readManifest(instanceId) {
  try {
    const dir = modsDir(instanceId);
    const primary = path.join(dir, '.native-mods.json');
    const legacy = path.join(dir, '.native-mods.json');
    const target = fs.existsSync(primary) ? primary : (fs.existsSync(legacy) ? legacy : primary);
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return {};
  }
}

function writeManifest(instanceId, manifest) {
  fs.mkdirSync(modsDir(instanceId), { recursive: true });
  const dir = modsDir(instanceId);
  const primary = path.join(dir, '.native-mods.json');
  const legacy = path.join(dir, '.native-mods.json');
  const payload = JSON.stringify(manifest, null, 2);
  writeFileAtomic(primary, payload);
  if (fs.existsSync(legacy)) {
    writeFileAtomic(legacy, payload);
  }
}

function cleanMetadata(metadata) {
  const text = (value, max) => String(value ?? '').trim().slice(0, max);
  const textList = (value) => Array.isArray(value)
    ? value.map((item) => text(item, 80)).filter(Boolean).slice(0, 80)
    : [];
  const source = metadata?.source === 'cf' ? 'cf' : 'modrinth';
  return {
    title: text(metadata?.title, 160),
    description: text(metadata?.description, 600),
    iconUrl: text(metadata?.iconUrl, 2048),
    author: text(metadata?.author, 120),
    source,
    version: text(metadata?.version, 120),
    gameVersions: textList(metadata?.gameVersions),
    loaders: textList(metadata?.loaders)
  };
}

function getInstance(instanceId) {
  if (!deps?.app) return false;
  try {
    const instPath = path.join(deps.app.getPath('userData'), 'instances.json');
    if (!fs.existsSync(instPath)) return false;
    const raw = fs.readFileSync(instPath, 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed.instances || [];
    return list.find((item) => item && item.id === instanceId) || null;
  } catch {
    return null;
  }
}

function isVanillaInstance(instanceId) {
  const instance = getInstance(instanceId);
  if (!instance) return false;
  const loader = (instance.mc_loader || instance.loader || 'Vanilla').toLowerCase();
  return !loader || loader === 'vanilla';
}

function assertContentCompatible(instanceId, folder, metadata) {
  const instance = getInstance(instanceId);
  if (!instance) return;
  const version = String(instance.mc_version || instance.version || '');
  const loader = String(instance.mc_loader || instance.loader || 'Vanilla').toLowerCase();
  const gameVersions = Array.isArray(metadata?.gameVersions) ? metadata.gameVersions.map(String) : [];
  const loaders = Array.isArray(metadata?.loaders) ? metadata.loaders.map((item) => String(item).toLowerCase()) : [];

  if (version && gameVersions.length > 0 && !gameVersions.includes(version)) {
    throw new Error(`This file is not compatible with Minecraft ${version}.`);
  }
  // Quilt runs Fabric mods; NeoForge for 1.20.1 still runs Forge mods.
  const accepted = loader === 'quilt' ? ['quilt', 'fabric']
    : loader === 'legacy fabric' ? ['legacy-fabric', 'fabric']
      : loader === 'neoforge' && version === '1.20.1' ? ['neoforge', 'forge']
        : [loader];
  if (folder === 'mods' && loaders.length > 0 && !loaders.some((item) => accepted.includes(item))) {
    throw new Error(`This mod is not compatible with the ${instance.mc_loader || instance.loader} loader.`);
  }
}

function init(dependencies, ipcMain) {
  deps = dependencies;

  ipcMain.handle('mods:installed', (_event, instanceId) => readManifest(instanceId));

  // Titles / icons / authors for files Native did not install itself
  // (modpack downloads, hand-copied jars). Returns { [filename]: metadata }.
  ipcMain.handle('mods:enrich', async (_event, instanceId, folder = 'mods') => {
    if (!ALLOWED_FOLDERS.has(folder)) throw new Error('Unsupported content folder');
    return enrichFolder(resolveInside(instanceDir(instanceId), folder));
  });

  // Deletes a content file that is not tracked in the install manifest.
  ipcMain.handle('mods:removeFile', (_event, { instanceId, folder = 'mods', filename }) => {
    require('./coreMods').assertNotCoreMod(folder, filename);
    const { target } = validateDestination(instanceId, folder, filename);
    try {
      fs.unlinkSync(target);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return true;
  });

  ipcMain.handle('mods:toggle', (_event, { instanceId, projectId, enabled }) => {
    const manifest = readManifest(instanceId);
    const raw = manifest[projectId];
    if (!raw) throw new Error('Mod is no longer installed');
    const entry = typeof raw === 'string' ? { filename: raw, folder: 'mods' } : raw;
    if ((entry.folder || 'mods') !== 'mods') throw new Error('Only mods can be toggled');
    const filename = enabled ? entry.filename.replace(/\.disabled$/, '') : entry.filename.replace(/\.disabled$/, '') + '.disabled';
    const source = validateDestination(instanceId, 'mods', entry.filename).target;
    const target = validateDestination(instanceId, 'mods', filename).target;
    if (source !== target) {
      if (fs.existsSync(target)) throw new Error('A mod with that filename already exists');
      fs.renameSync(source, target);
    }
    manifest[projectId] = { ...entry, filename, enabled: Boolean(enabled) };
    try { writeManifest(instanceId, manifest); }
    catch (error) { if (source !== target) fs.renameSync(target, source); throw error; }
    return manifest;
  });

  // folder: mods | resourcepacks | shaderpacks | datapacks
  ipcMain.handle(
    'mods:install',
    async (_event, { instanceId, projectId, url, filename, folder = 'mods', metadata }) => {
      if (folder === 'mods' && isVanillaInstance(instanceId)) {
        throw new Error('Mods cannot be installed to Vanilla instances. Please use Fabric, Forge, NeoForge, or Quilt.');
      }
      assertContentCompatible(instanceId, folder, metadata);
      const parsedUrl = new URL(url);
      if (!['https:', 'http:'].includes(parsedUrl.protocol)) throw new Error('Unsupported download URL');
      const { dir, target } = validateDestination(instanceId, folder, filename);
      fs.mkdirSync(dir, { recursive: true });

      const title = metadata && metadata.title ? String(metadata.title) : filename;
      const iconUrl = metadata && (metadata.icon_url || metadata.iconUrl || metadata.icon || metadata.logo)
        ? String(metadata.icon_url || metadata.iconUrl || metadata.icon || metadata.logo)
        : null;
      sendProgress({ projectId, folder, percent: 0, title, iconUrl, detail: `Starting ${title}\u2026` });
      try {
        await downloadFile(url, target, {
          retries: 3,
          onProgress: ({ percent, retrying, attempt }) => {
            // Reserve 100% for the explicit completion event below so the
            // Download Manager never clears the entry before the manifest is
            // written. Unknown-size downloads report null -> keep it pending.
            const pct = percent === null || percent === undefined
              ? null
              : Math.max(1, Math.min(99, Math.round(percent)));
            sendProgress({
              projectId,
              folder,
              percent: pct,
              title,
              iconUrl,
              detail: retrying ? `Retrying download (${attempt})\u2026` : `Downloading ${title}\u2026`
            });
          }
        });
      } catch (error) {
        // Resolve the entry so it doesn't hang in the manager; the caller also
        // raises a user-facing notification for the failure.
        sendProgress({ projectId, folder, percent: 100, title, iconUrl, detail: 'Failed', error: true });
        throw error;
      }

      const manifest = readManifest(instanceId);
      manifest[projectId] = { filename, folder, metadata: cleanMetadata(metadata) };
      writeManifest(instanceId, manifest);
      sendProgress({ projectId, folder, percent: 100, title, iconUrl, detail: 'Installed' });
      return manifest;
    }
  );

  ipcMain.handle('mods:remove', (_event, { instanceId, projectId }) => {
    const manifest = readManifest(instanceId);
    const entry = manifest[projectId];
    if (entry) {
      // older manifests stored a bare filename string in the mods folder
      const filename = typeof entry === 'string' ? entry : entry.filename;
      const folder = typeof entry === 'string' ? 'mods' : entry.folder || 'mods';
      try {
        const { target } = validateDestination(instanceId, folder, filename);
        fs.unlinkSync(target);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      delete manifest[projectId];
      writeManifest(instanceId, manifest);
    }
    return manifest;
  });
}

module.exports = {
  init,
  resolveInside,
  validateDestination,
  cleanMetadata,
  isVanillaInstance,
  assertContentCompatible,
  readManifest,
  writeManifest
};
