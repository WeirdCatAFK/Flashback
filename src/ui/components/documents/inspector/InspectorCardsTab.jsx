import { useCallback, useEffect, useState } from 'react';
import { readFile } from '../../../api/documents';
import FlashcardEditor from '../../FlashcardEditor';

const TYPE_LABELS = {
  basic: 'Basic',
  reversible: 'Reversible',
  cloze: 'Cloze',
  type_answer: 'Type',
  custom: 'Custom',
};

function CardItem({ card, index, onEdit }) {
  const cardType = card.cardType ?? (card.isCustom ? 'custom' : 'basic');
  const front = card.vanillaData?.frontText ?? card.name ?? '—';
  const back  = card.vanillaData?.backText ?? '';
  return (
    <div className="card-item">
      <div className="card-item-header">
        <span className="card-item-num">#{index + 1}</span>
        <span className="card-item-type">{TYPE_LABELS[cardType] ?? cardType}</span>
        {card.level > 0 && <span className="card-item-level">L{card.level}</span>}
        <button className="card-item-edit" onClick={() => onEdit(card)} title="Edit card">✎</button>
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

export default function InspectorCardsTab({ path, onNewCard }) {
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editingCard, setEditingCard] = useState(null);

  const loadCards = useCallback(() => {
    if (!path) { setCards([]); return; }
    setLoading(true);
    readFile(path)
      .then((data) => setCards(data.metadata?.flashcards ?? []))
      .catch(() => setCards([]))
      .finally(() => setLoading(false));
  }, [path]);

  useEffect(() => { loadCards(); }, [loadCards]);

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
        <button className="cards-new-btn" onClick={onNewCard}>+ New</button>
      </div>

      {!loading && cards.length === 0 && (
        <p className="inspector-placeholder">No flashcards yet.</p>
      )}

      {cards.map((card, i) => (
        <CardItem key={card.globalHash ?? i} card={card} index={i} onEdit={setEditingCard} />
      ))}
    </div>
  );
}
