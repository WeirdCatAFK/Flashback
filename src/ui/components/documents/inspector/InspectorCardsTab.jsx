import { useCallback, useEffect, useState } from 'react';
import { readFile } from '../../../api/documents';
import FlashcardEditor from '../../FlashcardEditor';

const TYPE_LABELS = {
  basic:       'Basic',
  reversible:  'Reversible',
  cloze:       'Cloze',
  type_answer: 'Type',
  custom:      'Custom',
};

function CardItem({ card, index, onEdit, onJumpToHighlight }) {
  const cardType     = card.cardType ?? (card.isCustom ? 'custom' : 'basic');
  const front        = card.vanillaData?.frontText ?? card.name ?? '—';
  const back         = card.vanillaData?.backText ?? '';
  const highlightLoc = card.vanillaData?.location?.type === 'highlight'
    ? card.vanillaData.location
    : null;

  return (
    <div className="card-item">
      <div className="card-item-header">
        <span className="card-item-num">#{index + 1}</span>
        <span className="card-item-type">{TYPE_LABELS[cardType] ?? cardType}</span>
        {card.level > 0 && <span className="card-item-level">L{card.level}</span>}
        <div className="card-item-actions">
          {highlightLoc && (
            <button type="button"
              className="card-item-source"
              title="Jump to source highlight"
              onClick={() => onJumpToHighlight?.(highlightLoc.id)}
            >
              ↗ source
            </button>
          )}
          <button type="button" className="card-item-edit" onClick={() => onEdit(card)} title="Edit card">✎</button>
        </div>
      </div>

      {cardType === 'custom'
        ? <p className="card-item-front card-item-custom-label">Custom HTML card</p>
        : <>
            <p className="card-item-front">{front}</p>
            {back && <p className="card-item-back">{back}</p>}
          </>
      }

      {card.tags?.length > 0 && (
        <div className="card-item-tags">
          {card.tags.map((t) => <span key={t} className="card-tag">{t}</span>)}
        </div>
      )}
    </div>
  );
}

export default function InspectorCardsTab({ path, flashcards: flashcardsProp, onNewCard, onJumpToHighlight }) {
  // Post-edit snapshot: after the user saves an inline edit we re-fetch fresh
  // data here. Null means "no local fetch yet — use parent's flashcardsProp."
  const [postEditCards, setPostEditCards] = useState(null);
  const [loading, setLoading]             = useState(false);
  const [editingCard, setEditingCard]     = useState(null);

  const loadCards = useCallback(() => {
    if (!path) { setPostEditCards(null); return; }
    setLoading(true);
    readFile(path)
      .then((data) => setPostEditCards(data.metadata?.flashcards ?? []))
      .catch(() => setPostEditCards(null))
      .finally(() => setLoading(false));
  }, [path]);

  // Clear stale post-edit snapshot when path or parent data changes.
  useEffect(() => {
    setPostEditCards(null);
  }, [path, flashcardsProp]);

  // Load from disk when the parent has no data to offer.
  useEffect(() => {
    if (flashcardsProp == null) loadCards();
  }, [loadCards, flashcardsProp]);

  // Post-edit data takes priority while fresh; otherwise use what the parent
  // passed (its already-loaded sidecar state).
  const cards = postEditCards ?? flashcardsProp ?? [];

  if (editingCard) {
    return (
      <FlashcardEditor
        card={editingCard}
        documentPath={path}
        onSaved={() => { setEditingCard(null); loadCards(); }}
        onCancel={() => setEditingCard(null)}
      />
    );
  }

  return (
    <div className="cards-tab">
      <div className="cards-tab-header">
        <span className="cards-tab-count">
          {loading ? '…' : `${cards.length} card${cards.length !== 1 ? 's' : ''}`}
        </span>
        <button type="button" className="cards-new-btn" onClick={onNewCard}>+ New</button>
      </div>

      {!loading && cards.length === 0 && (
        <p className="inspector-placeholder">No flashcards yet.</p>
      )}

      {cards.map((card, i) => (
        <CardItem
          key={card.globalHash ?? i}
          card={card}
          index={i}
          onEdit={setEditingCard}
          onJumpToHighlight={onJumpToHighlight}
        />
      ))}
    </div>
  );
}
