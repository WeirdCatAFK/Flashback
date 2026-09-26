/**
 * IconTrainer — the Trainer tab: a play mark.
 */

import Glyph from "./Glyph";

export default function IconTrainer({ size = 24 }) {
  return (
    <Glyph size={size} grid={24}>
      <path d="M7 5.1v13.8a1.3 1.3 0 0 0 2 1.1l10.6-6.9a1.3 1.3 0 0 0 0-2.2L9 4a1.3 1.3 0 0 0-2 1.1Z" />
    </Glyph>
  );
}
