/**
 * IconFlashcards — the Flashcards tab: two cards, the one behind in a lighter tone.
 */

import Glyph from "./Glyph";

export default function IconFlashcards({ size = 24 }) {
  return (
    <Glyph size={size} grid={24}>
      <rect x="6" y="4" width="15" height="10.5" rx="1.8" opacity="0.45" />
      <rect x="3" y="8.5" width="15" height="10.5" rx="1.8" />
    </Glyph>
  );
}
