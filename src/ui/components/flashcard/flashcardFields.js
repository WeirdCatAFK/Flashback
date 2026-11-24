export function cardTypes(t) {
  return [
    { key: 'basic',       label: t('Basic'),       desc: t('Front and back') },
    { key: 'reversible',  label: t('Reversible'),  desc: t('Either direction') },
    { key: 'cloze',       label: t('Cloze'),       desc: t('{{fill in blanks}}') },
    { key: 'type_answer', label: t('Type Answer'), desc: t('Typed input check') },
    { key: 'custom',      label: t('Custom HTML'), desc: t('Full HTML template') },
  ];
}

export function cardTypeLabel(key, t) {
  return cardTypes(t).find(c => c.key === key)?.label ?? String(key).replace('_', ' ');
}

export function cardTypeShortLabel(key, t) {
  switch (key) {
    case 'basic':       return t('Basic');
    case 'reversible':  return t('Reversible');
    case 'cloze':       return t('Cloze');
    case 'type_answer': return t('Type|card type badge');
    case 'custom':      return t('Custom');
    default:            return String(key);
  }
}

export function hasClozeBlank(text) {
  return /\{\{[^}]+\}\}/.test(text ?? '');
}

export function typeAnswerParts(vd = {}) {
  const hasAnswer = (vd?.answerText ?? '') !== '';
  return {
    answer: hasAnswer ? vd.answerText : (vd?.backText ?? ''),
    notes: hasAnswer ? (vd?.backText ?? '') : '',
  };
}

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

export function isCardBlank(cardType, f) {
  switch (cardType) {
    case 'basic':
    case 'reversible':  return !f.front.trim() && !f.back.trim();
    case 'cloze':       return !f.clozeText.trim();
    case 'type_answer': return !f.question.trim() && !f.expectedAnswer.trim() && !(f.notes ?? '').trim();
    case 'custom':      return !f.customHtml.trim();
    default:            return true;
  }
}

export function exampleFields(cardType, t) {
  const empty = { front: '', back: '', clozeText: '', question: '', expectedAnswer: '', notes: '', customHtml: '' };
  switch (cardType) {
    case 'reversible':
      return { ...empty, front: t('mitochondrion'), back: t('The organelle that makes most of a cell’s ATP') };
    case 'cloze':
      return { ...empty, clozeText: t('The {{mitochondria}} is the powerhouse of the {{cell}}.') };
    case 'type_answer':
      return { ...empty, question: t('Chemical symbol for tungsten'), expectedAnswer: 'W', notes: t('From its other name, wolfram.') };
    case 'custom':
      return { ...empty, customHtml: `<div style="font:18px/1.4 sans-serif;padding:24px;text-align:center">${t('Name the <b>largest</b> planet.')}</div>` };
    default:
      return { ...empty, front: t('What is the capital of France?'), back: t('Paris') };
  }
}

export function previewCardFor(cardType, f, media = {}) {
  if (cardType === 'custom')      return { cardType: 'custom', customData: { html: f.customHtml } };
  if (cardType === 'cloze')       return { cardType: 'cloze',       vanillaData: { frontText: f.clozeText, backText: f.clozeText,      media } };
  if (cardType === 'type_answer') return { cardType: 'type_answer', vanillaData: { frontText: f.question,  backText: f.notes ?? '', answerText: f.expectedAnswer, media } };
  return { cardType, direction: 'forward', vanillaData: { frontText: f.front, backText: f.back, media } };
}

export function deriveCardCore(cardType, f) {
  if (cardType === 'custom') {
    return { name: 'Custom card', cardType: 'custom', html: f.customHtml, frontText: '', backText: '' };
  }
  if (cardType === 'cloze') {
    const text = f.clozeText.trim();
    return { name: f.clozeText.replace(/\{\{([^}]+)\}\}/g, '$1').slice(0, 80), cardType: 'cloze', html: '', frontText: text, backText: text };
  }
  if (cardType === 'type_answer') {
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

