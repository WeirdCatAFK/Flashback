PRAGMA foreign_keys = ON;

-- Table for Documents
CREATE TABLE Documents (
  id INTEGER NOT NULL PRIMARY KEY,
  folder_id INTEGER,
  name VARCHAR,
  filepath VARCHAR,
  file_extension VARCHAR,
  CONSTRAINT fk_folder FOREIGN KEY (folder_id) REFERENCES Folders (id)
);

-- Table for Flashcards
CREATE TABLE Flashcards (
  id INTEGER NOT NULL PRIMARY KEY,
  document_id INTEGER,
  highlight_id INTEGER,
  tts_id INTEGER,
  text_renderer_id INTEGER,
  name VARCHAR,
  front TEXT,
  back TEXT,
  audio VARCHAR,
  presence INTEGER,
  next_recall DATETIME,
  CONSTRAINT fk_document FOREIGN KEY (document_id) REFERENCES Documents (id),
  CONSTRAINT fk_highlight FOREIGN KEY (highlight_id) REFERENCES Highlight (id),
  CONSTRAINT fk_text_renderer FOREIGN KEY (text_renderer_id) REFERENCES Text_renderer (id),
  CONSTRAINT fk_tts FOREIGN KEY (tts_id) REFERENCES TTS_voices (id)
);

-- Table for Highlights
CREATE TABLE Highlight (
  id INTEGER NOT NULL PRIMARY KEY,
  page INTEGER,
  x1 FLOAT,
  y1 FLOAT,
  x2 INTEGER,
  y2 INTEGER,
  start INTEGER NOT NULL,
  end INTEGER
);

-- Table for Inherited Tags
CREATE TABLE Inherited_tags (
  id INTEGER NOT NULL PRIMARY KEY,
  connection_id INTEGER,
  tag_id INTEGER,
  CONSTRAINT fk_connection FOREIGN KEY (connection_id) REFERENCES Node_connections (id),
  CONSTRAINT fk_tag FOREIGN KEY (tag_id) REFERENCES Tags (id)
);

-- Table for Node Connections
CREATE TABLE Node_connections (
  id INTEGER NOT NULL PRIMARY KEY,
  origin_id INTEGER,
  destiny_id INTEGER,
  relation_type_id INTEGER,
  CONSTRAINT fk_relation_type FOREIGN KEY (relation_type_id) REFERENCES Relation_types (id)
);

-- Table for Nodes
CREATE TABLE Nodes (
  id INTEGER NOT NULL PRIMARY KEY,
  tag_id INTEGER,
  folder_id INTEGER,
  document_id INTEGER,
  flashcard_id INTEGER,
  CONSTRAINT fk_tag FOREIGN KEY (tag_id) REFERENCES Tags (id),
  CONSTRAINT fk_folder FOREIGN KEY (folder_id) REFERENCES Folders (id),
  CONSTRAINT fk_document FOREIGN KEY (document_id) REFERENCES Documents (id),
  CONSTRAINT fk_flashcard FOREIGN KEY (flashcard_id) REFERENCES Flashcards (id)
);

-- Table for Paths
CREATE TABLE Path (
  id INTEGER NOT NULL PRIMARY KEY,
  name VARCHAR
);

-- Table for Path Connections
CREATE TABLE Path_connections (
  id INTEGER NOT NULL PRIMARY KEY,
  connection_id INTEGER,
  path_id INTEGER,
  CONSTRAINT fk_connection FOREIGN KEY (connection_id) REFERENCES Node_connections (id),
  CONSTRAINT fk_path FOREIGN KEY (path_id) REFERENCES Path (id)
);

-- Table for Tags
CREATE TABLE Tags (
  id INTEGER NOT NULL PRIMARY KEY,
  name VARCHAR
);

-- Table for Text Renderers
CREATE TABLE Text_renderer (
  id INTEGER NOT NULL PRIMARY KEY,
  name VARCHAR,
  filepath VARCHAR
);

-- Table for TTS Voices
CREATE TABLE TTS_voices (
  id INTEGER NOT NULL PRIMARY KEY,
  name VARCHAR,
  filepath VARCHAR
);

-- Table for Flashcard Media
CREATE TABLE Flashcard_media (
  id INTEGER NOT NULL PRIMARY KEY,
  flashcard_id INTEGER,
  front_media_id INTEGER,
  back_media_id INTEGER,
  CONSTRAINT fk_flashcard FOREIGN KEY (flashcard_id) REFERENCES Flashcards (id),
  CONSTRAINT fk_front_media FOREIGN KEY (front_media_id) REFERENCES Media (id),
  CONSTRAINT fk_back_media FOREIGN KEY (back_media_id) REFERENCES Media (id)
);

-- Table for Media
CREATE TABLE Media (
  id INTEGER NOT NULL PRIMARY KEY,
  filepath VARCHAR,
  media_type_id INTEGER,
  CONSTRAINT fk_media_type FOREIGN KEY (media_type_id) REFERENCES Media_types (id)
);

-- Table for Media Types
CREATE TABLE Media_types (
  id INTEGER NOT NULL PRIMARY KEY,
  name VARCHAR,
  file_extension VARCHAR,
  path_js VARCHAR
);

-- Table for Relation Types
CREATE TABLE Relation_types (
  id INTEGER NOT NULL PRIMARY KEY,
  name VARCHAR
);

-- Table for Folders
CREATE TABLE Folders (
  id INTEGER NOT NULL PRIMARY KEY,
  name VARCHAR,
  filepath VARCHAR
);

-- Indexes
CREATE INDEX idx_name_search_documents ON Documents (name);
CREATE INDEX idx_document_flashcards ON Flashcards (document_id);
CREATE INDEX idx_highlight_flashcards ON Flashcards (highlight_id);
CREATE INDEX idx_name_flashcards ON Flashcards (name);
CREATE INDEX idx_presence_flashcards ON Flashcards (presence);
CREATE INDEX idx_connection_inherited_tags ON Inherited_tags (connection_id);
CREATE INDEX idx_tag_inherited_tags ON Inherited_tags (tag_id);
CREATE INDEX idx_relationship_connections ON Node_connections (origin_id, destiny_id);
CREATE INDEX idx_type_connections ON Node_connections (relation_type_id);
CREATE INDEX idx_tag_nodes ON Nodes (tag_id);
CREATE INDEX idx_folder_nodes ON Nodes (folder_id);
CREATE INDEX idx_document_nodes ON Nodes (document_id);
CREATE INDEX idx_flashcard_nodes ON Nodes (flashcard_id);
CREATE INDEX idx_name_path ON Path (name);
CREATE INDEX idx_connection_path_connections ON Path_connections (connection_id);
CREATE INDEX idx_name_tags ON Tags (name);
CREATE INDEX idx_path_text_renderer ON Text_renderer (filepath);
CREATE INDEX idx_path_tts_voices ON TTS_voices (filepath);
CREATE INDEX idx_filepath_media ON Media (filepath);
CREATE INDEX idx_name_relation_types ON Relation_types (name);
CREATE INDEX idx_name_folders ON Folders (name);
CREATE INDEX idx_filepath_folders ON Folders (filepath);
