import { cardsByHighlight } from '../finderRows.js';

export const MARGIN_MIN_WIDTH = 760;

export const LIFT = 4;
export const GAP = 10;

export function marginItems(highlights, flashcards) {
  const byHl = cardsByHighlight(flashcards);
  return (highlights ?? []).map((h) => ({ id: h.id, color: h.color, cards: byHl.get(h.id) ?? [] }));
}

export function stackTops(entries) {
  const placed = entries.filter((e) => e.anchor != null).sort((a, b) => a.anchor - b.anchor);
  const tops = new Map();
  let bottom = -Infinity;
  for (const e of placed) {
    const top = Math.max(e.anchor - LIFT, bottom + GAP);
    tops.set(e.id, top);
    bottom = top + e.height;
  }
  return { tops, bottom: Number.isFinite(bottom) ? bottom : 0 };
}

export const COLUMN_GAP = 32;
export const EDGE = 20;

export const marginLeft = (textRight, areaWidth, columnWidth) =>
  Math.max(0, Math.min(textRight + COLUMN_GAP, areaWidth - columnWidth - EDGE));

export const marginFits = (width) => width >= MARGIN_MIN_WIDTH;

export function marginFront(card) {
  const type = card.cardType ?? (card.isCustom ? 'custom' : 'basic');
  if (type === 'custom') return { kind: 'custom', text: card.name || '' };
  const text = card.vanillaData?.frontText || card.name || '';
  if (type === 'cloze') return { kind: 'cloze', parts: text.split(/(\{\{[^}]+\}\})/).filter(Boolean).map((p) => (/^\{\{[^}]+\}\}$/.test(p) ? { blank: p.slice(2, -2) } : { text: p })) };
  return { kind: 'text', text };
}
