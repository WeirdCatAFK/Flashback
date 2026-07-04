import { useEffect, useMemo, useState } from 'react';
import Flashcard from './Flashcard';
import { CARD_TYPES, hasClozeBlank, isCardValid, previewCardFor, deriveCardCore } from './flashcardFields';
import './FlashcardForm.css';

// Reusable flashcard creator. Supports all five card types. Owns no server state:
// on save it hands { card, media } to `onSubmit` and the consumer makes the request.

const CATEGORIES = ['Definition', 'Terminology', 'Symbol', 'Concept', 'Example', 'Exercise', 'Procedure'];

const MEDIA_SLOTS = [
  { key: 'front_img',   label: 'Front image', accept: 'image/*' },
  { key: 'front_sound', label: 'Front sound', accept: 'audio/*' },
  { key: 'back_img',    label: 'Back image',  accept: 'image/*' },
  { key: 'back_sound',  label: 'Back sound',  accept: 'audio/*' },
];

const EMPTY_FILES = { front_img: null, back_img: null, front_sound: null, back_sound: null };

export default function FlashcardForm({
  selection,
  sourceLabel,
  location = null,
  saving = false,
  error = null,
  onSubmit,
  onCancel,
}) {
  const [cardType, setCardType] = useState('basic');
  const [front, setFront]               = useState(selection?.text ?? '');
  const [back, setBack]                 = useState('');
  const [clozeText, setClozeText]       = useState(selection?.text ?? '');
  const [question, setQuestion]         = useState(selection?.text ?? '');
  const [expectedAnswer, setExpectedAnswer] = useState('');
  const [customHtml, setCustomHtml]     = useState('');
  const [tags, setTags]                 = useState([]);
  const [tagInput, setTagInput]         = useState('');
  const [category, setCategory]         = useState('Concept');
  const [files, setFiles]               = useState(EMPTY_FILES);
  const [previewFace, setPreviewFace]   = useState('front');

  // Reset preview face inline when card type changes — no stale flash between renders.
  const [prevCardType, setPrevCardType] = useState(cardType);
  if (prevCardType !== cardType) {
    setPrevCardType(cardType);
    setPreviewFace('front');
  }

  // Object URLs for the live preview; revoked when files change / on unmount.
  const [urls, setUrls] = useState(EMPTY_FILES);
  // Destructure so the effect body references stable closure variables
  // instead of the `files` object — keeps the dep array explicit.
  const { front_img, back_img, front_sound, back_sound } = files;
  useEffect(() => {
    const next = {
      front_img:   front_img   ? URL.createObjectURL(front_img)   : null,
      back_img:    back_img    ? URL.createObjectURL(back_img)    : null,
      front_sound: front_sound ? URL.createObjectURL(front_sound) : null,
      back_sound:  back_sound  ? URL.createObjectURL(back_sound)  : null,
    };
    setUrls(next);
    return () => { for (const u of Object.values(next)) if (u) URL.revokeObjectURL(u); };
  }, [front_img, back_img, front_sound, back_sound]);

  const mediaObj = useMemo(() => ({
    front_img: urls.front_img, back_img: urls.back_img,
    front_sound: urls.front_sound, back_sound: urls.back_sound,
  }), [urls]);

  const previewCard = useMemo(
    () => previewCardFor(cardType, { front, back, clozeText, question, expectedAnswer, customHtml }, mediaObj),
    [cardType, front, back, clozeText, question, expectedAnswer, customHtml, mediaObj]
  );

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

  const fields = { front, back, clozeText, question, expectedAnswer, customHtml };
  const clozeReady = hasClozeBlank(clozeText);
  const canSave = !saving && isCardValid(cardType, fields);

  const handleSave = () => {
    if (!canSave) return;

    const core = deriveCardCore(cardType, fields);
    const base = { lastRecall: null, level: 0, presence: 0, tags, category };
    const emptyMedia = { front_img: null, back_img: null, front_sound: null, back_sound: null };

    const card = {
      ...base,
      name: core.name,
      cardType: core.cardType,
      customData: { html: core.html },
      vanillaData: { frontText: core.frontText, backText: core.backText, media: emptyMedia, location },
    };
    // Only the basic/reversible types carry uploaded media files.
    const media = (cardType === 'basic' || cardType === 'reversible') ? files : {};

    onSubmit?.({ card, media });
  };

  const showMedia = cardType !== 'custom';

  return (
    <div className="fc-form">
      {selection?.text && (
        <div className="fc-form-selection">
          <p className="fc-form-selected-text">"{selection.text}"</p>
          {sourceLabel && <span className="fc-form-source">{sourceLabel}</span>}
        </div>
      )}

      <label htmlFor="fc-card-type" className="fc-form-label">CARD TYPE</label>
      <select id="fc-card-type" className="fc-form-select fc-type-select" value={cardType}
        onChange={(e) => { setCardType(e.target.value); setPreviewFace('front'); }}>
        {CARD_TYPES.map((t) => (
          <option key={t.key} value={t.key}>{t.label}</option>
        ))}
      </select>

      <div className="fc-form-preview">
        <div className="fc-card-stage">
          <Flashcard
            card={previewCard}
            face={previewFace}
            onFlip={cardType !== 'type_answer' ? setPreviewFace : undefined}
            variant="full"
          />
        </div>
        {cardType !== 'type_answer' && (
          <span className="fc-form-preview-hint">Click the card to flip</span>
        )}
      </div>

      {(cardType === 'basic' || cardType === 'reversible') && (
        <>
          <label htmlFor="fc-front" className="fc-form-label">{cardType === 'reversible' ? 'TERM' : 'FRONT'}</label>
          <textarea
            id="fc-front"
            className="fc-form-field"
            value={front}
            onChange={(e) => setFront(e.target.value)}
            rows={2}
            placeholder={cardType === 'reversible' ? 'Term or concept…' : 'Question or prompt…'}
          />
          <label htmlFor="fc-back" className="fc-form-label">{cardType === 'reversible' ? 'DEFINITION' : 'BACK'}</label>
          <textarea
            id="fc-back"
            className="fc-form-field"
            value={back}
            onChange={(e) => setBack(e.target.value)}
            rows={2}
            placeholder={cardType === 'reversible' ? 'Definition or explanation…' : 'Answer…'}
          />
        </>
      )}

      {cardType === 'cloze' && (
        <>
          <label htmlFor="fc-cloze-text" className="fc-form-label">CLOZE TEXT</label>
          <p className="fc-form-hint">Wrap words in {'{{curly braces}}'} to mark them as blanks.</p>
          <textarea
            id="fc-cloze-text"
            className="fc-form-field"
            value={clozeText}
            onChange={(e) => setClozeText(e.target.value)}
            rows={3}
            placeholder="The {{mitochondria}} is the powerhouse of the {{cell}}."
          />
          {clozeText && !clozeReady && (
            <p className="fc-form-warn">Add at least one {'{{blank}}'} to save this card.</p>
          )}
        </>
      )}

      {cardType === 'type_answer' && (
        <>
          <label htmlFor="fc-question" className="fc-form-label">QUESTION</label>
          <textarea
            id="fc-question"
            className="fc-form-field"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={2}
            placeholder="What is the capital of France?"
          />
          <label htmlFor="fc-expected-answer" className="fc-form-label">EXPECTED ANSWER</label>
          <textarea
            id="fc-expected-answer"
            className="fc-form-field"
            value={expectedAnswer}
            onChange={(e) => setExpectedAnswer(e.target.value)}
            rows={2}
            placeholder="Paris"
          />
          <p className="fc-form-hint">Checked with a case-insensitive, trimmed exact match.</p>
        </>
      )}

      {cardType === 'custom' && (
        <>
          <label htmlFor="fc-custom-html" className="fc-form-label">HTML CONTENT</label>
          <p className="fc-form-hint">Full HTML with inline styles. Runs in a sandboxed iframe.</p>
          <textarea
            id="fc-custom-html"
            className="fc-form-field fc-form-field--code"
            value={customHtml}
            onChange={(e) => setCustomHtml(e.target.value)}
            rows={8}
            placeholder={'<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:24px">\n  Your custom card\n</div>'}
            spellCheck={false}
          />
        </>
      )}

      {showMedia && (
        <>
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
                    <input type="file" accept={accept} hidden onChange={(e) => setFile(key, e.target.files?.[0])} />
                  </label>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <label htmlFor="fc-tag-input" className="fc-form-label">TAGS</label>
      <div className="fc-form-tags">
        {tags.map((tag) => (
          <span key={tag} className="fc-tag fc-tag--removable">
            {tag}
            <button type="button" className="fc-tag-remove" onClick={() => removeTag(tag)}>×</button>
          </span>
        ))}
        <input
          id="fc-tag-input"
          className="fc-form-tag-input"
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={handleTagKeyDown}
          onBlur={addTag}
          placeholder="+ tag"
        />
      </div>

      <label htmlFor="fc-category" className="fc-form-label">CATEGORY</label>
      <select id="fc-category" className="fc-form-select" value={category} onChange={(e) => setCategory(e.target.value)}>
        {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>

      {error && <p className="fc-form-error">{error}</p>}

      <div className="fc-form-actions">
        <button type="button" className="fc-form-save" onClick={handleSave} disabled={!canSave}>
          {saving ? 'Saving…' : 'Save card'}
        </button>
        <button type="button" className="fc-form-cancel" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
