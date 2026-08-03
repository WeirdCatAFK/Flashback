/**
 * ReviewStrip — one bar per review of a card, oldest on the left.
 *
 * The curve above it shows where the card stands *now*; this shows how it got
 * there. Bar height is the level the review left the card at, colour is how it
 * went — the same four review tokens the Trainer's buttons use, so a red bar here
 * and an "Again" there are the same colour by construction.
 *
 * Rows a vault rebuild synthesised (no outcome — they exist only to carry an ease
 * factor) are not reviews and are counted out into a footnote rather than drawn.
 */

const RATING_TOKEN = {
  1: '--color-review-again',
  2: '--color-review-hard',
  3: '--color-review-good',
  4: '--color-review-easy',
};

const RATING_LABEL = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };

const localDay = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
};

export default function ReviewStrip({ history = [] }) {
  const real = history.filter((h) => !h.synthetic);
  const synthetic = history.length - real.length;

  if (real.length === 0) {
    return (
      <p className="cd-empty">
        Never reviewed.
        {synthetic > 0 && ' Its only log entry was restored by a vault rebuild.'}
      </p>
    );
  }

  const maxLevel = Math.max(1, ...real.map((h) => h.level ?? 0));

  return (
    <div className="cd-strip-wrap">
      <div className="cd-strip" role="img"
        aria-label={`${real.length} reviews, oldest first; bar height is the level each review left the card at`}>
        {real.map((h) => {
          const token = h.rating != null
            ? RATING_TOKEN[h.rating]
            : (h.outcome === 1 ? '--color-review-good' : '--color-review-again');
          const result = h.rating != null
            ? RATING_LABEL[h.rating]
            : (h.outcome === 1 ? 'Correct' : 'Missed');
          return (
            <div
              key={h.id}
              className="cd-strip-bar"
              style={{
                height: `${Math.max(10, ((h.level ?? 0) / maxLevel) * 100)}%`,
                background: `var(${token})`,
              }}
              title={`${localDay(h.at)} · ${h.algorithm ?? '—'} · ${result} · level ${h.level ?? 0}`}
            />
          );
        })}
      </div>
      {synthetic > 0 && (
        <p className="cd-note">
          {synthetic} {synthetic === 1 ? 'entry' : 'entries'} restored by a vault
          rebuild — not {synthetic === 1 ? 'a real review' : 'real reviews'}.
        </p>
      )}
    </div>
  );
}
