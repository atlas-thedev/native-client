import { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../../i18n/I18nProvider.jsx';
import {
  LOADER_FACETS,
  endpoint,
  getProject,
  getVersion,
  getVersions,
  isVanilla,
  loaderOf,
  primaryFile,
  versionOf
} from '../api/modrinthApi.js';

/**
 * Owns everything install-related: installed/busy sets, modpack progress
 * subscription, dependency resolution + prompt state, and the actual
 * `window.native.mods` / `window.native.modpacks` IPC calls (unchanged).
 */
export default function useInstaller({
  target,
  activeType,
  onAddInstance,
  onNotify,
  hideInstallToast = false
}) {
  const { t } = useI18n();

  const [installedKeys, setInstalledKeys] = useState(new Set());
  const [busyIds, setBusyIds] = useState(new Set());
  const [fetchingVersionIds, setFetchingVersionIds] = useState(new Set());
  const [packProgress, setPackProgress] = useState(null);
  const [depPrompt, setDepPrompt] = useState(null);
  const [resolvingDeps, setResolvingDeps] = useState(false);

  const targetVersion = versionOf(target);
  const targetLoader = loaderOf(target);
  const isTargetVanilla = isVanilla(target);
  const loaderFacet = LOADER_FACETS.has(targetLoader.toLowerCase())
    ? targetLoader.toLowerCase()
    : null;

  /* ---------------------------------------------------------- installed */

  const refreshInstalled = useCallback(async () => {
    if (!target?.id || !window.native?.mods?.installed) {
      setInstalledKeys(new Set());
      return;
    }
    try {
      const manifest = await window.native.mods.installed(target.id);
      setInstalledKeys(new Set(Object.keys(manifest || {})));
    } catch {
      setInstalledKeys(new Set());
    }
  }, [target?.id]);

  useEffect(() => {
    refreshInstalled();
  }, [refreshInstalled]);

  /* --------------------------------------------------- modpack progress */

  useEffect(() => {
    if (!window.native?.modpacks?.onProgress) return undefined;
    const unsubscribe = window.native.modpacks.onProgress((payload) => {
      setPackProgress(payload || null);
      if (payload && Number(payload.percent) >= 100) {
        setTimeout(() => setPackProgress(null), 1200);
      }
    });
    return typeof unsubscribe === 'function' ? unsubscribe : undefined;
  }, []);

  /* ------------------------------------------------------------ helpers */

  const markBusy = useCallback((id, busy) => {
    setBusyIds((current) => {
      const next = new Set(current);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const markFetching = useCallback((id, fetching) => {
    setFetchingVersionIds((current) => {
      const next = new Set(current);
      if (fetching) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const versionMatchesTarget = useCallback((version) => {
    if (!version) return false;
    const gameVersions = Array.isArray(version.game_versions) ? version.game_versions : [];
    const loaders = Array.isArray(version.loaders) ? version.loaders : [];
    if (targetVersion && !gameVersions.includes(targetVersion)) return false;
    if (activeType.id === 'mod' && loaderFacet && !loaders.includes(loaderFacet)) return false;
    return true;
  }, [activeType.id, targetVersion, loaderFacet]);

  /* Never substitute a newer, incompatible build for the selected instance. */
  const pickVersion = useCallback(async (projectId) => {
    const list = await getVersions(projectId, {
      gameVersion: targetVersion || null,
      loader: loaderFacet
    });
    return list.find(versionMatchesTarget) || null;
  }, [targetVersion, loaderFacet, versionMatchesTarget]);

  /* Walk the dependency graph: required deps recursively, optional one level. */
  const resolveDependencies = useCallback(async (rootVersion) => {
    const required = [];
    const optional = [];
    const seen = new Set([rootVersion.project_id]);
    const queue = (rootVersion.dependencies || []).slice();
    let guard = 0;

    while (queue.length > 0 && guard < 40) {
      guard += 1;
      const entry = queue.shift();
      const kind = entry?.dependency_type;
      if (kind !== 'required' && kind !== 'optional') continue;
      if (entry.project_id && seen.has(entry.project_id)) continue;

      let version = entry.version_id ? await getVersion(entry.version_id) : null;
      if (version && !versionMatchesTarget(version)) version = null;
      if (!version && entry.project_id) version = await pickVersion(entry.project_id);
      if (!version?.project_id) {
        if (kind === 'required') {
          throw new Error(`A required dependency has no build for ${targetVersion} ${targetLoader}.`);
        }
        continue;
      }
      if (seen.has(version.project_id)) continue;
      seen.add(version.project_id);

      const file = primaryFile(version);
      if (!file?.url) continue;
      const project = await getProject(version.project_id);

      const item = {
        projectId: version.project_id,
        title: project?.title || version.name || version.project_id,
        iconUrl: project?.icon_url || project?.icon || null,
        versionNumber: version.version_number,
        gameVersions: version.game_versions,
        loaders: version.loaders,
        file,
        kind
      };

      if (kind === 'required') {
        required.push(item);
        (version.dependencies || []).forEach((child) => queue.push(child));
      } else {
        optional.push(item);
      }
    }

    return { required, optional };
  }, [pickVersion, targetLoader, targetVersion, versionMatchesTarget]);

  /* ------------------------------------------------------------ install */

  const [modpackPrompt, setModpackPrompt] = useState(null);

  const installModpack = useCallback(async (project) => {
    const id = project.project_id;
    markFetching(id, true);
    try {
      const versions = await getVersions(id);
      if (versions && versions.length > 0) {
        setModpackPrompt({ project, versions });
      } else {
        throw new Error('No versions found for this modpack.');
      }
    } catch (err) {
      onNotify?.(t('browse.installFailed'), err?.message || t('browse.couldNotInstall', { name: project.title }));
    } finally {
      markFetching(id, false);
    }
  }, [markFetching, onNotify, t]);

  const confirmModpackVersion = useCallback(async (versionId) => {
    if (!modpackPrompt) return;
    const { project } = modpackPrompt;
    setModpackPrompt(null);
    const id = project.project_id;
    markBusy(id, true);
    try {
      const created = await window.native.modpacks.install({
        projectId: id,
        versionId,
        title: project.title,
        iconUrl: project.icon_url || project.icon
      });
      if (created) {
        onAddInstance?.(created);
        if (!hideInstallToast) {
          const title = t('browse.modpackInstalled');
          const body = t('browse.readyToPlay', { name: project.title });
          onNotify?.(title, body);
        }
      }
    } catch (err) {
      onNotify?.(t('browse.installFailed'), err?.message || t('browse.couldNotInstall', { name: project.title }));
    } finally {
      markBusy(id, false);
      setPackProgress(null);
    }
  }, [modpackPrompt, markBusy, onAddInstance, onNotify, hideInstallToast, t]);

  const cancelModpackVersion = useCallback(() => setModpackPrompt(null), []);

  const installBundle = useCallback(async (project, mainVersion, extras) => {
    const id = project.project_id;
    markBusy(id, true);

    try {
      for (const extra of extras) {
        if (installedKeys.has(extra.projectId)) continue;
        await window.native.mods.install({
          instanceId: target.id,
          projectId: extra.projectId,
          url: extra.file.url,
          filename: extra.file.filename,
          folder: 'mods',
          metadata: {
            title: extra.title,
            description: '',
            iconUrl: extra.iconUrl || '',
            author: '',
            source: String(extra.projectId || '').startsWith('cf:') ? 'cf' : 'modrinth',
            version: extra.versionNumber,
            gameVersions: extra.gameVersions,
            loaders: extra.loaders
          }
        });
      }

      const file = primaryFile(mainVersion);
      if (!file?.url) throw new Error(t('browse.noFile'));

      await window.native.mods.install({
        instanceId: target.id,
        projectId: id,
        url: file.url,
        filename: file.filename,
        folder: activeType.folder || 'mods',
        metadata: {
          title: project.title,
          description: project.description,
          iconUrl: project.icon_url,
          author: project.author,
          source: String(id || '').startsWith('cf:') ? 'cf' : 'modrinth',
          version: mainVersion.version_number,
          gameVersions: mainVersion.game_versions,
          loaders: mainVersion.loaders
        }
      });

      await refreshInstalled();
      if (!hideInstallToast) {
        const notifTitle = t('browse.installed');
        const notifBody = extras.length > 0
          ? `${project.title} and ${extras.length} ${extras.length === 1 ? 'dependency' : 'dependencies'} added to ${target.name}`
          : t('browse.addedTo', { name: project.title, instance: target.name });
        onNotify?.(notifTitle, notifBody);
      }
    } catch (err) {
      onNotify?.(t('browse.installFailed'), err?.message || t('browse.couldNotInstall', { name: project.title }));
    } finally {
      markBusy(id, false);
    }
  }, [markBusy, installedKeys, target, activeType.folder, refreshInstalled, hideInstallToast, onNotify, t]);

  /* Shared tail of the install pipelines: resolve deps for the chosen
     version, prompt if any are missing, otherwise install straight away. */
  const installResolvedVersion = useCallback(async (project, version, { resolveDeps }) => {
    const id = project.project_id;

    if (!primaryFile(version)?.url) throw new Error(t('browse.noFile'));

    const { required, optional } = resolveDeps
      ? await resolveDependencies(version)
      : { required: [], optional: [] };

    const missingRequired = required.filter((item) => !installedKeys.has(item.projectId));
    const offeredOptional = optional.filter((item) => !installedKeys.has(item.projectId));

    if (missingRequired.length > 0 || offeredOptional.length > 0) {
      markBusy(id, false);
      setResolvingDeps(false);
      setDepPrompt({
        project,
        version,
        required: missingRequired,
        optional: offeredOptional,
        selected: {}
      });
      return;
    }

    markBusy(id, false);
    setResolvingDeps(false);
    await installBundle(project, version, []);
  }, [installedKeys, installBundle, markBusy, resolveDependencies, t]);

  const installContent = useCallback(async (project) => {
    if (!target?.id) {
      onNotify?.(t('browse.noInstanceSelected'), t('browse.createBeforeInstall'));
      return;
    }

    if (activeType.id === 'mod' && isTargetVanilla) {
      onNotify?.(
        'Cannot Install Mod',
        `Mods cannot be installed on Vanilla instances (${target?.name || 'Vanilla'}). Please select or create a Fabric, Forge, NeoForge, or Quilt instance.`
      );
      return;
    }

    const id = project.project_id;
    markBusy(id, true);
    setResolvingDeps(true);

    try {
      /* Ask for versions that actually match the instance rather than
         blindly taking the newest build. */
      const params = {};
      if (targetVersion) params.game_versions = JSON.stringify([targetVersion]);
      if (activeType.id === 'mod' && loaderFacet) {
        params.loaders = JSON.stringify([loaderFacet]);
      }

      let response = await fetch(endpoint('/project/' + id + '/version', params));
      let versions = response.ok ? await response.json() : [];

      versions = Array.isArray(versions) ? versions.filter(versionMatchesTarget) : [];
      if (versions.length === 0) {
        const label = [targetVersion, activeType.id === 'mod' ? targetLoader : null]
          .filter(Boolean)
          .join(' ');
        throw new Error(`${project.title} has no compatible build for ${label || t('browse.thisInstance')}.`);
      }

      await installResolvedVersion(project, versions[0], { resolveDeps: activeType.id === 'mod' });
      return;
    } catch (err) {
      onNotify?.(t('browse.installFailed'), err?.message || t('browse.couldNotInstall', { name: project.title }));
    } finally {
      markBusy(id, false);
      setResolvingDeps(false);
    }
  }, [
    target,
    activeType.id,
    isTargetVanilla,
    targetVersion,
    targetLoader,
    loaderFacet,
    versionMatchesTarget,
    installResolvedVersion,
    markBusy,
    onNotify,
    t
  ]);

  /* Explicit build chosen from a version picker. Dependencies are only
     resolved when the build actually matches the instance. */
  const installVersion = useCallback(async (project, version) => {
    if (!target?.id) {
      onNotify?.(t('browse.noInstanceSelected'), t('browse.createBeforeInstall'));
      return;
    }

    if (activeType.id === 'mod' && isTargetVanilla) {
      onNotify?.(
        'Cannot Install Mod',
        `Mods cannot be installed on Vanilla instances (${target?.name || 'Vanilla'}). Please select or create a Fabric, Forge, NeoForge, or Quilt instance.`
      );
      return;
    }

    const id = project.project_id;
    markBusy(id, true);
    setResolvingDeps(true);

    try {
      const resolveDeps = activeType.id === 'mod' && versionMatchesTarget(version);
      await installResolvedVersion(project, version, { resolveDeps });
    } catch (err) {
      onNotify?.(t('browse.installFailed'), err?.message || t('browse.couldNotInstall', { name: project.title }));
    } finally {
      markBusy(id, false);
      setResolvingDeps(false);
    }
  }, [
    target,
    activeType.id,
    isTargetVanilla,
    versionMatchesTarget,
    installResolvedVersion,
    markBusy,
    onNotify,
    t
  ]);

  const install = useCallback((project) => {
    if (activeType.id === 'mod' && isTargetVanilla) {
      onNotify?.(
        'Cannot Install Mod',
        `Mods cannot be installed on Vanilla instances (${target?.name || 'Vanilla'}). Please select or create a Fabric, Forge, NeoForge, or Quilt instance.`
      );
      return;
    }
    if (activeType.id === 'modpack') installModpack(project);
    else installContent(project);
  }, [activeType.id, isTargetVanilla, target, installModpack, installContent, onNotify]);

  const remove = useCallback(async (project) => {
    if (!target?.id) return;
    const id = project.project_id;
    markBusy(id, true);
    try {
      await window.native.mods.remove({ instanceId: target.id, projectId: id });
      await refreshInstalled();
    } catch (err) {
      onNotify?.(t('browse.couldNotRemove'), err?.message || t('browse.removeFailed'));
    } finally {
      markBusy(id, false);
    }
  }, [target?.id, markBusy, refreshInstalled, onNotify, t]);

  /* ----------------------------------------------------------- deps ui */

  const toggleOptionalDep = useCallback((projectId) => {
    setDepPrompt((previous) => (previous
      ? { ...previous, selected: { ...previous.selected, [projectId]: !previous.selected[projectId] } }
      : previous));
  }, []);

  const confirmDeps = useCallback(async () => {
    const prompt = depPrompt;
    if (!prompt) return;
    setDepPrompt(null);
    const extras = [
      ...prompt.required,
      ...prompt.optional.filter((item) => prompt.selected[item.projectId])
    ];
    await installBundle(prompt.project, prompt.version, extras);
  }, [depPrompt, installBundle]);

  const cancelDeps = useCallback(() => setDepPrompt(null), []);

  return useMemo(() => ({
    installedKeys,
    busyIds,
    fetchingVersionIds,
    packProgress,
    depPrompt,
    modpackPrompt,
    resolvingDeps,
    refreshInstalled,
    versionMatchesTarget,
    pickVersion,
    resolveDependencies,
    installModpack,
    installBundle,
    installContent,
    install,
    installVersion,
    remove,
    toggleOptionalDep,
    confirmDeps,
    cancelDeps,
    confirmModpackVersion,
    cancelModpackVersion
  }), [
    installedKeys,
    busyIds,
    fetchingVersionIds,
    packProgress,
    depPrompt,
    modpackPrompt,
    resolvingDeps,
    refreshInstalled,
    versionMatchesTarget,
    pickVersion,
    resolveDependencies,
    installModpack,
    installBundle,
    installContent,
    install,
    installVersion,
    remove,
    toggleOptionalDep,
    confirmDeps,
    cancelDeps,
    confirmModpackVersion,
    cancelModpackVersion
  ]);
}
