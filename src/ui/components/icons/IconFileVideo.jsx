export default function IconFileVideo({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M7 1H2.5A1.5 1.5 0 0 0 1 2.5v11A1.5 1.5 0 0 0 2.5 15h7A1.5 1.5 0 0 0 11 13.5V5L7 1z"
        fill="#FB923C" opacity="0.12" stroke="#FB923C" strokeWidth="0.8"/>
      <path d="M7 1v4h4" stroke="#FB923C" strokeWidth="0.8" fill="none" opacity="0.7"/>
      {/* Play triangle */}
      <polygon points="4,8 4,13 9.5,10.5" fill="#FB923C" opacity="0.85"/>
    </svg>
  );
}
