/**
 * IconDocuments — the Documents tab: a page with its corner turned.
 */

import Glyph from "./Glyph";

export default function IconDocuments({ size = 24 }) {
  return (
    <Glyph size={size} grid={24}>
      <path d="M6.5 2.5H13v5a1.5 1.5 0 0 0 1.5 1.5H19v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V4a1.5 1.5 0 0 1 1.5-1.5Z" />
      <path d="M14.5 2.9 18.6 7h-3.3a.8.8 0 0 1-.8-.8Z" />
    </Glyph>
  );
}
