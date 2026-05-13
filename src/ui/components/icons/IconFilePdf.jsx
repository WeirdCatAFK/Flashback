export default function IconFilePdf({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M7 1H2.5A1.5 1.5 0 0 0 1 2.5v11A1.5 1.5 0 0 0 2.5 15h7A1.5 1.5 0 0 0 11 13.5V5L7 1z"
        fill="#F87171" opacity="0.15" stroke="#F87171" strokeWidth="0.8"/>
      <path d="M7 1v4h4" stroke="#F87171" strokeWidth="0.8" fill="none" opacity="0.7"/>
      {/* Full-width band across the middle — the contour-level differentiator */}
      <rect x="1" y="7" width="10" height="3.5" fill="#F87171" opacity="0.65"/>
    </svg>
  );
}
