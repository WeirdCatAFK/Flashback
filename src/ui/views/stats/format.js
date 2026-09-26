/** Number formatting the Stats view shares between its panels. */

export const pctText = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`);
export const oneDp = (n) => (n == null ? '—' : n.toFixed(1));

/** Scheduler names are proper nouns and stay as-is in every language. */
export const ALGO_LABEL = { leitner: 'Leitner', sm2: 'SM-2', fsrs: 'FSRS' };
export const algoLabel = (a) => ALGO_LABEL[a] ?? a;
