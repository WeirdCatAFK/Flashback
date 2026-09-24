/**
 * IconFileEpub — the tree glyph for an EPUB: a closed book above its page edge.
 */

import Glyph from "./Glyph";

export default function IconFileEpub({ size = 15 }) {
  return (
    <Glyph size={size} className="tree-glyph tree-glyph--file">
      <rect x="2.8" y="1.5" width="10.7" height="10" rx="1.2" />
      <path d="M4.1 12.6h9.4v1.9H4.1a.95.95 0 0 1 0-1.9Z" />
    </Glyph>
  );
}
