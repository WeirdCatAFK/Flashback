/**
 * IconStats — the Statistics tab: three rising bars.
 */

import Glyph from "./Glyph";

export default function IconStats({ size = 24 }) {
  return (
    <Glyph size={size} grid={24}>
      <rect x="4" y="13" width="4.2" height="7.5" rx="1.2" />
      <rect x="9.9" y="8.5" width="4.2" height="12" rx="1.2" />
      <rect x="15.8" y="4" width="4.2" height="16.5" rx="1.2" />
    </Glyph>
  );
}
