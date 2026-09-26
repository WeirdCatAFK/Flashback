/**
 * One card's review: the flip, the typed answer, the grade (submitted to the
 * server and reported to the session) and the reveal/grade shortcuts. Only
 * `answerText` is graded for a type_answer card — its back is notes.
 */

import { useState, useRef } from 'react';
import { submitReview } from '../../api/srs';
import { typeAnswerParts } from '../../components/flashcard/flashcardFields';
import { getPref, getNumberPref } from '../../prefs.js';
import { useT } from '../../translations/index';
import { FSRS_GRADES, gradesFor, gradeSm2, isTypedCorrect } from './grading';
import useTrainerKeys from './useTrainerKeys';

const algorithmPref = () => getPref('fb-srs-algorithm') ?? 'sm2';

export default function useReviewer({ card, isActive, session, onResult, onInterval, onReplied, onViewSource, onSaveError, onFlagged }) {
  const { t } = useT();
  const [flipped, setFlipped] = useState(false);
  const [typedAnswer, setTypedAnswer] = useState(null);
  const busyRef = useRef(false);
  const cardRef = useRef(null);

  const isTypeAnswer = (card.cardType ?? 'basic') === 'type_answer';
  const isCorrect = isTypedCorrect(typedAnswer, typeAnswerParts(card.vanillaData).answer);

  const collectReply = (promise, key, label) => promise
    .then((res) => {
      if (res?.flags?.length) onFlagged?.(card, res.flags);
      onInterval?.(card.globalHash, key, label, res?.interval ?? null);
    })
    .catch((err) => { console.error(err); onSaveError?.(err); })
    .finally(() => onReplied?.());

  const ordering = session?.sessionId
    ? { sessionId: session.sessionId, sessionPosition: session.position, prevCardHash: session.prevCardHash ?? null }
    : {};

  const grade = (key) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const algorithm = algorithmPref();
    const label = gradesFor(algorithm, t)[key]?.label ?? key;
    const hash = card.globalHash;
    if (algorithm === 'fsrs') {
      const g = FSRS_GRADES[key];
      const requestRetention = getNumberPref('fb-fsrs-retention', 0.9) || 0.9;
      onResult({ key, label, hash, success: g.rating > 1, toLevel: card.level ?? 0, easeFactor: card.easeFactor ?? 2.5 });
      collectReply(submitReview(card.documentPath, hash, null, null, null, algorithm, { rating: g.rating, requestRetention, ...ordering }), key, label);
      return;
    }
    const { outcome, success, toLevel, easeFactor } = gradeSm2(card, key, algorithm);
    onResult({ key, label, hash, success, toLevel, easeFactor });
    collectReply(submitReview(card.documentPath, hash, outcome, easeFactor, toLevel, algorithm, ordering), key, label);
  };

  const gradeWithAnimation = (key) => {
    const g = gradesFor(algorithmPref(), t)[key];
    if (!g) return;
    Promise.resolve(cardRef.current?.flyOut(g.kind)).then((ok) => {
      if (ok !== false) grade(key);
    });
  };

  const reveal = () => {
    if (isTypeAnswer) cardRef.current?.check();
    else setFlipped(true);
  };

  const keymap = useTrainerKeys(isActive, (hits, e) => {
    if (hits('trainer.viewSource')) { e.preventDefault(); onViewSource?.(); return; }
    if (!flipped) {
      if (hits('trainer.reveal')) { e.preventDefault(); reveal(); }
      return;
    }
    for (const [key, g] of Object.entries(gradesFor(algorithmPref(), t))) {
      if (hits(g.action)) { e.preventDefault(); gradeWithAnimation(key); break; }
    }
  });

  return {
    keymap,
    cardRef,
    flipped,
    setFlipped,
    typedAnswer,
    isTypeAnswer,
    isCorrect,
    grades: gradesFor(algorithmPref(), t),
    gradeWithAnimation,
    swipe: (dir) => grade(dir === 'right' ? 'good' : 'again'),
    typeCheck: (typed) => { setTypedAnswer(typed); setFlipped(true); },
  };
}
