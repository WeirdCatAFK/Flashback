/**
 * IconFolder — the tree glyph for a closed folder.
 */

import Glyph from "./Glyph";

export default function IconFolder({ size = 15 }) {
  return (
    <Glyph size={size} className="tree-glyph tree-glyph--folder">
      <path d="M1.5 3.8a1.2 1.2 0 0 1 1.2-1.2h3.5l1.6 1.8h5.5a1.2 1.2 0 0 1 1.2 1.2v6.8a1.2 1.2 0 0 1-1.2 1.2H2.7a1.2 1.2 0 0 1-1.2-1.2Z" />
    </Glyph>
  );
}
