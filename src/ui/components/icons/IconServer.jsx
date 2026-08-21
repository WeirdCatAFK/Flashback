export default function IconServer({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      {/* Two stacked rack units with status lamps — a machine other people also reach,
          which is the whole difference between this tab and the rest of the app. */}
      <rect x="3" y="4" width="18" height="7" rx="1.6" />
      <rect x="3" y="13" width="18" height="7" rx="1.6" />
      <circle cx="6.8" cy="7.5" r="0.9" />
      <circle cx="6.8" cy="16.5" r="0.9" />
      <path d="M10.5 7.5h7M10.5 16.5h7" />
    </svg>
  );
}
