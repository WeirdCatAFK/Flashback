import { useState } from 'react';
import './Inspector.css';
import InspectorCardsTab      from './InspectorCardsTab';
import InspectorNewCardTab    from './InspectorNewCardTab';
import InspectorTagsTab       from './InspectorTagsTab';
import InspectorHighlightsTab from './InspectorHighlightsTab';
import { useT } from '../../../translations';
import { useSession } from '../../../sessionContext.js';

// A function of `t`, not a module constant: a constant is evaluated once at import
// and would keep the old language after a switch. `id` is never translated.
// `can` filters rather than disables: an inspector tab that opens onto a form nobody may
// submit is worse than a tab bar with three entries. Cards, Highlights and Tags all stay —
// they are readable — and only the authoring tab goes.
const tabsFor = (t, can) => [
  { id: 'cards',      label: t('Cards') },
  { id: 'highlights', label: t('Highlights') },
  ...(can('editCards') ? [{ id: 'new-card', label: t('New Card') }] : []),
  { id: 'tags',       label: t('Tags') },
];

const MIN_WIDTH = 20;
const MAX_WIDTH = 520;

export default function Inspector({ path, activeTab, onTabChange, cardDraft, onSelectionClear, open, onToggle, highlights, flashcards, tags, excludedTags, onTagsChange, onJumpToHighlight, onHighlightCardRequest, onHighlightDeleteRequest, onCardSaved }) {
  const { t } = useT();
  const { can } = useSession();
  // A card draft can arrive from a selection made before the role was known, or from a tab
  // left open across a connection change, so the active tab is resolved rather than trusted.
  const resolvedTab = activeTab === 'new-card' && !can('editCards') ? 'cards' : activeTab;
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
        {open && tabsFor(t, can).map(({ id, label }) => (
          <button type="button"
            key={id}
            className={`inspector-tab${resolvedTab === id ? ' inspector-tab--active' : ''}`}
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
          {resolvedTab === 'cards'      && <InspectorCardsTab path={path} flashcards={flashcards} onNewCard={() => onTabChange('new-card')} onJumpToHighlight={onJumpToHighlight} />}
          {resolvedTab === 'highlights' && <InspectorHighlightsTab highlights={highlights} flashcards={flashcards} onJump={onJumpToHighlight} onAddCard={onHighlightCardRequest} onDelete={onHighlightDeleteRequest} />}
          {resolvedTab === 'new-card'   && (
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
          {resolvedTab === 'tags'       && <InspectorTagsTab path={path} tags={tags ?? []} excludedTags={excludedTags ?? []} onTagsChange={onTagsChange} />}
        </div>
      )}
    </aside>
  );
}
