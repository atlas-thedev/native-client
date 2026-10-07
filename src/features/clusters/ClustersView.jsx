import React, { useEffect, useMemo, useRef, useState } from "react";
import NativeIcon from "../../components/ui/NativeIcon.jsx";
import { ART_ASSETS, RELEASE_LINES, getClusterArt } from "../../data/versionsData.js";
import { bannerFor, getVersionBanners } from "../../lib/patchNotes.js";
import {
  LOADERS,
  compareVersions,
  getFabricGameVersions,
  getVersionManifest,
  isReleaseId,
  loaderAvailability,
  versionLine
} from "../../lib/mojang.js";
import { useI18n } from "../../i18n/I18nProvider.jsx";
import InstancePickerModal from "./InstancePickerModal.jsx";
import vanillaIcon from "../../assets/icons/vanilla.png";
import fabricIcon from "../../assets/icons/fabric.png";
import forgeIcon from "../../assets/icons/forge.jpg";
import "./ClustersView.css";

const SNAPSHOT_LINE = "snapshots";

function getLoaderIcon(loader) {
  if (loader === "Forge") return forgeIcon;
  if (loader === "Vanilla") return vanillaIcon;
  return fabricIcon;
}

/** Robust artwork renderer that handles cached & bundled artwork with graceful fallback. */
function Art({ src, className = "" }) {
  const [state, setState] = useState({ url: src, ready: false });
  const imgRef = useRef(null);

  useEffect(() => {
    setState({ url: src, ready: false });
    if (imgRef.current?.complete && imgRef.current?.naturalWidth > 0) {
      setState({ url: src, ready: true });
    }
  }, [src]);

  const handleRef = (node) => {
    imgRef.current = node;
    if (node?.complete && node?.naturalWidth > 0) {
      setState((prev) => (prev.ready ? prev : { ...prev, ready: true }));
    }
  };

  return (
    <img
      ref={handleRef}
      className={className + (state.ready ? " is-ready" : "")}
      src={state.url}
      alt=""
      draggable={false}
      loading="eager"
      decoding="async"
      onLoad={() => setState((prev) => ({ ...prev, ready: true }))}
      onError={() =>
        setState((prev) =>
          prev.url === ART_ASSETS.default
            ? { ...prev, ready: true }
            : { url: ART_ASSETS.default, ready: false }
        )
      }
    />
  );
}

