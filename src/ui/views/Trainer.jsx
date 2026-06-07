import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { submitReview, getDue } from '../api/srs';
import { getTags, readFile } from '../api/documents';
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

function formatNextDue(sqliteStr) {
  if (!sqliteStr) return null;
  // SQLite datetime() returns "YYYY-MM-DD HH:MM:SS" (UTC, no tz suffix)
  const next = new Date(sqliteStr.replace(' ', 'T') + 'Z');
  const diffMs = next - Date.now();
  if (diffMs <= 0) return 'now';
  const mins  = Math.round(diffMs / 60_000);
  const hours = Math.round(diffMs / 3_600_000);
  const days  = Math.round(diffMs / 86_400_000);
  if (mins  < 60)  return `in ${mins} minute${mins  !== 1 ? 's' : ''}`;
  if (hours < 24)  return `in ${hours} hour${hours  !== 1 ? 's' : ''}`;
  if (days  === 1) return 'tomorrow';
  return `in ${days} days`;
}

function mapApiCard(raw, isNew = false) {
  const cardType = raw.card_type ?? 'basic';
  return {
    globalHash: raw.global_hash,
    name: raw.name,
    level: raw.level ?? 0,
    easeFactor: 0.5,
    lastRecall: raw.last_recall,
    category: raw.category,
    documentPath: raw.document_path,
    isNew,
    cardType,
    // Reversible cards get a random direction assigned at session-build time.
    direction: cardType === 'reversible' ? (Math.random() < 0.5 ? 'forward' : 'reverse') : 'forward',
    vanillaData: {
      frontText: raw.frontText,
      backText: raw.backText,
      media: {
        front_img: raw.front_img,
        back_img: raw.back_img,
        front_sound: raw.front_sound,
        back_sound: raw.back_sound,
      },
    },
    ...(raw.custom_html ? { customData: { html: raw.custom_html } } : {}),
  };
}

