/**
 * What the document finder lists, as plain functions over the sidecar: each card's
 * front on one line, which highlight it hangs off, the cards on each highlight,
 * and whether a row matches the search. No React; labels take `t`.
 *
 * A card's highlight is `vanillaData.location` of type `highlight`; a card whose
 * highlight has been removed keeps the id, so "has a highlight" means the id is
 * still in the sidecar's `highlights[]`.
 */

/** The CSS colour token for a highlight's stored colour name. */
export const HL_VAR = { amber: '--color-hl-1', green: '--color-hl-2', blue: '--color-hl-3', pink: '--color-hl-4' };

/** A highlight colour name as the CSS value to paint it with. */
export const hlColor = (name) => `var(${HL_VAR[name] ?? HL_VAR.amber})`;

/** The highlight id a card hangs off, or null. */
export function highlightIdOf(card) {
  const loc = card?.vanillaData?.location;
  return loc?.type === 'highlight' && loc.id ? loc.id : null;
}

/** A card's front as one plain line: cloze blanks read as ___, a custom card by name. */
export function cardFront(card, t) {
  const type = card.cardType ?? (card.isCustom ? 'custom' : 'basic');
  if (type === 'custom') return card.name || t('Custom HTML card');
  const text = card.vanillaData?.frontText || card.name || '';
  return String(text).replace(/\{\{([^}]+)\}\}/g, ' ___ ').replace(/\s+/g, ' ').trim();
}

/** Cards grouped by the highlight they hang off: `Map<highlightId, card[]>`. */
export function cardsByHighlight(flashcards) {
  const map = new Map();
  for (const card of flashcards ?? []) {
    const id = highlightIdOf(card);
    if (!id) continue;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(card);
  }
  return map;
}

const has = (hay, q) => String(hay ?? '').toLowerCase().includes(q);

/** Whether a card matches a search: its front, back, notes or answer. */
export function cardMatches(card, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const vd = card.vanillaData ?? {};
  return has(vd.frontText, q) || has(vd.backText, q) || has(vd.answerText, q) || has(card.name, q);
}

/** Whether a highlight matches a search: its passage, or any of its cards. */
export function highlightMatches(highlight, cards, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return has(highlight.text, q) || (cards ?? []).some((c) => cardMatches(c, query));
}

/**
 * The finder's cards in the order their highlights were made, cards on no
 * highlight (or on one since removed) last, each with its highlight or null.
 */
export function orderedCards(flashcards, highlights) {
  const order = new Map((highlights ?? []).map((h, i) => [h.id, i]));
  const byId = new Map((highlights ?? []).map((h) => [h.id, h]));
  return (flashcards ?? [])
    .map((card, i) => ({ card, i, highlight: byId.get(highlightIdOf(card)) ?? null }))
    .sort((a, b) => (a.highlight ? order.get(a.highlight.id) : Infinity) - (b.highlight ? order.get(b.highlight.id) : Infinity) || a.i - b.i)
    .map(({ card, highlight }) => ({ card, highlight }));
}

/** A CFI's path as numbers, so `/10` sorts after `/8`; the range part is ignored. */
function cfiSteps(cfi) {
  const path = String(cfi).replace(/^epubcfi\(/, '').split(',')[0];
  return (path.match(/\d+/g) ?? []).map(Number);
}

function compareSteps(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

/**
 * The document's highlights in reading order, not the order they were made: by
 * page and height on it (PDF), by character offset (text, clips), by CFI (EPUB),
 * or by where each mark sits on the page (`domIds`, Markdown's inline marks).
 * One the order cannot place keeps its registry position after the rest.
 */
export function readingOrder(highlights, domIds = []) {
  const dom = new Map(domIds.map((id, i) => [id, i]));
  const key = (h, i) => {
    if (typeof h.page === 'number') return [0, h.page, h.bbox?.y ?? 0];
    if (typeof h.start === 'number') return [0, h.start];
    if (h.cfi) return [0, ...cfiSteps(h.cfi)];
    if (dom.has(h.id)) return [0, dom.get(h.id)];
    return [1, i];
  };
  return (highlights ?? [])
    .map((h, i) => ({ h, k: key(h, i) }))
    .sort((a, b) => compareSteps(a.k, b.k))
    .map(({ h }) => h);
}
