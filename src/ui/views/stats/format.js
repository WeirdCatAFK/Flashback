export const pctText = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`);
export const oneDp = (n) => (n == null ? '—' : n.toFixed(1));

export const ALGO_LABEL = { leitner: 'Leitner', sm2: 'SM-2', fsrs: 'FSRS' };
export const algoLabel = (a) => ALGO_LABEL[a] ?? a;
