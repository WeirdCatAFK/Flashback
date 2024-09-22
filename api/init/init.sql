PRAGMA foreign_keys = ON;

-- Nodes table
CREATE TABLE IF NOT EXISTS Nodes (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT
);

-- Folders table
CREATE TABLE IF NOT EXISTS Folders (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  name VARCHAR,
  filepath VARCHAR,
  node_id INTEGER,
  FOREIGN KEY (node_id) REFERENCES Nodes (id) ON DELETE CASCADE
);

CREATE INDEX idx_path_retrieval ON Folders (filepath);

CREATE INDEX idx_name_retrieval ON Folders (name);

-- Documents table
CREATE TABLE IF NOT EXISTS Documents (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER,
  name VARCHAR,
  filepath VARCHAR,
  file_extension VARCHAR,
  node_id INTEGER,
  FOREIGN KEY (folder_id) REFERENCES Folders (id) ON DELETE CASCADE,
  FOREIGN KEY (node_id) REFERENCES Nodes (id) ON DELETE CASCADE
);

CREATE INDEX idx_doc_name_search ON Documents (name);

-- Flashcard_highlight table
CREATE TABLE IF NOT EXISTS Flashcard_highlight (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  page INTEGER,
  x1 FLOAT,
  y1 FLOAT,
  x2 INTEGER,
  y2 INTEGER,
  start INTEGER NOT NULL,
end INTEGER
);

-- Flashcards table
CREATE TABLE IF NOT EXISTS Flashcards (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER,
  node_id INTEGER,
  highlight_id INTEGER,
  name VARCHAR,
  front TEXT,
  back TEXT,
  audio VARCHAR,
  presence INTEGER,
  next_recall DATETIME,
  FOREIGN KEY (document_id) REFERENCES Documents (id) ON DELETE CASCADE,
  FOREIGN KEY (highlight_id) REFERENCES Flashcard_highlight (id),
  FOREIGN KEY (node_id) REFERENCES Nodes (id) ON DELETE CASCADE
);

CREATE INDEX idx_document ON Flashcards (document_id);

CREATE INDEX idx_flash_name_search ON Flashcards (name);

CREATE INDEX idx_presence ON Flashcards (presence);

-- Flashcard_info table
CREATE TABLE IF NOT EXISTS Flashcard_info (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  flashcard_id INTEGER,
  text_renderer VARCHAR,
  tts_voice VARCHAR,
  FOREIGN KEY (flashcard_id) REFERENCES Flashcards (id)
);

-- Media_types table
CREATE TABLE IF NOT EXISTS Media_types (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  name VARCHAR,
  file_extension VARCHAR,
  path_js VARCHAR
);

-- Media table
CREATE TABLE IF NOT EXISTS Media (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  filepath VARCHAR,
  media_type_id INTEGER,
  FOREIGN KEY (media_type_id) REFERENCES Media_types (id)
);

CREATE INDEX idx_filepath_retrieval ON Media (filepath);

-- Flashcard_media table
CREATE TABLE IF NOT EXISTS Flashcard_media (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  flashcard_id INTEGER,
  front_media_id INTEGER,
  back_media_id INTEGER,
  FOREIGN KEY (flashcard_id) REFERENCES Flashcards (id),
  FOREIGN KEY (front_media_id) REFERENCES Media (id),
  FOREIGN KEY (back_media_id) REFERENCES Media (id)
);

-- Relation_types table
CREATE TABLE IF NOT EXISTS Relation_types (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  name VARCHAR
);

-- Node_connections table
CREATE TABLE IF NOT EXISTS Node_connections (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  origin_id INTEGER,
  destiny_id INTEGER,
  relation_type_id INTEGER,
  FOREIGN KEY (relation_type_id) REFERENCES Relation_types (id)
);

CREATE INDEX idx_relationship_retrieval ON Node_connections (origin_id, destiny_id);

CREATE INDEX idx_type ON Node_connections (relation_type_id);

-- Inherited_tags table
CREATE TABLE IF NOT EXISTS Inherited_tags