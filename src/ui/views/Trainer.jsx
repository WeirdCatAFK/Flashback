// The flashcard trainer is the core gameplay mechanic of flashback. It is where the user will spend its time daily.
// Most of the focus on the design would be focused on rendering default flashcards on a way that is satisfying to the user
// Not sure on the implementation but there needs to be a pre-rendering phase to fetch all flashcards
//
// NOTE: A GET /api/srs/due endpoint is needed to fetch cards ready for review.
// For now this view loads cards from a user-selected document as a stand-in.
import { useState, useEffect, useRef } from 'react';
import { listFolder, readFile } from '../api/documents';
import { submitReview } from '../api/srs';
import { mediaFileSrc } from '../api/media';
import Flashcard from '../components/shared/Flashcard';
import useFlashcardOrientation from '../hooks/useFlashcardOrientation';
import './Trainer.css';

// Anki-style grades. `outcome` is the binary success flag the backend logs; the
// nuance is encoded in the ease delta and the next Leitner level.
const GRADES = {
  again: { label: 'Again', outcome: 0, ease: -0.20, level: () => 0 },
  good:  { label: 'Good',  outcome: 1, ease:  0.00, level: (l) => l + 1 },
  easy:  { label: 'Easy',  outcome: 1, ease:  0.15, level: (l) => l + 2 },
};

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

function FlashcardReviewer({ card, filePath, orientation, onDone }) {
  const [flipped, setFlipped] = useState(false);
  const [submitting, setSubmitting] = useState(false);

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

  const handleGrade = async (key) => {
    if (busyRef.current) return; // guard double swipe / click
    busyRef.current = true;
    const g = GRADES[key];
    const easeFactor = Math.min(1, Math.max(0, (card.easeFactor ?? 0.5) + g.ease));
    const newLevel = g.level(card.level ?? 0);

    setSubmitting(true);
    await submitReview(filePath, card.globalHash, g.outcome, easeFactor, newLevel)
      .catch(console.error);
    setSubmitting(false);
    setFlipped(false);
    onDone();
  };

  // Swipe right → remembered (Good), swipe left → forgot (Again).
  const handleSwipe = (dir) => handleGrade(dir === 'right' ? 'good' : 'again');

  // Buttons run the same fly-out as a swipe, then grade. Again exits left;
  // Good/Easy (both positive) exit right.
  const gradeWithAnimation = (key) => {
    const dir = key === 'again' ? 'left' : 'right';
    Promise.resolve(cardRef.current?.flyOut(dir)).then((ok) => {
      if (ok !== false) handleGrade(key);
    });
  };

  return (
    <div className="trainer-reviewer">
      <p className="trainer-card-meta">
        <strong>Level {card.level ?? 0}</strong> · {card.category ?? 'uncategorized'}
      </p>
      <Flashcard
        ref={cardRef}
        card={displayCard}
        face={flipped ? 'back' : 'front'}
        onFlip={(next) => setFlipped(next === 'back')}
        onSwipe={handleSwipe}
        orientation={orientation}
        resolveMedia={(ref) => mediaFileSrc(filePath, ref)}
      />
      {!flipped
        ? <p className="trainer-hint">Click the card to reveal the answer</p>
        : (
          <div className="trainer-grades">
            {Object.entries(GRADES).map(([key, g]) => (
              <button
                key={key}
                className={`trainer-grade trainer-grade--${key}`}
                disabled={submitting}
                onClick={() => gradeWithAnimation(key)}
              >
                {g.label}
              </button>
            ))}
          </div>
        )
      }
    </div>
  );
}

export default function FlashcardsTrainer() {
  const [folderItems, setFolderItems] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [cardIndex, setCardIndex] = useState(0);

  const { cards, loading, error } = useDocumentFlashcards(selectedFile);
  const [orientation] = useFlashcardOrientation();

  useEffect(() => {
    listFolder('').then(setFolderItems).catch(console.error);
  }, []);

  const handleDone = () => setCardIndex(i => i + 1);
  const currentCard = cards[cardIndex];
  const done = cardIndex >= cards.length && cards.length > 0;

  return (
    <div>
      <h2>Trainer</h2>

      <div>
        <label>Load cards from file: </label>
        <select onChange={e => { setSelectedFile(e.target.value); setCardIndex(0); }} value={selectedFile ?? ''}>
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

      {done && <p>Session complete. {cards.length} cards reviewed.</p>}

      {currentCard && !done && (
        <FlashcardReviewer
          key={currentCard.globalHash}
          card={currentCard}
          filePath={selectedFile}
          orientation={orientation}
          onDone={handleDone}
        />
      )}
    </div>
  );
}
