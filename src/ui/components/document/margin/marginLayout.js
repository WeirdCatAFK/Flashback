/**
 * The margin's arithmetic, as plain functions: which highlights get an item and
 * which cards go in it, where each item sits so it stays level with its passage
 * without overlapping the one above, and whether the column has room at all.
 * No React, no DOM.
 */

import { cardsByHighlight } from '../finderRows.js';

/** The narrowest document area, in px, that keeps a margin column beside the text. */
export const MARGIN_MIN_WIDTH = 760;

/** How far above its passage's first line an item starts, and the least space between two. */
export const LIFT = 4;
export const GAP = 10;

/**
 * One item per highlight on the page, in the order given: its colour and the cards
 * that hang off it — a tick for none, a card for one, a box for several.
 */
export function marginItems(highlights, flashcards) {
  const byHl = cardsByHighlight(flashcards);
  return (highlights ?? []).map((h) => ({ id: h.id, color: h.color, cards: byHl.get(h.id) ?? [] }));
}

/**
 * Where each item's top goes: level with its passage (`anchor`, less LIFT), pushed
 * down only as far as the item above needs. Items without an anchor on the page
 * (a passage not rendered, a highlight since removed) are left out.
 * @param {Array<{ id: string, anchor: number|null, height: number }>} entries
 * @returns {Map<string, number>} top per id, and `bottom`, where the last one ends
 */
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

/** Space between the end of the text and the cards, and between the cards and the window's edge. */
export const COLUMN_GAP = 32;
export const EDGE = 20;

/**
 * Where the margin column starts: just past the text's right edge (`textRight`),
 * but never so far that it runs off the document area.
 */
export const marginLeft = (textRight, areaWidth, columnWidth) =>
  Math.max(0, Math.min(textRight + COLUMN_GAP, areaWidth - columnWidth - EDGE));

/** Whether a document area this wide keeps a margin column. */
export const marginFits = (width) => width >= MARGIN_MIN_WIDTH;

/** A card's front for the margin: cloze blanks as a gap to fill, the rest as written. */
export function marginFront(card) {
  const type = card.cardType ?? (card.isCustom ? 'custom' : 'basic');
  if (type === 'custom') return { kind: 'custom', text: card.name || '' };
  const text = card.vanillaData?.frontText || card.name || '';
  if (type === 'cloze') return { kind: 'cloze', parts: text.split(/(\{\{[^}]+\}\})/).filter(Boolean).map((p) => (/^\{\{[^}]+\}\}$/.test(p) ? { blank: p.slice(2, -2) } : { text: p })) };
  return { kind: 'text', text };
}
