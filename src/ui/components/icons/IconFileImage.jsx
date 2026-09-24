/**
 * IconFileImage — the tree glyph for an image: a picture with a hill and a sun.
 */

import Glyph from "./Glyph";

export default function IconFileImage({ size = 15 }) {
  return (
    <Glyph size={size} className="tree-glyph tree-glyph--file">
      <path fillRule="evenodd" d="M3 2.5h10A1.5 1.5 0 0 1 14.5 4v8a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12V4A1.5 1.5 0 0 1 3 2.5ZM3.5 11.5 6.8 7.6l2.4 2.6 1.5-1.4 1.8 2.7ZM9.9 5.6a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0 -2.2 0Z" />
    </Glyph>
  );
}
