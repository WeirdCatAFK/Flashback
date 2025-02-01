import express from 'express';
const tags_router = express.Router();
import db from '../config/DatabaseManager.js';

tags_router.use(express.json());

// Create a new tag
tags_router.post("/", async (req, res) => {
  let transaction = false;
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({
        code: 400,
        message: "Tag name is required",
      });
    }

    // Check if tag already exists
    const existingTag = await db.get("SELECT id FROM Tags WHERE name = ?", [
      name,
    ]);
    if (existingTag) {
      return res.status(200).json({
        code: 200,
        message: "Tag already exists",
        tagId: existingTag.id,
      });
    }

    await db.run("BEGIN TRANSACTION");
    transaction = true;

    // Create node for tag
    await db.run(
      "INSERT INTO Nodes (type_id, presence) VALUES ((SELECT id FROM Node_types WHERE name = 'Tag'), 0.0)"
    );
    const nodeResult = await db.get("SELECT last_insert_rowid() as lastID");

    // Create tag entry
    await db.run("INSERT INTO Tags (id, name) VALUES (?, ?)", [
      nodeResult.lastID,
      name,
    ]);

    await db.run("COMMIT");
    transaction = false;

    return res.status(201).json({
      code: 201,
      message: "Tag created successfully",
      tagId: nodeResult.lastID,
    });
  } catch (error) {
    if (transaction) {
      await db.run("ROLLBACK");
    }
    return res.status(500).json({
      code: 500,
      message: "Error creating tag: " + error.message,
    });
  }
});

// Get all tags
tags_router.get("/", async (req, res) => {
  try {
    const tags = await db.all(`
      SELECT t.id, t.name, n.presence 
      FROM Tags t 
      JOIN Nodes n ON t.id = n.id
      ORDER BY t.name`);
    return res.status(200).json({ code: 200, tags });
  } catch (error) {
    return res.status(500).json({
      code: 500,
      message: "Error retrieving tags: " + error.message,
    });
  }
});

// Rename a tag
tags_router.put("/:tagId", async (req, res) => {
  let transaction = false;
  try {
    const { tagId } = req.params;
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({
        code: 400,
        message: "New tag name is required",
      });
    }

    await db.run("BEGIN TRANSACTION");
    transaction = true;

    const result = await db.run("UPDATE Tags SET name = ? WHERE id = ?", [
      name,
      tagId,
    ]);

    if (result.changes === 0) {
      await db.run("ROLLBACK");
      return res.status(404).json({
        code: 404,
        message: "Tag not found",
      });
    }

    await db.run("COMMIT");
    transaction = false;

    return res.status(200).json({
      code: 200,
      message: "Tag renamed successfully",
    });
  } catch (error) {
    if (transaction) {
      await db.run("ROLLBACK");
    }
    return res.status(500).json({
      code: 500,
      message: "Error renaming tag: " + error.message,
    });
  }
});

// Delete a tag
tags_router.delete("/:tagId", async (req, res) => {
  let transaction = false;
  try {
    const { tagId } = req.params;

    await db.run("BEGIN TRANSACTION");
    transaction = true;

    // Delete tag (will cascade to Nodes and Inherited_tags)
    const result = await db.run("DELETE FROM Tags WHERE id = ?", [tagId]);

    if (result.changes === 0) {
      await db.run("ROLLBACK");
      return res.status(404).json({
        code: 404,
        message: "Tag not found",
      });
    }

    await db.run("COMMIT");
    transaction = false;

    return res.status(200).json({
      code: 200,
      message: "Tag deleted successfully",
    });
  } catch (error) {
    if (transaction) {
      await db.run("ROLLBACK");
    }
    return res.status(500).json({
      code: 500,
      message: "Error deleting tag: " + error.message,
    });
  }
});

