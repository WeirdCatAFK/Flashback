import { sm2Interval, leitnerInterval } from '../../../shared/intervals.js';

export const GRADES = {
  again: { outcome: 0, ease: -0.20, level: () => 0,      kind: 'reject', action: 'trainer.gradeAgain' },
  good:  { outcome: 1, ease:  0.00, level: (l) => l + 1, kind: 'accept', action: 'trainer.gradeGood' },
  easy:  { outcome: 1, ease:  0.15, level: (l) => l + 2, kind: 'accept', action: 'trainer.gradeEasy' },
};

export const FSRS_GRADES = {
  again: { rating: 1, kind: 'reject', action: 'trainer.gradeAgain' },
  hard:  { rating: 2, kind: 'reject', action: 'trainer.gradeHard' },
  good:  { rating: 3, kind: 'accept', action: 'trainer.gradeGood' },
  easy:  { rating: 4, kind: 'accept', action: 'trainer.gradeEasy' },
};

const EASE_MIN = 1.3;
const EASE_MAX = 3.0;

const gradeLabels = (t) => ({
  again: t('Again'), hard: t('Hard'), good: t('Good'), easy: t('Easy'),
});

export function gradesFor(algorithm, t) {
  const base = algorithm === 'fsrs' ? FSRS_GRADES : GRADES;
  const labels = gradeLabels(t);
  return Object.fromEntries(
    Object.entries(base).map(([id, grade]) => [id, { ...grade, label: labels[id] }])
  );
}

export function gradeSm2(card, key, algorithm) {
  const g = GRADES[key];
  const easeFactor = Math.min(EASE_MAX, Math.max(EASE_MIN, (card.easeFactor ?? 2.5) + g.ease));
  const rawLevel = g.level(card.level ?? 0);
  const toLevel = (key === 'again' && algorithm !== 'sm2') ? Math.max(1, rawLevel) : rawLevel;
  return { outcome: g.outcome, success: g.outcome === 1, toLevel, easeFactor };
}

export function previewGap(card, key, algorithm) {
  if (algorithm === 'fsrs') return card.fsrsPreview?.[key] ?? null;
  if (!GRADES[key]) return null;
  const { toLevel, easeFactor } = gradeSm2(card, key, algorithm);
  return algorithm === 'sm2' ? sm2Interval(toLevel, easeFactor) : leitnerInterval(toLevel);
}

export function isTypedCorrect(typed, answer) {
  return typed != null && typed.trim().toLowerCase() === (answer ?? '').trim().toLowerCase();
}
