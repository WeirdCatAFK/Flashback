import { useState } from 'react';

const EMPTY = [];

const COLOR_VAR = {
  amber: '--color-hl-1',
  green: '--color-hl-2',
  blue:  '--color-hl-3',
  pink:  '--color-hl-4',
};

const TYPE_LABELS = {
  basic:       'Basic',
  reversible:  'Reversible',
  cloze:       'Cloze',
  type_answer: 'Type',
  custom:      'Custom',
};

export default function InspectorHighlightsTab({ highlights = EMPTY, flashcards = EMPTY, onJump, onAddCard, onDelete }) {
  const [expandedId, setExpandedId] = useState(null);

  const cardsByHighlight = new Map();
  for (const card of flashcards) {
    const loc = card?.vanillaData?.location;
    if (loc?.type === 'highlight' && loc?.id) {
      if (!cardsByHighlight.has(loc.id)) cardsByHighlight.set(loc.id, []);
      cardsByHighlight.get(loc.id).push(card);
    }
  }

  if (highlights.length === 0) {
    return (
      <div className="cards-tab">
        <div className="cards-tab-header">
          <span className="cards-tab-count">0 highlights</span>
        </div>
        <p className="inspector-placeholder">No highlights yet.</p>
      </div>
    );
  }

  return (
    <div className="cards-tab">
      <div className="cards-tab-header">
        <span className="cards-tab-count">
          {highlights.length} highlight{highlights.length === 1 ? '' : 's'}
        </span>
      </div>

      {highlights.map((h) => {
        const cards   = cardsByHighlight.get(h.id) ?? [];
        const cssVar  = COLOR_VAR[h.color] ?? COLOR_VAR.amber;
        const isOpen  = expandedId === h.id;

        return (
          <div key={h.id} className={`hl-item${isOpen ? ' hl-item--expanded' : ''}`}>
            <div
              className="hl-item-row"
              role="button"
              tabIndex={0}
              onClick={() => { onJump?.(h.id); setExpandedId(isOpen ? null : h.id); }}
              onKeyDown={(e) => e.key === 'Enter' && (onJump?.(h.id), setExpandedId(isOpen ? null : h.id))}
            >
              <span
                className="hl-item-dot"
                style={{ background: `var(${cssVar})` }}
              />
              <p className="hl-item-text">
                {h.text || (h.type === 'pdf_bbox' && h.page ? `Marked region on page ${h.page}` : '(empty)')}
              </p>
              <div className="hl-item-meta">
                {cards.length > 0 && (
                  <span className="card-item-level">{cards.length}</span>
                )}
                <button type="button"
                  className="hl-jump-btn"
                  title="Scroll to highlight in document"
                  onClick={(e) => { e.stopPropagation(); onJump?.(h.id); }}
                >
                  ↗
                </button>
                <button type="button"
                  className="hl-delete-btn"
                  title={cards.length > 0 ? 'Remove highlight' : 'Remove highlight'}
                  aria-label="Remove highlight"
                  onClick={(e) => { e.stopPropagation(); onDelete?.(h.id); }}
                >
                  ×
                </button>
              </div>
            </div>

            {isOpen && (
              <div className="hl-cards-list">
                {cards.length === 0 && (
                  <p className="hl-cards-empty">No cards linked to this highlight.</p>
                )}
                {cards.map((card) => {
                  const ct    = card.cardType ?? (card.isCustom ? 'custom' : 'basic');
                  const front = card.vanillaData?.frontText ?? card.name ?? '—';
                  return (
                    <div key={card.globalHash} className="hl-card-item">
                      <span className="card-item-type">{TYPE_LABELS[ct] ?? ct}</span>
                      <span className="hl-card-front">
                        {ct === 'custom' ? 'Custom HTML card' : front}
                      </span>
                    </div>
                  );
                })}
                <button type="button"
                  className="hl-add-card-btn"
                  onClick={() => onAddCard?.(h.id)}
                >
                  + Add card
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
