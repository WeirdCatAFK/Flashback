import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { submitReview, undoReview, getDue } from '../api/srs';
import { generateSummary as generateDiarySummary } from '../api/diary';
import { getTags, readFile, listFolder } from '../api/documents';
import { listDecks } from '../api/decks';
import { mediaFileSrc } from '../api/media';
import Flashcard from '../components/shared/Flashcard';
import { typeAnswerParts } from '../components/shared/flashcardFields';
import CardDetailModal from '../components/shared/CardDetailModal';
import { LoadingState, ErrorState } from '../components/shared/StateView';
import useKeybindings from '../hooks/useKeybindings';
import { getPref, setPref, getNumberPref } from '../prefs.js';
import { eventKeyName, formatKeyLabel } from '../keybindings';
import { useT } from '../translations';
import { toDate } from '../translations/format';
import './Trainer.css';

const EMPTY_TAGS = [];

// Anki-style grades. `outcome` is the binary success flag the backend logs; the
// nuance is encoded in the ease delta and the next Leitner level. `kind` is the
// exit flight: 'accept' = ascend off the top, 'reject' = drop back to the deck.
// `action` is the keybinding id (see keybindings.js) used for both the shortcut
// and the keycap shown on the button.
//
// Labels are deliberately NOT in these tables. A module constant is evaluated once
// at import, so a t() call here would freeze the grade buttons in whatever language
// was active at load and never re-render on a switch. Only the scheduling maths
// lives here; the words come from gradeLabels() below, at render time.
const GRADES = {
  again: { outcome: 0, ease: -0.20, level: () => 0,      kind: 'reject', action: 'trainer.gradeAgain' },
  good:  { outcome: 1, ease:  0.00, level: (l) => l + 1, kind: 'accept', action: 'trainer.gradeGood' },
  easy:  { outcome: 1, ease:  0.15, level: (l) => l + 2, kind: 'accept', action: 'trainer.gradeEasy' },
};

// FSRS uses a four-button rating (Again/Hard/Good/Easy → 1..4). The schedule is
// computed server-side, so unlike GRADES these carry no client-side level/ease
// math — just the rating and the exit flight (`kind`).
const FSRS_GRADES = {
  again: { rating: 1, kind: 'reject', action: 'trainer.gradeAgain' },
  hard:  { rating: 2, kind: 'reject', action: 'trainer.gradeHard' },
  good:  { rating: 3, kind: 'accept', action: 'trainer.gradeGood' },
  easy:  { rating: 4, kind: 'accept', action: 'trainer.gradeEasy' },
};

// Every key is a literal so the extractor can see it; the lookup by grade id
// happens after translation, never before.
const gradeLabels = (t) => ({
  again: t('Again'), hard: t('Hard'), good: t('Good'), easy: t('Easy'),
});

/** The grade table for `algorithm`, with its labels resolved in the active language. */
const gradesFor = (algorithm, t) => {
  const base = algorithm === 'fsrs' ? FSRS_GRADES : GRADES;
  const labels = gradeLabels(t);
  return Object.fromEntries(
    Object.entries(base).map(([id, grade]) => [id, { ...grade, label: labels[id] }])
  );
};

const MAX_DECK = 5; // how many cards we draw behind the live one
// Cards to put between a failed card and its retry. Mirrors the sequencer's MIN_LAG
// (access/orchestration/sequencing.js) — kept as a separate constant because this one is a
// client-side queue mutation the server never sees, not a value the two must agree on.
const REQUEUE_LAG = 4;

/**
 * When the card comes back, in the active language.
 *
 * The hand-rolled English ladder this replaces ("in 3 hours", "tomorrow", "in 40
 * days") could not be translated without a key per rung; Intl.RelativeTimeFormat
 * produces all of them. `maxUnit: 'day'` is what keeps a 40-day interval reading
 * as "in 40 days" rather than the idiomatic-but-lossy "next month" — an SRS
 * interval is exactly the number the user is asking for.
 *
 * `toDate` handles SQLite's zone-less "YYYY-MM-DD HH:MM:SS" as UTC.
 */