// Add tag to a document and its flashcards
tags_router.post("/document/:documentId/tag/:tagId", async (req, res) => {
  let transaction = false;
  try {
    const { documentId, tagId } = req.params;

    await db.run("BEGIN TRANSACTION");
    transaction = true;

    // Get document's node_id
    const document = await db.get(
      "SELECT node_id FROM Documents WHERE id = ?",
      [documentId]
    );
    if (!document) {
      await db.run("ROLLBACK");
      return res.status(404).json({
        code: 404,
        message: "Document not found",
      });
    }

    // Create connection between document and tag
    await db.run(
      "INSERT INTO Node_connections (origin_id, destiny_id, connection_type_id) VALUES (?, ?, (SELECT id FROM Connection_types WHERE name = 'Tagged'))",
      [document.node_id, tagId]
    );
    const connectionResult = await db.get(
      "SELECT last_insert_rowid() as lastID"
    );

    // Record inheritance
    await db.run(
      "INSERT INTO Inherited_tags (connection_id, tag_id) VALUES (?, ?)",
      [connectionResult.lastID, tagId]
    );

    // Get all flashcards associated with the document
    const flashcards = await db.all(
      "SELECT node_id FROM Flashcards WHERE document_id = ?",
      [documentId]
    );

    // Create connections for all flashcards
    for (const flashcard of flashcards) {
      await db.run(
        "INSERT INTO Node_connections (origin_id, destiny_id, connection_type_id) VALUES (?, ?, (SELECT id FROM Connection_types WHERE name = 'Tagged'))",
        [flashcard.node_id, tagId]
      );
      const flashcardConnectionResult = await db.get(
        "SELECT last_insert_rowid() as lastID"
      );

      await db.run(
        "INSERT INTO Inherited_tags (connection_id, tag_id) VALUES (?, ?)",
        [flashcardConnectionResult.lastID, tagId]
      );
    }

    await db.run("COMMIT");
    transaction = false;

    return res.status(200).json({
      code: 200,
      message: "Tag added to document and its flashcards successfully",
    });
  } catch (error) {
    if (transaction) {
      await db.run("ROLLBACK");
    }
    return res.status(500).json({
      code: 500,
      message: "Error adding tag: " + error.message,
    });
  }
});

// Add tag to a folder and all its contents
tags_router.post("/folder/:folderId/tag/:tagId", async (req, res) => {
  let transaction = false;
  try {
    const { folderId, tagId } = req.params;

    await db.run("BEGIN TRANSACTION");
    transaction = true;

    // Get folder's node_id
    const folder = await db.get("SELECT node_id FROM Folders WHERE id = ?", [
      folderId,
    ]);
    if (!folder) {
      await db.run("ROLLBACK");
      return res.status(404).json({
        code: 404,
        message: "Folder not found",
      });
    }

    // Create connection between folder and tag
    await db.run(
      "INSERT INTO Node_connections (origin_id, destiny_id, connection_type_id) VALUES (?, ?, (SELECT id FROM Connection_types WHERE name = 'Tagged'))",
      [folder.node_id, tagId]
    );
    const folderConnectionResult = await db.get(
      "SELECT last_insert_rowid() as lastID"
    );

    // Record inheritance
    await db.run(
      "INSERT INTO Inherited_tags (connection_id, tag_id) VALUES (?, ?)",
      [folderConnectionResult.lastID, tagId]
    );

    // Get all documents in the folder
    const documents = await db.all(
      "SELECT id, node_id FROM Documents WHERE folder_id = ?",
      [folderId]
    );

    // Create connections for all documents and their flashcards
    for (const document of documents) {
      // Tag document
      await db.run(
        "INSERT INTO Node_connections (origin_id, destiny_id, connection_type_id) VALUES (?, ?, (SELECT id FROM Connection_types WHERE name = 'Tagged'))",
        [document.node_id, tagId]
      );
      const docConnectionResult = await db.get(
        "SELECT last_insert_rowid() as lastID"
      );

      await db.run(
        "INSERT INTO Inherited_tags (connection_id, tag_id) VALUES (?, ?)",
        [docConnectionResult.lastID, tagId]
      );

      // Tag document's flashcards
      const flashcards = await db.all(
        "SELECT node_id FROM Flashcards WHERE document_id = ?",
        [document.id]
      );

      for (const flashcard of flashcards) {
        await db.run(
          "INSERT INTO Node_connections (origin_id, destiny_id, connection_type_id) VALUES (?, ?, (SELECT id FROM Connection_types WHERE name = 'Tagged'))",
          [flashcard.node_id, tagId]
        );
        const flashcardConnectionResult = await db.get(
          "SELECT last_insert_rowid() as lastID"
        );

        await db.run(
          "INSERT INTO Inherited_tags (connection_id, tag_id) VALUES (?, ?)",
          [flashcardConnectionResult.lastID, tagId]
        );
      }
    }

    await db.run("COMMIT");
    transaction = false;

    return res.status(200).json({
      code: 200,
      message: "Tag added to folder and its contents successfully",
    });
  } catch (error) {
    if (transaction) {
      await db.run("ROLLBACK");
    }
    return res.status(500).json({
      code: 500,
      message: "Error adding tag: " + error.message,
    });
  }
});

