import './Inspector.css';
import InspectorCardsTab  from './InspectorCardsTab';
import InspectorNewCardTab from './InspectorNewCardTab';
import InspectorTagsTab   from './InspectorTagsTab';

const TABS = [
  { id: 'cards',    label: 'Cards' },
  { id: 'new-card', label: 'New Card' },
  { id: 'tags',     label: 'Tags' },
];

export default function Inspector({ path, activeTab, onTabChange, selection, onSelectionClear }) {
  const handleSaved  = () => { onSelectionClear(); onTabChange('cards'); };
  const handleCancel = () => { onSelectionClear(); onTabChange('cards'); };

  return (
    <aside className="inspector">
      <div className="inspector-header">
        <span className="inspector-title">INSPECTOR</span>
      </div>

      <div className="inspector-tabs">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            className={`inspector-tab${activeTab === id ? ' inspector-tab--active' : ''}`}
            onClick={() => onTabChange(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="inspector-content">
        {activeTab === 'cards'    && <InspectorCardsTab path={path} onNewCard={() => onTabChange('new-card')} />}
        {activeTab === 'new-card' && <InspectorNewCardTab path={path} selection={selection} onSaved={handleSaved} onCancel={handleCancel} />}
        {activeTab === 'tags'     && <InspectorTagsTab path={path} />}
      </div>
    </aside>
  );
}