function formatNextDue(sqliteStr, formatRelative, t) {
  if (!sqliteStr) return null;
  const next = toDate(sqliteStr);
  if (!next) return null;
  if (next.getTime() - Date.now() <= 0) return t('now');
  return formatRelative(next, { maxUnit: 'day' });
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
      // type_answer only; null on every other type and on cards that predate the split.
      answerText: raw.answerText ?? null,
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
    const algorithm = getPref('fb-srs-algorithm') ?? 'sm2';
    const order = getPref('fb-trainer-order') ?? 'interleaved';
    const tagsArray = tagsKey ? tagsKey.split(',') : undefined;
    getDue({
      algorithm,
      maxNew,
      folder,
      deck,
      order,
      tags: tagsArray?.length ? tagsArray : undefined,
    })
      .then(setResult)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [folder, deck, tagsKey, maxNew, refreshToken]);

  // The server already sequenced this queue — by pedagogical tier, then by graph distance
  // within each tier. Do NOT re-sort it here. The previous client-side sort was a stable
  // sort on categoryPriority alone, which left every tie resolving to creation order and
  // was the reason a session always played back in the order the cards were authored.
  const cards = useMemo(() => {
    if (!result) return [];
    const queue = result.queue ?? [...result.due, ...result.new];
    // `isNew` isn't a column — it's which bucket the server put the card in.
    const newHashes = new Set(result.new.map(c => c.global_hash));
    return queue.map(c => mapApiCard(c, newHashes.has(c.global_hash)));
  }, [result]);

  return { cards, result, loading, error, sessionId: result?.sessionId ?? null };
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
  const { t } = useT();
  if (!pop) return null;
  const up = pop.kind === 'up';
  return (
    <div
      className={`grade-pop grade-pop--${up ? 'up' : 'down'}`}
      key={pop.id}
      style={top != null ? { top: `${top}px` } : undefined}
    >
      <span className="grade-pop-arrow">{up ? '↑' : '↓'}</span>
      <span className="grade-pop-level">{t('Lv {n}', { n: pop.toLevel })}</span>
    </div>
  );
}

