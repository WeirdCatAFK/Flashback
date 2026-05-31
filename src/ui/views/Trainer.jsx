// The flashcard trainer is the core gameplay mechanic of flashback. It is where the user will spend its time daily.
// Most of the focus on the design would be focused on rendering default flashcards on a way that is satisfying to the user
// Not sure on the implementation but there needs to be a pre-rendering phase to fetch all flashcards
//
// NOTE: A GET /api/srs/due endpoint is needed to fetch cards ready for review.
// For now this view loads cards from a user-selected document as a stand-in.
import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { listFolder, readFile } from '../api/documents';
import { submitReview } from '../api/srs';
import { mediaFileSrc } from '../api/media';
import Flashcard from '../components/shared/Flashcard';
import useFlashcardOrientation from '../hooks/useFlashcardOrientation';
import useKeybindings from '../hooks/useKeybindings';
import { eventKeyName, formatKeyLabel } from '../keybindings';
import './Trainer.css';

// Anki-style grades. `outcome` is the binary success flag the backend logs; the
// nuance is encoded in the ease delta and the next Leitner level. `kind` is the
// exit flight: 'accept' = ascend off the top, 'reject' = drop back to the deck.
// `action` is the keybinding id (see keybindings.js) used for both the shortcut
// and the keycap shown on the button.
const GRADES = {
  again: { label: 'Again', outcome: 0, ease: -0.20, level: () => 0,      kind: 'reject', action: 'trainer.gradeAgain' },
  good:  { label: 'Good',  outcome: 1, ease:  0.00, level: (l) => l + 1, kind: 'accept', action: 'trainer.gradeGood' },
  easy:  { label: 'Easy',  outcome: 1, ease:  0.15, level: (l) => l + 2, kind: 'accept', action: 'trainer.gradeEasy' },
};

const MAX_DECK = 5; // how many cards we draw behind the live one

function useDocumentFlashcards(filePath) {
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!filePath) { setCards([]); return; }
    setLoading(true);
    setError(null);
    readFile(filePath)
      .then(data => setCards(data.metadata?.flashcards ?? []))
      .catch(setError)
      .finally(() => setLoading(false));
  }, [filePath]);

  return { cards, loading, error };
}

// The reducing stack behind the live card: one faint card-back per remaining
// card in the session (capped), so it empties as the session is cleared.
function CardDeck({ remaining }) {
  const n = Math.min(remaining, MAX_DECK);
  return (
    <div className="card-deck" aria-hidden="true">
      {Array.from({ length: n }).map((_, i) => (
        <span key={i} className="card-deck-card" style={{ '--i': n - i }} />
      ))}
    </div>
  );
}

// Elegant feedback over the top of the card showing the level change.
function GradePop({ pop, top }) {
  if (!pop) return null;
  const up = pop.kind === 'up';
  return (
    <div
      className={`grade-pop grade-pop--${up ? 'up' : 'down'}`}
      key={pop.id}
      style={top != null ? { top: `${top}px` } : undefined}
    >
      <span className="grade-pop-arrow">{up ? '↑' : '↓'}</span>
      <span className="grade-pop-level">Lv {pop.toLevel}</span>
    </div>
  );
}

