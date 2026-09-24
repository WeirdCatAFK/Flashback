/**
 * IconFileMarkdown — the tree glyph for a Markdown note: a page with its corner turned.
 */

import Glyph from "./Glyph";

export default function IconFileMarkdown({ size = 15 }) {
  return (
    <Glyph size={size} className="tree-glyph tree-glyph--file">
      <path d="M4.3 1.5H9v3a1 1 0 0 0 1 1h3v8a1 1 0 0 1-1 1H4.3a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1Z" />
      <path d="M10 1.8 12.7 4.5h-2.1a.6.6 0 0 1-.6-.6Z" />
    </Glyph>
  );
}
