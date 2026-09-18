/**
 * Grade tables and the client-side scheduling maths for Leitner / SM-2.
 *
 * FSRS grades carry no maths: the server computes that schedule from a rating.
 * Labels are deliberately not in the tables — a module constant is evaluated once,
 * so a `t()` here would freeze the buttons in the load-time language; `gradesFor()`
 * resolves them at render time.
 */

/** Anki-style grades: `outcome` is the logged success flag, `kind` the card's exit flight. */
export const GRADES = {
  again: { outcome: 0, ease: -0.20, level: () => 0,      kind: 'reject', action: 'trainer.gradeAgain' },
  good:  { outcome: 1, ease:  0.00, level: (l) => l + 1, kind: 'accept', action: 'trainer.gradeGood' },
  easy:  { outcome: 1, ease:  0.15, level: (l) => l + 2, kind: 'accept', action: 'trainer.gradeEasy' },
};

/** FSRS's four-button rating (1..4); the schedule is computed server-side. */
export const FSRS_GRADES = {
  again: { rating: 1, kind: 'reject', action: 'trainer.gradeAgain' },
  hard:  { rating: 2, kind: 'reject', action: 'trainer.gradeHard' },
  good:  { rating: 3, kind: 'accept', action: 'trainer.gradeGood' },
  easy:  { rating: 4, kind: 'accept', action: 'trainer.gradeEasy' },
};

const EASE_MIN = 1.3;
const EASE_MAX = 3.0;

/** Grade labels in the active language; every key is a literal so the extractor sees it. */
export const gradeLabels = (t) => ({
  again: t('Again'), hard: t('Hard'), good: t('Good'), easy: t('Easy'),
});

/** The grade table for `algorithm` with its labels resolved. */
export function gradesFor(algorithm, t) {
  const base = algorithm === 'fsrs' ? FSRS_GRADES : GRADES;
  const labels = gradeLabels(t);
  return Object.fromEntries(
    Object.entries(base).map(([id, grade]) => [id, { ...grade, label: labels[id] }])
  );
}

/**
 * The schedule a Leitner / SM-2 grade produces for `card`.
 * @returns {{ outcome: 0|1, success: boolean, toLevel: number, easeFactor: number }}
 */
export function gradeSm2(card, key, algorithm) {
  const g = GRADES[key];
  const easeFactor = Math.min(EASE_MAX, Math.max(EASE_MIN, (card.easeFactor ?? 2.5) + g.ease));
  const rawLevel = g.level(card.level ?? 0);
  const toLevel = (key === 'again' && algorithm !== 'sm2') ? Math.max(1, rawLevel) : rawLevel;
  return { outcome: g.outcome, success: g.outcome === 1, toLevel, easeFactor };
}

/** Whether a typed answer matches, ignoring case and surrounding whitespace. */
export function isTypedCorrect(typed, answer) {
  return typed != null && typed.trim().toLowerCase() === (answer ?? '').trim().toLowerCase();
}