function FlashcardReviewer({ card, filePath, orientation, remaining, isActive, stageRef, onResult }) {
  const [flipped, setFlipped] = useState(false);
  const keymap = useKeybindings();

  // Presentation is delegated to the shared <Flashcard>; the Trainer keeps only
  // the evaluation logic. Fall back to name/hash so older cards without
  // vanillaData text still show something.
  const displayCard = {
    ...card,
    vanillaData: {
      ...card.vanillaData,
      frontText: card.vanillaData?.frontText ?? card.name ?? card.globalHash,
      backText: card.vanillaData?.backText ?? '(no back text)',
    },
  };

  const busyRef = useRef(false);
  const cardRef = useRef(null);

  // Runs once the card has finished its flight: persist the review, then report
  // the result so the parent shows the pop and advances the queue.
  const handleGrade = (key) => {
    if (busyRef.current) return; // guard double swipe / click / key
    busyRef.current = true;
    const g = GRADES[key];
    const easeFactor = Math.min(1, Math.max(0, (card.easeFactor ?? 0.5) + g.ease));
    const fromLevel = card.level ?? 0;
    const toLevel = g.level(fromLevel);

    submitReview(filePath, card.globalHash, g.outcome, easeFactor, toLevel).catch(console.error);
    onResult({ key, success: g.outcome === 1, toLevel, easeFactor });
  };

  // Swipe right → remembered (Good), swipe left → forgot (Again). The card has
  // already flown by the time onSwipe fires.
  const handleSwipe = (dir) => handleGrade(dir === 'right' ? 'good' : 'again');

  // Buttons / keys run the same flight as a swipe, then grade.
  const gradeWithAnimation = (key) => {
    Promise.resolve(cardRef.current?.flyOut(GRADES[key].kind)).then((ok) => {
      if (ok !== false) handleGrade(key);
    });
  };

  // Keyboard: the configured "reveal" key flips; the grade keys grade once
  // revealed. Only while the Trainer is the active view and the user isn't
  // typing in a field. Bindings come from the global keymap.
  useEffect(() => {
    const onKey = (e) => {
      if (!isActive) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const name = eventKeyName(e);
      const hits = (id) => (keymap[id] ?? []).includes(name);
      if (!flipped) {
        if (hits('trainer.reveal')) { e.preventDefault(); setFlipped(true); }
        return;
      }
      for (const [gkey, g] of Object.entries(GRADES)) {
        if (hits(g.action)) { e.preventDefault(); gradeWithAnimation(gkey); break; }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // gradeWithAnimation/setFlipped are stable within a turn; re-bind on change.
  }, [isActive, flipped, keymap]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="trainer-reviewer">
      <p className="trainer-card-meta">
        <strong>Level {card.level ?? 0}</strong> · {card.category ?? 'uncategorized'}
      </p>
      <div className="card-stage" ref={stageRef}>
        <CardDeck remaining={remaining} />
        <Flashcard
          ref={cardRef}
          card={displayCard}
          face={flipped ? 'back' : 'front'}
          onFlip={(next) => setFlipped(next === 'back')}
          onSwipe={handleSwipe}
          orientation={orientation}
          resolveMedia={(ref) => mediaFileSrc(filePath, ref)}
        />
      </div>
      {!flipped
        ? <p className="trainer-hint">Press <kbd>{formatKeyLabel(keymap['trainer.reveal']?.[0] ?? 'Space')}</kbd> or click to reveal</p>
        : (
          <div className="trainer-grades">
            {Object.entries(GRADES).map(([key, g]) => (
              <button
                key={key}
                className={`trainer-grade trainer-grade--${key}`}
                onClick={() => gradeWithAnimation(key)}
              >
                {keymap[g.action]?.[0] && <kbd className="grade-key">{formatKeyLabel(keymap[g.action][0])}</kbd>}
                <span className="grade-label">{g.label}</span>
                <span className="grade-hint">Lv {g.level(card.level ?? 0)}</span>
              </button>
            ))}
          </div>
        )
      }
    </div>
  );
}

export default function FlashcardsTrainer({ isActive }) {
  const [folderItems, setFolderItems] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);

  const { cards, loading, error } = useDocumentFlashcards(selectedFile);
  const [orientation] = useFlashcardOrientation();

  // Session queue: the front card is live, fails go to the back, passes leave.
  // `turn` keys the reviewer so each presentation is a fresh mount.
  const [queue, setQueue] = useState([]);
  const [turn, setTurn] = useState(0);
  const [stats, setStats] = useState({ again: 0, good: 0, easy: 0 });
  const [pop, setPop] = useState(null);

  // The card is horizontally centered, so the pop only needs the card's top
  // measured (relative to the arena) to sit at the top of the card.
  const arenaRef = useRef(null);
  const stageRef = useRef(null);
  const [popTop, setPopTop] = useState(null);

  useLayoutEffect(() => {
    if (!pop || !stageRef.current || !arenaRef.current) return;
    const a = arenaRef.current.getBoundingClientRect();
    const s = stageRef.current.getBoundingClientRect();
    setPopTop(s.top - a.top + 16);
  }, [pop]);

  useEffect(() => {
    listFolder('').then(setFolderItems).catch(console.error);
  }, []);

  // (Re)start the session whenever a new set of cards loads. Clearing `pop` here
  // is what stops a stale grade pop from replaying on the first card.
  useEffect(() => {
    setQueue(cards);
    setTurn(0);
    setStats({ again: 0, good: 0, easy: 0 });
    setPop(null);
  }, [cards]);

  // The pop is transient — clear it after it plays so it never lingers to fire
  // again when the arena remounts.
  useEffect(() => {
    if (!pop) return undefined;
    const t = setTimeout(() => setPop(null), 1000);
    return () => clearTimeout(t);
  }, [pop]);

  const currentCard = queue[0];
  const remaining = Math.max(0, queue.length - 1);
  const started = cards.length > 0;
  const done = started && queue.length === 0;

  const total = cards.length;
  const passed = Math.max(0, total - queue.length);
  const reviews = stats.again + stats.good + stats.easy;
  const correct = stats.good + stats.easy;
  const accuracy = reviews ? Math.round((correct / reviews) * 100) : 0;
  const progress = total ? passed / total : 0;

  const handleResult = ({ key, success, toLevel, easeFactor }) => {
    setStats((s) => ({ ...s, [key]: s[key] + 1 }));
    setPop({ id: Date.now(), kind: success ? 'up' : 'down', toLevel });
    if (success) {
      setQueue((q) => q.slice(1));                          // consumed
    } else {
      // Re-queue with the persisted SRS state applied, so the card comes back
      // showing its new (reset) level rather than the stale in-memory one.
      setQueue((q) => (q.length > 1
        ? [...q.slice(1), { ...q[0], level: toLevel, easeFactor, lastRecall: new Date().toISOString() }]
        : [{ ...q[0], level: toLevel, easeFactor, lastRecall: new Date().toISOString() }]));
    }
    setTurn((t) => t + 1);
  };

  return (
    <div className="trainer-view">
      <h2>Trainer</h2>

      <div className="trainer-picker">
        <label>Load cards from file: </label>
        <select onChange={e => setSelectedFile(e.target.value)} value={selectedFile ?? ''}>
          <option value=''>— pick a file —</option>
          {folderItems.filter(i => i.type === 'file').map(i => (
            <option key={i.name} value={i.name}>{i.name}</option>
          ))}
        </select>
      </div>

      {loading && <p>Loading cards...</p>}
      {error && <p>Error: {error.message}</p>}

      {!loading && selectedFile && cards.length === 0 && (
        <p>No flashcards in this file.</p>
      )}

      {started && !done && (
        <div className="trainer-progress">
          <div className="trainer-progress-track">
            <div className="trainer-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <span className="trainer-progress-text">
            {passed}/{total} cleared · {reviews} reviews{reviews ? ` · ${accuracy}% correct` : ''}
          </span>
        </div>
      )}

      {done && (
        <div className="trainer-summary">
          <h3 className="trainer-summary-title">Session complete</h3>
          <p className="trainer-summary-line">{total} cards · {reviews} reviews · {accuracy}% correct</p>
          <div className="trainer-summary-breakdown">
            <span className="sum sum--again">Again <b>{stats.again}</b></span>
            <span className="sum sum--good">Good <b>{stats.good}</b></span>
            <span className="sum sum--easy">Easy <b>{stats.easy}</b></span>
          </div>
        </div>
      )}

      {currentCard && !done && (
        <div className="leitner-arena" ref={arenaRef}>
          <FlashcardReviewer
            key={turn}
            card={currentCard}
            filePath={selectedFile}
            orientation={orientation}
            remaining={remaining}
            isActive={isActive}
            stageRef={stageRef}
            onResult={handleResult}
          />
          <GradePop pop={pop} top={popTop} />
        </div>
      )}
    </div>
  );
}
