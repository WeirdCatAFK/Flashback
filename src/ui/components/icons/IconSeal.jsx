export default function IconSeal({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
      aria-hidden="true">
      <line x1="2" y1="12" x2="6.5" y2="12" />
      <circle cx="12" cy="12" r="5.5" />
      <line x1="17.5" y1="12" x2="22" y2="12" />
    </svg>
  );
}