function useDueCards({ folder, tags, refreshToken }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Stringify tags so the effect only re-runs when the set of tags actually changes.
  const tagsKey = tags ? tags.slice().sort().join(',') : '';

  useEffect(() => {
    setLoading(true);
    setResult(null);
    setError(null);
    const algorithm = localStorage.getItem('fb-srs-algorithm') ?? 'leitner';
    const stored = localStorage.getItem('fb-srs-max-new');
    const maxNew = stored != null ? parseInt(stored, 10) : undefined;
    getDue({ algorithm, maxNew, folder, tags: tags?.length ? tags : undefined })
      .then(setResult)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [folder, tagsKey, refreshToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const cards = useMemo(() =>
    result
      ? [...result.due.map(c => mapApiCard(c, false)), ...result.new.map(c => mapApiCard(c, true))]
      : [],
    [result]
  );

  return { cards, result, loading, error };
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

function TagInput({ selected = [], onApply }) {
  const [value, setValue] = useState('');
  const [allTags, setAllTags] = useState([]);
  const [focused, setFocused] = useState(false);
  const [dropPos, setDropPos] = useState({ top: 0, left: 0, width: 0 });
  const containerRef = useRef(null);
  const inputRef = useRef(null);
  const dropRef = useRef(null);

  useEffect(() => {
    getTags().then(d => setAllTags(d.tags ?? [])).catch(console.error);
  }, []);

  const suggestions = value.trim()
    ? allTags.filter(t =>
        t.toLowerCase().includes(value.toLowerCase()) && !selected.includes(t)
      ).slice(0, 8)
    : [];

  const updateDropPos = () => {
    if (containerRef.current) {
      const r = containerRef.current.getBoundingClientRect();
      setDropPos({ top: r.bottom + 4, left: r.left, width: r.width });
    }
  };

  const add = (tag) => {
    const t = tag.trim();
    if (!t || selected.includes(t) || !allTags.includes(t)) return;
    setValue('');
    onApply([...selected, t]);
    inputRef.current?.focus();
  };

  const remove = (tag) => {
    const next = selected.filter(t => t !== tag);
    onApply(next.length > 0 ? next : null);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && suggestions[0]) {
      e.preventDefault();
      add(suggestions[0]);
    }
    if (e.key === 'Backspace' && !value && selected.length > 0) {
      remove(selected[selected.length - 1]);
    }
    if (e.key === 'Escape') {
      setValue('');
      inputRef.current?.blur();
    }
  };

  useEffect(() => {
    if (!focused) return;
    const onDown = (e) => {
      if (!containerRef.current?.contains(e.target) && !dropRef.current?.contains(e.target))
        setFocused(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [focused]);

  const showDrop = focused && suggestions.length > 0;

  return (
    <div
      ref={containerRef}
      className={`tag-input${focused ? ' tag-input--focused' : ''}`}
      onClick={() => inputRef.current?.focus()}
    >
      {selected.map(t => (
        <span key={t} className="tag-input-chip">
          {t}
          <button
            className="tag-input-chip-remove"
            onMouseDown={e => { e.preventDefault(); remove(t); }}
          >×</button>
        </span>
      ))}
      <input
        ref={inputRef}
        className="tag-input-field"
        value={value}
        placeholder={selected.length === 0 ? 'Filter by tag…' : ''}
        onChange={e => { setValue(e.target.value); updateDropPos(); }}
        onFocus={() => { updateDropPos(); setFocused(true); }}
        onKeyDown={handleKeyDown}
      />
      {showDrop && createPortal(
        <div
          ref={dropRef}
          className="tag-input-dropdown"
          style={{ top: dropPos.top, left: dropPos.left, width: dropPos.width }}
        >
          {suggestions.map(t => (
            <button
              key={t}
              className="tag-input-suggestion"
              onMouseDown={e => { e.preventDefault(); add(t); }}
            >
              {highlightMatch(t, value)}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}

function highlightMatch(tag, query) {
  if (!query.trim()) return tag;
  const idx = tag.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return tag;
  return (
    <>
      {tag.slice(0, idx)}
      <mark className="tag-match">{tag.slice(idx, idx + query.length)}</mark>
      {tag.slice(idx + query.length)}
    </>
  );
}

function FlashcardReviewer({ card, orientation, remaining, isActive, stageRef, onResult, onViewSource }) {
  const [flipped, setFlipped] = useState(false);
  const [typedAnswer, setTypedAnswer] = useState(null);
  const keymap = useKeybindings();

  const cardType = card.cardType ?? 'basic';
  const isTypeAnswer = cardType === 'type_answer';
  const correctAnswer = card.vanillaData?.backText ?? '';
  const isCorrect = typedAnswer != null &&
    typedAnswer.trim().toLowerCase() === correctAnswer.trim().toLowerCase();

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

  const handleGrade = (key) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const g = GRADES[key];
    const easeFactor = Math.min(1, Math.max(0, (card.easeFactor ?? 0.5) + g.ease));
    const fromLevel = card.level ?? 0;
    const toLevel = g.level(fromLevel);
    submitReview(card.documentPath, card.globalHash, g.outcome, easeFactor, toLevel).catch(console.error);
    onResult({ key, success: g.outcome === 1, toLevel, easeFactor });
  };

  const handleSwipe = (dir) => handleGrade(dir === 'right' ? 'good' : 'again');

  const gradeWithAnimation = (key) => {
    Promise.resolve(cardRef.current?.flyOut(GRADES[key].kind)).then((ok) => {
      if (ok !== false) handleGrade(key);
    });
  };

  // For type_answer: called when the Check button inside Flashcard fires.
  const handleTypeCheck = (typed) => {
    setTypedAnswer(typed);
    setFlipped(true);
  };

  useEffect(() => {
    const onKey = (e) => {
      if (!isActive) return;
      const t = e.target;
      // For type_answer, let key events pass through to the input inside Flashcard.
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const name = eventKeyName(e);
      const hits = (id) => (keymap[id] ?? []).includes(name);
      if (hits('trainer.viewSource')) { e.preventDefault(); onViewSource?.(); return; }
      if (!flipped) {
        if (hits('trainer.reveal')) {
          e.preventDefault();
          if (isTypeAnswer) {
            // Forward to Flashcard's check() — submits whatever is typed.
            cardRef.current?.check();
          } else {
            setFlipped(true);
          }
        }
        return;
      }
      for (const [gkey, g] of Object.entries(GRADES)) {
        if (hits(g.action)) { e.preventDefault(); gradeWithAnimation(gkey); break; }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isActive, flipped, keymap, isTypeAnswer]); // eslint-disable-line react-hooks/exhaustive-deps

  const revealHint = isTypeAnswer
    ? 'Type your answer and press Enter or Check'
    : `Press  `;  // placeholder; rendered with the keycap below

  return (
    <div className="trainer-reviewer">
      <p className="trainer-card-meta">
        <strong>Level {card.level ?? 0}</strong>
        {' · '}{card.category ?? 'uncategorized'}
        {card.isNew ? ' · New' : ''}
        {cardType !== 'basic' && <span className="trainer-card-type-badge">{cardType.replace('_', ' ')}</span>}
      </p>
      <div className="card-stage" ref={stageRef}>
        <CardDeck remaining={remaining} />
        <Flashcard
          ref={cardRef}
          card={displayCard}
          face={flipped ? 'back' : 'front'}
          onFlip={(next) => setFlipped(next === 'back')}
          onSwipe={handleSwipe}
          onTypeCheck={handleTypeCheck}
          orientation={orientation}
          resolveMedia={(ref) => mediaFileSrc(card.documentPath, ref)}
        />
      </div>

      {!flipped && !isTypeAnswer && (
        <p className="trainer-hint">
          Press <kbd>{formatKeyLabel(keymap['trainer.reveal']?.[0] ?? 'Space')}</kbd> or click to reveal
        </p>
      )}

      {!flipped && isTypeAnswer && (
        <p className="trainer-hint">Type your answer above and press Enter or Check</p>
      )}

      {flipped && isTypeAnswer && (
        <div className={`type-answer-verdict type-answer-verdict--${isCorrect ? 'correct' : 'wrong'}`}>
          {isCorrect
            ? '✓ Correct!'
            : <span>✗ You typed: <em>"{typedAnswer}"</em></span>
          }
        </div>
      )}

      {flipped && (
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
      )}

      {card.documentPath && (
        <div className="trainer-source-row">
          <button className="trainer-source-btn" onClick={onViewSource}>
            {keymap['trainer.viewSource']?.[0] && (
              <kbd className="trainer-source-key">{formatKeyLabel(keymap['trainer.viewSource'][0])}</kbd>
            )}
            View source ↗
          </button>
        </div>
      )}
    </div>
  );
}

export default function FlashcardsTrainer({ isActive, studySession, onOpenSource }) {
  const [appliedScope, setAppliedScope] = useState({
    folder: studySession?.folder ?? null,
    tags: null,
  });

  // Tracks whether the last session has been completed (queue emptied by the user).
  // When true, new cards from a re-fetch are held back until the user clicks "start".
  const [sessionDone, setSessionDone] = useState(false);
  // Snapshot of stats at session end so the summary persists through re-fetches.
  const [lastSession, setLastSession] = useState(null);

  // When a study session is launched from the file explorer, reset scope.
  useEffect(() => {
    setAppliedScope({ folder: studySession?.folder ?? null, tags: null });
    setQueue([]);
    setSessionDone(false);
    setLastSession(null);
  }, [studySession]); // eslint-disable-line react-hooks/exhaustive-deps

  const clearFolder = () => { setAppliedScope(s => ({ ...s, folder: null })); setQueue([]); setSessionDone(false); };
  const clearTags   = () => { setAppliedScope(s => ({ ...s, tags: null })); setQueue([]); setSessionDone(false); };
  const applyTags   = (tags) => { setAppliedScope(s => ({ ...s, tags: tags?.length ? tags : null })); setQueue([]); setSessionDone(false); };

  // Re-check for due cards every time the view becomes active.
  const [refreshToken, setRefreshToken] = useState(0);
  useEffect(() => {
    if (isActive) setRefreshToken(t => t + 1);
  }, [isActive]);

  const { cards, result, loading, error } = useDueCards({ folder: appliedScope.folder, tags: appliedScope.tags, refreshToken });
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

  // Auto-start the session when cards load — but only if not mid-session and not
  // waiting for the user to confirm a new session after completion.
  useEffect(() => {
    if (queue.length > 0) return; // mid-session, don't interrupt
    if (sessionDone) return;      // completed, user must click to start again
    setQueue(cards);
    setTurn(0);
    setStats({ again: 0, good: 0, easy: 0 });
    setPop(null);
  }, [cards]); // eslint-disable-line react-hooks/exhaustive-deps

  const startNewSession = () => {
    setQueue(cards);
    setTurn(0);
    setStats({ again: 0, good: 0, easy: 0 });
    setPop(null);
    setSessionDone(false);
    setLastSession(null);
  };

  // The pop is transient — clear it after it plays so it never lingers to fire
  // again when the arena remounts.
  useEffect(() => {
    if (!pop) return undefined;
    const t = setTimeout(() => setPop(null), 1000);
    return () => clearTimeout(t);
  }, [pop]);

  const currentCard = queue[0];
  const remaining = Math.max(0, queue.length - 1);
  const empty = !loading && !error && cards.length === 0 && !sessionDone;

  // During an active session use live values; after completion use the snapshot.
  const displayStats = sessionDone && lastSession ? lastSession.stats : stats;
  const displayTotal = sessionDone && lastSession ? lastSession.total : cards.length;
  const reviews  = displayStats.again + displayStats.good + displayStats.easy;
  const correct  = displayStats.good  + displayStats.easy;
  const accuracy = reviews ? Math.round((correct / reviews) * 100) : 0;

  // Progress bar values (only used during active session).
  const total    = cards.length;
  const passed   = Math.max(0, total - queue.length);
  const progress = total ? passed / total : 0;

  const handleViewSource = useCallback(async () => {
    if (!currentCard?.documentPath) return;
    let highlightId = null;
    try {
      const data = await readFile(currentCard.documentPath);
      const match = data.metadata?.flashcards?.find(c => c.globalHash === currentCard.globalHash);
      const loc = match?.vanillaData?.location;
      if (loc?.type === 'highlight') highlightId = loc.id;
    } catch { /* navigate without highlight scroll */ }
    onOpenSource?.(currentCard.documentPath, highlightId);
  }, [currentCard, onOpenSource]);

  const handleResult = ({ key, success, toLevel, easeFactor }) => {
    const newStats = { ...stats, [key]: stats[key] + 1 };
    setStats(newStats);
    setPop({ id: Date.now(), kind: success ? 'up' : 'down', toLevel });
    if (success) {
      const nextQueue = queue.slice(1);
      setQueue(nextQueue);
      if (nextQueue.length === 0) {
        setSessionDone(true);
        setLastSession({ total: cards.length, stats: newStats });
      }
    } else {
      // Re-queue with the persisted SRS state applied, so the card comes back
      // showing its new (reset) level rather than the stale in-memory one.
      setQueue(queue.length > 1
        ? [...queue.slice(1), { ...queue[0], level: toLevel, easeFactor, lastRecall: new Date().toISOString() }]
        : [{ ...queue[0], level: toLevel, easeFactor, lastRecall: new Date().toISOString() }]);
    }
    setTurn((t) => t + 1);
  };

  return (
    <div className="trainer-view">
      <h2>Trainer</h2>

      {loading && !sessionDone && <p>Loading cards...</p>}
      {error && <p>Error: {error.message}</p>}

      {result && !sessionDone && (
        <p className="trainer-session-info">
          {result.counts.due} due · {result.counts.new} new · {result.algorithm}
        </p>
      )}

      <div className="trainer-scope-bar">
        {appliedScope.folder && (
          <span className="scope-chip">
            Folder: {appliedScope.folder}
            <button onClick={clearFolder} title="Clear">×</button>
          </span>
        )}
        <TagInput selected={appliedScope.tags ?? []} onApply={applyTags} />
      </div>

      {empty && (
        <div className="trainer-summary">
          <h3 className="trainer-summary-title">All caught up</h3>
          {result?.nextDue
            ? <p className="trainer-summary-line">Next review {formatNextDue(result.nextDue)}</p>
            : <p className="trainer-summary-line">No cards scheduled yet — start reviewing to build your schedule.</p>
          }
        </div>
      )}

      {!sessionDone && queue.length > 0 && (
        <div className="trainer-progress">
          <div className="trainer-progress-track">
            <div className="trainer-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <span className="trainer-progress-text">
            {passed}/{total} cleared · {reviews} reviews{reviews ? ` · ${accuracy}% correct` : ''}
          </span>
        </div>
      )}

      {sessionDone && lastSession && (
        <div className="trainer-summary">
          <h3 className="trainer-summary-title">Session complete</h3>
          <p className="trainer-summary-line">{displayTotal} cards · {reviews} reviews · {accuracy}% correct</p>
          <div className="trainer-summary-breakdown">
            <span className="sum sum--again">Again <b>{displayStats.again}</b></span>
            <span className="sum sum--good">Good <b>{displayStats.good}</b></span>
            <span className="sum sum--easy">Easy <b>{displayStats.easy}</b></span>
          </div>
          {loading && <p className="trainer-summary-line">Checking for new cards…</p>}
          {!loading && cards.length > 0 && (
            <button className="trainer-new-session-btn" onClick={startNewSession}>
              Start new session ({cards.length} card{cards.length !== 1 ? 's' : ''})
            </button>
          )}
          {!loading && cards.length === 0 && (
            <p className="trainer-summary-line">
              {result?.nextDue
                ? `Next review ${formatNextDue(result.nextDue)}`
                : 'All caught up!'}
            </p>
          )}
        </div>
      )}

      {!sessionDone && currentCard && (
        <div className="leitner-arena" ref={arenaRef}>
          <FlashcardReviewer
            key={turn}
            card={currentCard}
            orientation={orientation}
            remaining={remaining}
            isActive={isActive}
            stageRef={stageRef}
            onResult={handleResult}
            onViewSource={handleViewSource}
          />
          <GradePop pop={pop} top={popTop} />
        </div>
      )}
    </div>
  );
}
