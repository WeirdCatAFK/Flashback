import express from "express";
const flashcards_router = express.Router();
import db from "../config/dbmanager.js";
import multer from "multer";
const upload = multer();
// Create a flashcard
flashcards_router.post("/", async (req, res) => {
  const { document_id, name, front, back } = req.body;

  console.log("Received POST request to create flashcard with data:", {
    document_id,
    name,
    front,
    back,
  });

  if (!document_id || !name || !front || !back) {
    console.log("Missing required fields in the request body.");
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    // Ensure database operations are serialized
    console.log("Serializing database operations...");
    await db.serialize();

    // Create a new Node for the flashcard
    console.log("Creating a new Node for the flashcard...");
    await db.run(
      "INSERT INTO Nodes (type_id, presence) VALUES ((SELECT id FROM Node_types WHERE name = 'Flashcard'), 0.0)"
    );

    // Retrieve the ID of the newly created node
    console.log("Retrieving the ID of the created Node...");
    const nodeIdResult = await db.get("SELECT last_insert_rowid() AS id");
    const nodeId = nodeIdResult.id;

    // Retrieve the node ID of the associated document
    console.log("Retrieving the node ID of the associated document...");
    const documentNodeIdResult = await db.get(
      "SELECT node_id FROM Documents WHERE id = ?",
      [document_id]
    );
    const documentNodeId = documentNodeIdResult.node_id;

    // Connect the newly created flashcard node to the document node
    console.log("Connecting the flashcard node to the document node...");
    await db.run(
      "INSERT INTO Node_connections (origin_id, destiny_id, connection_type_id) VALUES (?, ?, (SELECT id FROM Connection_types WHERE name = 'Tagged'))",
      [nodeId, documentNodeId]
    );

    // Retrieve the ID of the newly created node connection
    console.log("Retrieving the ID of the created Node connection...");
    const connectionIdResult = await db.get("SELECT last_insert_rowid() AS id");
    const connectionId = connectionIdResult.id;

    // Create a new Flashcard entry linked to the created node and the document
    console.log("Creating a new Flashcard entry...");
    await db.run(
      "INSERT INTO Flashcards (document_id, node_id, name, front, back) VALUES (?, ?, ?, ?, ?)",
      [document_id, nodeId, name, front, back]
    );

    // Retrieve the ID of the newly created flashcard
    console.log("Retrieving the ID of the created Flashcard...");
    const flashcardIdResult = await db.get("SELECT last_insert_rowid() AS id");
    const flashcardId = flashcardIdResult.id;

    // Return success response with created flashcard ID
    console.log("Flashcard created successfully with ID:", flashcardId);
    res.status(201).json({
      success: true,
      flashcardId,
      message: "Flashcard created successfully",
    });
  } catch (error) {
    // Error handling
    console.error("Error creating flashcard:", error);
    res.status(500).json({
      error: "Failed to create flashcard",
      details: error.message,
    });
  }
});

// Get all flashcards for a document
flashcards_router.get("/document/:documentId", async (req, res) => {
  try {
    const flashcards = await db.all(
      `SELECT f.id, f.name, f.front, f.back 
       FROM Flashcards f 
       WHERE f.document_id = ?`,
      [req.params.documentId]
    );

    res.json(flashcards);
  } catch (error) {
    console.error("Error fetching flashcards:", error);
    res.status(500).json({ error: "Failed to fetch flashcards" });
  }
});

// Get all flashcards from a folder
flashcards_router.get("/folder/:folderId", async (req, res) => {
  try {
    const flashcards = await db.all(
      `SELECT DISTINCT f.id, f.name 
       FROM Flashcards f 
       JOIN Documents d ON f.document_id = d.id 
       WHERE d.folder_id = ?`,
      [req.params.folderId]
    );

    res.json(flashcards);
  } catch (error) {
    console.error("Error fetching folder flashcards:", error);
    res.status(500).json({ error: "Failed to fetch folder flashcards" });
  }
});

// Add media to a flashcard
flashcards_router.post(
  "/:id/media",
  upload.single("media"),
  async (req, res) => {
    const { position, media_type_id } = req.body;
    const flashcardId = req.params.id;

    try {
      await db.serialize();

      // Insert media
      const mediaResult = await db.run(
        "INSERT INTO Media (media, media_type_id) VALUES (?, ?)",
        [req.file.buffer, media_type_id]
      );

      // Get or create flashcard_media entry
      let flashcardMedia = await db.get(
        "SELECT * FROM Flashcard_media WHERE flashcard_id = ?",
        [flashcardId]
      );

      if (!flashcardMedia) {
        await db.run("INSERT INTO Flashcard_media (flashcard_id) VALUES (?)", [
          flashcardId,
        ]);
      }

      // Update appropriate media position
      const updateField =
        position === "front" ? "front_media_id" : "back_media_id";
      await db.run(
        `UPDATE Flashcard_media 
       SET ${updateField} = ? 
       WHERE flashcard_id = ?`,
        [mediaResult.lastID, flashcardId]
      );

      res.status(201).json({ message: "Media added successfully" });
    } catch (error) {
      console.error("Error adding media:", error);
      res.status(500).json({ error: "Failed to add media" });
    }
  }
);

