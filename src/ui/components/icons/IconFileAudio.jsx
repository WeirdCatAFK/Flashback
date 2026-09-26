/**
 * IconFileAudio — the tree glyph for audio: a pair of notes.
 */

import Glyph from "./Glyph";

export default function IconFileAudio({ size = 15 }) {
  return (
    <Glyph size={size} className="tree-glyph tree-glyph--file">
      <path d="M5.6 12.2V3.8l8-1.8v8.6h-1.4V4.2L7 5.4v6.8Z" />
      <path d="M2.4000000000000004 12.3a2 1.6 0 1 0 4 0a2 1.6 0 1 0 -4 0ZM9.8 10.7a2 1.6 0 1 0 4 0a2 1.6 0 1 0 -4 0Z" />
    </Glyph>
  );
}
