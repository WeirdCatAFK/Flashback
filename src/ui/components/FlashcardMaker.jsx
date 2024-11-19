import React, { useState, useEffect } from "react";
import "./FlashCardMaker.css";
import axios from "axios";

// A form for creating a new flashcard
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

// A flip-card component for each flashcard
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

// A list of flashcards (to be created or existing) with flip-card functionality
function FlashcardList({ title, flashcards }) {
  return (
    <div className="flashcard-list">
      <h2>{title}</h2>
      {flashcards.length === 0 ? (
        <p>No flashcards available.</p>
      ) : (
        flashcards.map((fc, index) => <Flashcard key={index} flashcard={fc} />)
      )}
    </div>
  );
}

// Display a flashcard with more details using flip-cards
function FlashcardDisplay({ flashcards }) {
  return (
    <div className="document-flashcards">
      <h2>Existing Flashcards for this Document</h2>
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

  // Fetch existing flashcards for the document on component mount
  useEffect(() => {
    const fetchDocumentFlashcards = async () => {
      try {
        const response = await axios.get(
          `http://localhost:50500/flashcards/document/${documentId}`
        );
        setDocumentFlashcards(response.data);
      } catch (error) {
        console.error("Error fetching flashcards:", error);
        alert("Failed to fetch flashcards for this document.");
      }
    };

    if (documentId) {
      fetchDocumentFlashcards();
    }
  }, [documentId]);

  // Handle input changes for the current flashcard form
  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setCurrentFlashcard((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  // Add the current flashcard to the list of flashcards to be created
  const addFlashcard = () => {
    if (
      currentFlashcard.name &&
      currentFlashcard.front &&
      currentFlashcard.back
    ) {
      setFlashcards([...flashcards, currentFlashcard]);
      setCurrentFlashcard({ name: "", front: "", back: "" });
    }
  };

  // Send flashcards to the backend endpoint
  const saveFlashcards = async () => {
    try {
      for (const flashcard of flashcards) {
        const { name, front, back } = flashcard;
        await axios.post("http://localhost:50500/flashcards", {
          document_id: documentId,
          name,
          front,
          back,
        });
      }
      alert("Flashcards saved successfully!");
      setFlashcards([]); // Clear saved flashcards after successful save
      fetchDocumentFlashcards(); // Refresh the document flashcards
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
      <FlashcardList title="Flashcards to Save" flashcards={flashcards} />
      <button onClick={saveFlashcards} disabled={flashcards.length === 0}>
        Save All Flashcards
      </button>
      <FlashcardDisplay flashcards={documentFlashcards} />
    </div>
  );
}
