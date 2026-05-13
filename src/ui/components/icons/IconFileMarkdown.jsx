export default function IconFileMarkdown({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M7 1H2.5A1.5 1.5 0 0 0 1 2.5v11A1.5 1.5 0 0 0 2.5 15h7A1.5 1.5 0 0 0 11 13.5V5L7 1z"
        fill="currentColor" opacity="0.15" stroke="currentColor" strokeWidth="0.8"/>
      <path d="M7 1v4h4" stroke="currentColor" strokeWidth="0.8" fill="none" opacity="0.5"/>
      <rect x="2" y="7"   width="7.5" height="1.2" rx="0.4" fill="currentColor" opacity="0.55"/>
      <rect x="2" y="9.5" width="7.5" height="1.2" rx="0.4" fill="currentColor" opacity="0.55"/>
      <rect x="2" y="12"  width="5"   height="1.2" rx="0.4" fill="currentColor" opacity="0.55"/>
    </svg>
  );
}
