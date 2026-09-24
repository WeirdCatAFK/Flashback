/**
 * The card editor's state for a screen that lists cards: open a card by hash (its
 * full record is fetched first), open a new one — which has no document, so it goes
 * to Cards, the default deck — save, delete, close. `benchProps` is ready to spread
 * into <CardBench> (with `benchKey` as its key), or null when the editor is shut.
 * Saving and deleting announce the change on the data bus, so every open list
 * refreshes — unless `announce` is false, for a screen that would rather refresh
 * just what it shows through `onChanged` (an open document, which a vault-wide
 * announcement would remount and scroll back to the top).
 */

import { useState } from 'react';
import { getCardDetail, updateCard, createStandaloneCard, deleteCard } from '../../api/decks';
import { mediaFileSrc } from '../../api/media';
import { getPref } from '../../prefs.js';
import { invalidateData } from '../../utils/dataBus';
import { useT } from '../../translations/index';
import { docTitle } from './cardLineText.js';

/** A saved card's fields as the API's update and create routes take them. */
function cardBody(card) {
  return {
    name: card.name || null,
    cardType: card.cardType,
    frontText: card.vanillaData?.frontText ?? '',
    backText: card.vanillaData?.backText ?? '',
    ...(card.vanillaData?.answerText !== undefined ? { answerText: card.vanillaData.answerText } : {}),
    customHtml: card.customData?.html ?? '',
    category: card.category || null,
    tags: card.tags ?? [],
  };
}

export default function useCardBench({ onError, onChanged, announce = true } = {}) {
  const { t } = useT();
  const [bench, setBench] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const openEdit = async (hash) => {
    setError(null);
    try {
      const detail = await getCardDetail(hash, getPref('fb-srs-algorithm') ?? 'sm2');
      setBench({ mode: 'edit', hash, card: detail.card });
    } catch (err) {
      onError?.(err);
    }
  };

  const openNew = () => { setError(null); setBench({ mode: 'new' }); };

  const run = async (fn) => {
    setSaving(true);
    setError(null);
    try {
      await fn();
      if (announce) invalidateData();
      onChanged?.();
      return true;
    } catch (err) {
      setError(err.message ?? String(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const save = ({ card }) => run(() => (bench.mode === 'edit'
    ? updateCard(bench.hash, cardBody(card))
    : createStandaloneCard({
      ...cardBody(card),
      frontText: card.vanillaData?.frontText || null,
      backText: card.vanillaData?.backText || null,
      customHtml: card.customData?.html || null,
    })));

  const remove = () => run(() => deleteCard(bench.hash));

  const close = () => { setBench(null); setError(null); };

  const doc = bench?.card?.documentPath ?? null;
  const editing = bench?.mode === 'edit';
  const benchProps = bench && {
    title: editing ? t('Edit card') : t('New card'),
    source: editing
      ? (doc ? t('from {document}', { document: docTitle(doc) }) : t('in Cards, the default deck'))
      : t('new card · goes to Cards, the default deck'),
    initial: editing ? {
      cardType: bench.card.cardType ?? 'basic',
      frontText: bench.card.frontText ?? '',
      backText: bench.card.backText ?? '',
      answerText: bench.card.answerText ?? null,
      customHtml: bench.card.customHtml ?? '',
      category: bench.card.category ?? '',
      media: bench.card.media ?? null,
      tags: bench.card.tags ?? [],
    } : null,
    resolveMedia: (ref) => mediaFileSrc(doc, ref),
    mediaEnabled: false,
    submitLabel: editing ? t('Save changes') : t('Save card'),
    saving,
    deleting: saving,
    error,
    onSubmit: save,
    onDelete: editing ? remove : null,
    onClose: close,
  };

  return { benchProps, benchKey: bench?.hash ?? 'new', openEdit, openNew, close };
}
