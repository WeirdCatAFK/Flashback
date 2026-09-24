/**
 * IconDiary — the Diary tab: an open book.
 */

import Glyph from "./Glyph";

export default function IconDiary({ size = 24 }) {
  return (
    <Glyph size={size} grid={24}>
      <path d="M2.5 6.2c3.2-1.3 6.3-1 9 .9V20c-2.7-1.6-5.8-1.8-9-.7Z" />
      <path d="M21.5 6.2c-3.2-1.3-6.3-1-9 .9V20c2.7-1.6 5.8-1.8 9-.7Z" />
    </Glyph>
  );
}
