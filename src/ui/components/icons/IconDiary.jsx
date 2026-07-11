export default function IconDiary({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      {/* A journal with a bookmark ribbon — the per-day study diary. */}
      <path d="M5 4a2 2 0 0 1 2-2h11a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a2 2 0 0 0-2 2z" />
      <path d="M5 18a2 2 0 0 0 2 2h11" />
      <path d="M14 2v7l-2.2-1.6L9.6 9V2" />
    </svg>
  );
}
