/**
 * One-click instance presets. Each preset is a curated Modrinth mod list that
 * is installed into a brand-new Fabric (or Quilt) instance. Mods that have no
 * build for the chosen Minecraft version are skipped, never fatal.
 */

const API = 'https://api.modrinth.com/v2';

const CORE_PERFORMANCE = [
  'fabric-api',
  'sodium',
  'lithium',
  'ferrite-core',
  'modernfix',
  'immediatelyfast',
  'entityculling',
  'krypton',
  'memoryleakfix',
  'cull-leaves',
  'dynamic-fps'
];

export const PRESET_LOADERS = ['Fabric', 'Quilt'];

export const PRESETS = [
  {
    id: 'optimization',
    name: 'Optimization',
    tagline: 'Max FPS, low memory use, fast loading',
    memoryMb: 4096,
    mods: [...CORE_PERFORMANCE, 'sodium-extra', 'reeses-sodium-options', 'noisium', 'modmenu']
  },
  {
    id: 'pvp',
    name: 'PvP + Optimization',
    tagline: 'Performance base plus zoom, HUD and combat quality of life',
    memoryMb: 4096,
    mods: [
      ...CORE_PERFORMANCE.filter((slug) => slug !== 'cull-leaves'),
      'sodium-extra',
      'reeses-sodium-options',
      'zoomify',
      'appleskin',
      'mouse-tweaks',
      'modmenu'
    ]
  },
  {
    id: 'visuals',
    name: 'Visuals',
    tagline: 'Shaders (Iris), connected textures, dynamic lights',
    memoryMb: 6144,
    mods: [
      'fabric-api',
      'sodium',
      'sodium-extra',
      'reeses-sodium-options',
      'iris',
      'lithium',
      'ferrite-core',
      'immediatelyfast',
      'entityculling',
      'continuity',
      'lambdynamiclights',
      'visuality',
      '3dskinlayers',
      'cull-leaves',
      'modmenu'
    ],
    shaders: ['complementary-reimagined']
  }
];

export const getPreset = (id) => PRESETS.find((preset) => preset.id === id) || null;

export const presetModCount = (preset) => (preset ? preset.mods.length + (preset.shaders?.length || 0) : 0);

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Modrinth returned HTTP ${response.status}`);
  return response.json();
}

function pickVersion(versions) {
  if (!Array.isArray(versions) || versions.length === 0) return null;
  return (
    versions.find((entry) => entry.version_type === 'release') ||
    versions.find((entry) => entry.version_type === 'beta') ||
    versions[0]
  );
}

async function resolveProject(idOrSlug, { mcVersion, loaders, shader = false }) {
  const query =
    `?game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}` +
    (shader ? '' : `&loaders=${encodeURIComponent(JSON.stringify(loaders))}`) +
    '&include_changelog=false';
  try {
    const version = pickVersion(await getJson(`${API}/project/${encodeURIComponent(idOrSlug)}/version${query}`));
    const file = version?.files?.find((entry) => entry.primary) || version?.files?.[0];
    if (!version || !file?.url) return null;
    return { slug: idOrSlug, projectId: version.project_id, version, file };
  } catch {
    return null;
  }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

/**
 * Installs a preset into an existing instance.
 * Resolves { installed: string[], skipped: string[], failed: string[] }.
 */
export async function installPreset(instance, presetId, { onProgress } = {}) {
  const preset = getPreset(presetId);
  const api = window.native?.mods;
  if (!preset) throw new Error('Unknown preset');
  if (!api?.install) throw new Error('Mod installs only work in the desktop app.');

  const mcVersion = instance.mc_version || instance.version;
  const loader = String(instance.mc_loader || instance.loader || 'Fabric');
  if (!PRESET_LOADERS.includes(loader)) throw new Error('Presets need a Fabric or Quilt instance.');
  const loaders = loader === 'Quilt' ? ['quilt', 'fabric'] : ['fabric'];

  let alreadyInstalled = {};
  try {
    alreadyInstalled = (await api.installed(instance.id)) || {};
  } catch { /* fresh instance */ }

  // 1. Resolve every mod (plus required dependencies) to a concrete file.
  const plan = new Map();
  const skipped = [];
  const queue = preset.mods.map((slug) => ({ slug, shader: false, depth: 0 }));
  preset.shaders?.forEach((slug) => queue.push({ slug, shader: true, depth: 0 }));

  let cursor = 0;
  while (cursor < queue.length) {
    const batch = queue.slice(cursor, cursor + 6);
    cursor += batch.length;
    const resolved = await Promise.all(
      batch.map((entry) => resolveProject(entry.slug, { mcVersion, loaders, shader: entry.shader }))
    );
    resolved.forEach((hit, index) => {
      const entry = batch[index];
      if (!hit) {
        skipped.push(entry.slug);
        return;
      }
      if (plan.has(hit.projectId)) return;
      plan.set(hit.projectId, { ...hit, shader: entry.shader });
      if (entry.depth >= 2) return;
      (hit.version.dependencies || []).forEach((dependency) => {
        if (dependency.dependency_type !== 'required' || !dependency.project_id) return;
        if (plan.has(dependency.project_id) || queue.some((q) => q.slug === dependency.project_id)) return;
        queue.push({ slug: dependency.project_id, shader: false, depth: entry.depth + 1, dependency: true });
      });
    });
  }

  // 2. Titles and icons for the Download Manager and the mods tab.
  let projects = [];
  try {
    const ids = [...plan.keys()];
    if (ids.length) projects = await getJson(`${API}/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`);
  } catch { /* metadata is cosmetic */ }
  const byId = new Map((Array.isArray(projects) ? projects : []).map((project) => [project.id, project]));

  // 3. Download.
  const items = [...plan.values()].filter((item) => !alreadyInstalled[item.projectId]);
  const installed = [];
  const failed = [];
  let done = 0;
  await mapLimit(items, 3, async (item) => {
    const project = byId.get(item.projectId);
    const title = project?.title || item.slug;
    try {
      await api.install({
        instanceId: instance.id,
        projectId: item.projectId,
        url: item.file.url,
        filename: item.file.filename,
        folder: item.shader ? 'shaderpacks' : 'mods',
        metadata: {
          title,
          description: project?.description || '',
          iconUrl: project?.icon_url || '',
          author: '',
          source: 'modrinth',
          version: item.version.version_number,
          gameVersions: item.version.game_versions || [],
          loaders: item.version.loaders || []
        }
      });
      installed.push(title);
    } catch {
      failed.push(title);
    }
    done += 1;
    onProgress?.({ done, total: items.length, title });
  });

  return { installed, skipped, failed };
}
