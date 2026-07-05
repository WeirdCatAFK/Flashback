export default function IconManage({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      {/* A tag over a small catalog — vault-wide metadata (categories & tags). */}
      <path d="M3 5h7l9 9a1.6 1.6 0 0 1 0 2.3l-3.4 3.4a1.6 1.6 0 0 1-2.3 0L3 12z" />
      <circle cx="7" cy="9" r="1.4" />
    </svg>
  );
}
