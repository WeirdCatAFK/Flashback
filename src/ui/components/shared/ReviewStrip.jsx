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

import { useT } from '../../translations';

const RATING_TOKEN = {
  1: '--color-review-again',
  2: '--color-review-hard',
  3: '--color-review-good',
  4: '--color-review-easy',
};

// Labels are built per render rather than frozen in a module constant, so a
// language switch reaches them. Every key stays a literal for the extractor.
function ratingLabels(t) {
  return { 1: t('Again'), 2: t('Hard'), 3: t('Good'), 4: t('Easy') };
}

export default function ReviewStrip({ history = [] }) {
  const { t, tp, formatDate } = useT();
  const real = history.filter((h) => !h.synthetic);
  const synthetic = history.length - real.length;
  const RATING_LABEL = ratingLabels(t);

  if (real.length === 0) {
    return (
      <p className="cd-empty">
        {t('Never reviewed.')}
        {synthetic > 0 && ` ${t('Its only log entry was restored by a vault rebuild.')}`}
      </p>
    );
  }

  const maxLevel = Math.max(1, ...real.map((h) => h.level ?? 0));

  return (
    <div className="cd-strip-wrap">
      <div className="cd-strip" role="img"
        aria-label={tp(
          '{n} review, oldest first; bar height is the level each review left the card at',
          '{n} reviews, oldest first; bar height is the level each review left the card at',
          real.length
        )}>
        {real.map((h) => {
          const token = h.rating != null
            ? RATING_TOKEN[h.rating]
            : (h.outcome === 1 ? '--color-review-good' : '--color-review-again');
          const result = h.rating != null
            ? RATING_LABEL[h.rating]
            : (h.outcome === 1 ? t('Correct') : t('Missed'));
          return (
            <div
              key={h.id}
              className="cd-strip-bar"
              style={{
                height: `${Math.max(10, ((h.level ?? 0) / maxLevel) * 100)}%`,
                background: `var(${token})`,
              }}
              title={`${formatDate(h.at) || h.at} · ${h.algorithm ?? '—'} · ${result} · ${t('level {n}', { n: h.level ?? 0 })}`}
            />
          );
        })}
      </div>
      {synthetic > 0 && (
        <p className="cd-note">
          {tp(
            '{n} entry restored by a vault rebuild — not a real review.',
            '{n} entries restored by a vault rebuild — not real reviews.',
            synthetic
          )}
        </p>
      )}
    </div>
  );
}