// Remove tag from a document and its flashcards
tags_router.delete("/document/:documentId/tag/:tagId", async (req, res) => {
  let transaction = false;
  try {
    const { documentId, tagId } = req.params;

    await db.run("BEGIN TRANSACTION");
    transaction = true;

    // Get document's node_id
    const document = await db.get(
      "SELECT node_id FROM Documents WHERE id = ?",
      [documentId]
    );
    if (!document) {
      await db.run("ROLLBACK");
      return res.status(404).json({
        code: 404,
        message: "Document not found",
      });
    }

    // Remove connections and inherited tags will be removed by cascade
    const result = await db.run(
      `DELETE FROM Node_connections 
       WHERE origin_id = ? AND destiny_id = ? 
       AND connection_type_id = (SELECT id FROM Connection_types WHERE name = 'Tagged')`,
      [document.node_id, tagId]
    );

    if (result.changes === 0) {
      await db.run("ROLLBACK");
      return res.status(404).json({
        code: 404,
        message: "Tag not found on document",
      });
    }

    // Remove tags from flashcards
    const flashcards = await db.all(
      "SELECT node_id FROM Flashcards WHERE document_id = ?",
      [documentId]
    );

    for (const flashcard of flashcards) {
      await db.run(
        `DELETE FROM Node_connections 
         WHERE origin_id = ? AND destiny_id = ? 
         AND connection_type_id = (SELECT id FROM Connection_types WHERE name = 'Tagged')`,
        [flashcard.node_id, tagId]
      );
    }

    await db.run("COMMIT");
    transaction = false;

    return res.status(200).json({
      code: 200,
      message: "Tag removed from document and its flashcards successfully",
    });
  } catch (error) {
    if (transaction) {
      await db.run("ROLLBACK");
    }
    return res.status(500).json({
      code: 500,
      message: "Error removing tag: " + error.message,
    });
  }
});

// Get all tags for a node (document/folder/flashcard)
tags_router.get("/node/:nodeId", async (req, res) => {
  try {
    const { nodeId } = req.params;

    const tags = await db.all(
      `
      SELECT DISTINCT t.id, t.name, n.presence, 
        CASE 
          WHEN it.id IS NOT NULL THEN 1 
          ELSE 0 
        END as inherited
      FROM Tags t
      JOIN Nodes n ON t.id = n.id
      JOIN Node_connections nc ON t.id = nc.destiny_id
      LEFT JOIN Inherited_tags it ON nc.id = it.connection_id
      WHERE nc.origin_id = ?
      AND nc.connection_type_id = (SELECT id FROM Connection_types WHERE name = 'Tagged')
      ORDER BY t.name
    `,
      [nodeId]
    );

    return res.status(200).json({
      code: 200,
      tags,
    });
  } catch (error) {
    return res.status(500).json({
      code: 500,
      message: "Error retrieving tags: " + error.message,
    });
  }
});

