export default function IconFileAudio({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M7 1H2.5A1.5 1.5 0 0 0 1 2.5v11A1.5 1.5 0 0 0 2.5 15h7A1.5 1.5 0 0 0 11 13.5V5L7 1z"
        fill="#C084FC" opacity="0.12" stroke="#C084FC" strokeWidth="0.8"/>
      <path d="M7 1v4h4" stroke="#C084FC" strokeWidth="0.8" fill="none" opacity="0.7"/>
      {/* Waveform — symmetric bell, 5 bars centered at y=10.5 */}
      <line x1="2.5" y1="9.5"  x2="2.5" y2="11.5" stroke="#C084FC" strokeWidth="1.1" strokeLinecap="round" opacity="0.9"/>
      <line x1="4"   y1="8.5"  x2="4"   y2="12.5" stroke="#C084FC" strokeWidth="1.1" strokeLinecap="round" opacity="0.9"/>
      <line x1="5.5" y1="7.5"  x2="5.5" y2="13.5" stroke="#C084FC" strokeWidth="1.1" strokeLinecap="round" opacity="0.9"/>
      <line x1="7"   y1="8.5"  x2="7"   y2="12.5" stroke="#C084FC" strokeWidth="1.1" strokeLinecap="round" opacity="0.9"/>
      <line x1="8.5" y1="9.5"  x2="8.5" y2="11.5" stroke="#C084FC" strokeWidth="1.1" strokeLinecap="round" opacity="0.9"/>
    </svg>
  );
}
