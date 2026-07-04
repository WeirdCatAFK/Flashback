/**
 * Shared relative-time formatting. The same "just now / Nm / Nh / Nd / date" ladder
 * was reimplemented in Flashcards, Seal, and elsewhere — this is the single source.
 *
 *   relativeFromMs(Date.now() - 5000)      // "just now"
 *   relativeFromIso('2026-07-01T…')        // "2d ago"
 */

export function relativeFromMs(ms) {
  if (ms == null || Number.isNaN(ms)) return '';
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 2) return 'just now';
  if (hrs < 1) return `${mins}m ago`;
  if (days < 1) return `${hrs}h ago`;
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function relativeFromIso(iso) {
  if (!iso) return '';
  return relativeFromMs(new Date(iso).getTime());
}
