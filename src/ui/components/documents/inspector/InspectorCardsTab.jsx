import { useCallback, useEffect, useMemo, useState } from 'react';
import { readFile } from '../../../api/documents';
import { deleteCard as deleteCardRequest } from '../../../api/decks';
import { useConfirm } from '../../shared/ConfirmDialog';
import FlashcardEditor from '../../FlashcardEditor';
import { typeAnswerParts, cardTypeShortLabel } from '../../shared/flashcardFields';
import { useT } from '../../../translations';
import { useSession } from '../../../sessionContext.js';

function CardItem({ card, index, onEdit, onDelete, onJumpToHighlight }) {
  const { t } = useT();
  // Hidden rather than disabled: a row of dead ✎/✕ glyphs on every card reads as breakage,
  // and the row still carries "↗ source", which is what a Reader came here for.
  const { can } = useSession();
  const mayEdit = can('editCards');
  const cardType     = card.cardType ?? (card.isCustom ? 'custom' : 'basic');
  const front        = card.vanillaData?.frontText ?? card.name ?? '—';
  // For a type_answer card the preview line is the compared answer, not the notes that
  // follow it (on a card predating that split, backText is still the answer).
  const back         = (cardType === 'type_answer'
    ? typeAnswerParts(card.vanillaData).answer
    : card.vanillaData?.backText) ?? '';
  const highlightLoc = card.vanillaData?.location?.type === 'highlight'
    ? card.vanillaData.location
    : null;

  return (
    <div className="card-item">
      <div className="card-item-header">
        <span className="card-item-num">#{index + 1}</span>
        <span className="card-item-type">{cardTypeShortLabel(cardType, t)}</span>
        {card.level > 0 && <span className="card-item-level">{t('L{n}', { n: card.level })}</span>}
        <div className="card-item-actions">
          {highlightLoc && (
            <button type="button"
              className="card-item-source"
              title={t('Jump to source highlight')}
              onClick={() => onJumpToHighlight?.(highlightLoc.id)}
            >
              {t('↗ source')}
            </button>
          )}
          {mayEdit && (<>
            <button type="button" className="card-item-edit" onClick={() => onEdit(card)} title={t('Edit card')}>✎</button>
            <button type="button" className="card-item-delete" onClick={() => onDelete(card)} title={t('Delete card')}>✕</button>
          </>)}
        </div>
      </div>

      {cardType === 'custom'
        ? <p className="card-item-front card-item-custom-label">{t('Custom HTML card')}</p>
        : <>
            <p className="card-item-front">{front}</p>
            {back && <p className="card-item-back">{back}</p>}
          </>
      }

      {card.tags?.length > 0 && (
        <div className="card-item-tags">
          {card.tags.map((tag) => <span key={tag} className="card-tag">{tag}</span>)}
        </div>
      )}
    </div>
  );
}

export default function InspectorCardsTab({ path, flashcards: flashcardsProp, onNewCard, onJumpToHighlight }) {
  const { t, tp } = useT();
  const { can } = useSession();
  // Post-edit snapshot: after the user saves an inline edit we re-fetch fresh
  // data here. Null means "no local fetch yet — use parent's flashcardsProp."
  const [postEditCards, setPostEditCards] = useState(null);
  const [loading, setLoading]             = useState(false);
  const [editingCard, setEditingCard]     = useState(null);
  const confirm = useConfirm();

  // After an inline edit the parent's sidecar state may not have refreshed yet,
  // so we re-fetch directly. Also used as the initial load when no prop is given.
  const loadCards = useCallback(() => {
    if (!path) { setPostEditCards(null); return; }
    setLoading(true);
    readFile(path)
      .then((data) => setPostEditCards(data.metadata?.flashcards ?? []))
      .catch(() => setPostEditCards(null))
      .finally(() => setLoading(false));
  }, [path]);

  // Delete a card. This used to fetch the sidecar, filter flashcards[], and save it
  // back from here — a read-modify-write that reverted any other change landing on
  // the sidecar in between, and that left the card's DeckEntries dangling. The server
  // now owns the whole operation (DELETE /api/flashcards/:hash), which is the same
  // call the Flashcards view makes.
  const deleteCard = useCallback(async (card) => {
    if (!path) return;
    const ok = await confirm({
      title: t('Delete this card?'),
      message: t('This permanently removes the flashcard from this document, including its review history. This cannot be undone.'),
      confirmLabel: t('Delete card'),
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await deleteCardRequest(card.globalHash);
    } finally {
      loadCards();
    }
  }, [path, confirm, loadCards, t]);

  // Reset local post-edit snapshot when the document changes or parent sends fresh data.
  useEffect(() => {
    setPostEditCards(null);
  }, [path]);

  // Async fetch stays in an effect; only runs when parent has no data to offer.
  useEffect(() => {
    if (flashcardsProp == null) loadCards();
  }, [loadCards, flashcardsProp]);

  // Post-edit data takes priority while fresh; otherwise use what the parent
  // passed (its already-loaded sidecar state).
  const cards = postEditCards ?? flashcardsProp ?? [];

  // Newest first. The sidecar appends new cards, so in raw order the card you
  // just made lands at the bottom of the panel — off-screen on any document with
  // a few cards. The #n badge keeps the creation-order index so a card's number
  // never changes as the list grows.
  const ordered = useMemo(
    () => (postEditCards ?? flashcardsProp ?? []).map((card, i) => ({ card, i })).reverse(),
    [postEditCards, flashcardsProp]
  );

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
          {loading ? '…' : tp('{n} card', '{n} cards', cards.length)}
        </span>
        {can('editCards') && (
          <button type="button" className="cards-new-btn" onClick={onNewCard}>{t('+ New')}</button>
        )}
      </div>

      {!loading && cards.length === 0 && (
        <p className="inspector-placeholder">{t('No flashcards yet.')}</p>
      )}

      {ordered.map(({ card, i }) => (
        <CardItem
          key={card.globalHash ?? i}
          card={card}
          index={i}
          onEdit={setEditingCard}
          onDelete={deleteCard}
          onJumpToHighlight={onJumpToHighlight}
        />
      ))}
    </div>
  );
}
