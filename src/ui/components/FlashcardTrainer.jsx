import React, { useState, useEffect } from "react";
import axios from "axios";
import "./FlashcardTrainer.css";

export default function FlashcardTrainer() {
  const [dueFlashcards, setDueFlashcards] = useState([]);
  const [currentFlashcardIndex, setCurrentFlashcardIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchDueFlashcards();
  }, []);

  const fetchDueFlashcards = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get("http://localhost:50500/flashcards/due");
      setDueFlashcards(response.data);
    } catch (err) {
      console.error("Error fetching due flashcards:", err);
      setError("Failed to fetch flashcards for review.");
    } finally {
      setLoading(false);
    }
  };

  const handleFlip = () => {
    setFlipped(!flipped);
  };

  const calculateNextRecall = (presence) => {
    // Calculate days until next review based on presence^2
    const daysUntilNextReview = Math.pow(presence, 2);
    // Convert days to milliseconds and add to current time
    return new Date(Date.now() + daysUntilNextReview * 24 * 60 * 60 * 1000).toISOString();
  };

  const reviewFlashcard = async (reviewType) => {
    if (currentFlashcardIndex >= dueFlashcards.length) return;

    const flashcard = dueFlashcards[currentFlashcardIndex];
    
    try {
      // First, get current presence
      const presenceResponse = await axios.get(
        `http://localhost:50500/flashcards/${flashcard.id}/presence`
      );
      let currentPresence = presenceResponse.data.presence || 0;
      let newPresence;
      let nextRecall;

      // Calculate new presence and next recall based on review type
      switch (reviewType) {
        case "Again":
          newPresence = 0;
          nextRecall = new Date().toISOString(); // Due immediately
          break;
        case "Challenging":
          newPresence = currentPresence + 0.5;
          nextRecall = calculateNextRecall(newPresence);
          break;
        case "Good":
          newPresence = currentPresence + 1;
          nextRecall = calculateNextRecall(newPresence);
          break;
        default:
          return;
      }

      // Update presence
      await axios.put(
        `http://localhost:50500/flashcards/${flashcard.id}/presence`,
        { presence: newPresence }
      );

      // Update next recall date
      await axios.put(
        `http://localhost:50500/flashcards/${flashcard.id}/review`,
        { next_recall: nextRecall }
      );

      setFlipped(false);
      if (currentFlashcardIndex < dueFlashcards.length - 1) {
        setCurrentFlashcardIndex(currentFlashcardIndex + 1);
      } else {
        setDueFlashcards([]);
      }
    } catch (err) {
      console.error("Error reviewing flashcard:", err);
      alert("Failed to review flashcard. Please try again.");
    }
  };

  const currentFlashcard = dueFlashcards[currentFlashcardIndex];

  return (
    <div className="flashcard-trainer-container">
      <h1>Flashcard Trainer</h1>
      {loading ? (
        <p>Loading flashcards...</p>
      ) : error ? (
        <p className="error">{error}</p>
      ) : dueFlashcards.length === 0 ? (
        <p>No flashcards due for review!</p>
      ) : (
        <div className="flashcard-trainer">
          <div
            className={`flashcard-item ${flipped ? "flipped" : ""}`}
            onClick={handleFlip}
          >
            <div className="flashcard-content">
              {flipped ? (
                <div className="flashcard-back">
                  <strong>{currentFlashcard.name}</strong>
                  <p>{currentFlashcard.back}</p>
                </div>
              ) : (
                <div className="flashcard-front">
                  <strong>{currentFlashcard.name}</strong>
                  <p>{currentFlashcard.front}</p>
                </div>
              )}
            </div>
          </div>
          <div className="review-buttons">
            <button
              onClick={() => reviewFlashcard("Again")}
              className="review-button again"
            >
              Again
            </button>
            <button
              onClick={() => reviewFlashcard("Challenging")}
              className="review-button challenging"
            >
              Challenging
            </button>
            <button
              onClick={() => reviewFlashcard("Good")}
              className="review-button good"
            >
              Good
            </button>
          </div>
        </div>
      )}
    </div>
  );
}