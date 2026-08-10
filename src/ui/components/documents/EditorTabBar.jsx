import IconSave from '../icons/IconSave';
import { useT } from '../../translations';
import './EditorTabBar.css';

function getLabel(path) {
  return path.replace(/\\/g, '/').split('/').pop();
}

export default function EditorTabBar({ tabs, activeTab, previewTab, dirtyPaths, onTabChange, onTabClose, onTabDoubleClick, onSave, canSave, isDirty }) {
  const { t } = useT();
  return (
    <div className="tab-bar">
      <div className="tab-bar-scroll" role="tablist">
        {tabs.map(({ path }) => {
          const label = getLabel(path);
          const isActive  = path === activeTab;
          const isPreview = path === previewTab;
          const isTabDirty = dirtyPaths?.has(path) ?? false;
          return (
            <button type="button"
              key={path}
              role="tab"
              aria-selected={isActive}
              className={`tab${isActive ? ' tab--active' : ''}${isPreview ? ' tab--preview' : ''}${isTabDirty ? ' tab--dirty' : ''}`}
              onClick={() => onTabChange(path)}
              onDoubleClick={() => onTabDoubleClick?.(path)}
              title={path}
            >
              <span className="tab-label">{label}</span>
              <span
                className="tab-close"
                role="button"
                tabIndex={-1}
                aria-label={t('Close {name}', { name: label })}
                onClick={(e) => { e.stopPropagation(); onTabClose(path); }}
                onKeyDown={(e) => e.key === 'Enter' && (e.stopPropagation(), onTabClose(path))}
              >
                ×
              </span>
            </button>
          );
        })}
      </div>

      {onSave && (
        <div className="tab-bar-actions">
          <button
            type="button"
            className={`tab-save-btn${isDirty ? ' tab-save-btn--dirty' : ''}`}
            onClick={() => onSave()}
            disabled={!canSave}
            title={t('Save (Ctrl+S)')}
            aria-label={t('Save (Ctrl+S)')}
          >
            <IconSave size={13} />
            <span>{isDirty ? t('Save') : t('Saved')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
