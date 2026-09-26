/**
 * IconConfig — the Config button: three sliders.
 */

import Glyph from "./Glyph";

export default function IconConfig({ size = 24 }) {
  return (
    <Glyph size={size} grid={24}>
      <path d="M4 6h16M4 12h16M4 18h16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.45" />
      <path d="M5.4 6a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0 -5.2 0ZM13.4 12a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0 -5.2 0ZM7.4 18a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0 -5.2 0Z" />
    </Glyph>
  );
}
