const HL_VAR = { amber: '--color-hl-1', green: '--color-hl-2', blue: '--color-hl-3', pink: '--color-hl-4' };

export const hlColor = (name) => `var(${HL_VAR[name] ?? HL_VAR.amber})`;

function highlightIdOf(card) {
  const loc = card?.vanillaData?.location;
  return loc?.type === 'highlight' && loc.id ? loc.id : null;
}

export function cardFront(card, t) {
  const type = card.cardType ?? (card.isCustom ? 'custom' : 'basic');
  if (type === 'custom') return card.name || t('Custom HTML card');
  const text = card.vanillaData?.frontText || card.name || '';
  return String(text).replace(/\{\{([^}]+)\}\}/g, ' ___ ').replace(/\s+/g, ' ').trim();
}

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

export function cardMatches(card, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const vd = card.vanillaData ?? {};
  return has(vd.frontText, q) || has(vd.backText, q) || has(vd.answerText, q) || has(card.name, q);
}

export function highlightMatches(highlight, cards, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return has(highlight.text, q) || (cards ?? []).some((c) => cardMatches(c, query));
}

export function orderedCards(flashcards, highlights) {
  const order = new Map((highlights ?? []).map((h, i) => [h.id, i]));
  const byId = new Map((highlights ?? []).map((h) => [h.id, h]));
  return (flashcards ?? [])
    .map((card, i) => ({ card, i, highlight: byId.get(highlightIdOf(card)) ?? null }))
    .sort((a, b) => (a.highlight ? order.get(a.highlight.id) : Infinity) - (b.highlight ? order.get(b.highlight.id) : Infinity) || a.i - b.i)
    .map(({ card, highlight }) => ({ card, highlight }));
}

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
