/**
 * Shared flashcard-field logic used by both the creator (FlashcardForm) and the
 * editor (FlashcardEditor). The two components keep their own layout and their own
 * persistence (the creator delegates via onSubmit; the editor calls the API itself),
 * but the type list, validation, preview shape, and card-core derivation
 * are identical and were duplicated — a divergence here would silently corrupt cards,
 * so it lives in one place.
 *
 * `fields` is the flat bag of per-type values a form holds:
 *   { front, back, clozeText, question, expectedAnswer, notes, customHtml }
 */

/**
 * The card-type picker's labels. A function of `t` rather than a module constant:
 * a constant is evaluated once at import and would keep the old language after a
 * switch, and every key here has to stay a literal for the extractor to see it.
 * `key` is the stored card_type value and is never translated.
 */
export function cardTypes(t) {
  return [
    { key: 'basic',       label: t('Basic'),       desc: t('Front and back') },
    { key: 'reversible',  label: t('Reversible'),  desc: t('Either direction') },
    { key: 'cloze',       label: t('Cloze'),       desc: t('{{fill in blanks}}') },
    { key: 'type_answer', label: t('Type Answer'), desc: t('Typed input check') },
    { key: 'custom',      label: t('Custom HTML'), desc: t('Full HTML template') },
  ];
}

export function hasClozeBlank(text) {
  return /\{\{[^}]+\}\}/.test(text ?? '');
}

/**
 * Splits a type_answer card's vanillaData into the value that gets compared and the notes
 * that merely get shown.
 *
 * `answerText` is the compared value and `backText` is free prose revealed after checking —
 * a mnemonic, a why. Cards written before that split kept the answer in `backText` and have
 * no `answerText` at all, so it is the fallback. The vault normally migrates them on first
 * launch (canonical update 001 — see src/api/config/updates/UPDATES.md), but a Seal rollback
 * can restore a pre-split sidecar at any time, so every reader goes through here rather than
 * assuming.
 *
 * @param {object} vd a card's vanillaData
 * @returns {{ answer: string, notes: string }}
 */
export function typeAnswerParts(vd = {}) {
  const hasAnswer = (vd?.answerText ?? '') !== '';
  return {
    answer: hasAnswer ? vd.answerText : (vd?.backText ?? ''),
    notes: hasAnswer ? (vd?.backText ?? '') : '',
  };
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

// The shape the live <Flashcard> preview renders. `media` holds ready-to-load URLs,
// not stored references: object URLs for files being uploaded, /api/media URLs for
// media the card already has.
export function previewCardFor(cardType, f, media = {}) {
  if (cardType === 'custom')      return { cardType: 'custom', customData: { html: f.customHtml } };
  if (cardType === 'cloze')       return { cardType: 'cloze',       vanillaData: { frontText: f.clozeText, backText: f.clozeText,      media } };
  if (cardType === 'type_answer') return { cardType: 'type_answer', vanillaData: { frontText: f.question,  backText: f.notes ?? '', answerText: f.expectedAnswer, media } };
  return { cardType, direction: 'forward', vanillaData: { frontText: f.front, backText: f.back, media } };
}

// The card identity + text derived from the fields, independent of media/base fields:
//   { name, cardType, html, frontText, backText } — plus `answerText` for type_answer.
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
    // backText is the notes field here; the compared value rides in answerText, and is
    // always written (even empty) so the card never reads as one predating the split.
    return {
      name: f.question.trim().slice(0, 80),
      cardType: 'type_answer',
      html: '',
      frontText: f.question.trim(),
      backText: (f.notes ?? '').trim(),
      answerText: f.expectedAnswer.trim(),
    };
  }
  return { name: f.front.trim(), cardType, html: '', frontText: f.front.trim(), backText: f.back.trim() };
}
