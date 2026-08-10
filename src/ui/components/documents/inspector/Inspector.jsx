import { useState } from 'react';
import './Inspector.css';
import InspectorCardsTab      from './InspectorCardsTab';
import InspectorNewCardTab    from './InspectorNewCardTab';
import InspectorTagsTab       from './InspectorTagsTab';
import InspectorHighlightsTab from './InspectorHighlightsTab';
import { useT } from '../../../translations';

// A function of `t`, not a module constant: a constant is evaluated once at import
// and would keep the old language after a switch. `id` is never translated.
const tabsFor = (t) => [
  { id: 'cards',      label: t('Cards') },
  { id: 'highlights', label: t('Highlights') },
  { id: 'new-card',   label: t('New Card') },
  { id: 'tags',       label: t('Tags') },
];

const MIN_WIDTH = 20;
const MAX_WIDTH = 520;

export default function Inspector({ path, activeTab, onTabChange, cardDraft, onSelectionClear, open, onToggle, highlights, flashcards, tags, excludedTags, onTagsChange, onJumpToHighlight, onHighlightCardRequest, onHighlightDeleteRequest, onCardSaved }) {
  const { t } = useT();
  const handleSaved  = () => { onCardSaved ? onCardSaved() : (onSelectionClear(), onTabChange('cards')); };
  const handleCancel = () => { onSelectionClear(); onTabChange('cards'); };

  const [width, setWidth]       = useState(300);
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
      {open && <div className="inspector-resize-handle" onMouseDown={startResize} aria-hidden="true" />}

      <div className="inspector-tabs">
        {open && tabsFor(t).map(({ id, label }) => (
          <button type="button"
            key={id}
            className={`inspector-tab${activeTab === id ? ' inspector-tab--active' : ''}`}
            onClick={() => onTabChange(id)}
          >
            {label}
          </button>
        ))}
        <button type="button"
          className="inspector-toggle"
          onClick={onToggle}
          title={open ? t('Collapse inspector') : t('Expand inspector')}
        >
          {open ? '›' : '‹'}
        </button>
      </div>

      {open && (
        <div className="inspector-content">
          {activeTab === 'cards'      && <InspectorCardsTab path={path} flashcards={flashcards} onNewCard={() => onTabChange('new-card')} onJumpToHighlight={onJumpToHighlight} />}
          {activeTab === 'highlights' && <InspectorHighlightsTab highlights={highlights} flashcards={flashcards} onJump={onJumpToHighlight} onAddCard={onHighlightCardRequest} onDelete={onHighlightDeleteRequest} />}
          {activeTab === 'new-card'   && (
            <InspectorNewCardTab
              // Remount when the anchor changes so the form re-seeds from the
              // new draft instead of keeping the previous passage's fields.
              key={cardDraft ? `${cardDraft.highlightId ?? ''}:${cardDraft.text}` : 'blank'}
              path={path}
              draft={cardDraft}
              onSaved={handleSaved}
              onCancel={handleCancel}
            />
          )}
          {activeTab === 'tags'       && <InspectorTagsTab path={path} tags={tags ?? []} excludedTags={excludedTags ?? []} onTagsChange={onTagsChange} />}
        </div>
      )}
    </aside>
  );
}
