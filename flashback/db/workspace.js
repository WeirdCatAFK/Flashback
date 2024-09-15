const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
// Load the current workspace json
let config = require("./config/config.json").config;
const current_id = config.current.workspace_id;
const currentWorkspace = config.workspaces.find(
  (workspace) => workspace.id === current_id
);

let db = new sqlite3.Database(currentWorkspace.db);

// Function to get data from the database and export to JSON
function exportWorkspace() {
  db.serialize(() => {
    // Query all documents
    db.all(
      `
            SELECT d.id, d.name, d.path, m.name AS media_type
            FROM Documents d
            JOIN Media_types m ON d.media_type_id = m.id
        `,
      (err, documents) => {
        if (err) {
          console.error(err);
          return;
        }

        // Loop through each document
        documents.forEach((document) => {
          // Create a JSON object for each document
          let docJson = {
            name: document.name,
            path: document.path,
            document_tags: [],
            mediaType: document.media_type,
            document_connections: [],
            flashcards: [],
          };

          // Fetch document tags
          db.all(
            `
                    SELECT t.name
                    FROM Document_Tags dt
                    JOIN Tags t ON dt.tag_id = t.id
                    WHERE dt.document_id = ?
                `,
            [document.id],
            (err, tags) => {
              if (err) {
                console.error(err);
                return;
              }

              docJson.document_tags = tags.map((tag) => tag.name);

              // Fetch document connections
              db.all(
                `
                        SELECT d2.path
                        FROM Document_Connections dc
                        JOIN Documents d2 ON dc.destiny_id = d2.id
                        WHERE dc.origin_id = ?
                    `,
                [document.id],
                (err, connections) => {
                  if (err) {
                    console.error(err);
                    return;
                  }

                  docJson.document_connections = connections.map(
                    (conn) => conn.path
                  );

                  // Fetch flashcards for the document
                  db.all(
                    `
                            SELECT f.id, f.name, f.next_recall, f.front, f.back, tr.type AS text_renderer, tts.voice_name || ' - ' || tts.language AS tts
                            FROM Flashcards f
                            JOIN Text_Renderers tr ON f.text_renderer_id = tr.id
                            JOIN TTS_Voices tts ON f.tts_id = tts.id
                            WHERE f.document_id = ?
                        `,
                    [document.id],
                    (err, flashcards) => {
                      if (err) {
                        console.error(err);
                        return;
                      }

                      let flashcardPromises = flashcards.map((flashcard) => {
                        return new Promise((resolve, reject) => {
                          // Create flashcard JSON
                          let flashcardJson = {
                            name: flashcard.name,
                            next_recall: flashcard.next_recall,
                            front: flashcard.front,
                            back: flashcard.back,
                            text_renderer: flashcard.text_renderer,
                            tts: flashcard.tts,
                            position_text_start: null,
                            position_text_end: null,
                            position_pdf_page: null,
                            position_pdf_x: null,
                            position_pdf_y: null,
                            flashcard_Tags: [],
                            flashcard_connections: [],
                          };

                          // Fetch flashcard tags
                          db.all(
                            `
                                        SELECT t.name
                                        FROM Flashcard_Tags ft
                                        JOIN Tags t ON ft.tag_id = t.id
                                        WHERE ft.flashcard_id = ?
                                    `,
                            [flashcard.id],
                            (err, flashcardTags) => {
                              if (err) {
                                reject(err);
                              }
                              flashcardJson.flashcard_Tags = flashcardTags.map(
                                (tag) => tag.name
                              );

                              // Fetch flashcard connections
                              db.all(
                                `
                                            SELECT f2.name
                                            FROM Flashcard_Connections fc
                                            JOIN Flashcards f2 ON fc.destiny_id = f2.id
                                            WHERE fc.origin_id = ?
                                        `,
                                [flashcard.id],
                                (err, connections) => {
                                  if (err) {
                                    reject(err);
                                  }
                                  flashcardJson.flashcard_connections =
                                    connections.map((conn) => conn.name);

                                  // Fetch flashcard position for PDF or Text
                                  db.get(
                                    `
                                                SELECT p.page AS position_pdf_page, p.x AS position_pdf_x, p.y AS position_pdf_y
                                                FROM Highlight h
                                                JOIN Position_pdf p ON h.Position_pdf = p.id
                                                WHERE h.id = ?
                                            `,
                                    [flashcard.highlight_id],
                                    (err, pdfPosition) => {
                                      if (err) {
                                        reject(err);
                                      }

                                      if (pdfPosition) {
                                        flashcardJson.position_pdf_page =
                                          pdfPosition.position_pdf_page;
                                        flashcardJson.position_pdf_x =
                                          pdfPosition.position_pdf_x;
                                        flashcardJson.position_pdf_y =
                                          pdfPosition.position_pdf_y;
                                      }

                                      // Check for text-based position if not PDF
                                      db.get(
                                        `
                                                    SELECT pt.start AS position_text_start, pt.end AS position_text_end
                                                    FROM Highlight h
                                                    JOIN Position_text pt ON h.Position_text = pt.id
                                                    WHERE h.id = ?
                                                `,
                                        [flashcard.highlight_id],
                                        (err, textPosition) => {
                                          if (err) {
                                            reject(err);
                                          }

                                          if (textPosition) {
                                            flashcardJson.position_text_start =
                                              textPosition.position_text_start;
                                            flashcardJson.position_text_end =
                                              textPosition.position_text_end;
                                          }

                                          resolve(flashcardJson);
                                        }
                                      );
                                    }
                                  );
                                }
                              );
                            }
                          );
                        });
                      });

                      // Once all flashcards for the document are fetched, add them to the document JSON
                      Promise.all(flashcardPromises)
                        .then((flashcardsData) => {
                          docJson.flashcards = flashcardsData;

                          // Write the document JSON to a file
                          fs.writeFileSync(
                            `${currentWorkspace.path}/${document.name}.flashback`,
                            JSON.stringify(docJson, null, 2)
                          );
                          console.log(`Exported: ${document.name}.flashback`);
                        })
                        .catch((err) => {
                          console.error(err);
                        });
                    }
                  );
                }
              );
            }
          );
        });
      }
    );
  });
}
// Function to import data from Flashback files into the database
function importWorkspace() {
  let config = require("./config/config.json").config;
  const current_id = config.current.workspace_id;
  const currentWorkspace = config.workspaces.find(
    (workspace) => workspace.id === current_id
  );

  let db = new sqlite3.Database(currentWorkspace.db);

  // Read all ".flashback" files in the workspace path
  fs.readdir(currentWorkspace.path, (err, files) => {
    if (err) {
      console.error(err);
      return;
    }

    const flashbackFiles = files.filter(
      (file) => path.extname(file) === ".flashback"
    );

    flashbackFiles.forEach((file) => {
      const filePath = path.join(currentWorkspace.path, file);
      const fileContent = fs.readFileSync(filePath, "utf8");
      const docJson = JSON.parse(fileContent);

      db.serialize(() => {
        // Insert or update document data
        db.run(
          `
                    INSERT OR REPLACE INTO Documents (name, path, media_type_id)
                    VALUES (?, ?, (SELECT id FROM Media_types WHERE name = ?))
                `,
          [docJson.name, docJson.path, docJson.mediaType],
          function (err) {
            if (err) {
              console.error(err);
              return;
            }

            const documentId = this.lastID;

            // Insert document tags
            docJson.document_tags.forEach((tag) => {
              db.run(
                `
                            INSERT OR IGNORE INTO Tags (name) VALUES (?)
                        `,
                [tag],
                function (err) {
                  if (err) {
                    console.error(err);
                    return;
                  }

                  const tagId =
                    this.lastID || `(SELECT id FROM Tags WHERE name = ?)`;
                  db.run(
                    `
                                INSERT OR IGNORE INTO Document_Tags (document_id, tag_id)
                                VALUES (?, ${tagId})
                            `,
                    [documentId, tag],
                    (err) => {
                      if (err) {
                        console.error(err);
                      }
                    }
                  );
                }
              );
            });

            // Insert document connections
            docJson.document_connections.forEach((connectionPath) => {
              db.run(
                `
                            INSERT OR IGNORE INTO Document_Connections (origin_id, destiny_id)
                            VALUES (?, (SELECT id FROM Documents WHERE path = ?))
                        `,
                [documentId, connectionPath],
                (err) => {
                  if (err) {
                    console.error(err);
                  }
                }
              );
            });

            // Insert flashcards
            docJson.flashcards.forEach((flashcard) => {
              db.run(
                `
                            INSERT OR REPLACE INTO Flashcards (document_id, name, next_recall, front, back, text_renderer_id, tts_id)
                            VALUES (?, ?, ?, ?, ?, (SELECT id FROM Text_Renderers WHERE type = ?), (SELECT id FROM TTS_Voices WHERE voice_name || ' - ' || language = ?))
                        `,
                [
                  documentId,
                  flashcard.name,
                  flashcard.next_recall,
                  flashcard.front,
                  flashcard.back,
                  flashcard.text_renderer,
                  flashcard.tts,
                ],
                function (err) {
                  if (err) {
                    console.error(err);
                    return;
                  }

                  const flashcardId = this.lastID;

                  // Insert flashcard tags
                  flashcard.flashcard_Tags.forEach((tag) => {
                    db.run(
                      `
                                    INSERT OR IGNORE INTO Tags (name) VALUES (?)
                                `,
                      [tag],
                      function (err) {
                        if (err) {
                          console.error(err);
                          return;
                        }

                        const tagId =
                          this.lastID || `(SELECT id FROM Tags WHERE name = ?)`;
                        db.run(
                          `
                                        INSERT OR IGNORE INTO Flashcard_Tags (flashcard_id, tag_id)
                                        VALUES (?, ${tagId})
                                    `,
                          [flashcardId, tag],
                          (err) => {
                            if (err) {
                              console.error(err);
                            }
                          }
                        );
                      }
                    );
                  });

                  // Insert flashcard connections
                  flashcard.flashcard_connections.forEach((conn) => {
                    db.run(
                      `
                                    INSERT OR IGNORE INTO Flashcard_Connections (origin_id, destiny_id)
                                    VALUES (?, (SELECT id FROM Flashcards WHERE name = ?))
                                `,
                      [flashcardId, conn],
                      (err) => {
                        if (err) {
                          console.error(err);
                        }
                      }
                    );
                  });

                  // Insert flashcard position (PDF or text)
                  if (flashcard.position_pdf_page !== null) {
                    db.run(
                      `
                                    INSERT INTO Position_pdf (page, x, y) VALUES (?, ?, ?)
                                `,
                      [
                        flashcard.position_pdf_page,
                        flashcard.position_pdf_x,
                        flashcard.position_pdf_y,
                      ],
                      function (err) {
                        if (err) {
                          console.error(err);
                          return;
                        }

                        const pdfPositionId = this.lastID;
                        db.run(
                          `
                                        INSERT INTO Highlight (Position_pdf) VALUES (?)
                                    `,
                          [pdfPositionId],
                          (err) => {
                            if (err) {
                              console.error(err);
                            }
                          }
                        );
                      }
                    );
                  } else if (flashcard.position_text_start !== null) {
                    db.run(
                      `
                                    INSERT INTO Position_text (start, end) VALUES (?, ?)
                                `,
                      [
                        flashcard.position_text_start,
                        flashcard.position_text_end,
                      ],
                      function (err) {
                        if (err) {
                          console.error(err);
                          return;
                        }

                        const textPositionId = this.lastID;
                        db.run(
                          `
                                        INSERT INTO Highlight (Position_text) VALUES (?)
                                    `,
                          [textPositionId],
                          (err) => {
                            if (err) {
                              console.error(err);
                            }
                          }
                        );
                      }
                    );
                  }
                }
              );
            });
          }
        );
      });
    });
  });
}
