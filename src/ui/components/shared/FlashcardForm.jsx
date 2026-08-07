import { useEffect, useMemo, useState } from 'react';
import Flashcard from './Flashcard';
import { getCategories } from '../../api/categories';
import { CARD_TYPES, hasClozeBlank, isCardValid, previewCardFor, deriveCardCore, typeAnswerParts } from './flashcardFields';
import './FlashcardForm.css';

// Reusable flashcard form. Supports all five card types. On save it hands
// { card, media } to `onSubmit` and the consumer makes the request; the only
// server state it owns is the vault's pedagogical categories (editable in Manage).
//
// Pass `initial` to edit an existing card instead of creating one. Editing is
// text-only — the card's media is preserved server-side, so the upload slots are
// hidden rather than being able to clear what they can't show. The preview still
// shows that media (via `initial.media` + `resolveMedia`), so what you see while
// editing is the card as the Trainer will show it.

const MEDIA_SLOTS = [
  { key: 'front_img',   label: 'Front image', accept: 'image/*' },
  { key: 'front_sound', label: 'Front sound', accept: 'audio/*' },
  { key: 'back_img',    label: 'Back image',  accept: 'image/*' },
  { key: 'back_sound',  label: 'Back sound',  accept: 'audio/*' },
];

const EMPTY_FILES = { front_img: null, back_img: null, front_sound: null, back_sound: null };

const HL_COLOR_VAR = {
  amber: '--color-hl-1',
  green: '--color-hl-2',
  blue:  '--color-hl-3',
  pink:  '--color-hl-4',
};

