export default function IconFileImage({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M7 1H2.5A1.5 1.5 0 0 0 1 2.5v11A1.5 1.5 0 0 0 2.5 15h7A1.5 1.5 0 0 0 11 13.5V5L7 1z"
        fill="#38BDF8" opacity="0.12" stroke="#38BDF8" strokeWidth="0.8"/>
      <path d="M7 1v4h4" stroke="#38BDF8" strokeWidth="0.8" fill="none" opacity="0.7"/>
      {/* Sun */}
      <circle cx="3.5" cy="8" r="1.1" fill="#38BDF8" opacity="0.85"/>
      {/* Mountain */}
      <polyline points="1.5,13.5 6,8.5 10.5,13.5" stroke="#38BDF8" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" opacity="0.9"/>
    </svg>
  );
}
