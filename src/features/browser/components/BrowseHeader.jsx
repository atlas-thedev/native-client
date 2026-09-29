import React from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  FileCode,
  Image,
  Layers,
  Package,
  Sparkles
} from 'lucide-react';
import { CONTENT_TYPES, isVanilla } from '../api/modrinthApi.js';
import { useI18n } from '../../../i18n/I18nProvider.jsx';

const TYPE_ICONS = {
  mod: Package,
  modpack: Layers,
  shader: Sparkles,
  resourcepack: Image,
  datapack: FileCode
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
              <ArrowLeft size={18} />
            </button>
          )}

          <div className="browse-title-group">
            <h1 className="browse-title page-title">{pageTitle || 'Discover'}</h1>
          </div>
        </div>

        {/* Content Type Tabs */}
        {!fixedContentType && (
          <nav className="browse-type-tabs" role="tablist" aria-label="Content types">
            {availableContentTypes.map((type) => {
              const isSelected = type.id === contentType?.id;
              const Icon = TYPE_ICONS[type.id] || Package;
              return (
                <button
                  key={type.id}
                  role="tab"
                  type="button"
                  aria-selected={isSelected}
                  className={`browse-type-tab ${isSelected ? 'is-active' : ''}`}
                  onClick={() => onSelectContentType(type)}
                >
                  <Icon size={14} />
                  <span>{t(type.labelKey) || type.id}</span>
                </button>
              );
            })}
          </nav>
        )}
      </div>

      {/* Vanilla Warning Banner - exactly matches test/browse.vanilla.test.js requirement:
          browse-vanilla-warning
          "is a Vanilla instance. Minecraft Vanilla does not support mods" */}
      {isModOnVanilla && (
        <div className="browse-vanilla-warning" role="alert">
          <AlertTriangle size={16} className="browse-vanilla-warning-icon" />
          <div className="browse-vanilla-warning-text">
            <strong>{target.name}</strong> is a Vanilla instance. Minecraft Vanilla does not support mods.
            Switch to a Fabric, Forge, NeoForge, or Quilt instance to install and play mods.
          </div>
        </div>
      )}
    </header>
  );
}
