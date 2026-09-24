/**
 * IconDecks — the Decks tab: a card box with a thumb notch, a card standing in it.
 */

import Glyph from "./Glyph";

export default function IconDecks({ size = 24 }) {
  return (
    <Glyph size={size} grid={24}>
      <rect x="5.5" y="4" width="13" height="8" rx="1.4" opacity="0.45" />
      <path d="M4.5 10H9.2a2.8 2.8 0 0 0 5.6 0h4.7a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-7A1.5 1.5 0 0 1 4.5 10Z" />
    </Glyph>
  );
}
