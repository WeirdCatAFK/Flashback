export default function IconDocuments({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      <rect x="4" y="2" width="12" height="16" rx="1" />
      <line x1="7" y1="7" x2="13" y2="7" />
      <line x1="7" y1="10" x2="13" y2="10" />
      <line x1="7" y1="13" x2="10" y2="13" />
      <polyline points="12,2 12,7 17,7" />
      <path d="M12 2 L16 2 L20 6 L20 18 A1 1 0 0 1 19 19 L8 19" />
    </svg>
  );
}