export default function ClustersView({
  instances = [],
  selectedCluster,
  onSelectCluster,
  onOpenCluster,
  onLaunch,
  onKill,
  onOpenNewInstanceModal,
  onCreateInstance,
  onNotify,
  launcherState
}) {
  const { t } = useI18n();
  const [manifest, setManifest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fabricSet, setFabricSet] = useState(null);
  const [banners, setBanners] = useState(null);

  // Until a card is picked, the newest release line is the highlighted one
  const [selectedLine, setSelectedLine] = useState(null);
  const [selectedPatches, setSelectedPatches] = useState({});
  const [selectedLoaders, setSelectedLoaders] = useState({});
  const [openDropdownLine, setOpenDropdownLine] = useState(null);
  const [dropUp, setDropUp] = useState(false);
  const [includeSnapshots, setIncludeSnapshots] = useState(() => {
    try { return localStorage.getItem("native.versions.snapshots") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("native.versions.snapshots", includeSnapshots ? "1" : "0"); } catch { /* ignore */ }
  }, [includeSnapshots]);
  const [creatingLineId, setCreatingLineId] = useState(null);
  const [instancePicker, setInstancePicker] = useState({
    open: false,
    mode: "launch",
    line: null,
    patch: "",
    loader: "",
    matches: []
  });

  // Close patch dropdown on click outside
  useEffect(() => {
    const handleOutside = (e) => {
      if (!e.target.closest(".version-patch-dropdown-container")) {
        setOpenDropdownLine(null);
      }
    };
    if (openDropdownLine) {
      document.addEventListener("pointerdown", handleOutside);
      return () => document.removeEventListener("pointerdown", handleOutside);
    }
  }, [openDropdownLine]);

  // Fetch manifests and artwork maps
  useEffect(() => {
    let cancelled = false;

    getVersionManifest()
      .then((data) => {
        if (!cancelled) setManifest(data);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    getFabricGameVersions()
      .then((set) => {
        if (!cancelled) setFabricSet(set);
      })
      .catch(() => {});

    getVersionBanners()
      .then((map) => {
        if (!cancelled) setBanners(map);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  // Build and sort release lines
  const lines = useMemo(() => {
    const versions = manifest?.versions || [];
    const buckets = new Map();

    // 1. Seed buckets with known RELEASE_LINES to ensure 26.2, 26.1, 1.21..1.7 exist
    RELEASE_LINES.forEach((knownLine) => {
      if (knownLine.id === SNAPSHOT_LINE && !includeSnapshots) return;
      buckets.set(knownLine.id, {
        id: knownLine.id,
        versions: (knownLine.versions || []).map((v) => ({ id: v.version, type: "release" })),
        newest: "2026-01-01T00:00:00Z",
        known: knownLine
      });
    });

    // 2. Ingest versions from Mojang manifest
    versions.forEach((version) => {
      const release = isReleaseId(version.id);
      if (!release && !includeSnapshots) return;
      // Snapshot line: real Mojang snapshots / pre-releases only (not 2010 alphas and betas)
      if (!release && version.type && version.type !== "snapshot") return;

      const key = release ? versionLine(version.id) : SNAPSHOT_LINE;
      if (!key) return;

      if (!buckets.has(key)) {
        buckets.set(key, { id: key, versions: [], newest: version.releaseTime, known: null });
      }
      const bucket = buckets.get(key);
      if (!bucket.versions.some((item) => item.id === version.id)) {
        bucket.versions.push(version);
      }
      if (version.releaseTime && (!bucket.newest || version.releaseTime > bucket.newest)) {
        bucket.newest = version.releaseTime;
      }
    });

    const list = Array.from(buckets.values());
    // Newest patch first, so the default and the menu always lead with the latest.
    list.forEach((bucket) => {
      if (bucket.id === SNAPSHOT_LINE) return;
      bucket.versions.sort((x, y) => compareVersions(y.id, x.id));
    });

    // Snapshots: newest first, capped so the patch menu stays usable.
    const snapBucket = list.find((bucket) => bucket.id === SNAPSHOT_LINE);
    if (snapBucket) {
      snapBucket.versions.sort((x, y) => String(y.releaseTime || "").localeCompare(String(x.releaseTime || "")));
      snapBucket.versions = snapBucket.versions.slice(0, 40);
    }

    // 3. Sort: snapshots first when switched on, then newest release line (26.3, 26.2, 26.1, 1.21 ...).
    list.sort((a, b) => {
      if (a.id === SNAPSHOT_LINE) return -1;
      if (b.id === SNAPSHOT_LINE) return 1;
      const cmp = compareVersions(b.id, a.id);
      if (cmp !== 0) return cmp;
      return String(b.newest || "").localeCompare(String(a.newest || ""));
    });

    return list.map((bucket) => {
      const known = bucket.known || RELEASE_LINES.find((r) => r.id === bucket.id);
      const ids = bucket.versions.map((v) => v.id);
      const banner = bannerFor(banners, ids[0], ids);
      const highResArt = known?.art || banner?.image || getClusterArt({ version: bucket.id, mc_version: ids[0] });

      return {
        ...bucket,
        name: known?.name || "Minecraft " + bucket.id,
        art: highResArt || banner?.image || ART_ASSETS.default,
        tags: known?.tags || [bucket.id === SNAPSHOT_LINE ? "Snapshot" : "Release"],
        description: known?.description || banner?.shortText || "Minecraft release " + bucket.id
      };
    });
  }, [manifest, includeSnapshots, banners]);

  const latestRelease = useMemo(() => {
    let best = null;
    lines.forEach((line) => {
      if (line.id === SNAPSHOT_LINE) return;
      const top = line.versions[0]?.id;
      if (top && (!best || compareVersions(top, best) > 0)) best = top;
    });
    return best;
  }, [lines]);

  // Patch resolution per line: the newest patch the chosen loader can run.
  const getPatchForLine = (lineId, lineVersions = [], loader = null) => {
    if (selectedPatches[lineId]) return selectedPatches[lineId];
    const ids = lineVersions.map((v) => v.id);
    if (!ids.length) return lineId;
    if (loader === "Fabric" && fabricSet) {
      const supported = ids.find((id) => fabricSet.has(id));
      if (supported) return supported;
    }
    return ids[0];
  };

  // Loader resolution per line
  const getLoaderForLine = (lineId) => {
    if (selectedLoaders[lineId]) return selectedLoaders[lineId];
    if (["1.7", "1.8", "1.9", "1.10", "1.11", "1.12"].includes(lineId)) return "Forge";
    if (lineId === "1.13") return "Vanilla";
    // Most snapshots have no mod loader builds; Vanilla always launches.
    if (lineId === SNAPSHOT_LINE) return "Vanilla";
    return "Fabric";
  };

  // Artwork for a card: bundled art for that exact patch, then the official
  // Mojang banner fetched from the web (newest releases have no bundled art),
  // then the line's own artwork.
  const artFor = (line, patch) => {
    const exact = line.known?.versions?.find((v) => v.version === patch)?.art;
    if (exact) return exact;
    if (/^26\.3(\.\d+)?$/.test(String(patch))) return getClusterArt({ version: patch, mc_version: patch });
    const banner = bannerFor(banners, patch, line.versions);
    if (banner?.image) return banner.image;
    return getClusterArt({ version: patch, mc_version: patch }) || line.art || ART_ASSETS.default;
  };

  // Find all matching instances from instances array
  const findMatchingInstances = (patch, loader) => {
    return instances.filter(
      (inst) =>
        (inst.version === patch || inst.mc_version === patch) &&
        (inst.loader || "Vanilla").toLowerCase() === loader.toLowerCase()
    );
  };

  // Find matching instance from instances array (first match)
  const findMatchingInstance = (patch, loader) => {
    return findMatchingInstances(patch, loader)[0] || null;
  };

  // Cycle loader on icon click
  const handleCycleLoader = (e, lineId, patch) => {
    e.stopPropagation();
    const current = getLoaderForLine(lineId);
    const available = LOADERS.filter(
      (l) => loaderAvailability(l, patch, fabricSet)?.available !== false
    );
    const idx = available.indexOf(current);
    const next = available[(idx + 1) % available.length] || "Fabric";
    setSelectedLoaders((prev) => ({ ...prev, [lineId]: next }));
  };

  // Select patch from dropdown
  const handleSelectPatch = (lineId, patch) => {
    setSelectedPatches((prev) => ({ ...prev, [lineId]: patch }));
    setSelectedLine(lineId);
    setOpenDropdownLine(null);
  };

  // Launch button handler
  const handleLaunchClick = async (e, line) => {
    e.stopPropagation();
    setSelectedLine(line.id);
    const loader = getLoaderForLine(line.id);
    const patch = getPatchForLine(line.id, line.versions, loader);
    const matches = findMatchingInstances(patch, loader);
    const matching = matches[0] || null;

    const isBusy =
      Boolean(launcherState?.busy) &&
      (matches.some((m) => m.id === launcherState?.instanceId) ||
        launcherState?.instance?.version === patch);

    if (isBusy) {
      onKill?.();
      return;
    }

    if (matches.length > 1) {
      setInstancePicker({
        open: true,
        mode: "launch",
        line,
        patch,
        loader,
        matches
      });
      return;
    }

    if (matching) {
      onSelectCluster?.(matching.id);
      onLaunch?.(matching);
      return;
    }

    if (!onCreateInstance) return;

    const payload = {
      name: (line.name || patch) + " " + loader,
      version: patch,
      loader,
      description: line.description || "",
      tags: line.tags || [],
      art: artFor(line, patch)
    };

    setCreatingLineId(line.id);
    try {
      const created = await onCreateInstance(payload);
      if (created?.id) {
        onSelectCluster?.(created.id);
        onLaunch?.(created);
      }
    } finally {
      setCreatingLineId(null);
    }
  };

  // Settings gear handler
  const handleOpenSettings = async (e, line) => {
    e.stopPropagation();
    setSelectedLine(line.id);
    const loader = getLoaderForLine(line.id);
    const patch = getPatchForLine(line.id, line.versions, loader);
    const matches = findMatchingInstances(patch, loader);
    const matching = matches[0] || null;

    if (matches.length > 1) {
      setInstancePicker({
        open: true,
        mode: "settings",
        line,
        patch,
        loader,
        matches
      });
      return;
    }

    if (matching) {
      onSelectCluster?.(matching.id);
      onOpenCluster?.(matching, "overview");
      return;
    }

    if (!onCreateInstance) return;

    const payload = {
      name: (line.name || patch) + " " + loader,
      version: patch,
      loader,
      description: line.description || "",
      tags: line.tags || [],
      art: artFor(line, patch)
    };

    setCreatingLineId(line.id);
    try {
      const created = await onCreateInstance(payload);
      if (created?.id) onSelectCluster?.(created.id);
    } finally {
      setCreatingLineId(null);
    }
  };

  // Instance picker callbacks
  const handlePickerSelect = (inst) => {
    setInstancePicker((prev) => ({ ...prev, open: false }));
    onSelectCluster?.(inst.id);
    if (instancePicker.mode === "settings") {
      onOpenCluster?.(inst, "overview");
    } else {
      onLaunch?.(inst);
    }
  };

  const handlePickerCreateNew = async () => {
    const { line, patch, loader, mode, matches } = instancePicker;
    setInstancePicker((prev) => ({ ...prev, open: false }));
    if (!line || !onCreateInstance) return;

    const payload = {
      name: `${line.name || patch} ${loader} (${matches.length + 1})`,
      version: patch,
      loader,
      description: line.description || "",
      tags: line.tags || [],
      art: artFor(line, patch)
    };

    setCreatingLineId(line.id);
    try {
      const created = await onCreateInstance(payload);
      if (created?.id) {
        onSelectCluster?.(created.id);
        if (mode !== "settings") {
          onLaunch?.(created);
        }
      }
    } finally {
      setCreatingLineId(null);
    }
  };

  return (
    <div className="clusters-view">
      <header className="clusters-header">
        <div className="clusters-heading-group">
          <h1 className="clusters-title page-title">{t("nav.versions")}</h1>
          <p className="clusters-subtitle">
            {latestRelease ? `Latest release ${latestRelease}` : "Minecraft releases"}
          </p>
        </div>

        <div className="clusters-header-actions">
          <button
            type="button"
            className={"clusters-chip " + (includeSnapshots ? "active" : "")}
            onClick={() => setIncludeSnapshots((v) => !v)}
            aria-pressed={includeSnapshots}
          >
            <span className="clusters-chip-dot" aria-hidden="true" />
            {t("versions.snapshots")}
          </button>

          <button type="button" className="clusters-new-btn" onClick={onOpenNewInstanceModal}>
            <NativeIcon name="plus" size={16} />
            <span>{t("instances.new")}</span>
          </button>
        </div>
      </header>

      {loading && !lines.length ? (
        <div className="clusters-loading">
          <NativeIcon name="refresh" size={24} className="is-spinning" />
          <span>{t("versions.fetching")}</span>
        </div>
      ) : (
        <div className="clusters-grid-container">
          <div className="clusters-cards-grid">
            {lines.map((line) => {
              const isSelected = line.id === (selectedLine ?? lines[0]?.id);
              const loader = getLoaderForLine(line.id);
              const patch = getPatchForLine(line.id, line.versions, loader);
              const matches = findMatchingInstances(patch, loader);
              const matching = matches[0] || null;
              const hasMultiple = matches.length > 1;
              const loaderIcon = getLoaderIcon(loader);
              const isDropdownOpen = openDropdownLine === line.id;
              const cardArt = artFor(line, patch);

              const isBusyThisVersion =
                (Boolean(launcherState?.busy) &&
                  (matches.some((m) => m.id === launcherState?.instanceId) ||
                    launcherState?.instance?.version === patch)) ||
                creatingLineId === line.id;

              return (
                <div
                  key={line.id}
                  className={"version-card" + (isSelected ? " is-selected" : "")}
                  onClick={() => setSelectedLine(line.id)}
                >
                  {/* Background Artwork */}
                  <div className="version-card-art-wrap">
                    <Art src={cardArt} className="version-card-art" />
                    <div className="version-card-scrim" />
                  </div>

                  {/* Top-Left Patch Dropdown Pill */}
                  <div
                    className="version-patch-dropdown-container"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      className={"version-patch-chip" + (isDropdownOpen ? " is-open" : "")}
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setDropUp(rect.bottom + 250 > window.innerHeight);
                        setOpenDropdownLine((prev) => (prev === line.id ? null : line.id));
                      }}
                      title="Select patch version"
                    >
                      <span>{patch}</span>
                      <NativeIcon
                        name={isDropdownOpen ? "chevron-up" : "chevron-down"}
                        size={10}
                        className="version-patch-chevron"
                      />
                    </button>

                    {isDropdownOpen && (
                      <div className={"version-patch-menu" + (dropUp ? " is-up" : "")}>
                        {line.versions.map((v, i) => (
                          <button
                            key={v.id}
                            type="button"
                            className={
                              "version-patch-item" + (v.id === patch ? " is-active" : "")
                            }
                            onClick={() => handleSelectPatch(line.id, v.id)}
                          >
                            <span className="version-patch-name">{v.id}</span>
                            {i === 0 && line.id !== SNAPSHOT_LINE && (
                              <span className="version-patch-tag">Latest</span>
                            )}
                            {v.id === patch && <NativeIcon name="check" size={12} />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Centered Big Version Number */}
                  <div
                    className={
                      "version-card-center-numeral" +
                      (String(line.id).length > 4 ? " is-long" : "")
                    }
                  >
                    <span>{line.id}</span>
                  </div>

                  {/* Bottom Action Footer */}
                  <div className="version-card-footer">
                    <div className="version-footer-left">
                      <button
                        type="button"
                        className="version-loader-btn"
                        onClick={(e) => handleCycleLoader(e, line.id, patch)}
                        title={"Modloader: " + loader + " (Click to switch)"}
                      >
                        <img src={loaderIcon} alt={loader} className="version-loader-img" />
                      </button>
                    </div>

                    <div className="version-footer-right">
                      <button
                        type="button"
                        className="version-gear-btn"
                        onClick={(e) => handleOpenSettings(e, line)}
                        title={
                          hasMultiple
                            ? `Configure instance (${matches.length} available)`
                            : "Manage mods & instance settings"
                        }
                      >
                        <NativeIcon name="settings" size={13} />
                      </button>

                      <button
                        type="button"
                        className={
                          "version-launch-btn" +
                          (isBusyThisVersion ? " is-busy" : "") +
                          (isSelected ? " is-active-launch" : "")
                        }
                        onClick={(e) => handleLaunchClick(e, line)}
                        disabled={isBusyThisVersion}
                        title={
                          hasMultiple
                            ? `Choose instance to launch (${matches.length} available)`
                            : matching
                            ? "Launch " + matching.name
                            : "Install & Launch " + patch
                        }
                      >
                        {isBusyThisVersion && (
                          <span className="version-launch-icon">
                            <NativeIcon name="refresh" size={12} className="is-spinning" />
                          </span>
                        )}
                        <span>{isBusyThisVersion ? "LAUNCHING" : hasMultiple ? `LAUNCH (${matches.length})` : "LAUNCH"}</span>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <InstancePickerModal
        open={instancePicker.open}
        mode={instancePicker.mode}
        version={instancePicker.patch}
        loader={instancePicker.loader}
        instances={instancePicker.matches}
        onClose={() => setInstancePicker((prev) => ({ ...prev, open: false }))}
        onSelect={handlePickerSelect}
        onCreateNew={handlePickerCreateNew}
      />
    </div>
  );
}
