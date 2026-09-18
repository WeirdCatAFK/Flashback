/**
 * Everything a study session is, minus the markup: the scope controls, the due
 * queue for that scope, the queue reducers applied to grades and undos, the
 * flags collected along the way, and the undo shortcut. Trainer.jsx renders what
 * this returns.
 */

import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { undoReview } from '../../api/srs';
import { generateSummary as generateDiarySummary } from '../../api/diary';
import { readFile } from '../../api/documents';
import { getPref } from '../../prefs.js';
import { useT } from '../../translations/index';
import useTrainerScope from './useTrainerScope';
import useDueCards from './useDueCards';
import useTrainerKeys from './useTrainerKeys';
import { startSession, applyResult, undoResult, sessionFigures } from './queue';

const POP_MS = 1000;

export default function useTrainerSession({ isActive, studySession, onOpenSource }) {
  const { t } = useT();
  const [session, setSession] = useState(() => startSession([]));
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
  const { scope, version, readOnly, maxNew } = controls;

  const [prevVersion, setPrevVersion] = useState(version);
  if (prevVersion !== version) {
    setPrevVersion(version);
    setSession(startSession([]));
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

  const [prevCards, setPrevCards] = useState(cards);
  if (prevCards !== cards) {
    setPrevCards(cards);
    if (session.queue.length === 0 && !session.sessionDone) {
      setSession(startSession(cards));
      setTurn(0);
      setPop(null);
    }
  }

  useLayoutEffect(() => {
    if (!pop || !stageRef.current || !arenaRef.current) return;
    const a = arenaRef.current.getBoundingClientRect();
    const s = stageRef.current.getBoundingClientRect();
    setPopTop(s.top - a.top + 16);
  }, [pop]);

  useEffect(() => {
    if (!session.sessionDone) return;
    if (getPref('fb-diary-enabled') !== '1') return;
    generateDiarySummary().catch(() => {});
  }, [session.sessionDone]);

  useEffect(() => {
    if (!pop) return undefined;
    const timer = setTimeout(() => setPop(null), POP_MS);
    return () => clearTimeout(timer);
  }, [pop]);

  const handleFlagged = useCallback((card, flags) => {
    setFlagged((prev) => prev.some((f) => f.hash === card.globalHash)
      ? prev
      : [...prev, { hash: card.globalHash, label: card.name || card.frontText || t('Untitled card'), flags }]);
  }, [t]);

  const startNewSession = () => {
    setSession(startSession(cards));
    setTurn(0);
    setPop(null);
    setFlagged([]);
  };

  const handleResult = ({ key, success, toLevel, easeFactor }) => {
    const next = applyResult(session, { key, success, toLevel, easeFactor, total: cards.length });
    setSession(next);
    setPop({ id: Date.now(), kind: success ? 'up' : 'down', toLevel });
    if (next.sessionDone) setRefreshToken((n) => n + 1);
    setTurn((n) => n + 1);
  };

  const handleUndo = useCallback(async () => {
    const action = session.lastAction;
    if (!action) return;
    setSession(undoResult(session));
    setPop(null);
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
  const displayTotal = sessionDone && lastSession ? lastSession.total : cards.length;
  const figures = sessionFigures(displayStats, cards.length, queue.length);

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
    handleUndo,
    handleFlagged,
    handleViewSource,
  };
}
