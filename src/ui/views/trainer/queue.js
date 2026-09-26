/**
 * The session queue as pure reducers over `{ queue, stats, presented, lastAction,
 * sessionDone, lastSession }`, so the ordering rules are testable without React.
 *
 * The server sequences the queue; nothing here re-sorts it. A failed card is
 * re-inserted a few positions ahead, clamped to the end of its pedagogical tier
 * and never at index 0 — recognising the card you just saw is not recall.
 */

/**
 * Cards between a failed card and its retry. Mirrors the sequencer's MIN_LAG but is
 * a client-side queue mutation the server never sees, not a value the two must share.
 */
export const REQUEUE_LAG = 4;

export const EMPTY_STATS = Object.freeze({ again: 0, good: 0, easy: 0 });
export const START_PRESENTED = Object.freeze({ position: 0, prevCardHash: null });

/** A fresh session over `cards`. */
export function startSession(cards) {
  return {
    queue: cards,
    stats: { ...EMPTY_STATS },
    presented: { ...START_PRESENTED },
    lastAction: null,
    sessionDone: false,
    lastSession: null,
  };
}

/** Where a failed card of `priority` goes back into `rest`. */
export function insertIndexFor(rest, priority) {
  if (rest.length === 0) return 0;
  let tierEnd = rest.length;
  for (let i = 0; i < rest.length; i++) {
    if ((rest[i].categoryPriority ?? 0) > priority) { tierEnd = i; break; }
  }
  return Math.max(1, Math.min(REQUEUE_LAG, tierEnd));
}

/** `rest` with `failedCard` re-inserted for its retry. */
export function requeueFailed(rest, failedCard) {
  const at = insertIndexFor(rest, failedCard.categoryPriority ?? 0);
  return [...rest.slice(0, at), failedCard, ...rest.slice(at)];
}

/**
 * The state after grading the head of the queue.
 * @param {object} state
 * @param {{ key: string, success: boolean, toLevel: number, easeFactor: number, total: number, now?: string }} result
 */
export function applyResult(state, { key, success, toLevel, easeFactor, total, now = new Date().toISOString() }) {
  const { queue, stats, presented, lastSession } = state;
  const head = queue[0];
  const newStats = { ...stats, [key]: (stats[key] ?? 0) + 1 };
  const lastAction = { key, card: head, queue, stats, lastSession, presented };
  const nextPresented = { position: presented.position + 1, prevCardHash: head?.globalHash ?? null };
  const rest = queue.slice(1);

  if (success) {
    const done = rest.length === 0;
    return {
      queue: rest,
      stats: newStats,
      presented: nextPresented,
      lastAction,
      sessionDone: done,
      lastSession: done ? { total, stats: newStats } : lastSession,
    };
  }
  const failedCard = { ...head, level: toLevel, easeFactor, lastRecall: now, fsrsPreview: null };
  return {
    queue: requeueFailed(rest, failedCard),
    stats: newStats,
    presented: nextPresented,
    lastAction,
    sessionDone: false,
    lastSession,
  };
}

/** The state before the last grade, or `state` when there is nothing to undo. */
export function undoResult(state) {
  const action = state.lastAction;
  if (!action) return state;
  return {
    queue: action.queue,
    stats: action.stats,
    presented: action.presented ?? { ...START_PRESENTED },
    lastAction: null,
    sessionDone: false,
    lastSession: action.lastSession,
  };
}

/** The numbers the progress line and the summary show. */
export function sessionFigures(stats, total, queueLength) {
  const reviews = stats.again + stats.good + stats.easy;
  const correct = stats.good + stats.easy;
  const accuracy = reviews ? Math.round((correct / reviews) * 100) : 0;
  const passed = Math.max(0, total - queueLength);
  return { reviews, accuracy, passed, progress: total ? passed / total : 0 };
}
