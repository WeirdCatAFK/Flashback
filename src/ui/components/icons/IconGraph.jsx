export default function IconGraph({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      <circle cx="12" cy="5" r="2" />
      <circle cx="5" cy="17" r="2" />
      <circle cx="19" cy="17" r="2" />
      <line x1="12" y1="7" x2="5" y2="15" />
      <line x1="12" y1="7" x2="19" y2="15" />
      <line x1="7" y1="17" x2="17" y2="17" />
    </svg>
  );
}
