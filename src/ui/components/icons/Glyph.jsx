export default function Glyph({ size = 15, grid = 16, className = "", children }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${grid} ${grid}`}
      fill="currentColor"
      aria-hidden="true"
      className={className || undefined}
      style={{ flexShrink: 0 }}
    >
      {children}
    </svg>
  );
}
