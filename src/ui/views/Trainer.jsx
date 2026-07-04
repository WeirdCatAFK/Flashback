import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { submitReview, undoReview, getDue } from '../api/srs';
import { getTags, readFile, listFolder } from '../api/documents';
import { listDecks } from '../api/decks';
import { mediaFileSrc } from '../api/media';
import Flashcard from '../components/shared/Flashcard';
import { LoadingState, ErrorState } from '../components/shared/StateView';
import useKeybindings from '../hooks/useKeybindings';
import { eventKeyName, formatKeyLabel } from '../keybindings';
import './Trainer.css';

const EMPTY_TAGS = [];

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
    easeFactor: raw.ease_factor ?? 2.5,
    lastRecall: raw.last_recall,
    category: raw.category,
    categoryPriority: raw.category_priority ?? 0,
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

function useDueCards({ folder, deck, tags, maxNew, refreshToken }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Stringify tags so the effect only re-runs when the set of tags actually changes.
  const tagsKey = tags ? tags.slice().sort().join(',') : '';

  // Reset loading/result/error inline when deps change so users don't see a
  // stale result between when deps change and when the effect fires.
  const [prevDeps, setPrevDeps] = useState({ folder, deck, tagsKey, maxNew, refreshToken });
  if (prevDeps.folder !== folder || prevDeps.deck !== deck ||
      prevDeps.tagsKey !== tagsKey || prevDeps.maxNew !== maxNew ||
      prevDeps.refreshToken !== refreshToken) {
    setPrevDeps({ folder, deck, tagsKey, maxNew, refreshToken });
    setLoading(true);
    setResult(null);
    setError(null);
  }

  useEffect(() => {
    // Read algorithm fresh from localStorage so Config changes are picked up
    // on the next fetch without needing a separate state channel.
    const algorithm = localStorage.getItem('fb-srs-algorithm') ?? 'leitner';
    const tagsArray = tagsKey ? tagsKey.split(',') : undefined;
    getDue({
      algorithm,
      maxNew,
      folder,
      deck,
      tags: tagsArray?.length ? tagsArray : undefined,
    })
      .then(setResult)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [folder, deck, tagsKey, maxNew, refreshToken]);

  const cards = useMemo(() => {
    if (!result) return [];
    const all = [
      ...result.due.map(c => mapApiCard(c, false)),
      ...result.new.map(c => mapApiCard(c, true)),
    ];
    // Sort by pedagogical category priority ascending: lower = more foundational = first.
    // Within the same priority, due cards precede new cards.
    all.sort((a, b) => {
      const pDiff = (a.categoryPriority ?? 0) - (b.categoryPriority ?? 0);
      if (pDiff !== 0) return pDiff;
      if (!a.isNew && b.isNew) return -1;
      if (a.isNew && !b.isNew) return 1;
      return 0;
    });
    return all;
  }, [result]);

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

function TagInput({ selected = EMPTY_TAGS, onApply }) {
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
          <button type="button"
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
        aria-label="Filter by tag"
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
            <button type="button"
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

// Browsable folder picker. Clicking a folder label applies it as scope;
// clicking › navigates into that folder to see its subfolders.
function FolderPicker({ onPick }) {
  const [open, setOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState('');
  const [subfolders, setSubfolders] = useState([]);
  const [loading, setLoading] = useState(false);
  const btnRef = useRef(null);
  const dropRef = useRef(null);
  const [dropPos, setDropPos] = useState({ top: 0, left: 0 });

  const loadLevel = (folderPath) => {
    setLoading(true);
    setBrowsePath(folderPath);
    listFolder(folderPath)
      .then(items => setSubfolders(items.filter(i => i.type === 'folder')))
      .catch(() => setSubfolders([]))
      .finally(() => setLoading(false));
  };

  const openPicker = () => {
    if (!open) {
      const r = btnRef.current.getBoundingClientRect();
      setDropPos({ top: r.bottom + 4, left: r.left });
      loadLevel('');
      setOpen(true);
    } else {
      setOpen(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!btnRef.current?.contains(e.target) && !dropRef.current?.contains(e.target))
        setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const crumbs = browsePath ? browsePath.split('/') : [];

  return (
    <>
      <button ref={btnRef} type="button" className="scope-picker-btn" onClick={openPicker}>
        + Folder
      </button>
      {open && createPortal(
        <div ref={dropRef} className="scope-picker-dropdown" style={{ top: dropPos.top, left: dropPos.left }}>
          <div className="scope-picker-breadcrumb">
            <button type="button" className="scope-picker-crumb" onClick={() => loadLevel('')}>root</button>
            {crumbs.map((seg, i) => {
              const segPath = crumbs.slice(0, i + 1).join('/');
              return (
                <span key={segPath}>
                  <span className="scope-picker-sep"> / </span>
                  <button type="button" className="scope-picker-crumb" onClick={() => loadLevel(segPath)}>{seg}</button>
                </span>
              );
            })}
          </div>
          {browsePath && (
            <button type="button" className="scope-picker-apply"
              onClick={() => { onPick(browsePath); setOpen(false); }}>
              Study &quot;{crumbs.at(-1)}&quot;
            </button>
          )}
          <div className="scope-picker-list">
            {loading && <span className="scope-picker-empty">Loading…</span>}
            {!loading && subfolders.length === 0 && (
              <span className="scope-picker-empty">No subfolders</span>
            )}
            {!loading && subfolders.map(item => {
              const itemPath = browsePath ? `${browsePath}/${item.name}` : item.name;
              return (
                <div key={itemPath} className="scope-picker-item">
                  <button type="button" className="scope-picker-item-label"
                    onClick={() => { onPick(itemPath); setOpen(false); }}>
                    {item.name}
                  </button>
                  <button type="button" className="scope-picker-item-drill"
                    onClick={() => loadLevel(itemPath)} title="Show subfolders">
                    ›
                  </button>
                </div>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

// Flat deck list picker.
function DeckPicker({ onPick }) {
  const [open, setOpen] = useState(false);
  const [decks, setDecks] = useState([]);
  const [loading, setLoading] = useState(false);
  const btnRef = useRef(null);
  const dropRef = useRef(null);
  const [dropPos, setDropPos] = useState({ top: 0, left: 0 });

  const openPicker = () => {
    if (!open) {
      const r = btnRef.current.getBoundingClientRect();
      setDropPos({ top: r.bottom + 4, left: r.left });
      setLoading(true);
      listDecks()
        .then(data => setDecks(Array.isArray(data) ? data : []))
        .catch(() => setDecks([]))
        .finally(() => setLoading(false));
      setOpen(true);
    } else {
      setOpen(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!btnRef.current?.contains(e.target) && !dropRef.current?.contains(e.target))
        setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <>
      <button ref={btnRef} type="button" className="scope-picker-btn" onClick={openPicker}>
        + Deck
      </button>
      {open && createPortal(
        <div ref={dropRef} className="scope-picker-dropdown" style={{ top: dropPos.top, left: dropPos.left }}>
          <div className="scope-picker-list">
            {loading && <span className="scope-picker-empty">Loading…</span>}
            {!loading && decks.length === 0 && (
              <span className="scope-picker-empty">No decks yet</span>
            )}
            {!loading && decks.map(deck => (
              <div key={deck.globalHash} className="scope-picker-item">
                <button type="button" className="scope-picker-item-label"
                  onClick={() => { onPick({ deck: deck.globalHash, deckName: deck.name }); setOpen(false); }}>
                  {deck.name}
                </button>
              </div>
            ))}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

function FlashcardReviewer({ card, remaining, isActive, stageRef, onResult, onViewSource, onSaveError, onUndo, canUndo }) {
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
      frontText: card.vanillaData?.frontText || (
        (card.vanillaData?.media?.front_img || card.vanillaData?.media?.front_sound) ? '' : (card.name ?? card.globalHash)
      ),
      backText: card.vanillaData?.backText || (
        (card.vanillaData?.media?.back_img || card.vanillaData?.media?.back_sound) ? '' : '(no back text)'
      ),
    },
  };

  const busyRef = useRef(false);
  const cardRef = useRef(null);

  // Stable refs so the keydown effect doesn't need these in its dep array
  // (they close over card/onResult which change per-card, but the component
  // remounts via key={turn} so staleness is never observable in practice).
  const onViewSourceRef = useRef(onViewSource);
  onViewSourceRef.current = onViewSource;
  const onSaveErrorRef = useRef(onSaveError);
  onSaveErrorRef.current = onSaveError;

  const handleGrade = (key) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const g = GRADES[key];
    const algorithm = localStorage.getItem('fb-srs-algorithm') ?? 'leitner';
    const easeFactor = Math.min(3.0, Math.max(1.3, (card.easeFactor ?? 2.5) + g.ease));
    const fromLevel = card.level ?? 0;
    const rawLevel = g.level(fromLevel);
    // Leitner "Again" floors at level 1 (1-day interval); level 0 = 0-day would
    // make the card permanently due every session. SM-2 level 0 gives 1 day already.
    const toLevel = (key === 'again' && algorithm !== 'sm2') ? Math.max(1, rawLevel) : rawLevel;
    // We advance the UI optimistically for a fluid review flow, but a failed write
    // must never be silent — surface it so the user knows this grade wasn't saved.
    submitReview(card.documentPath, card.globalHash, g.outcome, easeFactor, toLevel, algorithm)
      .catch((err) => {
        console.error(err);
        onSaveErrorRef.current?.(err);
      });
    onResult({ key, success: g.outcome === 1, toLevel, easeFactor });
  };

  const handleSwipe = (dir) => handleGrade(dir === 'right' ? 'good' : 'again');

  const gradeWithAnimation = (key) => {
    Promise.resolve(cardRef.current?.flyOut(GRADES[key].kind)).then((ok) => {
      if (ok !== false) handleGrade(key);
    });
  };
  const gradeWithAnimationRef = useRef(gradeWithAnimation);
  gradeWithAnimationRef.current = gradeWithAnimation;

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
      if (hits('trainer.viewSource')) { e.preventDefault(); onViewSourceRef.current?.(); return; }
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
        if (hits(g.action)) { e.preventDefault(); gradeWithAnimationRef.current(gkey); break; }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isActive, flipped, keymap, isTypeAnswer]);

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
          resolveMedia={(ref) => mediaFileSrc(card.documentPath, ref)}
        />
      </div>

      {!flipped && !isTypeAnswer && (
        <p className="trainer-hint">
          Press <kbd>{formatKeyLabel(keymap['trainer.reveal']?.[0] ?? 'Space')}</kbd> or click to reveal
        </p>
      )}

      {!flipped && isTypeAnswer && (
        <p className="trainer-hint">Enter to check · Shift+Enter for newline</p>
      )}

      {flipped && isTypeAnswer && (
        <div className={`type-answer-verdict type-answer-verdict--${isCorrect ? 'correct' : 'wrong'}`}>
          {isCorrect
            ? 'Correct!'
            : <span> You typed: <em>&quot;{typedAnswer}&quot;</em></span>
          }
        </div>
      )}

      {flipped && (
        <div className="trainer-grades">
          {Object.entries(GRADES).map(([key, g]) => (
            <button type="button"
              key={key}
              className={`trainer-grade trainer-grade--${key}`}
              onClick={() => gradeWithAnimation(key)}
            >
              {keymap[g.action]?.[0] && <kbd className="grade-key">{formatKeyLabel(keymap[g.action][0])}</kbd>}
              <span className="grade-label">{g.label}</span>
              <span className="grade-hint">Lv {g.level(card.level ?? 0)}</span>
            </button>
          ))}
          <button type="button"
            className="trainer-grade trainer-grade--undo"
            onClick={onUndo}
            disabled={!canUndo}
            title="Take back your last grade and review that card again"
          >
            {keymap['trainer.undo']?.[0] && <kbd className="grade-key">{formatKeyLabel(keymap['trainer.undo'][0])}</kbd>}
            <span className="grade-label">Undo</span>
          </button>
        </div>
      )}

      {card.documentPath && (
        <div className="trainer-source-row">
          <button type="button" className="trainer-source-btn" onClick={onViewSource}>
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
  const [appliedScope, setAppliedScope] = useState(() => {
    if (studySession) {
      return {
        folder: studySession.folder ?? null,
        deck: studySession.deck ?? null,
        deckName: studySession.deckName ?? null,
        tags: null,
      };
    }
    try {
      const saved = localStorage.getItem('fb-trainer-scope');
      if (saved) return JSON.parse(saved);
    } catch { /* ignore */ }
    return { folder: null, deck: null, deckName: null, tags: null };
  });

  // Session settings — read from localStorage, changes persist and reset the session.
  const [maxNew, setMaxNew] = useState(() => {
    const v = localStorage.getItem('fb-srs-max-new');
    return v != null ? parseInt(v, 10) : 20;
  });
  // Separate display value so the input doesn't reset on every keystroke.
  const [maxNewDisplay, setMaxNewDisplay] = useState(() => {
    const v = localStorage.getItem('fb-srs-max-new');
    return v != null ? v : '20';
  });
  // Session queue + status — declared early so all inline guards and handlers can reference setters.
  const [sessionDone, setSessionDone] = useState(false);
  const [lastSession, setLastSession] = useState(null);
  const [queue, setQueue] = useState([]);
  const [turn, setTurn] = useState(0);
  const [stats, setStats] = useState({ again: 0, good: 0, easy: 0 });
  const [pop, setPop] = useState(null);
  // Set when a review write fails; shown as a dismissible banner so an optimistic
  // advance can never hide lost progress from the user.
  const [saveError, setSaveError] = useState(null);
  // Snapshot of the session state just before the most recent grade, so a
  // misdiagnosed result can be taken back and the card re-graded. Null when
  // there's nothing to undo (session start, or the last action was itself an undo).
  const [lastAction, setLastAction] = useState(null);
  const keymap = useKeybindings();

  // Settings change handlers — reset queue so the new fetch auto-starts a fresh session.
  const applyMaxNew = (display) => {
    const n = Math.max(0, parseInt(display) || 0);
    setMaxNew(n);
    setMaxNewDisplay(String(n));
    localStorage.setItem('fb-srs-max-new', String(n));
    setQueue([]);
    setSessionDone(false);
  };

  // Persist scope to localStorage so it survives app restarts.
  useEffect(() => {
    localStorage.setItem('fb-trainer-scope', JSON.stringify(appliedScope));
  }, [appliedScope]);

  // When a study session is launched from the file explorer or decks view, reset scope
  // inline so all state updates land in the same render (no stale intermediate frame).
  // Guard: if the incoming scope is identical to what's active and a session is running,
  // don't reset — the user re-clicked Study on the same folder/deck.
  const [prevStudySession, setPrevStudySession] = useState(studySession);
  if (prevStudySession !== studySession) {
    setPrevStudySession(studySession);
    if (studySession) {
      const sameScope =
        (studySession.folder ?? null) === appliedScope.folder &&
        (studySession.deck ?? null) === appliedScope.deck;
      if (!sameScope || sessionDone) {
        setAppliedScope({
          folder: studySession.folder ?? null,
          deck: studySession.deck ?? null,
          deckName: studySession.deckName ?? null,
          tags: null,
        });
        setQueue([]);
        setSessionDone(false);
        setLastSession(null);
      }
    }
  }

  const clearFolder = () => { setAppliedScope(s => ({ ...s, folder: null })); setQueue([]); setSessionDone(false); };
  const clearDeck   = () => { setAppliedScope(s => ({ ...s, deck: null, deckName: null })); setQueue([]); setSessionDone(false); };
  const applyFolder = (folder) => { setAppliedScope(s => ({ ...s, folder })); setQueue([]); setSessionDone(false); };
  const applyDeck   = ({ deck, deckName }) => { setAppliedScope(s => ({ ...s, deck, deckName })); setQueue([]); setSessionDone(false); };
  const applyTags   = (tags) => { setAppliedScope(s => ({ ...s, tags: tags?.length ? tags : null })); setQueue([]); setSessionDone(false); };

  // Re-check for due cards when the view becomes active — but only when there is
  // no session running. Mid-session the queue is already in state; a re-fetch would
  // temporarily clear `cards` to [] (loading), which resets the progress bar and
  // disrupts the stats display before loading the new values.
  const [refreshToken, setRefreshToken] = useState(0);
  const [prevIsActiveForRefresh, setPrevIsActiveForRefresh] = useState(isActive);
  if (prevIsActiveForRefresh !== isActive) {
    setPrevIsActiveForRefresh(isActive);
    if (isActive && queue.length === 0 && !sessionDone) setRefreshToken(t => t + 1);
  }

  const { cards, result, loading, error } = useDueCards({
    folder: appliedScope.folder,
    deck: appliedScope.deck,
    tags: appliedScope.tags,
    maxNew,
    refreshToken,
  });
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
  // Inline avoids the stale-UI extra render that a useEffect would cause.
  const [prevCardsForStart, setPrevCardsForStart] = useState(cards);
  if (prevCardsForStart !== cards) {
    setPrevCardsForStart(cards);
    if (queue.length === 0 && !sessionDone) {
      setQueue(cards);
      setTurn(0);
      setStats({ again: 0, good: 0, easy: 0 });
      setPop(null);
    }
  }

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
    // Snapshot the pre-grade session so this result can be undone. Closures here
    // hold the current (pre-mutation) queue/stats/lastSession.
    setLastAction({ key, card: queue[0], queue, stats, lastSession });
    const newStats = { ...stats, [key]: stats[key] + 1 };
    setStats(newStats);
    setPop({ id: Date.now(), kind: success ? 'up' : 'down', toLevel });
    if (success) {
      const nextQueue = queue.slice(1);
      setQueue(nextQueue);
      if (nextQueue.length === 0) {
        setSessionDone(true);
        setLastSession({ total: cards.length, stats: newStats });
        setRefreshToken(t => t + 1);
      }
    } else {
      // Re-queue within the same priority tier: insert the failed card immediately
      // before the first card whose categoryPriority is higher. This keeps failed
      // cards looping inside their tier rather than falling behind higher-priority work.
      const failedCard = { ...queue[0], level: toLevel, easeFactor, lastRecall: new Date().toISOString() };
      const rest = queue.slice(1);
      const failedPriority = failedCard.categoryPriority ?? 0;
      let insertAt = rest.length; // default: end (all remaining cards share this tier)
      for (let i = 0; i < rest.length; i++) {
        if ((rest[i].categoryPriority ?? 0) > failedPriority) { insertAt = i; break; }
      }
      setQueue([...rest.slice(0, insertAt), failedCard, ...rest.slice(insertAt)]);
    }
    setTurn((t) => t + 1);
  };

  const handleUndo = useCallback(async () => {
    if (!lastAction) return;
    const action = lastAction;
    // Restore the session to just before the graded result, then reverse it on the
    // server (drops the erroneous review log and restores the card's prior state).
    setLastAction(null);
    setPop(null);
    setSaveError(null);
    setQueue(action.queue);
    setStats(action.stats);
    setLastSession(action.lastSession);
    setSessionDone(false);
    setTurn((t) => t + 1);
    try {
      const algorithm = localStorage.getItem('fb-srs-algorithm') ?? 'leitner';
      await undoReview(action.card.documentPath, action.card.globalHash, algorithm);
    } catch (err) {
      console.error(err);
      setSaveError(err);
    }
  }, [lastAction]);

  // The undo shortcut lives on the parent (not the reviewer) so it still works
  // from the session-complete screen, after the reviewer has unmounted.
  const handleUndoRef = useRef(handleUndo);
  handleUndoRef.current = handleUndo;
  useEffect(() => {
    const onKey = (e) => {
      if (!isActive) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if ((keymap['trainer.undo'] ?? []).includes(eventKeyName(e))) {
        e.preventDefault();
        handleUndoRef.current?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isActive, keymap]);

  return (
    <div className="trainer-view">
      <h2>Trainer</h2>

      {loading && !sessionDone && <LoadingState message="Loading cards…" />}
      {error && <ErrorState error={error} title="Couldn't load your cards" onRetry={() => setRefreshToken(t => t + 1)} />}

      {saveError && (
        <div className="trainer-save-error" role="alert">
          <span>{`Couldn't save your last review — ${saveError.message || 'the change may not be recorded'}.`}</span>
          <button type="button" onClick={() => setSaveError(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      {result && !sessionDone && (
        <p className="trainer-session-info">
          {result.counts.due} due · {result.counts.new} new · {result.algorithm}
        </p>
      )}

      <div className="trainer-scope-bar">
        {appliedScope.deck && (
          <span className="scope-chip">
            Deck: {appliedScope.deckName ?? appliedScope.deck}
            <button type="button" onClick={clearDeck} title="Clear">×</button>
          </span>
        )}
        {appliedScope.folder && (
          <span className="scope-chip">
            Folder: {appliedScope.folder}
            <button type="button" onClick={clearFolder} title="Clear">×</button>
          </span>
        )}
        {!appliedScope.folder && <FolderPicker onPick={applyFolder} />}
        {!appliedScope.deck   && <DeckPicker   onPick={applyDeck} />}
        <TagInput selected={appliedScope.tags ?? []} onApply={applyTags} />
      </div>

      <div className="trainer-settings-row">
        <div className="trainer-setting">
          <label className="trainer-setting-label" htmlFor="trainer-max-new">Max new</label>
          <input
            id="trainer-max-new"
            type="number"
            className="trainer-setting-input"
            min="0"
            max="500"
            value={maxNewDisplay}
            onChange={e => setMaxNewDisplay(e.target.value)}
            onBlur={() => applyMaxNew(maxNewDisplay)}
            onKeyDown={e => { if (e.key === 'Enter') applyMaxNew(maxNewDisplay); }}
          />
        </div>
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
            <button type="button" className="trainer-new-session-btn" onClick={startNewSession}>
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
            remaining={remaining}
            isActive={isActive}
            stageRef={stageRef}
            onResult={handleResult}
            onViewSource={handleViewSource}
            onSaveError={setSaveError}
            onUndo={handleUndo}
            canUndo={!!lastAction}
          />
          <GradePop pop={pop} top={popTop} />
        </div>
      )}
    </div>
  );
}
