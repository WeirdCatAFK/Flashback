export default function IconConfig({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      <line x1="4" y1="6" x2="20" y2="6" />
      <circle cx="8" cy="6" r="2" style={{ fill: "var(--color-bg-sidebar)" }} />
      <line x1="4" y1="12" x2="20" y2="12" />
      <circle cx="16" cy="12" r="2" style={{ fill: "var(--color-bg-sidebar)" }} />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="10" cy="18" r="2" style={{ fill: "var(--color-bg-sidebar)" }} />
    </svg>
  );
}
