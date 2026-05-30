import { useState } from 'react';
import { createVanillaCard } from '../../../api/media';
import FlashcardForm from '../../shared/FlashcardForm';
import useFlashcardOrientation from '../../../hooks/useFlashcardOrientation';

export default function InspectorNewCardTab({ path, selection, highlightId, onCancel, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState(null);
  const [orientation] = useFlashcardOrientation();

  const filename = path?.replace(/\\/g, '/').split('/').pop() ?? '';
  const location  = highlightId ? { type: 'highlight', id: highlightId } : null;

  const handleSubmit = async ({ card, media }) => {
    setSaving(true);
    setError(null);
    try {
      // One request creates the card and uploads its media; the API assigns the
      // globalHash and patches vanillaData.media — no client-side sequencing.
      await createVanillaCard(path, card, media);
      onSaved();
    } catch (err) {
      setError(err.message ?? 'Failed to save card');
    } finally {
      setSaving(false);
    }
  };

  return (
    <FlashcardForm
      selection={selection}
      sourceLabel={selection?.text ? `${highlightId ? 'highlight' : 'unanchored'} · ${filename}` : undefined}
      location={location}
      orientation={orientation}
      saving={saving}
      error={error}
      onSubmit={handleSubmit}
      onCancel={onCancel}
    />
  );
}
