// Memo: consider to present the flashcard viewer as a "shoebox" or "leitner box" to strengthen the symbology of the app
// Will take skeumorphisms of a box, a literal cardboard box. And will show cards grouped by level, and a searchbar for flashcards.
// Subcomponent for this, a flashcard editor. But that is for later
import { useState, useEffect } from 'react';
import { getStats } from '../api/srs';

function useLeitnerStats() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    getStats()
      .then(setStats)
      .catch(setError)
      .finally(() => setLoading(false));
  }, []);

  return { stats, loading, error };
}

function LeitnerBox({ level, count, total }) {
  const pct = total > 0 ? ((count / total) * 100).toFixed(1) : 0;
  return (
    <li>
      Box {level}: {count} cards ({pct}%)
    </li>
  );
}

export default function FlashcardsView() {
  const { stats, loading, error } = useLeitnerStats();

  if (loading) return <p>Loading stats...</p>;
  if (error) return <p>Error: {error.message}</p>;
  if (!stats) return null;

  const { boxes, totalCards, masteryPercentage } = stats;

  return (
    <div>
      <h2>Flashcards — Leitner Box</h2>
      <p>Total cards: {totalCards}</p>
      <p>Mastery: {masteryPercentage?.toFixed(1) ?? 0}%</p>
      <ul>
        {boxes.map(box => (
          <LeitnerBox key={box.level} level={box.level} count={box.count} total={totalCards} />
        ))}
      </ul>
    </div>
  );
}