function TagInput({ selected = EMPTY_TAGS, onApply }) {
  const { t } = useT();
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
    ? allTags.filter(tag =>
        tag.toLowerCase().includes(value.toLowerCase()) && !selected.includes(tag)
      ).slice(0, 8)
    : [];

  const updateDropPos = () => {
    if (containerRef.current) {
      const r = containerRef.current.getBoundingClientRect();
      setDropPos({ top: r.bottom + 4, left: r.left, width: r.width });
    }
  };

  const add = (tag) => {
    const trimmed = tag.trim();
    if (!trimmed || selected.includes(trimmed) || !allTags.includes(trimmed)) return;
    setValue('');
    onApply([...selected, trimmed]);
    inputRef.current?.focus();
  };

  const remove = (tag) => {
    const next = selected.filter(x => x !== tag);
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
      {selected.map(tag => (
        <span key={tag} className="tag-input-chip">
          {tag}
          <button type="button"
            className="tag-input-chip-remove"
            onMouseDown={e => { e.preventDefault(); remove(tag); }}
          >×</button>
        </span>
      ))}
      <input
        ref={inputRef}
        className="tag-input-field"
        value={value}
        placeholder={selected.length === 0 ? t('Filter by tag…') : ''}
        aria-label={t('Filter by tag')}
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
          {suggestions.map(tag => (
            <button type="button"
              key={tag}
              className="tag-input-suggestion"
              onMouseDown={e => { e.preventDefault(); add(tag); }}
            >
              {highlightMatch(tag, value)}
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
  const { t } = useT();
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
        {t('+ Folder')}
      </button>
      {open && createPortal(
        <div ref={dropRef} className="scope-picker-dropdown" style={{ top: dropPos.top, left: dropPos.left }}>
          <div className="scope-picker-breadcrumb">
            <button type="button" className="scope-picker-crumb" onClick={() => loadLevel('')}>{t('root')}</button>
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
              {t('Study “{name}”', { name: crumbs.at(-1) })}
            </button>
          )}
          <div className="scope-picker-list">
            {loading && <span className="scope-picker-empty">{t('Loading…')}</span>}
            {!loading && subfolders.length === 0 && (
              <span className="scope-picker-empty">{t('No subfolders')}</span>
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
                    onClick={() => loadLevel(itemPath)} title={t('Show subfolders')}>
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
  const { t } = useT();
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
        {t('+ Deck')}
      </button>
      {open && createPortal(
        <div ref={dropRef} className="scope-picker-dropdown" style={{ top: dropPos.top, left: dropPos.left }}>
          <div className="scope-picker-list">
            {loading && <span className="scope-picker-empty">{t('Loading…')}</span>}
            {!loading && decks.length === 0 && (
              <span className="scope-picker-empty">{t('No decks yet')}</span>
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

function FlashcardReviewer({ card, remaining, isActive, stageRef, onResult, onViewSource, onSaveError, onFlagged, onUndo, canUndo, session }) {
  const [flipped, setFlipped] = useState(false);
  const [typedAnswer, setTypedAnswer] = useState(null);
  const keymap = useKeybindings();
  const { t } = useT();

  const cardType = card.cardType ?? 'basic';
  const isTypeAnswer = cardType === 'type_answer';
  // Only the answer is graded — a type_answer card's backText is post-review notes, which
  // the reviewer was never asked to reproduce (and on a pre-split card IS the answer).
  const correctAnswer = typeAnswerParts(card.vanillaData).answer;
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
      // The placeholder is for a card that has genuinely nothing on its back. A
      // type_answer card's back is driven by its answer, and its notes are optional —
      // an empty notes field must not be reported as a missing back.
      backText: card.vanillaData?.backText || (
        (isTypeAnswer || card.vanillaData?.media?.back_img || card.vanillaData?.media?.back_sound)
          ? '' : '(no back text)'
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
  const onFlaggedRef = useRef(onFlagged);
  onFlaggedRef.current = onFlagged;

  // A failing grade can make the server raise a card-health flag. It is reported at the
  // END of the session, never mid-card: interrupting a review to tell someone their card
  // is badly built is exactly the wrong moment, and the point of the feature is to make
  // the failure useful afterwards rather than to editorialise during it.
  const collectFlags = (promise) => promise
    .then((res) => {
      if (res?.flags?.length) onFlaggedRef.current?.(card, res.flags);
    })
    .catch((err) => {
      console.error(err);
      onSaveErrorRef.current?.(err);
    });

  // How this card was actually presented. `prevCardHash` is the card the user saw
  // immediately before — not the one the sequencer planned — so a card re-queued after a
  // failed grade reports the position it really occupied. Empty outside a session.
  const ordering = session?.sessionId
    ? {
      sessionId: session.sessionId,
      sessionPosition: session.position,
      prevCardHash: session.prevCardHash ?? null,
    }
    : {};

  const handleGrade = (key) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const algorithm = getPref('fb-srs-algorithm') ?? 'sm2';

    if (algorithm === 'fsrs') {
      const g = FSRS_GRADES[key];
      const requestRetention = getNumberPref('fb-fsrs-retention', 0.9) || 0.9;
      // FSRS grading is computed server-side; we only send the rating. Optimistic
      // UI advance; a failed write is surfaced, never silent.
      collectFlags(submitReview(card.documentPath, card.globalHash, null, null, null, algorithm, { rating: g.rating, requestRetention, ...ordering }));
      onResult({ key, success: g.rating > 1, toLevel: card.level ?? 0, easeFactor: card.easeFactor ?? 2.5 });
      return;
    }

    const g = GRADES[key];
    const easeFactor = Math.min(3.0, Math.max(1.3, (card.easeFactor ?? 2.5) + g.ease));
    const fromLevel = card.level ?? 0;
    const rawLevel = g.level(fromLevel);
    // Leitner "Again" floors at level 1 (1-day interval); level 0 = 0-day would
    // make the card permanently due every session. SM-2 level 0 gives 1 day already.
    const toLevel = (key === 'again' && algorithm !== 'sm2') ? Math.max(1, rawLevel) : rawLevel;
    // We advance the UI optimistically for a fluid review flow, but a failed write
    // must never be silent — surface it so the user knows this grade wasn't saved.
    collectFlags(submitReview(card.documentPath, card.globalHash, g.outcome, easeFactor, toLevel, algorithm, ordering));
    onResult({ key, success: g.outcome === 1, toLevel, easeFactor });
  };

  const handleSwipe = (dir) => handleGrade(dir === 'right' ? 'good' : 'again');

  const gradeWithAnimation = (key) => {
    const algorithm = getPref('fb-srs-algorithm') ?? 'sm2';
    const g = gradesFor(algorithm, t)[key];
    if (!g) return;
    Promise.resolve(cardRef.current?.flyOut(g.kind)).then((ok) => {
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
      const target = e.target;
      // For type_answer, let key events pass through to the input inside Flashcard.
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
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
      const algorithm = getPref('fb-srs-algorithm') ?? 'sm2';
      for (const [gkey, g] of Object.entries(gradesFor(algorithm, t))) {
        if (hits(g.action)) { e.preventDefault(); gradeWithAnimationRef.current(gkey); break; }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isActive, flipped, keymap, isTypeAnswer, t]);

  return (
    <div className="trainer-reviewer">
      <p className="trainer-card-meta">
        <strong>{t('Level {n}', { n: card.level ?? 0 })}</strong>
        {' · '}{card.category ?? t('uncategorized')}
        {card.isNew ? ` · ${t('New')}` : ''}
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
          {t('Press')} <kbd>{formatKeyLabel(keymap['trainer.reveal']?.[0] ?? 'Space')}</kbd> {t('or click to reveal')}
        </p>
      )}

      {!flipped && isTypeAnswer && (
        <p className="trainer-hint">{t('Enter to check · Shift+Enter for newline')}</p>
      )}

      {flipped && isTypeAnswer && (
        <div className={`type-answer-verdict type-answer-verdict--${isCorrect ? 'correct' : 'wrong'}`}>
          {isCorrect
            ? t('Correct!')
            : <span> {t('You typed:')} <em>&quot;{typedAnswer}&quot;</em></span>
          }
        </div>
      )}

      {flipped && (
        <div className="trainer-grades">
          {Object.entries(gradesFor(getPref('fb-srs-algorithm') ?? 'sm2', t)).map(([key, g]) => (
            <button type="button"
              key={key}
              className={`trainer-grade trainer-grade--${key}`}
              onClick={() => gradeWithAnimation(key)}
            >
              {keymap[g.action]?.[0] && <kbd className="grade-key">{formatKeyLabel(keymap[g.action][0])}</kbd>}
              <span className="grade-label">{g.label}</span>
              {g.level && <span className="grade-hint">{t('Lv {n}', { n: g.level(card.level ?? 0) })}</span>}
            </button>
          ))}
          <button type="button"
            className="trainer-grade trainer-grade--undo"
            onClick={onUndo}
            disabled={!canUndo}
            title={t('Take back your last grade and review that card again')}
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
            {t('View source ↗')}
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
      const saved = getPref('fb-trainer-scope');
      if (saved) return JSON.parse(saved);
    } catch { /* ignore */ }
    return { folder: null, deck: null, deckName: null, tags: null };
  });

  // Session settings — read from localStorage, changes persist and reset the session.
  const [maxNew, setMaxNew] = useState(() => {
    const v = getPref('fb-srs-max-new');
    return v != null ? parseInt(v, 10) : 20;
  });
  // Separate display value so the input doesn't reset on every keystroke.
  const [maxNewDisplay, setMaxNewDisplay] = useState(() => {
    const v = getPref('fb-srs-max-new');
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
  // Cards the classifier flagged during this session, shown once at the end. Keyed by
  // hash so a card that fails, gets re-queued and fails again is named once, not twice.
  const [flagged, setFlagged] = useState([]);
  // Presentation trace for ordering telemetry: how many cards have been shown so far and
  // which one came last. Counts what the user ACTUALLY saw, so a re-queued card advances
  // the position again rather than reusing its first one.
  const [presented, setPresented] = useState({ position: 0, prevCardHash: null });
  // Hash of the flagged card the user opened from the summary, if any.
  const [inspecting, setInspecting] = useState(null);
  const keymap = useKeybindings();
  const { t, tp, formatRelative } = useT();

  const handleFlagged = useCallback((card, flags) => {
    setFlagged((prev) => prev.some((f) => f.hash === card.globalHash)
      ? prev
      : [...prev, {
          hash: card.globalHash,
          label: card.name || card.frontText || t('Untitled card'),
          flags,
        }]);
  }, [t]);

  // Settings change handlers — reset queue so the new fetch auto-starts a fresh session.
  const applyMaxNew = (display) => {
    const n = Math.max(0, parseInt(display) || 0);
    setMaxNew(n);
    setMaxNewDisplay(String(n));
    setPref('fb-srs-max-new', String(n));
    setQueue([]);
    setSessionDone(false);
  };

  // Persist scope to localStorage so it survives app restarts.
  useEffect(() => {
    setPref('fb-trainer-scope', JSON.stringify(appliedScope));
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

  const { cards, result, loading, error, sessionId } = useDueCards({
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
      setPresented({ position: 0, prevCardHash: null });
    }
  }

  const startNewSession = () => {
    setQueue(cards);
    setTurn(0);
    setStats({ again: 0, good: 0, easy: 0 });
    setPop(null);
    setSessionDone(false);
    setLastSession(null);
    setFlagged([]);
    setPresented({ position: 0, prevCardHash: null });
  };

  // When a session completes, record the day's summary to the diary — only if the
  // user opted in (localStorage `fb-diary-enabled`, set in Config). Best-effort: the
  // diary is non-critical and the server derives the summary idempotently from
  // ReviewLogs, so a failure here is safe to swallow. A session with no real reviews
  // produces no summary server-side.
  useEffect(() => {
    if (!sessionDone) return;
    if (getPref('fb-diary-enabled') !== '1') return;
    generateDiarySummary().catch(() => {});
  }, [sessionDone]);

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
    // hold the current (pre-mutation) queue/stats/lastSession/presented.
    setLastAction({ key, card: queue[0], queue, stats, lastSession, presented });
    const newStats = { ...stats, [key]: stats[key] + 1 };
    setStats(newStats);
    setPop({ id: Date.now(), kind: success ? 'up' : 'down', toLevel });
    // Advance the presentation trace: this card has now been shown, whatever happens to it.
    setPresented(p => ({ position: p.position + 1, prevCardHash: queue[0]?.globalHash ?? null }));
    if (success) {
      const nextQueue = queue.slice(1);
      setQueue(nextQueue);
      if (nextQueue.length === 0) {
        setSessionDone(true);
        setLastSession({ total: cards.length, stats: newStats });
        setRefreshToken(t => t + 1);
      }
    } else {
      // Re-queue within the same priority tier, at least REQUEUE_LAG cards later.
      // Two constraints, in this order:
      //   1. Never past the tier boundary — a failed Definition must not fall behind the
      //      Exercises that build on it.
      //   2. Never immediately: re-showing a card the user just failed tests recognition,
      //      not recall. The lag mirrors the sequencer's own spacing so a lapsed card gets
      //      the same treatment as any other confusable repeat.
      // The old behaviour appended to the end of the tier, which spaced short tiers fine
      // but buried the card in long ones; clamping to the tier end keeps both cases sane.
      const failedCard = { ...queue[0], level: toLevel, easeFactor, lastRecall: new Date().toISOString() };
      const rest = queue.slice(1);
      const failedPriority = failedCard.categoryPriority ?? 0;
      let tierEnd = rest.length; // default: all remaining cards share this tier
      for (let i = 0; i < rest.length; i++) {
        if ((rest[i].categoryPriority ?? 0) > failedPriority) { tierEnd = i; break; }
      }
      // Clamp to the tier, but never to 0: a failed card sitting at the end of its tier
      // would otherwise be re-dealt as the very next card, which tests recognition rather
      // than recall. One card past the boundary is a smaller price than no lag at all.
      const insertAt = rest.length === 0 ? 0 : Math.max(1, Math.min(REQUEUE_LAG, tierEnd));
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
    // Rewind the presentation trace too: the undone review's log row is deleted server-side,
    // so leaving the position advanced would put a gap in the session's ordering record and
    // make the next card look further from its sibling than it was.
    setPresented(action.presented ?? { position: 0, prevCardHash: null });
    setSessionDone(false);
    setTurn((t) => t + 1);
    try {
      const algorithm = getPref('fb-srs-algorithm') ?? 'sm2';
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
      const target = e.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
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
      <h2>{t('Trainer')}</h2>

      {loading && !sessionDone && <LoadingState message={t('Loading cards…')} />}
      {error && <ErrorState error={error} title={t('Couldn’t load your cards')} onRetry={() => setRefreshToken(n => n + 1)} />}

      {saveError && (
        <div className="trainer-save-error" role="alert">
          <span>{t('Couldn’t save your last review — {reason}.',
            { reason: saveError.message || t('the change may not be recorded') })}</span>
          <button type="button" onClick={() => setSaveError(null)} aria-label={t('Dismiss')}>×</button>
        </div>
      )}

      {result && !sessionDone && (
        <p className="trainer-session-info">
          {t('{due} due · {new} new · {algorithm}',
            { due: result.counts.due, new: result.counts.new, algorithm: result.algorithm })}
        </p>
      )}

      <div className="trainer-scope-bar">
        {appliedScope.deck && (
          <span className="scope-chip">
            {t('Deck: {name}', { name: appliedScope.deckName ?? appliedScope.deck })}
            <button type="button" onClick={clearDeck} title={t('Clear')}>×</button>
          </span>
        )}
        {appliedScope.folder && (
          <span className="scope-chip">
            {t('Folder: {path}', { path: appliedScope.folder })}
            <button type="button" onClick={clearFolder} title={t('Clear')}>×</button>
          </span>
        )}
        {!appliedScope.folder && <FolderPicker onPick={applyFolder} />}
        {!appliedScope.deck   && <DeckPicker   onPick={applyDeck} />}
        <TagInput selected={appliedScope.tags ?? []} onApply={applyTags} />
      </div>

      <div className="trainer-settings-row">
        <div className="trainer-setting">
          <label className="trainer-setting-label" htmlFor="trainer-max-new">{t('Max new')}</label>
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
          <h3 className="trainer-summary-title">{t('All caught up')}</h3>
          {result?.nextDue
            ? <p className="trainer-summary-line">{t('Next review {when}', { when: formatNextDue(result.nextDue, formatRelative, t) })}</p>
            : <p className="trainer-summary-line">{t('No cards scheduled yet — start reviewing to build your schedule.')}</p>
          }
        </div>
      )}

      {!sessionDone && queue.length > 0 && (
        <div className="trainer-progress">
          <div className="trainer-progress-track">
            <div className="trainer-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <span className="trainer-progress-text">
            {t('{passed}/{total} cleared · {reviews} reviews', { passed, total, reviews })}
            {reviews ? ` · ${t('{pct}% correct', { pct: accuracy })}` : ''}
          </span>
        </div>
      )}

      {sessionDone && lastSession && (
        <div className="trainer-summary">
          <h3 className="trainer-summary-title">{t('Session complete')}</h3>
          <p className="trainer-summary-line">
            {t('{cards} cards · {reviews} reviews · {pct}% correct',
              { cards: displayTotal, reviews, pct: accuracy })}
          </p>
          <div className="trainer-summary-breakdown">
            <span className="sum sum--again">{t('Again')} <b>{displayStats.again}</b></span>
            <span className="sum sum--good">{t('Good')} <b>{displayStats.good}</b></span>
            <span className="sum sum--easy">{t('Easy')} <b>{displayStats.easy}</b></span>
          </div>
          {loading && <p className="trainer-summary-line">{t('Checking for new cards…')}</p>}
          {!loading && cards.length > 0 && (
            <button type="button" className="trainer-new-session-btn" onClick={startNewSession}>
              {tp('Start new session ({n} card)', 'Start new session ({n} cards)', cards.length)}
            </button>
          )}
          {!loading && cards.length === 0 && (
            <p className="trainer-summary-line">
              {result?.nextDue
                ? t('Next review {when}', { when: formatNextDue(result.nextDue, formatRelative, t) })
                : t('All caught up!')}
            </p>
          )}

          {/* Cards that failed in a way worth acting on. Reported here rather than
              mid-session: the review is not the moment to argue with someone about how
              their card is built. Only failures reach this list — a card that is
              working is never mentioned. */}
          {flagged.length > 0 && (
            <div className="trainer-flagged">
              <h4 className="trainer-flagged-title">
                {tp('{n} card worth a look', '{n} cards worth a look', flagged.length)}
              </h4>
              <ul className="trainer-flagged-list">
                {flagged.map((f) => (
                  <li key={f.hash} className="trainer-flagged-item">
                    <button type="button" className="trainer-flagged-btn"
                      onClick={() => setInspecting(f.hash)}>
                      {f.label}
                    </button>
                    <span className="trainer-flagged-why">
                      {f.flags.map((x) => x.title).join(' · ')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {inspecting && (
        <CardDetailModal hash={inspecting} onClose={() => setInspecting(null)} />
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
            onFlagged={handleFlagged}
            onUndo={handleUndo}
            canUndo={!!lastAction}
            session={{ sessionId, ...presented }}
          />
          <GradePop pop={pop} top={popTop} />
        </div>
      )}
    </div>
  );
}
