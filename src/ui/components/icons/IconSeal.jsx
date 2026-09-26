/**
 * IconSeal — the Seal tab: a rubber stamp over its impression.
 */

import Glyph from "./Glyph";

export default function IconSeal({ size = 24 }) {
  return (
    <Glyph size={size} grid={24}>
      <path d="M12 2.5a3.4 3.4 0 0 1 1.7 6.35V11h3.8a2 2 0 0 1 2 2v2.2a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V13a2 2 0 0 1 2-2h3.8V8.85A3.4 3.4 0 0 1 12 2.5Z" />
      <rect x="5" y="18.2" width="14" height="2.2" rx="1.1" opacity="0.45" />
    </Glyph>
  );
}
