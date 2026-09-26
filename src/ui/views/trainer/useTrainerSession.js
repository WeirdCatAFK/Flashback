/**
 * Everything a study session is, minus the markup: the scope controls, the due
 * queue for that scope, the batch taken from it, the queue reducers applied to
 * grades and undos, the streak, the grade pop (whose interval arrives with the
 * server's reply), the flags collected along the way, and the undo shortcut.
 * Trainer.jsx renders what this returns.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { undoReview } from '../../api/srs';
import { generateSummary as generateDiarySummary } from '../../api/diary';
import { readFile } from '../../api/documents';
import { getPref } from '../../prefs.js';
import { useT } from '../../translations/index';
import { getUiZoom } from '../../utils/uiZoom';
import useTrainerScope from './useTrainerScope';
import useDueCards from './useDueCards';
import useTrainerKeys from './useTrainerKeys';
import { startSession, applyResult, undoResult, sessionFigures } from './queue';
import { batchOf, batchTally, popFor } from './session';

const POP_MS = 1100;

/**
 * How long the stage stays empty after a grade, so the pop has its moment before
 * the next card comes in. The card has already flown out by then (Flashcard's
 * flyOut runs before the grade is recorded); the next one enters as the pop fades.
 */
const HOLD_MS = 600;

export default function useTrainerSession({ isActive, studySession, onOpenSource }) {
  const { t } = useT();
  const [session, setSession] = useState(() => startSession([]));
  const [batch, setBatch] = useState([]);
  const [streak, setStreak] = useState(0);
  const [holding, setHolding] = useState(false);
  const [turn, setTurn] = useState(0);
  const [pop, setPop] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [flagged, setFlagged] = useState([]);
  const [inspecting, setInspecting] = useState(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const arenaRef = useRef(null);
  const stageRef = useRef(null);
  const [popTop, setPopTop] = useState(null);

  const controls = useTrainerScope({ studySession, sessionDone: session.sessionDone });
  const { scope, version, readOnly, maxNew, batchSize } = controls;

  const [prevVersion, setPrevVersion] = useState(version);
  if (prevVersion !== version) {
    setPrevVersion(version);
    setSession(startSession([]));
    setBatch([]);
    setStreak(0);
  }

  const [prevIsActive, setPrevIsActive] = useState(isActive);
  if (prevIsActive !== isActive) {
    setPrevIsActive(isActive);
    if (isActive && session.queue.length === 0 && !session.sessionDone) setRefreshToken((n) => n + 1);
  }

  const { cards, result, loading, error, sessionId } = useDueCards({
    folder: scope.folder,
    document: scope.document,
    deck: scope.deck,
    tags: scope.tags,
    exclude: scope.exclude,
    readOnly,
    maxNew,
    refreshToken,
  });

  const begin = (from) => {
    const next = batchOf(from, batchSize);
    setBatch(next);
    setSession(startSession(next));
    setTurn((n) => n + 1);
    setPop(null);
  };

  const [prevCards, setPrevCards] = useState(cards);
  if (prevCards !== cards) {
    setPrevCards(cards);
    if (session.queue.length === 0 && !session.sessionDone) begin(cards);
  }

  const [prevBatchSize, setPrevBatchSize] = useState(batchSize);
  if (prevBatchSize !== batchSize) {
    setPrevBatchSize(batchSize);
    if (!session.sessionDone) {
      setSession(startSession([]));
      setBatch([]);
      setRefreshToken((n) => n + 1);
    }
  }

  const popId = pop?.id ?? null;

  /**
   * The day's diary summary is recorded when a session ends — but only once the
   * session's last review has been saved: the grade advances the queue before its
   * request lands, and a summary derived a moment too early would miss that card.
   */
  const pendingRef = useRef(0);
  const summaryDueRef = useRef(false);
  const summariseIfDue = () => {
    if (!summaryDueRef.current || pendingRef.current > 0) return;
    summaryDueRef.current = false;
    if (getPref('fb-diary-enabled') === '1') generateDiarySummary().catch(() => {});
  };
  const handleReplied = useCallback(() => {
    pendingRef.current = Math.max(0, pendingRef.current - 1);
    summariseIfDue();
  }, []);

  useEffect(() => {
    if (!popId) return undefined;
    const timer = setTimeout(() => setPop(null), POP_MS);
    return () => clearTimeout(timer);
  }, [popId]);

  useEffect(() => {
    if (!holding) return undefined;
    const timer = setTimeout(() => setHolding(false), HOLD_MS);
    return () => clearTimeout(timer);
  }, [holding, popId]);

  /** The pop sits over the middle of the card that was just graded. */
  const measurePopTop = () => {
    if (!stageRef.current || !arenaRef.current) return null;
    const a = arenaRef.current.getBoundingClientRect();
    const s = stageRef.current.getBoundingClientRect();
    return (s.top - a.top + s.height * 0.45) / getUiZoom();
  };

  const handleFlagged = useCallback((card, flags) => {
    setFlagged((prev) => prev.some((f) => f.hash === card.globalHash)
      ? prev
      : [...prev, { hash: card.globalHash, label: card.name || card.frontText || t('Untitled card'), flags }]);
  }, [t]);

  const startNewSession = () => {
    begin(cards);
    setFlagged([]);
  };

  const handleResult = ({ key, label, success, toLevel, easeFactor, hash }) => {
    const next = applyResult(session, { key, success, toLevel, easeFactor, total: batch.length });
    pendingRef.current += 1;
    if (next.sessionDone) summaryDueRef.current = true;
    setSession(next);
    setStreak((n) => (success ? n + 1 : 0));
    setPopTop(measurePopTop());
    setPop({ id: Date.now(), hash, ...popFor(key, label, null, t) });
    if (!next.sessionDone) setHolding(true);
    if (next.sessionDone) setRefreshToken((n) => n + 1);
    setTurn((n) => n + 1);
  };

  const handleInterval = useCallback((hash, key, label, interval) => {
    if (!interval) return;
    setPop((p) => (p && p.hash === hash ? { ...p, ...popFor(key, label, interval, t) } : p));
  }, [t]);

  const handleUndo = useCallback(async () => {
    const action = session.lastAction;
    if (!action) return;
    setSession(undoResult(session));
    setStreak(0);
    setPop(null);
    setHolding(false);
    setSaveError(null);
    setTurn((n) => n + 1);
    try {
      await undoReview(action.card.documentPath, action.card.globalHash, getPref('fb-srs-algorithm') ?? 'sm2');
    } catch (err) {
      console.error(err);
      setSaveError(err);
    }
  }, [session]);

  const currentCard = session.queue[0];

  const handleViewSource = useCallback(async () => {
    if (!currentCard?.documentPath) return;
    let highlightId = null;
    try {
      const data = await readFile(currentCard.documentPath);
      const match = data.metadata?.flashcards?.find((c) => c.globalHash === currentCard.globalHash);
      const loc = match?.vanillaData?.location;
      if (loc?.type === 'highlight') highlightId = loc.id;
    } catch { }
    onOpenSource?.(currentCard.documentPath, highlightId);
  }, [currentCard, onOpenSource]);

  useTrainerKeys(isActive, (hits, e) => {
    if (hits('trainer.undo')) {
      e.preventDefault();
      handleUndo();
    }
  });

  const { sessionDone, lastSession, stats, queue } = session;
  const displayStats = sessionDone && lastSession ? lastSession.stats : stats;
  const displayTotal = sessionDone && lastSession ? lastSession.total : batch.length;
  const figures = sessionFigures(displayStats, batch.length, queue.length);
  const tally = batchTally(displayStats, batch);

  return {
    controls,
    cards,
    result,
    loading,
    error,
    sessionId,
    session,
    currentCard,
    remaining: Math.max(0, queue.length - 1),
    empty: !loading && !error && cards.length === 0 && !sessionDone,
    displayStats,
    displayTotal,
    figures,
    tally,
    batch,
    streak,
    holding,
    turn,
    pop,
    popTop,
    arenaRef,
    stageRef,
    saveError,
    setSaveError,
    flagged,
    inspecting,
    setInspecting,
    refresh: () => setRefreshToken((n) => n + 1),
    startNewSession,
    handleResult,
    handleInterval,
    handleReplied,
    handleUndo,
    handleFlagged,
    handleViewSource,
  };
}
