/**
 * InspectorCardsTab — the cards anchored to the open document, as CardRows, with
 * edit and delete.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { readFile } from '../../../api/documents';
import { deleteCard as deleteCardRequest } from '../../../api/decks';
import { useConfirm } from '../../base/confirmContext.js';
import FlashcardEditor from '../../flashcard/FlashcardEditor';
import CardRow from '../../flashcard/CardRow';
import { typeAnswerParts, cardTypeShortLabel } from '../../flashcard/flashcardFields';
import { useT } from '../../../translations/index';
import { useSession } from '../../../sessionContext.js';

function CardItem({ card, index, onEdit, onDelete, onJumpToHighlight }) {
  const { t } = useT();
  const { can } = useSession();
  const mayEdit = can('editCards');
  const cardType = card.cardType ?? (card.isCustom ? 'custom' : 'basic');
  const front = cardType === 'custom' ? t('Custom HTML card') : (card.vanillaData?.frontText ?? card.name ?? '—');
  const back = cardType === 'custom' ? '' : ((cardType === 'type_answer' ? typeAnswerParts(card.vanillaData).answer : card.vanillaData?.backText) ?? '');
  const highlightLoc = card.vanillaData?.location?.type === 'highlight' ? card.vanillaData.location : null;

  return (
    <CardRow
      layout="stack"
      level={card.level ?? 0}
      front={front}
      back={back}
      tags={card.tags}
      badges={[
        { key: 'num', label: `#${index + 1}`, tone: 'outline' },
        { key: 'type', label: cardTypeShortLabel(cardType, t) },
      ]}
      actions={
        <>
          {highlightLoc && (
            <button type="button" className="btn btn--ghost btn--sm" title={t('Jump to source highlight')} onClick={() => onJumpToHighlight?.(highlightLoc.id)}>
              {t('↗ source')}
            </button>
          )}
          {mayEdit && (
            <>
              <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={() => onEdit(card)} title={t('Edit card')}>✎</button>
              <button type="button" className="btn-close" onClick={() => onDelete(card)} title={t('Delete card')}>✕</button>
            </>
          )}
        </>
      }
    />
  );
}

export default function InspectorCardsTab({ path, flashcards: flashcardsProp, onNewCard, onJumpToHighlight }) {
  const { t, tp } = useT();
  const { can } = useSession();
  const [postEditCards, setPostEditCards] = useState(null);
  const [loading, setLoading]             = useState(false);
  const [editingCard, setEditingCard]     = useState(null);
  const confirm = useConfirm();

  const loadCards = useCallback(() => {
    if (!path) { setPostEditCards(null); return; }
    setLoading(true);
    readFile(path)
      .then((data) => setPostEditCards(data.metadata?.flashcards ?? []))
      .catch(() => setPostEditCards(null))
      .finally(() => setLoading(false));
  }, [path]);

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

  const [syncedPath, setSyncedPath] = useState(path);
  if (syncedPath !== path) {
    setSyncedPath(path);
    setPostEditCards(null);
  }

  useEffect(() => {
    if (flashcardsProp == null) loadCards();
  }, [loadCards, flashcardsProp]);

  const cards = postEditCards ?? flashcardsProp ?? [];

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
