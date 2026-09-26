/**
 * IconFilePdf — the tree glyph for a PDF: printed pages, one behind the other.
 */

import Glyph from "./Glyph";

export default function IconFilePdf({ size = 15 }) {
  return (
    <Glyph size={size} className="tree-glyph tree-glyph--file">
      <rect x="5.5" y="1.5" width="8.5" height="10.5" rx="1" opacity="0.45" />
      <rect x="2" y="4" width="8.5" height="10.5" rx="1" />
    </Glyph>
  );
}
