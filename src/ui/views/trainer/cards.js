/**
 * The card shape the trainer renders, built from the API's flat row, plus the
 * formatting helpers the summary uses.
 */

import { toDate } from '../../translations/format.js';

/**
 * An API row as a trainer card. A reversible card draws its direction here, once,
 * so it holds for the whole session.
 */
export function mapApiCard(raw, isNew = false, random = Math.random) {
  const cardType = raw.card_type ?? 'basic';
  return {
    globalHash: raw.global_hash,
    name: raw.name,
    level: raw.level ?? 0,
    easeFactor: raw.ease_factor ?? 2.5,
    lastRecall: raw.last_recall,
    category: raw.category,
    categoryPriority: raw.category_priority ?? 0,
    documentPath: raw.document_path,
    isNew,
    cardType,
    direction: cardType === 'reversible' ? (random() < 0.5 ? 'forward' : 'reverse') : 'forward',
    vanillaData: {
      frontText: raw.frontText,
      backText: raw.backText,
      answerText: raw.answerText ?? null,
      media: {
        front_img: raw.front_img,
        back_img: raw.back_img,
        front_sound: raw.front_sound,
        back_sound: raw.back_sound,
      },
    },
    ...(raw.custom_html ? { customData: { html: raw.custom_html } } : {}),
  };
}

/**
 * When the next card comes back, in the active language. `maxUnit: 'day'` keeps a
 * 40-day interval as "in 40 days" rather than "next month": the number is the point.
 */
export function formatNextDue(sqliteStr, formatRelative, t) {
  if (!sqliteStr) return null;
  const next = toDate(sqliteStr);
  if (!next) return null;
  if (next.getTime() - Date.now() <= 0) return t('now');
  return formatRelative(next, { maxUnit: 'day' });
}

/**
 * The source a card cites: its document's name without the folder or extension
 * ("Memory (1885)"). Null for a card with no document — it lives in the default
 * deck and has nothing to quote.
 */
export function sourceTitle(documentPath) {
  if (!documentPath) return null;
  const leaf = documentPath.split(/[\\/]/).pop();
  const dot = leaf.lastIndexOf('.');
  return dot > 0 ? leaf.slice(0, dot) : leaf;
}

/** The card as the Flashcard component wants it: a missing side reads as its fallback. */
export function displayCardFor(card) {
  const isTypeAnswer = (card.cardType ?? 'basic') === 'type_answer';
  const media = card.vanillaData?.media;
  return {
    ...card,
    vanillaData: {
      ...card.vanillaData,
      frontText: card.vanillaData?.frontText || ((media?.front_img || media?.front_sound) ? '' : (card.name ?? card.globalHash)),
      backText: card.vanillaData?.backText || ((isTypeAnswer || media?.back_img || media?.back_sound) ? '' : '(no back text)'),
    },
  };
}
