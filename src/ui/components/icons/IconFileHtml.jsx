import { useId } from "react";
import Glyph from "./Glyph";

export default function IconFileHtml({ size = 15 }) {
  const id = `globe-${useId().replace(/[^\w-]/g, "")}`;
  return (
    <Glyph size={size} className="tree-glyph tree-glyph--file">
      <mask id={id}>
        <rect width="16" height="16" fill="white" />
        <ellipse cx="8" cy="8" rx="2.7" ry="6.5" fill="none" stroke="black" strokeWidth="1.1" />
        <path d="M1.5 8h13" stroke="black" strokeWidth="1.1" />
      </mask>
      <circle cx="8" cy="8" r="6.5" mask={`url(#${id})`} />
    </Glyph>
  );
}
