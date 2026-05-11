// The flashcard trainer is the core gameplay mechanic of flashback. It is where the user will spend its time daily.
// Most of the focus on the design would be focused on rendering default flashcards on a way that is satisfying to the user
// Not sure on the implementation but there needs to be a pre-rendering phase to fetch all flashcards
//
// NOTE: A GET /api/srs/due endpoint is needed to fetch cards ready for review.
// For now this view loads cards from a user-selected document as a stand-in.
import { useState, useEffect } from 'react';
import { listFolder, readFile } from '../api/documents';
import { submitReview } from '../api/srs';

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

function FlashcardReviewer({ card, filePath, onDone }) {
  const [flipped, setFlipped] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const front = card.vanillaData?.frontText ?? card.name ?? card.globalHash;
  const back = card.vanillaData?.backText ?? '(no back text)';

  const handleOutcome = async (outcome) => {
    const easeFactor = outcome === 1
      ? Math.min((card.easeFactor ?? 0.5) + 0.1, 1)
      : Math.max((card.easeFactor ?? 0.5) - 0.2, 0);
    const newLevel = outcome === 1 ? (card.level ?? 0) + 1 : 0;

    setSubmitting(true);
    await submitReview(filePath, card.globalHash, outcome, easeFactor, newLevel)
      .catch(console.error);
    setSubmitting(false);
    setFlipped(false);
    onDone();
  };

  return (
    <div>
      <p><strong>Level {card.level ?? 0}</strong> · {card.category ?? 'uncategorized'}</p>
      <p>{front}</p>
      {!flipped
        ? <button onClick={() => setFlipped(true)}>Flip</button>
        : (
          <div>
            <p>{back}</p>
            <button disabled={submitting} onClick={() => handleOutcome(1)}>Got it</button>
            {' '}
            <button disabled={submitting} onClick={() => handleOutcome(0)}>Missed it</button>
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
          onDone={handleDone}
        />
      )}
    </div>
  );
}
