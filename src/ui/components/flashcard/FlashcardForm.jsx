/**
 * FlashcardForm — the one card editor: type, faces, answer text for type_answer,
 * category, tags, and media from files, a book's figures or a clip's assets, beside
 * a live preview that shows a worked example until anything is written. Edit mode is
 * text-only; media is preserved server-side. `onDelete` adds a Delete that confirms
 * in place. CardBench is the floating shell it opens in; the Inspector hosts it bare.
 */

import { useEffect, useMemo, useState } from 'react';
import InlineConfirm from '../base/InlineConfirm';
import Flashcard from './Flashcard';
import BookImagePicker from './BookImagePicker';
import ClipMediaPicker from './ClipMediaPicker';
import { fetchBookImageFile, fetchDocumentMediaFile } from '../../api/reader';
import { saveClipAsset } from '../../api/documents';
import { getCategories } from '../../api/categories';
import { cardTypes, hasClozeBlank, isCardValid, isCardBlank, exampleFields, previewCardFor, deriveCardCore, typeAnswerParts } from './flashcardFields';
import { useT } from '../../translations/index';
import './FlashcardForm.css';

/**
 * A function of `t`, not a constant: a constant freezes its labels at import and
 * would survive a language switch untranslated. `key` is a storage slot, never a label.
 */
function mediaSlots(t) {
  return [
    { key: 'front_img',   label: t('Front image'), accept: 'image/*' },
    { key: 'front_sound', label: t('Front sound'), accept: 'audio/*' },
    { key: 'back_img',    label: t('Back image'),  accept: 'image/*' },
    { key: 'back_sound',  label: t('Back sound'),  accept: 'audio/*' },
  ];
}

