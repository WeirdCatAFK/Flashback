import React, { useState, useEffect } from "react";
import "./FlashCardMaker.css";
import axios from "axios";

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
        placeholder="Enter question or content for the front side"
        value={currentFlashcard.front}
        onChange={onChange}
      ></textarea>
      <textarea
        name="back"
        placeholder="Enter answer or details for the back side"
        value={currentFlashcard.back}
        onChange={onChange}
      ></textarea>
      <button onClick={onAdd}>Add Flashcard</button>
    </div>
  );
}

function Flashcard({ flashcard }) {
  const [flipped, setFlipped] = useState(false);

  const toggleFlip = () => {
    setFlipped(!flipped);
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
        </div>
        <div className="flashcard-back">
          <strong>{flashcard.name}</strong>
          <p>{flashcard.back}</p>
        </div>
      </div>
    </div>
  );
}

function FlashcardList({ title, flashcards }) {
  return (
    <div className="flashcard-list">
      <h2>{title}</h2>
      {flashcards.length === 0 ? (
        <p></p>
      ) : (
        flashcards.map((fc, index) => <Flashcard key={index} flashcard={fc} />)
      )}
    </div>
  );
}

function FlashcardDisplay({ flashcards }) {
  return (
    <div className="document-flashcards">
      <h2>Flashcards</h2>
      {flashcards.length === 0 ? (
        <p>No flashcards found for this document.</p>
      ) : (
        flashcards.map((fc) => <Flashcard key={fc.id} flashcard={fc} />)
      )}
    </div>
  );
}

export default function FlashCardMaker({ documentId }) {
  const [flashcards, setFlashcards] = useState([]);
  const [currentFlashcard, setCurrentFlashcard] = useState({
    name: "",
    front: "",
    back: "",
  });
  const [documentFlashcards, setDocumentFlashcards] = useState([]);
  const [loading, setLoading] = useState(false); // Loading state
  const [error, setError] = useState(null); // Error state

  // Fetch existing flashcards for the document
  useEffect(() => {
    if (documentId) {
      setLoading(true);
      setError(null);

      axios
        .get(`http://localhost:50500/flashcards/document/${documentId}`)
        .then((response) => {
          setDocumentFlashcards(response.data);
          console.log("Fetched flashcards:", response.data);
        })
        .catch((err) => {
          console.error("Error fetching flashcards:", err);
          setError("Failed to fetch flashcards for this document.");
        })
        .finally(() => setLoading(false));
    }
  }, [documentId]);

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setCurrentFlashcard((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const addFlashcard = () => {
    if (
      currentFlashcard.name &&
      currentFlashcard.front &&
      currentFlashcard.back
    ) {
      setFlashcards([...flashcards, currentFlashcard]);
      setCurrentFlashcard({ name: "", front: "", back: "" });
    } else {
      console.warn("Incomplete flashcard data:", currentFlashcard);
    }
  };

  const saveFlashcards = async () => {
    try {
      for (const flashcard of flashcards) {
        const { name, front, back } = flashcard;
        await axios.post("http://localhost:50500/flashcards/", {
          document_id: documentId,
          name: name,
          front: front,
          back : back,
        });
      }
      alert("Flashcards saved successfully!");
      setFlashcards([]);
      setLoading(true); 
      axios
        .get(`http://localhost:50500/flashcards/document/${documentId}`)
        .then((response) => setDocumentFlashcards(response.data))
        .finally(() => setLoading(false));
    } catch (error) {
      console.error("Error saving flashcards:", error);
      alert("Failed to save flashcards. Please try again.");
    }
  };

  return (
    <div className="flashcard-maker-container">
      <h1>Flashcard Maker!</h1>
      <FlashcardForm
        currentFlashcard={currentFlashcard}
        onChange={handleInputChange}
        onAdd={addFlashcard}
      />
      <FlashcardList title="Plotted" flashcards={flashcards} />
      <button onClick={saveFlashcards} disabled={flashcards.length === 0}>
        Save All Flashcards
      </button>
      {loading ? (
        <p>Loading flashcards...</p>
      ) : error ? (
        <p className="error">{error}</p>
      ) : (
        <FlashcardDisplay flashcards={documentFlashcards} />
      )}
    </div>
  );
}
