/**
 * IconFolderOpen — the tree glyph for an open folder, its back in a lighter tone.
 */

import Glyph from "./Glyph";

export default function IconFolderOpen({ size = 15 }) {
  return (
    <Glyph size={size} className="tree-glyph tree-glyph--folder">
      <path d="M1.5 3.8a1.2 1.2 0 0 1 1.2-1.2h3.5l1.6 1.8h5.5a1.2 1.2 0 0 1 1.2 1.2v6.8H1.5Z" opacity="0.45" />
      <path d="M3.6 7.2a1 1 0 0 1 .95-.7h9.8a.6.6 0 0 1 .57.8l-1.9 5.3a1 1 0 0 1-.95.7H1.5Z" />
    </Glyph>
  );
}