export default function FlashcardForm({
  selection,
  sourceLabel,
  anchorColor = null, // highlight color key when the card is anchored to a highlight
  location = null,
  initial = null,     // existing card's fields → edit mode
  resolveMedia = null, // (storedRef) => url — needed to preview `initial.media`
  submitLabel,
  showTags = true,
  saving = false,
  error = null,
  onSubmit,
  onCancel,
}) {
  const editing = !!initial;
  // A card being edited may predate the answer/notes split, in which case its answer is
  // still in backText. Seeding through the shared helper puts it in the answer field with
  // empty notes, so saving normalises the card without the user doing anything.
  const initialTypeAnswer = typeAnswerParts({
    answerText: initial?.answerText, backText: initial?.backText,
  });
  const [cardType, setCardType] = useState(initial?.cardType ?? 'basic');
  const [front, setFront]               = useState(initial?.frontText ?? selection?.text ?? '');
  const [back, setBack]                 = useState(initial?.backText ?? '');
  const [clozeText, setClozeText]       = useState(initial?.frontText ?? selection?.text ?? '');
  const [question, setQuestion]         = useState(initial?.frontText ?? selection?.text ?? '');
  const [expectedAnswer, setExpectedAnswer] = useState(initialTypeAnswer.answer);
  const [notes, setNotes]               = useState(initialTypeAnswer.notes);
  const [customHtml, setCustomHtml]     = useState(initial?.customHtml ?? '');
  const [tags, setTags]                 = useState(initial?.tags ?? []);
  const [tagInput, setTagInput]         = useState('');
  const [category, setCategory]         = useState(initial?.category ?? '');
  const [categories, setCategories]     = useState([]);
  const [files, setFiles]               = useState(EMPTY_FILES);
  const [previewFace, setPreviewFace]   = useState('front');

  // Categories are vault data, not a constant — they're created/renamed/reordered
  // in Manage. The list arrives sorted by priority ascending (most foundational
  // first), so the first entry is the sensible default for a NEW card. An existing
  // card keeps whatever it already had, including a category since deleted.
  // A failed load leaves the select empty and the card is saved uncategorised.
  useEffect(() => {
    let alive = true;
    getCategories()
      .then((list) => {
        if (!alive) return;
        setCategories(list);
        if (!editing) {
          setCategory((cur) => (list.some((c) => c.name === cur) ? cur : list[0]?.name ?? ''));
        }
      })
      .catch(() => { if (alive) setCategories([]); });
    return () => { alive = false; };
  }, [editing]);

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

  // Preview media: a freshly picked file wins (object URL), otherwise fall back to
  // whatever the card already has on disk. Everything here is already a URL, so the
  // <Flashcard> below needs no resolveMedia of its own.
  // Depend on the refs themselves, not on `initial` — callers build that object
  // inline, so it is a new identity on every render.
  const stored = initial?.media ?? {};
  const { front_img: sFrontImg, back_img: sBackImg,
          front_sound: sFrontSnd, back_sound: sBackSnd } = stored;
  const mediaObj = useMemo(() => {
    const at = (ref) => (ref && resolveMedia ? resolveMedia(ref) : null);
    return {
      front_img:   urls.front_img   ?? at(sFrontImg),
      back_img:    urls.back_img    ?? at(sBackImg),
      front_sound: urls.front_sound ?? at(sFrontSnd),
      back_sound:  urls.back_sound  ?? at(sBackSnd),
    };
  }, [urls, sFrontImg, sBackImg, sFrontSnd, sBackSnd, resolveMedia]);

  const previewCard = useMemo(
    () => previewCardFor(cardType, { front, back, clozeText, question, expectedAnswer, notes, customHtml }, mediaObj),
    [cardType, front, back, clozeText, question, expectedAnswer, notes, customHtml, mediaObj]
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

  const fields = { front, back, clozeText, question, expectedAnswer, notes, customHtml };
  const clozeReady = hasClozeBlank(clozeText);
  const canSave = !saving && isCardValid(cardType, fields);

  const handleSave = () => {
    if (!canSave) return;

    const core = deriveCardCore(cardType, fields);
    const base = { lastRecall: null, level: 0, presence: 0, tags, category: category || null };
    const emptyMedia = { front_img: null, back_img: null, front_sound: null, back_sound: null };

    const card = {
      ...base,
      name: core.name,
      cardType: core.cardType,
      customData: { html: core.html },
      vanillaData: {
        frontText: core.frontText,
        backText: core.backText,
        ...(core.answerText !== undefined ? { answerText: core.answerText } : {}),
        media: emptyMedia,
        location,
      },
    };
    // Only the basic/reversible types carry uploaded media files.
    const media = (cardType === 'basic' || cardType === 'reversible') ? files : {};

    onSubmit?.({ card, media });
  };

  const selectedCategory = categories.find((c) => c.name === category);
  // The card's category isn't in the vault list — either it's still loading, or it
  // was renamed/deleted in Manage. Either way the select needs an option for it so
  // the current value stays visible and survives a save.
  const missingCategory = category && !selectedCategory ? category : null;
  const showMedia = cardType !== 'custom' && !editing;
  const anchorVar = anchorColor ? HL_COLOR_VAR[anchorColor] ?? HL_COLOR_VAR.amber : null;

  return (
    <div className="fc-form">
      {selection?.text && (
        <div
          className="fc-form-selection"
          style={anchorVar ? { borderLeftColor: `var(${anchorVar})` } : undefined}
        >
          <p className="fc-form-selected-text">&ldquo;{selection.text}&rdquo;</p>
          {sourceLabel && (
            <span className="fc-form-source">
              {anchorVar && (
                <span className="fc-form-anchor-dot" style={{ background: `var(${anchorVar})` }} />
              )}
              {sourceLabel}
            </span>
          )}
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
          {/* The preview behaves like the real thing, including type_answer: its
              front deliberately ignores clicks (the Check button is the only reveal),
              so without onTypeCheck the back would be unreachable here. */}
          <Flashcard
            card={previewCard}
            face={previewFace}
            onFlip={setPreviewFace}
            onTypeCheck={() => setPreviewFace('back')}
            variant="full"
          />
        </div>
        <span className="fc-form-preview-hint">
          {cardType === 'type_answer'
            ? 'Check an answer to reveal the back'
            : 'Click the card to flip'}
        </span>
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
          <label htmlFor="fc-notes" className="fc-form-label">NOTES (OPTIONAL)</label>
          <textarea
            id="fc-notes"
            className="fc-form-field"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="A mnemonic, an explanation, a why…"
          />
          <p className="fc-form-hint">Shown under the answer after checking. Never compared.</p>
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

      {showTags && (
        <>
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
        </>
      )}

      <label htmlFor="fc-category" className="fc-form-label">CATEGORY</label>
      <select
        id="fc-category"
        className="fc-form-select"
        value={category}
        disabled={categories.length === 0 && !missingCategory}
        onChange={(e) => setCategory(e.target.value)}
      >
        {categories.length === 0 && !missingCategory ? (
          <option value="">No categories — add one in Manage</option>
        ) : (
          categories.map((c) => (
            <option key={c.id} value={c.name} title={c.description || undefined}>
              {c.name} · priority {c.priority}
            </option>
          ))
        )}
        {missingCategory && (
          <option value={missingCategory}>
            {missingCategory}{categories.length > 0 ? ' · removed' : ''}
          </option>
        )}
      </select>
      {selectedCategory?.description && (
        <p className="fc-form-hint">{selectedCategory.description}</p>
      )}

      {error && <p className="fc-form-error">{error}</p>}

      <div className="fc-form-actions">
        <button type="button" className="fc-form-save" onClick={handleSave} disabled={!canSave}>
          {saving ? 'Saving…' : (submitLabel ?? 'Save card')}
        </button>
        <button type="button" className="fc-form-cancel" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
