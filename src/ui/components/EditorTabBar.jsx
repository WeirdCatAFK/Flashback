import './EditorTabBar.css';

function getLabel(path) {
  return path.replace(/\\/g, '/').split('/').pop();
}

export default function EditorTabBar({ tabs, activeTab, previewTab, onTabChange, onTabClose, onTabDoubleClick }) {
  return (
    <div className="tab-bar" role="tablist">
      {tabs.map(({ path }) => {
        const label = getLabel(path);
        const isActive  = path === activeTab;
        const isPreview = path === previewTab;
        return (
          <button
            key={path}
            role="tab"
            aria-selected={isActive}
            className={`tab${isActive ? ' tab--active' : ''}${isPreview ? ' tab--preview' : ''}`}
            onClick={() => onTabChange(path)}
            onDoubleClick={() => onTabDoubleClick?.(path)}
            title={path}
          >
            <span className="tab-label">{label}</span>
            <span
              className="tab-close"
              role="button"
              tabIndex={-1}
              aria-label={`Close ${label}`}
              onClick={(e) => { e.stopPropagation(); onTabClose(path); }}
            >
              ×
            </span>
          </button>
        );
      })}
    </div>
  );
}
