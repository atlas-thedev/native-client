import React, { useMemo } from 'react';
import NativeIcon from '../../../components/ui/NativeIcon.jsx';
import SegmentedTabs from '../../../components/ui/SegmentedTabs.jsx';
import { CONTENT_TYPES, isVanilla } from '../api/modrinthApi.js';
import { useI18n } from '../../../i18n/I18nProvider.jsx';

/* Content-type glyphs are drawn in the app's own icon set so the switcher
   reads as a single family instead of five borrowed marks. */
const TYPE_ICONS = {
  mod: 'type-mod',
  modpack: 'type-modpack',
  shader: 'type-shader',
  resourcepack: 'type-resourcepack',
  datapack: 'type-datapack'
};

export default function BrowseHeader({
  pageTitle,
  availableContentTypes = CONTENT_TYPES,
  contentType,
  onSelectContentType,
  target,
  onBack,
  fixedContentType = false
}) {
  const { t } = useI18n();

  const isTargetVanilla = target ? isVanilla(target) : false;
  const isModOnVanilla = Boolean(target) && contentType?.id === 'mod' && isTargetVanilla;

  const tabItems = useMemo(
    () =>
      availableContentTypes.map((type) => ({
        id: type.id,
        label: t(type.labelKey) || type.id,
        icon: TYPE_ICONS[type.id] || 'type-mod'
      })),
    [availableContentTypes, t]
  );

  const handleChange = (id) => {
    const match = availableContentTypes.find((type) => type.id === id);
    if (match) onSelectContentType?.(match);
  };

  return (
    <header className="browse-header-bar">
      <div className="browse-header-main-row">
        <div className="browse-header-left">
          {onBack && (
            <button
              type="button"
              className="browse-back-btn"
              onClick={onBack}
              aria-label="Go back"
            >
              <NativeIcon name="arrow-left" size={17} />
            </button>
          )}

          <div className="browse-title-group">
            <h1 className="browse-title page-title">{pageTitle || 'Discover'}</h1>
            {target && (
              <div className="browse-target-line" title={`Installing into ${target.name}`}>
                <span className="browse-target-art" aria-hidden="true">
                  <NativeIcon name="cube" size={12} />
                </span>
                <span className="browse-target-label">Adding to</span>
                <strong className="browse-target-name">{target.name}</strong>
                <span className="browse-target-meta">
                  {target.mc_version || target.version} · {target.mc_loader || target.loader || 'Vanilla'}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Content Type Tabs */}
        {!fixedContentType && (
          <SegmentedTabs
            className="browse-type-tabs"
            items={tabItems}
            value={contentType?.id}
            onChange={handleChange}
            ariaLabel="Content types"
          />
        )}
      </div>

      {/* Vanilla Warning Banner - exactly matches test/browse.vanilla.test.js requirement:
          browse-vanilla-warning
          "is a Vanilla instance. Minecraft Vanilla does not support mods" */}
      {isModOnVanilla && (
        <div className="browse-vanilla-warning" role="alert">
          <NativeIcon name="alert" size={16} className="browse-vanilla-warning-icon" />
          <div className="browse-vanilla-warning-text">
            <strong>{target.name}</strong> is a Vanilla instance. Minecraft Vanilla does not support mods.
            Switch to a Fabric, Forge, NeoForge, or Quilt instance to install and play mods.
          </div>
        </div>
      )}
    </header>
  );
}
