import { useEffect, useMemo, useState } from 'react';
import Flashcard from './Flashcard';
import './FlashcardForm.css';

// Reusable, presentation-only flashcard creator. Collects front/back text,
// per-side image + sound, tags and a pedagogical category, and previews the
// result live with the same <Flashcard> used everywhere else. It owns no server
// state: on save it hands a { card, media } payload to `onSubmit`, and the
// consumer performs the single create-with-media request.

const CATEGORIES = ['Definition', 'Terminology', 'Symbol', 'Concept', 'Example', 'Exercise', 'Procedure'];

const MEDIA_SLOTS = [
  { key: 'front_img',   label: 'Front image', accept: 'image/*' },
  { key: 'front_sound', label: 'Front sound', accept: 'audio/*' },
  { key: 'back_img',    label: 'Back image',  accept: 'image/*' },
  { key: 'back_sound',  label: 'Back sound',  accept: 'audio/*' },
];

const EMPTY_FILES = { front_img: null, back_img: null, front_sound: null, back_sound: null };

export default function FlashcardForm({
  selection,                 // optional { text } to show a source banner
  sourceLabel,               // optional caption under the selection (e.g. filename)
  location = null,           // optional reference anchor stored on the card
  orientation = 'landscape',
  saving = false,
  error = null,
  onSubmit,
  onCancel,
}) {
  const [front, setFront]       = useState(selection?.text ?? '');
  const [back, setBack]         = useState('');
  const [tags, setTags]         = useState([]);
  const [tagInput, setTagInput] = useState('');
  const [category, setCategory] = useState('Concept');
  const [files, setFiles]       = useState(EMPTY_FILES);
  const [previewFace, setPreviewFace] = useState('front');

  // Object URLs for the live preview; revoked when files change / on unmount.
  const [urls, setUrls] = useState(EMPTY_FILES);
  useEffect(() => {
    const next = {};
    for (const { key } of MEDIA_SLOTS) next[key] = files[key] ? URL.createObjectURL(files[key]) : null;
    setUrls(next);
    return () => { for (const u of Object.values(next)) if (u) URL.revokeObjectURL(u); };
  }, [files.front_img, files.back_img, files.front_sound, files.back_sound]);

  const previewCard = useMemo(() => ({
    isCustom: false,
    vanillaData: {
      frontText: front,
      backText: back,
      media: { front_img: urls.front_img, back_img: urls.back_img, front_sound: urls.front_sound, back_sound: urls.back_sound },
    },
  }), [front, back, urls]);

  const addTag = () => {
    const t = tagInput.trim();
    if (t && !tags.includes(t)) setTags((prev) => [...prev, t]);
    setTagInput('');
  };
  const removeTag = (tag) => setTags((prev) => prev.filter((t) => t !== tag));
  const handleTagKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(); }
  };

  const setFile = (key, file) => setFiles((prev) => ({ ...prev, [key]: file ?? null }));

  const canSave = front.trim() && back.trim() && !saving;

  const handleSave = () => {
    if (!canSave) return;
    const card = {
      name: front.trim(),
      lastRecall: null,
      level: 0,
      presence: 0,
      tags,
      category,
      isCustom: false,
      customData: { html: '' },
      vanillaData: {
        frontText: front.trim(),
        backText: back.trim(),
        // Slots are filled in server-side once the uploaded files land in media/.
        media: { front_img: null, back_img: null, front_sound: null, back_sound: null },
        location,
      },
    };
    onSubmit?.({ card, media: files });
  };

  return (
    <div className="fc-form">
      {selection?.text && (
        <div className="fc-form-selection">
          <p className="fc-form-selected-text">"{selection.text}"</p>
          {sourceLabel && <span className="fc-form-source">{sourceLabel}</span>}
        </div>
      )}

      <div className="fc-form-preview">
        <Flashcard
          card={previewCard}
          face={previewFace}
          onFlip={setPreviewFace}
          orientation={orientation}
        />
        <span className="fc-form-preview-hint">Click the card to flip</span>
      </div>

      <label className="fc-form-label">FRONT</label>
      <textarea
        className="fc-form-field"
        value={front}
        onChange={(e) => setFront(e.target.value)}
        rows={2}
        placeholder="Question or prompt…"
      />

      <label className="fc-form-label">BACK</label>
      <textarea
        className="fc-form-field"
        value={back}
        onChange={(e) => setBack(e.target.value)}
        rows={2}
        placeholder="Answer…"
      />

      <label className="fc-form-label">MEDIA</label>
      <div className="fc-form-media">
        {MEDIA_SLOTS.map(({ key, label, accept }) => (
          <div className="fc-form-media-slot" key={key}>
            <span className="fc-form-media-label">{label}</span>
            {files[key] ? (
              <div className="fc-form-media-picked">
                <span className="fc-form-media-name" title={files[key].name}>{files[key].name}</span>
                <button type="button" className="fc-form-media-clear" onClick={() => setFile(key, null)}>×</button>
              </div>
            ) : (
              <label className="fc-form-media-add">
                + Add
                <input
                  type="file"
                  accept={accept}
                  hidden
                  onChange={(e) => setFile(key, e.target.files?.[0])}
                />
              </label>
            )}
          </div>
        ))}
      </div>

      <label className="fc-form-label">TAGS</label>
      <div className="fc-form-tags">
        {tags.map((tag) => (
          <span key={tag} className="fc-tag fc-tag--removable">
            {tag}
            <button className="fc-tag-remove" onClick={() => removeTag(tag)}>×</button>
          </span>
        ))}
        <input
          className="fc-form-tag-input"
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={handleTagKeyDown}
          onBlur={addTag}
          placeholder="+ tag"
        />
      </div>

      <label className="fc-form-label">PEDAGOGICAL CATEGORY</label>
      <select className="fc-form-select" value={category} onChange={(e) => setCategory(e.target.value)}>
        {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>

      {error && <p className="fc-form-error">{error}</p>}

      <div className="fc-form-actions">
        <button className="fc-form-save" onClick={handleSave} disabled={!canSave}>
          {saving ? 'Saving…' : 'Save card'}
        </button>
        <button className="fc-form-cancel" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