// Add a tag to a flashcard
tags_router.post("/flashcard/:flashcardId", async (req, res) => {
  let transaction = false;
  try {
    const { flashcardId } = req.params;
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({
        code: 400,
        message: "Tag name is required",
      });
    }

    await db.run("BEGIN TRANSACTION");
    transaction = true;

    // Check if tag exists
    let tag = await db.get("SELECT id FROM Tags WHERE name = ?", [name]);

    // If tag does not exist, create it
    if (!tag) {
      await db.run(
        "INSERT INTO Nodes (type_id, presence) VALUES ((SELECT id FROM Node_types WHERE name = 'Tag'), 0.0)"
      );
      const nodeResult = await db.get("SELECT last_insert_rowid() as lastID");
      await db.run("INSERT INTO Tags (id, name) VALUES (?, ?)", [
        nodeResult.lastID,
        name,
      ]);
      tag = { id: nodeResult.lastID };
    }

    // Create connection between flashcard and tag
    await db.run(
      "INSERT INTO Node_connections (origin_id, destiny_id, connection_type_id) VALUES (?, ?, (SELECT id FROM Connection_types WHERE name = 'Tagged'))",
      [flashcardId, tag.id]
    );

    await db.run("COMMIT");
    transaction = false;

    return res.status(201).json({
      code: 201,
      message: "Tag added to flashcard successfully",
      tagId: tag.id,
    });
  } catch (error) {
    if (transaction) {
      await db.run("ROLLBACK");
    }
    return res.status(500).json({
      code: 500,
      message: "Error adding tag to flashcard: " + error.message,
    });
  }
});

// Edit a tag on a flashcard
tags_router.put("/flashcard/:flashcardId/tag/:tagId", async (req, res) => {
  let transaction = false;
  try {
    const { flashcardId, tagId } = req.params;
    const { newName } = req.body;

    if (!newName) {
      return res.status(400).json({
        code: 400,
        message: "New tag name is required",
      });
    }

    await db.run("BEGIN TRANSACTION");
    transaction = true;

    // Check if a tag with the new name already exists
    let existingTag = await db.get("SELECT id FROM Tags WHERE name = ?", [
      newName,
    ]);

    if (existingTag) {
      // If the new name tag exists, update the connection to the existing tag
      await db.run(
        "UPDATE Node_connections SET destiny_id = ? WHERE origin_id = ? AND destiny_id = ? AND connection_type_id = (SELECT id FROM Connection_types WHERE name = 'Tagged')",
        [existingTag.id, flashcardId, tagId]
      );
    } else {
      // Rename the existing tag
      await db.run("UPDATE Tags SET name = ? WHERE id = ?", [newName, tagId]);
    }

    await db.run("COMMIT");
    transaction = false;

    return res.status(200).json({
      code: 200,
      message: "Tag updated on flashcard successfully",
    });
  } catch (error) {
    if (transaction) {
      await db.run("ROLLBACK");
    }
    return res.status(500).json({
      code: 500,
      message: "Error updating tag on flashcard: " + error.message,
    });
  }
});

// Remove a tag from a flashcard
tags_router.delete("/flashcard/:flashcardId/tag/:tagId", async (req, res) => {
  let transaction = false;
  try {
    const { flashcardId, tagId } = req.params;

    await db.run("BEGIN TRANSACTION");
    transaction = true;

    const result = await db.run(
      `DELETE FROM Node_connections 
       WHERE origin_id = ? AND destiny_id = ? 
       AND connection_type_id = (SELECT id FROM Connection_types WHERE name = 'Tagged')`,
      [flashcardId, tagId]
    );

    if (result.changes === 0) {
      await db.run("ROLLBACK");
      return res.status(404).json({
        code: 404,
        message: "Tag not found on flashcard",
      });
    }

    await db.run("COMMIT");
    transaction = false;

    return res.status(200).json({
      code: 200,
      message: "Tag removed from flashcard successfully",
    });
  } catch (error) {
    if (transaction) {
      await db.run("ROLLBACK");
    }
    return res.status(500).json({
      code: 500,
      message: "Error removing tag from flashcard: " + error.message,
    });
  }
});

export default tags_router;
