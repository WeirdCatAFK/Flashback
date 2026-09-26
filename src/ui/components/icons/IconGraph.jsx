/**
 * IconGraph — the Graph tab: three nodes and the links between them.
 */

import Glyph from "./Glyph";

export default function IconGraph({ size = 24 }) {
  return (
    <Glyph size={size} grid={24}>
      <path d="M12 5 5.5 17.5M12 5l6.5 12.5M5.5 17.5h13" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.45" />
      <path d="M9.2 5a2.8 2.8 0 1 0 5.6 0a2.8 2.8 0 1 0 -5.6 0ZM2.7 17.5a2.8 2.8 0 1 0 5.6 0a2.8 2.8 0 1 0 -5.6 0ZM15.7 17.5a2.8 2.8 0 1 0 5.6 0a2.8 2.8 0 1 0 -5.6 0Z" />
    </Glyph>
  );
}
