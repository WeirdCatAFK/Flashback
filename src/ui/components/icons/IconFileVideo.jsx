/**
 * IconFileVideo — the tree glyph for a video or YouTube link: a screen with a play mark.
 */

import Glyph from "./Glyph";

export default function IconFileVideo({ size = 15 }) {
  return (
    <Glyph size={size} className="tree-glyph tree-glyph--file">
      <path fillRule="evenodd" d="M4 3h8a2.5 2.5 0 0 1 2.5 2.5v5A2.5 2.5 0 0 1 12 13H4a2.5 2.5 0 0 1-2.5-2.5v-5A2.5 2.5 0 0 1 4 3Zm2.6 2.6v4.8L10.8 8Z" />
    </Glyph>
  );
}
