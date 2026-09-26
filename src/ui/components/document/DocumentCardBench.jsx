/**
 * DocumentCardBench — the card editor over a document, for a new card seeded from
 * a selection, a highlight or a picked figure. `draft` is the editor's snapshot of
 * what the card is anchored to — `{ text, highlightId, color, image? }`, or `{}`
 * for a blank card — stable state that, unlike the live selection, does not vanish
 * when a field is clicked. `image` is set when the card started from a figure in
 * the reader rather than from a passage.
 */

import { useState } from 'react';
import CardBench from '../flashcard/CardBench';
import { createVanillaCard } from '../../api/media';
import { docStem } from './explorer/rowFacts.js';
import { useT } from '../../translations/index';

export default function DocumentCardBench({ path, draft, onClose, onSaved }) {
  const { t } = useT();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const title = docStem(path.replace(/\\/g, '/').split('/').pop() ?? '');
  const highlightId = draft?.highlightId ?? null;
  const sourceKind = /\.epub$/i.test(path) ? 'epub' : /\.clip$/i.test(path) ? 'clip' : null;
  const seedImage = draft?.image?.href
    ? { slot: draft.image.kind === 'audio' ? 'front_sound' : 'front_img', href: draft.image.href }
    : null;

  const source = draft?.text
    ? (highlightId ? t('anchored to a highlight in {document}', { document: title }) : t('from {document}, not anchored', { document: title }))
    : draft?.image
      ? (draft.image.kind === 'audio' ? t('sound from {document}', { document: title }) : t('figure from {document}', { document: title }))
      : t('in {document}', { document: title });

  const submit = async ({ card, media }) => {
    setSaving(true);
    setError(null);
    try {
      await createVanillaCard(path, card, media);
      onSaved();
      return true;
    } catch (err) {
      setError(err.message ?? t('Failed to save card'));
      return false;
    } finally {
      setSaving(false);
    }
  };

  return (
    <CardBench
      title={t('New card')}
      source={source}
      selection={draft?.text ? { text: draft.text } : null}
      anchorColor={highlightId ? (draft?.color ?? 'amber') : null}
      location={highlightId ? { type: 'highlight', id: highlightId } : null}
      sourcePath={sourceKind ? path : null}
      sourceKind={sourceKind}
      seedImage={seedImage}
      saving={saving}
      error={error}
      onSubmit={submit}
      onClose={onClose}
    />
  );
}
