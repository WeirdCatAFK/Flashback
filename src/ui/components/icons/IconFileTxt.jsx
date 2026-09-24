/**
 * IconFileTxt — the tree glyph for plain text: three lines of text, no page.
 */

import Glyph from "./Glyph";

export default function IconFileTxt({ size = 15 }) {
  return (
    <Glyph size={size} className="tree-glyph tree-glyph--file">
      <rect x="2.5" y="3" width="11" height="2" rx="1" />
      <rect x="2.5" y="7" width="11" height="2" rx="1" />
      <rect x="2.5" y="11" width="7" height="2" rx="1" />
    </Glyph>
  );
}
