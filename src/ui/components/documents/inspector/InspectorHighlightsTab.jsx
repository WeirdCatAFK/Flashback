import { useMemo, useState } from 'react';
import { cardTypeShortLabel } from '../../shared/flashcardFields';
import { useT } from '../../../translations';

const EMPTY = [];

const COLOR_VAR = {
  amber: '--color-hl-1',
  green: '--color-hl-2',
  blue:  '--color-hl-3',
  pink:  '--color-hl-4',
};

export default function InspectorHighlightsTab({ highlights = EMPTY, flashcards = EMPTY, onJump, onAddCard, onDelete }) {
  const { t, tp } = useT();
  const [expandedId, setExpandedId] = useState(null);

  // Newest first, matching the Cards tab and the /api/highlights listing: the
  // sidecar stores highlights in the order they were made, so the one you just
  // marked would otherwise sit at the bottom of the panel.
  const ordered = useMemo(() => [...highlights].reverse(), [highlights]);

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
          <span className="cards-tab-count">{tp('{n} highlight', '{n} highlights', 0)}</span>
        </div>
        <p className="inspector-placeholder">{t('No highlights yet.')}</p>
      </div>
    );
  }

  return (
    <div className="cards-tab">
      <div className="cards-tab-header">
        <span className="cards-tab-count">
          {tp('{n} highlight', '{n} highlights', highlights.length)}
        </span>
      </div>

      {ordered.map((h) => {
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
                {h.text || (h.type === 'pdf_bbox' && h.page
                  ? t('Marked region on page {page}', { page: h.page })
                  : t('(empty)'))}
              </p>
              <div className="hl-item-meta">
                {cards.length > 0 && (
                  <span className="card-item-level">{cards.length}</span>
                )}
                <button type="button"
                  className="hl-jump-btn"
                  title={t('Scroll to highlight in document')}
                  onClick={(e) => { e.stopPropagation(); onJump?.(h.id); }}
                >
                  ↗
                </button>
                <button type="button"
                  className="hl-delete-btn"
                  title={t('Remove highlight')}
                  aria-label={t('Remove highlight')}
                  onClick={(e) => { e.stopPropagation(); onDelete?.(h.id); }}
                >
                  ×
                </button>
              </div>
            </div>

            {isOpen && (
              <div className="hl-cards-list">
                {cards.length === 0 && (
                  <p className="hl-cards-empty">{t('No cards linked to this highlight.')}</p>
                )}
                {cards.map((card) => {
                  const ct    = card.cardType ?? (card.isCustom ? 'custom' : 'basic');
                  const front = card.vanillaData?.frontText ?? card.name ?? '—';
                  return (
                    <div key={card.globalHash} className="hl-card-item">
                      <span className="card-item-type">{cardTypeShortLabel(ct, t)}</span>
                      <span className="hl-card-front">
                        {ct === 'custom' ? t('Custom HTML card') : front}
                      </span>
                    </div>
                  );
                })}
                <button type="button"
                  className="hl-add-card-btn"
                  onClick={() => onAddCard?.(h.id)}
                >
                  {t('+ Add card')}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