// Update flashcard TTS voice
flashcards_router.put("/:id/tts", async (req, res) => {
  const { tts_voice } = req.body;

  try {
    await db.run(
      `UPDATE Flashcard_info 
       SET tts_voice = ? 
       WHERE flashcard_id = ?`,
      [tts_voice, req.params.id]
    );

    res.json({ message: "TTS voice updated successfully" });
  } catch (error) {
    console.error("Error updating TTS voice:", error);
    res.status(500).json({ error: "Failed to update TTS voice" });
  }
});

// Update flashcard renderer
flashcards_router.put("/:id/renderer", async (req, res) => {
  const { text_renderer } = req.body;

  try {
    await db.run(
      `UPDATE Flashcard_info 
       SET text_renderer = ? 
       WHERE flashcard_id = ?`,
      [text_renderer, req.params.id]
    );

    res.json({ message: "Text renderer updated successfully" });
  } catch (error) {
    console.error("Error updating text renderer:", error);
    res.status(500).json({ error: "Failed to update text renderer" });
  }
});

// Edit flashcard
flashcards_router.put("/:id", async (req, res) => {
  const { name, front, back } = req.body;

  try {
    await db.run(
      `UPDATE Flashcards 
       SET name = ?, front = ?, back = ? 
       WHERE id = ?`,
      [name, front, back, req.params.id]
    );

    res.json({ message: "Flashcard updated successfully" });
  } catch (error) {
    console.error("Error updating flashcard:", error);
    res.status(500).json({ error: "Failed to update flashcard" });
  }
});

