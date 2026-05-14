export default function IconFileHtml({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M7 1H2.5A1.5 1.5 0 0 0 1 2.5v11A1.5 1.5 0 0 0 2.5 15h7A1.5 1.5 0 0 0 11 13.5V5L7 1z"
        fill="#60A5FA" opacity="0.12" stroke="#60A5FA" strokeWidth="0.8"/>
      <path d="M7 1v4h4" stroke="#60A5FA" strokeWidth="0.8" fill="none" opacity="0.7"/>
      <polyline points="4,7.5 2.5,10 4,12.5"   stroke="#60A5FA" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" opacity="0.9"/>
      <polyline points="8,7.5 9.5,10 8,12.5"   stroke="#60A5FA" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" opacity="0.9"/>
      <line x1="6.8" y1="7.5" x2="5.2" y2="12.5" stroke="#60A5FA" strokeWidth="1" strokeLinecap="round" opacity="0.7"/>
    </svg>
  );
}
