export default function IconStats({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      {/* A bar chart — vault-wide study analytics. */}
      <path d="M3 21h18" />
      <rect x="5" y="12" width="3.4" height="6" rx="1" />
      <rect x="10.3" y="8" width="3.4" height="10" rx="1" />
      <rect x="15.6" y="4" width="3.4" height="14" rx="1" />
    </svg>
  );
}
