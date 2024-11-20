import React, { useState, useEffect } from "react";
import "./FlashCardMaker.css";
import axios from "axios";

// Flashcard Form Component
function FlashcardForm({ currentFlashcard, onChange, onAdd }) {
  return (
    <div className="flashcard-form">
      <input
        type="text"
        name="name"
        placeholder="Enter flashcard title"
        value={currentFlashcard.name}
        onChange={onChange}
      />
      <textarea
        name="front"
        placeholder="Enter Front"
        value={currentFlashcard.front}
        onChange={onChange}
      ></textarea>
      <textarea
        name="back"
        placeholder="Enter Back"
        value={currentFlashcard.back}
        onChange={onChange}
      ></textarea>
      <button onClick={onAdd}>Add Flashcard</button>
    </div>
  );
}

// Single Flashcard Component
function Flashcard({ flashcard, onDelete, showDeleteButton }) {
  const [flipped, setFlipped] = useState(false);

  const toggleFlip = () => setFlipped(!flipped);

  const handleDelete = async (e) => {
    e.stopPropagation();
    try {
      await axios.delete(`http://localhost:50500/flashcards/${flashcard.id}`);
      onDelete(flashcard.id);
    } catch (error) {
      console.error("Error deleting flashcard:", error);
      alert("Failed to delete flashcard. Please try again.");
    }
  };

  return (
    <div
      className={`flashcard-item ${flipped ? "flipped" : ""}`}
      onClick={toggleFlip}
    >
      <div className="flashcard-content">
        <div className="flashcard-front">
          <strong>{flashcard.name}</strong>
          <p>{flashcard.front}</p>
          {showDeleteButton && (
            <button onClick={handleDelete} className="delete-button">
              Delete
            </button>
          )}
        </div>
        <div className="flashcard-back">
          <strong>{flashcard.name}</strong>
          <p>{flashcard.back}</p>
        </div>
      </div>
    </div>
  );
}

// Flashcard List Component
function FlashcardList({ title, flashcards, onDelete, showDeleteButton }) {
  if (flashcards.length === 0) {
    return (
      <div className="flashcard-list">
        <h2>{title}</h2>
      </div>
    );
  }

  return (
    <div className="flashcard-list">
      <h2>{title}</h2>
      {flashcards.map((fc) => (
        <Flashcard
          key={fc.id}
          flashcard={fc}
          onDelete={onDelete}
          showDeleteButton={showDeleteButton}
        />
      ))}
    </div>
  );
}

// Main FlashCardMaker Component
export default function FlashCardMaker({ documentId }) {
  const [flashcards, setFlashcards] = useState([]);
  const [currentFlashcard, setCurrentFlashcard] = useState({
    name: "",
    front: "",
    back: "",
  });
  const [documentFlashcards, setDocumentFlashcards] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!documentId) return;

    setLoading(true);
    setError(null);

    axios
      .get(`http://localhost:50500/flashcards/document/${documentId}`)
      .then((response) => setDocumentFlashcards(response.data))
      .catch((err) => {
        console.error("Error fetching flashcards:", err);
        setError("Failed to fetch flashcards for this document.");
      })
      .finally(() => setLoading(false));
  }, [documentId]);

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setCurrentFlashcard((prev) => ({ ...prev, [name]: value }));
  };

  const addFlashcard = () => {
    if (!currentFlashcard.name || !currentFlashcard.front || !currentFlashcard.back) {
      console.warn("Incomplete flashcard data:", currentFlashcard);
      return;
    }
    setFlashcards((prev) => [...prev, currentFlashcard]);
    setCurrentFlashcard({ name: "", front: "", back: "" });
  };

  const saveFlashcards = async () => {
    try {
      await Promise.all(
        flashcards.map((flashcard) =>
          axios.post("http://localhost:50500/flashcards/", {
            document_id: documentId,
            name: flashcard.name,
            front: flashcard.front,
            back: flashcard.back,
          })
        )
      );
      setFlashcards([]);
      fetchDocumentFlashcards();
    } catch (error) {
      console.error("Error saving flashcards:", error);
      alert("Failed to save flashcards. Please try again.");
    }
  };

  const fetchDocumentFlashcards = () => {
    setLoading(true);
    axios
      .get(`http://localhost:50500/flashcards/document/${documentId}`)
      .then((response) => setDocumentFlashcards(response.data))
      .catch((err) => console.error(err))
      .finally(() => setLoading(false));
  };

  const handleDeleteFlashcard = (id) => {
    setDocumentFlashcards((prev) => prev.filter((fc) => fc.id !== id));
  };

  return (
    <div className="flashcard-maker-container">
      <h1>Flashcard Maker!</h1>
      <FlashcardForm
        currentFlashcard={currentFlashcard}
        onChange={handleInputChange}
        onAdd={addFlashcard}
      />
      <FlashcardList
        title="Plotted"
        flashcards={flashcards}
        showDeleteButton={false}
      />
      <button onClick={saveFlashcards} disabled={flashcards.length === 0}>
        Save Flashcards
      </button>
      {loading ? (
        <p>Loading flashcards...</p>
      ) : error ? (
        <p className="error">{error}</p>
      ) : (
        <FlashcardList
          title="Flashcards"
          flashcards={documentFlashcards}
          onDelete={handleDeleteFlashcard}
          showDeleteButton={true}
        />
      )}
    </div>
  );
}