const isImageSlot = (key) => key === 'front_img' || key === 'back_img';

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
  anchorColor = null,
  location = null,
  initial = null,
  resolveMedia = null,
  sourcePath = null,
  sourceKind = null,
  seedImage = null,
  submitLabel,
  saving = false,
  error = null,
  mediaEnabled = true,
  onSubmit,
  onCancel,
  onDelete = null,
  deleting = false,
}) {
  const { t } = useT();
  const editing = !!initial;
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
  const [confirmingDelete, setConfirmingDelete] = useState(false);

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

  const [prevCardType, setPrevCardType] = useState(cardType);
  if (prevCardType !== cardType) {
    setPrevCardType(cardType);
    setPreviewFace('front');
  }

  const [urls, setUrls] = useState(EMPTY_FILES);
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

  const blank = isCardBlank(cardType, { front, back, clozeText, question, expectedAnswer, notes, customHtml });
  const previewCard = useMemo(
    () => previewCardFor(cardType, blank ? exampleFields(cardType, t) : { front, back, clozeText, question, expectedAnswer, notes, customHtml }, mediaObj),
    [cardType, blank, t, front, back, clozeText, question, expectedAnswer, notes, customHtml, mediaObj]
  );

  const addTag = () => {
    const trimmed = tagInput.trim();
    if (trimmed && !tags.includes(trimmed)) setTags((prev) => [...prev, trimmed]);
    setTagInput('');
  };
  const removeTag = (tag) => setTags((prev) => prev.filter((x) => x !== tag));
  const handleTagKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(); }
  };
  const setFile = (key, file) => setFiles((prev) => ({ ...prev, [key]: file ?? null }));

  const [pickingFor, setPickingFor] = useState(null);
  const [pickError, setPickError] = useState(null);
  const [loadingSlot, setLoadingSlot] = useState(null);

  const fetchSourceFile = async (href, name) => {
    if (sourceKind !== 'clip') return fetchBookImageFile(sourcePath, href, name);
    const saved = await saveClipAsset(sourcePath, href);
    return fetchDocumentMediaFile(sourcePath, saved.href, name ?? saved.name);
  };

  const seedSlot = seedImage?.slot;
  const seedHref = seedImage?.href;
  useEffect(() => {
    if (!sourcePath || !seedHref || !seedSlot) return;
    let cancelled = false;
    setLoadingSlot(seedSlot);
    fetchSourceFile(seedHref)
      .then((file) => { if (!cancelled) setFile(seedSlot, file); })
      .catch((err) => { if (!cancelled) setPickError(err.message ?? t('Could not load that image')); })
      .finally(() => { if (!cancelled) setLoadingSlot(null); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcePath, sourceKind, seedHref, seedSlot]);

  const handleSourcePick = async (asset) => {
    const slot = pickingFor;
    setPickingFor(null);
    setPickError(null);
    setLoadingSlot(slot);
    try {
      setFile(slot, await fetchSourceFile(asset.href, asset.name));
    } catch (err) {
      setPickError(err.message ?? t('Could not load that media'));
    } finally {
      setLoadingSlot(null);
    }
  };

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
    const media = (cardType === 'basic' || cardType === 'reversible') ? files : {};

    onSubmit?.({ card, media });
  };

  const selectedCategory = categories.find((c) => c.name === category);
  const missingCategory = category && !selectedCategory ? category : null;
  const showMedia = mediaEnabled && cardType !== 'custom' && !editing;
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

      <div className="fc-form-body">
      <div className="fc-form-fields">
      <span className="fc-form-label" id="fc-card-type">{t('CARD TYPE')}</span>
      <div className="fc-form-types" role="group" aria-labelledby="fc-card-type">
        {cardTypes(t).map((ct) => (
          <button
            key={ct.key}
            type="button"
            className="fc-form-type"
            aria-pressed={cardType === ct.key}
            onClick={() => { setCardType(ct.key); setPreviewFace('front'); }}
          >
            <b>{ct.label}</b>
            <small>{ct.desc}</small>
          </button>
        ))}
      </div>

      {(cardType === 'basic' || cardType === 'reversible') && (
        <>
          <label htmlFor="fc-front" className="fc-form-label">{cardType === 'reversible' ? t('TERM') : t('FRONT')}</label>
          <textarea
            id="fc-front"
            className="fc-form-field"
            value={front}
            onChange={(e) => setFront(e.target.value)}
            rows={2}
            placeholder={cardType === 'reversible' ? t('Term or concept…') : t('Question or prompt…')}
          />
          <label htmlFor="fc-back" className="fc-form-label">{cardType === 'reversible' ? t('DEFINITION') : t('BACK')}</label>
          <textarea
            id="fc-back"
            className="fc-form-field"
            value={back}
            onChange={(e) => setBack(e.target.value)}
            rows={2}
            placeholder={cardType === 'reversible' ? t('Definition or explanation…') : t('Answer…')}
          />
        </>
      )}

      {cardType === 'cloze' && (
        <>
          <label htmlFor="fc-cloze-text" className="fc-form-label">{t('CLOZE TEXT')}</label>
          <p className="fc-form-hint">{t('Wrap words in {{curly braces}} to mark them as blanks.')}</p>
          <textarea
            id="fc-cloze-text"
            className="fc-form-field"
            value={clozeText}
            onChange={(e) => setClozeText(e.target.value)}
            rows={3}
            placeholder={t('The {{mitochondria}} is the powerhouse of the {{cell}}.')}
          />
          {clozeText && !clozeReady && (
            <p className="fc-form-warn">{t('Add at least one {{blank}} to save this card.')}</p>
          )}
        </>
      )}

      {cardType === 'type_answer' && (
        <>
          <label htmlFor="fc-question" className="fc-form-label">{t('QUESTION')}</label>
          <textarea
            id="fc-question"
            className="fc-form-field"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={2}
            placeholder={t('What is the capital of France?')}
          />
          <label htmlFor="fc-expected-answer" className="fc-form-label">{t('EXPECTED ANSWER')}</label>
          <textarea
            id="fc-expected-answer"
            className="fc-form-field"
            value={expectedAnswer}
            onChange={(e) => setExpectedAnswer(e.target.value)}
            rows={2}
            placeholder={t('Paris')}
          />
          <p className="fc-form-hint">{t('Checked with a case-insensitive, trimmed exact match.')}</p>
          <label htmlFor="fc-notes" className="fc-form-label">{t('NOTES (OPTIONAL)')}</label>
          <textarea
            id="fc-notes"
            className="fc-form-field"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder={t('A mnemonic, an explanation, a why…')}
          />
          <p className="fc-form-hint">{t('Shown under the answer after checking. Never compared.')}</p>
        </>
      )}

      {cardType === 'custom' && (
        <>
          <label htmlFor="fc-custom-html" className="fc-form-label">{t('HTML CONTENT')}</label>
          <p className="fc-form-hint">{t('Full HTML with inline styles. Runs in a sandboxed iframe.')}</p>
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
          <label className="fc-form-label">{t('MEDIA')}</label>
          <div className="fc-form-media">
            {mediaSlots(t).map(({ key, label, accept }) => (
              <div className="fc-form-media-slot" key={key}>
                <span className="fc-form-media-label">{label}</span>
                {files[key] ? (
                  <div className="fc-form-media-picked">
                    <span className="fc-form-media-name" title={files[key].name}>{files[key].name}</span>
                    <button type="button" className="fc-form-media-clear" onClick={() => setFile(key, null)}>×</button>
                  </div>
                ) : loadingSlot === key ? (
                  <div className="fc-form-media-picked">
                    <span className="fc-form-media-name">{t('Saving…')}</span>
                  </div>
                ) : (
                  <div className="fc-form-media-sources">
                    <label className="fc-form-media-add">
                      {t('+ Add')}
                      <input type="file" accept={accept} hidden onChange={(e) => setFile(key, e.target.files?.[0])} />
                    </label>
                    {sourcePath && (sourceKind === 'clip' || isImageSlot(key)) && (
                      <button
                        type="button"
                        className="fc-form-media-add fc-form-media-add--book"
                        onClick={() => setPickingFor(key)}
                      >
                        {sourceKind === 'clip' ? t('From clip') : t('From book')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          {pickError && <p className="fc-form-media-error">{pickError}</p>}
        </>
      )}

      {pickingFor && (sourceKind === 'clip' ? (
        <ClipMediaPicker
          clipPath={sourcePath}
          kind={isImageSlot(pickingFor) ? 'image' : 'audio'}
          onPick={handleSourcePick}
          onClose={() => setPickingFor(null)}
        />
      ) : (
        <BookImagePicker
          bookPath={sourcePath}
          onPick={handleSourcePick}
          onClose={() => setPickingFor(null)}
        />
      ))}

      <div className="fc-form-row">
      <div>
      <label htmlFor="fc-tag-input" className="fc-form-label">{t('TAGS')}</label>
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
          placeholder={t('+ tag')}
        />
      </div>
      </div>

      <div>
      <label htmlFor="fc-category" className="fc-form-label">{t('CATEGORY')}</label>
      <select
        id="fc-category"
        className="fc-form-select"
        value={category}
        disabled={categories.length === 0 && !missingCategory}
        onChange={(e) => setCategory(e.target.value)}
      >
        {categories.length === 0 && !missingCategory ? (
          <option value="">{t('No categories — add one in Manage')}</option>
        ) : (
          categories.map((c) => (
            <option key={c.id} value={c.name} title={c.description || undefined}>
              {t('{name} · priority {priority}', { name: c.name, priority: c.priority })}
            </option>
          ))
        )}
        {missingCategory && (
          <option value={missingCategory}>
            {categories.length > 0
              ? t('{name} · removed', { name: missingCategory })
              : missingCategory}
          </option>
        )}
      </select>
      {selectedCategory?.description && (
        <p className="fc-form-hint">{selectedCategory.description}</p>
      )}
      </div>
      </div>

      {error && <p className="fc-form-error">{error}</p>}
      </div>

      <div className="fc-form-preview">
        <span className="fc-form-label">{t('Preview')}</span>
        <div className={`fc-card-stage${blank ? ' fc-card-stage--example' : ''}`}>
          <Flashcard
            card={previewCard}
            face={previewFace}
            onFlip={setPreviewFace}
            onTypeCheck={() => setPreviewFace('back')}
            variant="full"
          />
          {blank && <span className="fc-form-example">{t('Example')}</span>}
        </div>
        <span className="fc-form-preview-hint">
          {blank
            ? t('An example of this type, until you write your own')
            : cardType === 'type_answer'
              ? t('Check an answer to reveal the back')
              : t('Click the card to flip')}
        </span>
      </div>
      </div>

      {confirmingDelete ? (
        <InlineConfirm
          className="fc-form-confirm"
          title={t('Delete this card?')}
          message={t('It goes with its review history. This cannot be undone.')}
          busy={deleting}
          onCancel={() => setConfirmingDelete(false)}
          actions={[{ label: t('Delete card'), kind: 'danger', onClick: onDelete }]}
        />
      ) : (
        <div className="fc-form-actions">
          {onDelete && (
            <button type="button" className="btn btn--quiet btn--sm fc-form-delete" onClick={() => setConfirmingDelete(true)}>
              {t('Delete card')}
            </button>
          )}
          <span className="fc-form-spacer" />
          <button type="button" className="btn btn--quiet btn--sm" onClick={onCancel}>{t('Cancel')}</button>
          <button type="button" className="btn btn--quiet-accent btn--sm" onClick={handleSave} disabled={!canSave}>
            {saving ? t('Saving…') : (submitLabel ?? t('Save card'))}
          </button>
        </div>
      )}
    </div>
  );
}
