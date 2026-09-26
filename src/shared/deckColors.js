/**
 * The colours a deck's box can be: bookcloth tones, each a `--color-box-<id>` theme
 * token. The default deck is always kraft (`--color-kraft`) and never takes one of
 * these, so the box that holds cards made without a document reads as the plain
 * cardboard one.
 *
 * A deck's colour is an optional `color` field in its `_decks/<uuid>.json`. A deck
 * written before the field existed has none and shows the colour its hash picks, so
 * an older vault's decks come out varied rather than all one tone — and the same
 * deck shows the same colour on every machine, without a write.
 *
 * Shared because the API validates against it and the renderer draws from it. No
 * imports, so both load it as is.
 */

export const DECK_COLORS = ['slate', 'sage', 'ochre', 'brick', 'plum', 'ink'];

export const isDeckColor = (c) => DECK_COLORS.includes(c);

/** The colour a deck shows: kraft for the default deck, else its own, else its hash's. */
export function deckColor({ is_system: isSystem, color, global_hash: hash } = {}) {
  if (isSystem) return 'kraft';
  if (isDeckColor(color)) return color;
  let h = 0;
  for (const ch of String(hash ?? '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return DECK_COLORS[h % DECK_COLORS.length];
}

/** The colour for a new deck: the first no deck uses yet, else the next in turn. */
export function nextDeckColor(used) {
  return DECK_COLORS.find((c) => !used.includes(c)) ?? DECK_COLORS[used.length % DECK_COLORS.length];
}
