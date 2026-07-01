import { useMemo, useState } from 'react';
import { readFile, updateMetadata } from '../api/documents';
import Flashcard from './shared/Flashcard';
import './shared/FlashcardForm.css';

const CARD_TYPES = [
  { key: 'basic',       label: 'Basic' },
  { key: 'reversible',  label: 'Reversible' },
  { key: 'cloze',       label: 'Cloze' },
  { key: 'type_answer', label: 'Type Answer' },
  { key: 'custom',      label: 'Custom HTML' },
];

export default function FlashcardEditor({ card, documentPath, onSaved, onCancel }) {
  const originalType = card?.cardType ?? (card?.isCustom ? 'custom' : 'basic');
  const vd = card?.vanillaData ?? {};

  const [cardType, setCardType]             = useState(originalType);
  const [front, setFront]                   = useState(vd.frontText ?? '');
  const [back, setBack]                     = useState(vd.backText ?? '');
  const [clozeText, setClozeText]           = useState(vd.frontText ?? '');
  const [question, setQuestion]             = useState(vd.frontText ?? '');
  const [expectedAnswer, setExpectedAnswer] = useState(vd.backText ?? '');
  const [customHtml, setCustomHtml]         = useState(card?.customData?.html ?? '');
  const [tags, setTags]                     = useState(card?.tags ?? []);
  const [tagInput, setTagInput]             = useState('');
  const [saving, setSaving]                 = useState(false);
  const [error, setError]                   = useState(null);
  const [previewFace, setPreviewFace]       = useState('front');

  const previewCard = useMemo(() => {
    if (cardType === 'custom')      return { cardType: 'custom', customData: { html: customHtml } };
    if (cardType === 'cloze')       return { cardType: 'cloze',       vanillaData: { frontText: clozeText,      backText: clozeText,        media: {} } };
    if (cardType === 'type_answer') return { cardType: 'type_answer', vanillaData: { frontText: question,       backText: expectedAnswer,    media: {} } };
    return { cardType, direction: 'forward', vanillaData: { frontText: front, backText: back, media: {} } };
  }, [cardType, front, back, clozeText, question, expectedAnswer, customHtml]);

  const addTag = () => {
    const t = tagInput.trim();
    if (t && !tags.includes(t)) setTags((p) => [...p, t]);
    setTagInput('');
  };
  const removeTag = (tag) => setTags((p) => p.filter((t) => t !== tag));
  const onTagKey  = (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(); } };

  const hasClozeBlank = /\{\{[^}]+\}\}/.test(clozeText);
  const canSave = !saving && (() => {
    switch (cardType) {
      case 'basic':
      case 'reversible':  return front.trim() !== '' && back.trim() !== '';
      case 'cloze':       return clozeText.trim() !== '' && hasClozeBlank;
      case 'type_answer': return question.trim() !== '' && expectedAnswer.trim() !== '';
      case 'custom':      return customHtml.trim() !== '';
      default:            return false;
    }
  })();

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const data = await readFile(documentPath);
      const meta = data.metadata ?? {};
      if (!Array.isArray(meta.flashcards)) throw new Error('No flashcards in document');
      const idx = meta.flashcards.findIndex((f) => f.globalHash === card.globalHash);
      if (idx === -1) throw new Error('Card not found');
      const ex = meta.flashcards[idx];

      let updated;
      if (cardType === 'custom') {
        updated = { ...ex, cardType: 'custom', name: 'Custom card', tags,
          customData: { html: customHtml } };
      } else if (cardType === 'cloze') {
        updated = { ...ex, cardType: 'cloze', tags,
          name: clozeText.replace(/\{\{([^}]+)\}\}/g, '$1').slice(0, 80),
          vanillaData: { ...ex.vanillaData, frontText: clozeText.trim(), backText: clozeText.trim() } };
      } else if (cardType === 'type_answer') {
        updated = { ...ex, cardType: 'type_answer', tags,
          name: question.trim().slice(0, 80),
          vanillaData: { ...ex.vanillaData, frontText: question.trim(), backText: expectedAnswer.trim() } };
      } else {
        updated = { ...ex, cardType, tags,
          name: front.trim(),
          vanillaData: { ...ex.vanillaData, frontText: front.trim(), backText: back.trim() } };
      }

      meta.flashcards[idx] = updated;
      await updateMetadata(documentPath, meta, false);
      onSaved?.();
    } catch (err) {
      setError(err.message ?? 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fc-editor">
      <button type="button" className="fc-editor-back" onClick={onCancel}>← Cards</button>

      <div className="fc-editor-preview">
        <div className="fc-card-stage">
          <Flashcard
            card={previewCard}
            face={previewFace}
            onFlip={cardType !== 'type_answer' ? setPreviewFace : undefined}
            variant="full"
          />
        </div>
        {cardType !== 'type_answer' && (
          <span className="fc-editor-flip-hint">click to flip</span>
        )}
      </div>

      <select className="fc-form-select fc-type-select" aria-label="Card type" value={cardType}
        onChange={(e) => { setCardType(e.target.value); setPreviewFace('front'); }}>
        {CARD_TYPES.map((t) => (
          <option key={t.key} value={t.key}>{t.label}</option>
        ))}
      </select>

      {(cardType === 'basic' || cardType === 'reversible') && (
        <>
          <textarea className="fc-form-field" rows={2} value={front}
            aria-label={cardType === 'reversible' ? 'Term' : 'Front'}
            onChange={(e) => setFront(e.target.value)}
            placeholder={cardType === 'reversible' ? 'Term or concept…' : 'Front / question…'} />
          <textarea className="fc-form-field" rows={2} value={back}
            aria-label={cardType === 'reversible' ? 'Definition' : 'Back'}
            onChange={(e) => setBack(e.target.value)}
            placeholder={cardType === 'reversible' ? 'Definition…' : 'Back / answer…'} />
        </>
      )}

      {cardType === 'cloze' && (
        <>
          <p className="fc-form-hint">Wrap words in {'{{curly braces}}'} to mark blanks.</p>
          <textarea className="fc-form-field" rows={3} value={clozeText}
            aria-label="Cloze text"
            onChange={(e) => setClozeText(e.target.value)}
            placeholder="The {{mitochondria}} is the powerhouse of the {{cell}}." />
          {clozeText && !hasClozeBlank && (
            <p className="fc-form-warn">Add at least one {'{{blank}}'}.</p>
          )}
        </>
      )}

      {cardType === 'type_answer' && (
        <>
          <textarea className="fc-form-field" rows={2} value={question}
            aria-label="Question"
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Question…" />
          <textarea className="fc-form-field" rows={2} value={expectedAnswer}
            aria-label="Expected answer"
            onChange={(e) => setExpectedAnswer(e.target.value)}
            placeholder="Expected answer (case-insensitive)…" />
        </>
      )}

      {cardType === 'custom' && (
        <textarea className="fc-form-field fc-form-field--code" rows={7} value={customHtml}
          aria-label="Custom HTML content"
          onChange={(e) => setCustomHtml(e.target.value)}
          placeholder={'<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:24px">\n  Your content\n</div>'}
          spellCheck={false} />
      )}

      <div className="fc-form-tags">
        {tags.map((tag) => (
          <span key={tag} className="fc-tag fc-tag--removable">
            {tag}<button type="button" className="fc-tag-remove" onClick={() => removeTag(tag)}>×</button>
          </span>
        ))}
        <input className="fc-form-tag-input" aria-label="Add tag" value={tagInput} placeholder="+ tag"
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={onTagKey} onBlur={addTag} />
      </div>

      {error && <p className="fc-form-error">{error}</p>}

      <div className="fc-form-actions">
        <button type="button" className="fc-form-save" onClick={handleSave} disabled={!canSave}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="fc-form-cancel" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
