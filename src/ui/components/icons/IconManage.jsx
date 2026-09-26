/**
 * IconManage — the Metadata tab: a tag.
 */

import Glyph from "./Glyph";

export default function IconManage({ size = 24 }) {
  return (
    <Glyph size={size} grid={24}>
      <path fillRule="evenodd" d="M3 4.5A1.5 1.5 0 0 1 4.5 3h6.6l9.5 9.5a1.6 1.6 0 0 1 0 2.3l-5.8 5.8a1.6 1.6 0 0 1-2.3 0L3 11.1ZM5.8 7.6a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0 -3.6 0Z" />
    </Glyph>
  );
}