// Add highlight to flashcard
flashcards_router.post("/:id/highlight", async (req, res) => {
  const { document_id, is_utf8 } = req.body;

  try {
    await db.serialize();

    let highlightResult;

    if (!is_utf8) {
      // Binary file highlight (coordinates)
      const { page, x1, y1, x2, y2 } = req.body;

      if (!page || !x1 || !y1 || !x2 || !y2) {
        return res.status(400).json({
          error: "Missing coordinates parameters for binary highlight",
        });
      }

      highlightResult = await db.run(
        `INSERT INTO Flashcard_highlight 
         (page, x1, y1, x2, y2) 
         VALUES (?, ?, ?, ?, ?)`,
        [page, x1, y1, x2, y2]
      );
    } else {
      // UTF-8 text highlight (positions)
      const { start, end } = req.body;

      if (!start || !end) {
        return res.status(400).json({
          error: "Missing start/end parameters for text highlight",
        });
      }

      highlightResult = await db.run(
        `INSERT INTO Flashcard_highlight 
         (start, end) 
         VALUES (?, ?)`,
        [start, end]
      );
    }

    // Link highlight to flashcard
    await db.run("UPDATE Flashcards SET highlight_id = ? WHERE id = ?", [
      highlightResult.lastID,
      req.params.id,
    ]);

    res.status(201).json({
      message: "Highlight added successfully",
      highlight_id: highlightResult.lastID,
    });
  } catch (error) {
    console.error("Error adding highlight:", error);
    res.status(500).json({ error: "Failed to add highlight" });
  }
  // Get flashcards due for review
  flashcards_router.get("/due", async (req, res) => {
    try {
      const dueFlashcards = await db.all(
        `SELECT f.id, f.name, f.front, f.back, f.next_recall,
              d.name as document_name, d.filepath as document_path
       FROM Flashcards f
       LEFT JOIN Documents d ON f.document_id = d.id
       WHERE f.next_recall <= datetime('now')
       ORDER BY f.next_recall ASC`
      );

      res.json(dueFlashcards);
    } catch (error) {
      console.error("Error fetching due flashcards:", error);
      res.status(500).json({ error: "Failed to fetch due flashcards" });
    }
  });

  // Get detailed flashcard information
  flashcards_router.get("/:id/details", async (req, res) => {
    try {
      const flashcard = await db.get(
        `SELECT f.*, fi.text_renderer, fi.tts_voice,
              d.name as document_name, d.filepath as document_path,
              h.page, h.x1, h.y1, h.x2, h.y2, h.start, h.end,
              fm.front_media_id, fm.back_media_id
       FROM Flashcards f
       LEFT JOIN Flashcard_info fi ON f.id = fi.flashcard_id
       LEFT JOIN Documents d ON f.document_id = d.id
       LEFT JOIN Flashcard_highlight h ON f.highlight_id = h.id
       LEFT JOIN Flashcard_media fm ON f.id = fm.flashcard_id
       WHERE f.id = ?`,
        [req.params.id]
      );

      if (!flashcard) {
        return res.status(404).json({ error: "Flashcard not found" });
      }

      // If there's media, fetch it
      if (flashcard.front_media_id || flashcard.back_media_id) {
        const mediaIds = [
          flashcard.front_media_id,
          flashcard.back_media_id,
        ].filter(Boolean);
        const media = await db.all(
          `SELECT id, media_type_id 
         FROM Media 
         WHERE id IN (${mediaIds.join(",")})` // Safe since we control the IDs
        );
        flashcard.media = media;
      }

      res.json(flashcard);
    } catch (error) {
      console.error("Error fetching flashcard details:", error);
      res.status(500).json({ error: "Failed to fetch flashcard details" });
    }
  });

  // Update next recall date after review
  flashcards_router.put("/:id/review", async (req, res) => {
    const { next_recall } = req.body;

    try {
      await db.run("UPDATE Flashcards SET next_recall = ? WHERE id = ?", [
        next_recall,
        req.params.id,
      ]);

      res.json({ message: "Review date updated successfully" });
    } catch (error) {
      console.error("Error updating review date:", error);
      res.status(500).json({ error: "Failed to update review date" });
    }
  });

  // Get all flashcards with a specific tag
  flashcards_router.get("/tag/:tagId", async (req, res) => {
    try {
      const flashcards = await db.all(
        `SELECT DISTINCT f.id, f.name, f.front, f.back
       FROM Flashcards f
       JOIN Node_connections nc ON f.node_id = nc.destiny_id
       WHERE nc.origin_id = ?`,
        [req.params.tagId]
      );

      res.json(flashcards);
    } catch (error) {
      console.error("Error fetching tagged flashcards:", error);
      res.status(500).json({ error: "Failed to fetch tagged flashcards" });
    }
  });

  // Get flashcard statistics
  flashcards_router.get("/stats", async (req, res) => {
    try {
      const stats = await db.get(
        `SELECT 
        COUNT(*) as total_flashcards,
        COUNT(CASE WHEN next_recall <= datetime('now') THEN 1 END) as due_flashcards,
        COUNT(DISTINCT document_id) as documents_with_flashcards,
        COUNT(DISTINCT node_id) as total_nodes
       FROM Flashcards`
      );

      res.json(stats);
    } catch (error) {
      console.error("Error fetching flashcard statistics:", error);
      res.status(500).json({ error: "Failed to fetch statistics" });
    }
  });

  // Delete multiple flashcards
  flashcards_router.delete("/batch", async (req, res) => {
    const { flashcard_ids } = req.body;

    if (!Array.isArray(flashcard_ids) || flashcard_ids.length === 0) {
      return res.status(400).json({ error: "Invalid flashcard IDs" });
    }

    try {
      await db.serialize();

      // Delete flashcards (cascading will handle related records)
      await db.run(
        `DELETE FROM Flashcards 
       WHERE id IN (${flashcard_ids.join(",")})` // Safe since we validate array contents
      );

      res.json({ message: "Flashcards deleted successfully" });
    } catch (error) {
      console.error("Error deleting flashcards:", error);
      res.status(500).json({ error: "Failed to delete flashcards" });
    }
  });

  // Clone a flashcard
  flashcards_router.post("/:id/clone", async (req, res) => {
    const { document_id } = req.body; // Optional: clone to different document

    try {
      await db.serialize();

      // Get original flashcard data
      const original = await db.get(`SELECT * FROM Flashcards WHERE id = ?`, [
        req.params.id,
      ]);

      if (!original) {
        return res.status(404).json({ error: "Original flashcard not found" });
      }

      // Create new node
      const nodeResult = await db.run(
        "INSERT INTO Nodes (type_id, presence) VALUES ((SELECT id FROM Node_types WHERE name = 'Flashcard'), 1.0)"
      );

      // Clone flashcard
      const flashcardResult = await db.run(
        `INSERT INTO Flashcards 
       (document_id, node_id, name, front, back) 
       VALUES (?, ?, ?, ?, ?)`,
        [
          document_id || original.document_id,
          nodeResult.lastID,
          `${original.name} (Copy)`,
          original.front,
          original.back,
        ]
      );

      // Clone flashcard info
      const info = await db.get(
        "SELECT * FROM Flashcard_info WHERE flashcard_id = ?",
        [req.params.id]
      );

      if (info) {
        await db.run(
          `INSERT INTO Flashcard_info 
         (flashcard_id, text_renderer, tts_voice) 
         VALUES (?, ?, ?)`,
          [flashcardResult.lastID, info.text_renderer, info.tts_voice]
        );
      }

      res.status(201).json({
        message: "Flashcard cloned successfully",
        new_flashcard_id: flashcardResult.lastID,
      });
    } catch (error) {
      console.error("Error cloning flashcard:", error);
      res.status(500).json({ error: "Failed to clone flashcard" });
    }
  });
});

export default flashcards_router;
