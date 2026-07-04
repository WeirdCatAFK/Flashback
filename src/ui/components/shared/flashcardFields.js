/**
 * Shared flashcard-field logic used by both the creator (FlashcardForm) and the
 * editor (FlashcardEditor). The two components keep their own layout and their own
 * persistence (the creator delegates via onSubmit; the editor writes the sidecar
 * itself), but the type list, validation, preview shape, and card-core derivation
 * are identical and were duplicated — a divergence here would silently corrupt cards,
 * so it lives in one place.
 *
 * `fields` is the flat bag of per-type values a form holds:
 *   { front, back, clozeText, question, expectedAnswer, customHtml }
 */

export const CARD_TYPES = [
  { key: 'basic',       label: 'Basic',       desc: 'Front and back' },
  { key: 'reversible',  label: 'Reversible',  desc: 'Either direction' },
  { key: 'cloze',       label: 'Cloze',       desc: '{{fill in blanks}}' },
  { key: 'type_answer', label: 'Type Answer', desc: 'Typed input check' },
  { key: 'custom',      label: 'Custom HTML', desc: 'Full HTML template' },
];

export function hasClozeBlank(text) {
  return /\{\{[^}]+\}\}/.test(text ?? '');
}

// Whether the current field values are enough to save the given card type.
export function isCardValid(cardType, f) {
  switch (cardType) {
    case 'basic':
    case 'reversible':  return f.front.trim() !== '' && f.back.trim() !== '';
    case 'cloze':       return f.clozeText.trim() !== '' && hasClozeBlank(f.clozeText);
    case 'type_answer': return f.question.trim() !== '' && f.expectedAnswer.trim() !== '';
    case 'custom':      return f.customHtml.trim() !== '';
    default:            return false;
  }
}

// The shape the live <Flashcard> preview renders. `media` is the resolved media obj
// (object URLs during creation, {} when editing).
export function previewCardFor(cardType, f, media = {}) {
  if (cardType === 'custom')      return { cardType: 'custom', customData: { html: f.customHtml } };
  if (cardType === 'cloze')       return { cardType: 'cloze',       vanillaData: { frontText: f.clozeText, backText: f.clozeText,      media } };
  if (cardType === 'type_answer') return { cardType: 'type_answer', vanillaData: { frontText: f.question,  backText: f.expectedAnswer, media } };
  return { cardType, direction: 'forward', vanillaData: { frontText: f.front, backText: f.back, media } };
}

// The card identity + text derived from the fields, independent of media/base fields:
//   { name, cardType, html, frontText, backText }
// Callers layer their own base fields, media, and location on top.
export function deriveCardCore(cardType, f) {
  if (cardType === 'custom') {
    return { name: 'Custom card', cardType: 'custom', html: f.customHtml, frontText: '', backText: '' };
  }
  if (cardType === 'cloze') {
    const text = f.clozeText.trim();
    return { name: f.clozeText.replace(/\{\{([^}]+)\}\}/g, '$1').slice(0, 80), cardType: 'cloze', html: '', frontText: text, backText: text };
  }
  if (cardType === 'type_answer') {
    return { name: f.question.trim().slice(0, 80), cardType: 'type_answer', html: '', frontText: f.question.trim(), backText: f.expectedAnswer.trim() };
  }
  return { name: f.front.trim(), cardType, html: '', frontText: f.front.trim(), backText: f.back.trim() };
}
