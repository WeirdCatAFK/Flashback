import { useState } from 'react';
import { createVanillaCard } from '../../../api/media';
import FlashcardForm from '../../shared/FlashcardForm';
import { useT } from '../../../translations';

// `draft` is DocumentEditor's snapshot of what this card is anchored to:
// { text, highlightId, color, image? } | null. It is stable state — unlike the live
// browser selection, it doesn't vanish when the user clicks into a field. `image` is
// set when the card started from a figure clicked in the reader rather than from a
// selected passage.
export default function InspectorNewCardTab({ path, draft, onCancel, onSaved }) {
  const { t } = useT();
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState(null);

  const filename    = path?.replace(/\\/g, '/').split('/').pop() ?? '';
  const highlightId = draft?.highlightId ?? null;
  const location    = highlightId ? { type: 'highlight', id: highlightId } : null;

  // An EPUB's figures are reachable from a card made while reading it; no other
  // format has an image list, so the picker stays hidden for those.
  const bookPath  = /\.epub$/i.test(path ?? '') ? path : null;
  const seedImage = draft?.image?.href ? { slot: 'front_img', href: draft.image.href } : null;

  const sourceLabel = draft?.text
    ? (highlightId
      ? t('Anchored to highlight in {file}', { file: filename })
      : t('From {file} (not anchored)', { file: filename }))
    : (draft?.image ? t('Figure from {file}', { file: filename }) : undefined);

  const handleSubmit = async ({ card, media }) => {
    setSaving(true);
    setError(null);
    try {
      // One request creates the card and uploads its media; the API assigns the
      // globalHash and patches vanillaData.media — no client-side sequencing.
      await createVanillaCard(path, card, media);
      onSaved();
    } catch (err) {
      setError(err.message ?? t('Failed to save card'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FlashcardForm
      selection={draft?.text ? { text: draft.text } : null}
      sourceLabel={sourceLabel}
      anchorColor={highlightId ? (draft?.color ?? 'amber') : null}
      location={location}
      bookPath={bookPath}
      seedImage={seedImage}
      saving={saving}
      error={error}
      onSubmit={handleSubmit}
      onCancel={onCancel}
    />
  );
}
