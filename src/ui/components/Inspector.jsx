import { useState } from 'react';
import './Inspector.css';
import InspectorCardsTab  from './InspectorCardsTab';
import InspectorNewCardTab from './InspectorNewCardTab';
import InspectorTagsTab   from './InspectorTagsTab';

const TABS = [
  { id: 'cards',    label: 'Cards' },
  { id: 'new-card', label: 'New Card' },
  { id: 'tags',     label: 'Tags' },
];

const MIN_WIDTH = 160;
const MAX_WIDTH = 520;

export default function Inspector({ path, activeTab, onTabChange, selection, onSelectionClear, open, onToggle }) {
  const handleSaved  = () => { onSelectionClear(); onTabChange('cards'); };
  const handleCancel = () => { onSelectionClear(); onTabChange('cards'); };

  const [width, setWidth]       = useState(240);
  const [resizing, setResizing] = useState(false);

  const startResize = (e) => {
    e.preventDefault();
    const startX     = e.clientX;
    const startWidth = width;
    setResizing(true);

    const onMove = (e) => {
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + startX - e.clientX)));
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <aside
      className={`inspector${open ? '' : ' inspector--collapsed'}${resizing ? ' inspector--resizing' : ''}`}
      style={open ? { width } : undefined}
    >
      {open && <div className="inspector-resize-handle" onMouseDown={startResize} />}

      <div className="inspector-tabs">
        {open && TABS.map(({ id, label }) => (
          <button
            key={id}
            className={`inspector-tab${activeTab === id ? ' inspector-tab--active' : ''}`}
            onClick={() => onTabChange(id)}
          >
            {label}
          </button>
        ))}
        <button
          className="inspector-toggle"
          onClick={onToggle}
          title={open ? 'Collapse inspector' : 'Expand inspector'}
        >
          {open ? '›' : '‹'}
        </button>
      </div>

      {open && (
        <div className="inspector-content">
          {activeTab === 'cards'    && <InspectorCardsTab path={path} onNewCard={() => onTabChange('new-card')} />}
          {activeTab === 'new-card' && <InspectorNewCardTab path={path} selection={selection} onSaved={handleSaved} onCancel={handleCancel} />}
          {activeTab === 'tags'     && <InspectorTagsTab path={path} />}
        </div>
      )}
    </aside>
  );
}
